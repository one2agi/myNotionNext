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
 * 6. 返 plain text 'success' (否则 Z-Pay 按 0/15/.../3600s 重发 11 次)
 */
import { verifySign } from '../../../lib/zpay.js'
import { alreadyPaid, markPaid } from '../../../lib/order-store.js'

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

async function handle(request: Request, env: Record<string, string>, isPost: boolean): Promise<Response> {
  const params = await readParams(request, isPost)
  // 早返:out_trade_no / money 任一缺失都返 400（tsconfig noUncheckedIndexedAccess 让
  // params 索引访问返 string | undefined，传给 markPaid / alreadyPaid / parseFloat
  // 会触发 TS2345；运行时 markPaid(undefined, ...) 会让金额校验 100% 失败）。
  // 跟 query-order.ts 缺 outTradeNo 返 400 一致。
  const outTradeNo = params.out_trade_no
  const money = params.money
  if (!outTradeNo || !money) {
    return new Response('bad request', { status: 400 })
  }
  if (!verifySign(params, env.ZPAY_KEY)) {
    return new Response('sign error', { status: 400 })
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
  return new Response('success')
}

export async function onRequestGet(ctx: EventContext): Promise<Response> {
  return handle(ctx.request, ctx.env, false)
}

export async function onRequestPost(ctx: EventContext): Promise<Response> {
  return handle(ctx.request, ctx.env, true)
}
