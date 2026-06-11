/**
 * EdgeOne Pages Cloud Function — Z-Pay 异步回调
 * 路径: /api/pay/notify  →  GET (Z-Pay 文档默认) + POST (PHP/Java SDK 常用)
 *
 * 流程:
 * 1. 解析参数 (GET: query string; POST: form-urlencoded)
 * 2. verifySign 验签 (失败 → 400 'sign error'，阻止 Z-Pay 重试)
 * 3. 非 TRADE_SUCCESS → 早 ack 'success' (中间态重发没意义)
 * 4. alreadyPaid 幂等检查 (已 paid → 'success'，不重复处理)
 * 5. markPaid 金额校验 + 写内存 (mismatch → 400 'amount mismatch')
 * 6. H-5 简化: markPaid 成功后直接调 Notion REST API 写订单页 (2.5s AbortController, Sentry warn)
 * 7. 返 plain text 'success' (否则 Z-Pay 按 0/15/.../3600s 重发 11 次)
 *
 * H-5 简化 (2026-06-11): 直接 Notion API (砍掉 Workers 层)
 */
import crypto from 'crypto'
import { verifySign } from '../../../lib/zpay.js'
import { alreadyPaid, markPaid, getOrder } from '../../../lib/order-store.js'

interface EventContext {
  request: Request
  env: Record<string, string>
}

async function readParams(request: Request, isPost: boolean): Promise<Record<string, string>> {
  if (isPost) {
    const form = await request.formData()
    const out: Record<string, string> = {}
    for (const [k, v] of form.entries()) out[k] = String(v)
    return out
  }
  const sp = new URL(request.url).searchParams
  const out: Record<string, string> = {}
  for (const [k, v] of sp.entries()) out[k] = v
  return out
}

/**
 * 从原始 query string 提取 sign（不经过 URL decode）
 * Z-Pay 签名用的是 URL 编码后的字符串，auto-decoding 会导致验签失败
 */
function extractSignRaw(request: Request): string | null {
  const url = new URL(request.url)
  const raw = url.search.slice(1) // 去掉 '?'
  const params = new URLSearchParams(raw)
  return params.get('sign')
}

/**
 * 用原始 query string 重新计算签名来验证（避免 URL decode 破坏中文/特殊字符）
 * GET 请求专用
 */
function verifySignRaw(request: Request, key: string): boolean {
  const url = new URL(request.url)
  const raw = url.search.slice(1) // 去掉 '?'
  if (!raw) return false

  // 从 raw query string 直接提取 sign
  const signMatch = raw.match(/sign=([^&]+)/)
  if (!signMatch) return false
  const receivedSign = signMatch[1]

  // 用 URLSearchParams 解析（自动 URL decode），再按 key 升序排列后拼接
  const params = new URLSearchParams(raw)
  const pairs: string[] = []
  const keys = Array.from(params.keys()).sort()
  for (const k of keys) {
    if (k === 'sign' || k === 'sign_type') continue
    const v = params.get(k)
    if (!v) continue
    // 直接用解码后的值（不用 re-encode）— Z-Pay 签名时 name=原始中文
    pairs.push(`${k}=${v}`)
  }
  const signData = pairs.join('&') + key
  const expected = crypto.createHash('md5').update(signData).digest('hex')
  if (expected.length !== receivedSign.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSign))
}

/**
 * H-5 简化: 直接写 Notion 订单页 (砍 Workers 层)
 * POST https://api.notion.com/v1/pages
 * 2.5s AbortController (G3 修复: EdgeOne 3s 超时, 留 0.5s buffer)
 * 失败不阻断 200 success 给 Z-Pay
 */
async function writeNotionPage(outTradeNo: string, moneyYuan: string, env: Record<string, string>): Promise<void> {
  const notionToken = env.NOTION_TOKEN
  const databaseId = env.NOTION_DATABASE_ID
  if (!notionToken || !databaseId) {
    console.warn('[notify] NOTION_TOKEN or NOTION_DATABASE_ID not set, skipping Notion write')
    return
  }

  const order = getOrder(outTradeNo)
  const ci = order?.customerInfo ?? { name: '', email: '', discountCode: undefined, partnerName: undefined, productName: '' }

  const payload = {
    parent: { database_id: databaseId },
    properties: {
      Name: { title: [{ text: { content: ci.name || '匿名' } }] },
      '客户邮箱': { email: ci.email || '' },
      '购买日期': { date: { start: new Date().toISOString().slice(0, 10) } },
      '状态': { status: { name: '待发送' } },
      '订单号': { rich_text: [{ text: { content: outTradeNo } }] },
      '商品名': { rich_text: [{ text: { content: ci.productName ?? '' } }] },
      '金额': { number: parseFloat(moneyYuan) },
      '备注': {
        rich_text: [{
          text: {
            content: ci.discountCode
              ? `[code:${ci.discountCode} ${ci.partnerName ?? ''}] 付款于 ${new Date().toISOString().slice(11, 19)}`
              : `付款于 ${new Date().toISOString().slice(11, 19)}`,
          },
        }],
      },
    },
  }
  const rawBody = JSON.stringify(payload)

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 2500)

  try {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionToken}`,
        'Notion-Version': '2025-09-03',
        'Content-Type': 'application/json',
      },
      body: rawBody,
      signal: ac.signal,
    })
    if (!res.ok) {
      // H-5: Notion API HTTP error — log to console (Sentry added later in H-10)
      console.warn(`[notify] Notion API HTTP ${res.status} for ${outTradeNo}`)
    }
  } catch (e: any) {
    const isAbort = e?.name === 'AbortError'
    console.warn(`[notify] Notion API error for ${outTradeNo}: ${isAbort ? 'timeout' : e?.message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function handle(request: Request, env: Record<string, string>, isPost: boolean): Promise<Response> {
  const params = await readParams(request, isPost)
  const outTradeNo = params.out_trade_no
  const money = params.money
  if (!outTradeNo || !money) {
    return new Response('bad request', { status: 400 })
  }
  // GET 请求：用原始 query string 验签（避免 URL decode 破坏中文签名）
  // POST 请求：用已解码的 form data 验签（Z-Pay POST SDK 自动编码）
  if (isPost) {
    if (!verifySign(params, env.ZPAY_KEY)) {
      return new Response('sign error', { status: 400 })
    }
  } else {
    if (!verifySignRaw(request, env.ZPAY_KEY)) {
      return new Response('sign error', { status: 400 })
    }
  }
  if (params.trade_status !== 'TRADE_SUCCESS') {
    return new Response('success')
  }
  if (alreadyPaid(outTradeNo)) {
    return new Response('success')
  }
  if (!markPaid(outTradeNo, parseFloat(money))) {
    return new Response('amount mismatch', { status: 400 })
  }

  // H-5 简化: markPaid 成功后直接写 Notion API
  try {
    await writeNotionPage(outTradeNo, money, env)
  } catch {
    // already captured in writeNotionPage, no need to handle here
  }

  return new Response('success')
}

export async function onRequestGet(ctx: EventContext): Promise<Response> {
  return handle(ctx.request, ctx.env, false)
}

export async function onRequestPost(ctx: EventContext): Promise<Response> {
  return handle(ctx.request, ctx.env, true)
}