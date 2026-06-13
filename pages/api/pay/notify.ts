/**
 * GET /api/pay/notify
 *
 * 用途：Z-Pay 异步回调，通知支付结果
 *
 * 处理流程：
 * 1. MD5 验签（timingSafeEqual 防时序攻击）
 * 2. 若 trade_status != TRADE_SUCCESS → 早 ack "success"
 * 3. 金额校验（order-store 优先，Notion fallback）
 * 4. 幂等检查（已 paid → 直接 return success）
 * 5. markPaid
 * 6. POST n8n /webhook/notify
 * 7. return "success"
 *
 * 响应格式为纯文本（text/plain），遵循 Z-Pay 回调规范
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import * as crypto from 'crypto'
import { orderStore } from '@/lib/order-store'
import { getNotionProperty, type NotionPropertyValue } from '@/lib/notion-utils'

// ---- 纯文本响应工具 ----
const text = (res: NextApiResponse, status: number, body: string) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  return res.status(status).send(body)
}

// ============= Z-Pay 验签 =============
/**
 * 验证 ZPay 回调签名
 * 签名算法：MD5（参数 ASCII 排序 + 排除 sign/sign_type/空值 + prestr+KEY），小写 hex
 * 使用 timingSafeEqual 防时序攻击
 *
 * @param params GET 解析出的全部参数（含 sign）
 * @param key ZPAY_KEY
 */
function verifyZPaySign(params: Record<string, string | undefined>, key: string): boolean {
  const receivedSign = params.sign ?? ''
  if (!receivedSign) return false

  const filtered = Object.entries(params)
    .filter(([k, v]) => v !== undefined && v !== '' && k !== 'sign' && k !== 'sign_type')
    .sort(([a], [b]) => a.localeCompare(b))

  const prestr = filtered.map(([k, v]) => `${k}=${v}`).join('&')
  const calculatedSign = crypto
    .createHash('md5')
    .update(prestr + key, 'utf8')
    .digest('hex')

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSign, 'utf8'),
      Buffer.from(calculatedSign, 'utf8')
    )
  } catch {
    return false
  }
}

// ============= Notion 订单 DB 金额查询（fallback） =============
/**
 * fallback：从 Notion 订单 DB 按 outTradeNo 查订单金额
 * 用于 order-store 为空时（容器冷启动）的金额校验
 */
async function queryOrderAmountFromNotion(outTradeNo: string): Promise<number | null> {
  const token = process.env.NOTION_TOKEN
  const dbId = process.env.NOTION_DATABASE_ID

  if (!token || !dbId) return null

  const response = await fetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          property: '订单号',
          rich_text: { equals: outTradeNo },
        },
        page_size: 1,
      }),
    }
  )

  if (!response.ok) return null

  const data = await response.json() as { results: Array<{ properties: Record<string, unknown> }> }
  if (data.results.length === 0) return null

  const props = data.results[0]?.properties
  if (!props) return null

  const amountProp = getNotionProperty(props, '金额') as NotionPropertyValue | null
  if (!amountProp || amountProp.type !== 'number') return null
  return (amountProp as { type: 'number'; number: number | null }).number ?? null
}

// ============= 主处理函数 =============
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return text(res, 405, 'method not allowed')
  }

  const params = req.query as Record<string, string | undefined>

  // ---- 1. 验签 ----
  const zpayKey = process.env.ZPAY_KEY
  if (!zpayKey) {
    return text(res, 400, 'sign error')
  }

  if (!verifyZPaySign(params, zpayKey)) {
    return text(res, 400, 'sign error')
  }

  // ---- 2. 提取参数 ----
  const outTradeNo  = params.out_trade_no ?? ''
  const tradeStatus = params.trade_status ?? ''
  const paidMoney = parseFloat(params.money ?? '')
  if (Number.isNaN(paidMoney)) {
    return text(res, 400, 'invalid money param')
  }

  if (!outTradeNo) {
    return text(res, 400, 'sign error')
  }

  // ---- 3. 非 TRADE_SUCCESS 早 ack ----
  if (tradeStatus !== 'TRADE_SUCCESS') {
    return text(res, 200, 'success')
  }

  // ---- 4. 金额校验 ----
  let expectedFinalPrice: number | null = null

  // 优先：查 order-store
  const orderFromStore = orderStore.get(outTradeNo)
  if (orderFromStore) {
    expectedFinalPrice = orderFromStore.finalPrice
  } else {
    // Fallback：查 Notion 订单 DB
    expectedFinalPrice = await queryOrderAmountFromNotion(outTradeNo)
  }

  if (expectedFinalPrice === null) {
    return text(res, 500, 'order not found')
  }

  // ZPay money 单位是元，与 finalPrice 单位一致，直接比较
  if (Math.abs(paidMoney - expectedFinalPrice) > 0.01) {
    return text(res, 400, 'amount mismatch')
  }

  // ---- 5. 幂等检查 ----
  if (orderStore.isPaid(outTradeNo)) {
    return text(res, 200, 'success')
  }

  // ---- 6. markPaid ----
  orderStore.markPaid(outTradeNo)

  // ---- 7. 发 n8n webhook（失败不影响主流程） ----
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL
  const n8nSecret = process.env.N8N_WEBHOOK_SECRET
  const discountCode = orderFromStore?.discountCode ?? ''

  if (n8nWebhookUrl && n8nSecret) {
    fetch(`${n8nWebhookUrl}/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-n8n-secret': n8nSecret,
      },
      body: JSON.stringify({
        outTradeNo,
        paidAmount: paidMoney,
        paidAt: new Date().toISOString().slice(0, 10),
        discountCode,
      }),
    }).catch(() => {
      // n8n webhook 失败不影响主流程，忽略
    })
  }

  // ---- 8. 返回 success ----
  return text(res, 200, 'success')
}