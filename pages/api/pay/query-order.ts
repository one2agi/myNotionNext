/**
 * GET /api/pay/query-order
 *
 * 用途：前端 PayModal 轮询订单支付状态（兜底 Z-Pay 异步回调）
 *
 * 处理流程（遵循 PAYMENT-API-SPEC.md §3.5）：
 * 1. Origin 校验（同源 + allow list）— 防跨站任意调用
 * 2. IP 限速（60 req/min）— 防自家 DoS
 * 3. outTradeNo 白名单校验（字符集 + 长度）— 防 Notion 配额滥用
 * 4. 优先查 order-store.get(outTradeNo)
 *    - 有 → 返回 paid 状态 + productName + finalPrice + paidAt
 *    - 无 → fallback 查 Notion 订单 DB
 * 5. fallback 也查不到 → 返回 404 E_ORDER_NOT_FOUND
 *
 * 遵循 PAYMENT-IMPLEMENTATION-NOTES.md B.1 + 2026-06-14 安全评审 H1
 *
 * @module pages/api/pay/query-order
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { orderStore } from '@/lib/order-store'
import {
  getNotionProperty,
  getRichText,
  getNumber,
  type NotionPropertyValue,
} from '@/lib/notion-utils'
import { checkOrigin, validateOutTradeNo, rateLimit, getClientIp } from '@/lib/security'
import { ErrorCode } from '@/lib/errors'

// ============= 响应类型 =============
interface QueryOrderData {
  outTradeNo: string
  paid: boolean
  paidAt: string | null
  productName: string
  finalPrice: number
  unit: '元'
}

type QueryOrderResponse =
  | { code: 0; message: 'success'; data: QueryOrderData }
  | { code: typeof ErrorCode.E_ORDER_NOT_FOUND; message: 'E_ORDER_NOT_FOUND'; data: null }
  | { code: typeof ErrorCode.E_NOTION_FAIL; message: 'E_NOTION_FAIL'; data: null }
  | { code: typeof ErrorCode.E_INTERNAL; message: 'E_INTERNAL'; data: null }
  | { code: typeof ErrorCode.E_METHOD_NOT_ALLOWED; message: 'E_METHOD_NOT_ALLOWED'; data: null }
  | { code: typeof ErrorCode.E_PARAM_MISSING; message: 'E_PARAM_MISSING'; data: null }
  | { code: typeof ErrorCode.E_PARAM_INVALID; message: 'E_PARAM_INVALID'; data: null }
  | { code: typeof ErrorCode.E_ORIGIN_FORBIDDEN; message: 'E_ORIGIN_FORBIDDEN'; data: null }
  | { code: typeof ErrorCode.E_RATE_LIMITED; message: 'E_RATE_LIMITED'; data: null }

// ============= Notion 查询（fallback） =============
/**
 * 从 Notion 订单数据库查询订单信息
 * 仅在 order-store miss（容器冷启动）时调用
 */
async function queryNotionOrder(outTradeNo: string): Promise<{
  paid: boolean
  paidAt: string | null
  productName: string
  finalPrice: number
} | null> {
  const token = process.env.NOTION_TOKEN
  const dbId = process.env.NOTION_DATABASE_ID

  if (!token || !dbId) {
    throw new Error('E_NOTION_FAIL: NOTION_TOKEN or NOTION_DATABASE_ID not set')
  }

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

  if (!response.ok) {
    throw new Error(`E_NOTION_FAIL: Notion API ${response.status}`)
  }

  const data = await response.json() as {
    results: Array<{ properties: Record<string, unknown> }>
  }

  if (data.results.length === 0) {
    return null
  }

  const props = data.results[0]?.properties
  if (!props) return null

  const pProductName = getNotionProperty(props, '商品名')
  const pAmount = getNotionProperty(props, '金额')
  const pPurchaseDate = getNotionProperty(props, '购买日期')

  const productName = getRichText(pProductName)
  const finalPrice = getNumber(pAmount)
  // 购买日期存在 = 已支付
  const paidDate = pPurchaseDate as NotionPropertyValue & { type: 'date'; date: { start: string } | null }
  const paidAt = paidDate?.type === 'date' && paidDate?.date?.start
    ? paidDate.date.start
    : null

  return {
    paid: Boolean(paidAt),
    paidAt,
    productName: productName || '未知商品',
    finalPrice,
  }
}

// ============= 主处理函数 =============
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<QueryOrderResponse>
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({
      code: ErrorCode.E_METHOD_NOT_ALLOWED,
      message: 'E_METHOD_NOT_ALLOWED',
      data: null,
    })
  }

  // ---- 0. Origin 校验（防跨站调用）----
  if (!checkOrigin(req)) {
    return res.status(403).json({
      code: ErrorCode.E_ORIGIN_FORBIDDEN,
      message: 'E_ORIGIN_FORBIDDEN',
      data: null,
    })
  }

  // ---- 0b. IP 限速（60 req/min）----
  const clientIp = getClientIp(req)
  if (!rateLimit(clientIp)) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({
      code: ErrorCode.E_RATE_LIMITED,
      message: 'E_RATE_LIMITED',
      data: null,
    })
  }

  const { outTradeNo } = req.query

  if (!outTradeNo || typeof outTradeNo !== 'string') {
    return res.status(400).json({
      code: ErrorCode.E_PARAM_MISSING,
      message: 'E_PARAM_MISSING',
      data: null,
    })
  }

  // ---- 0c. outTradeNo 白名单校验（字符集 + 长度）----
  const validation = validateOutTradeNo(outTradeNo)
  if (!validation.valid) {
    return res.status(400).json({
      code: ErrorCode.E_PARAM_INVALID,
      message: 'E_PARAM_INVALID',
      data: null,
    })
  }

  try {
    // ---- 1. order-store 优先查询 ----
    const cached = orderStore.get(outTradeNo)

    if (cached) {
      return res.status(200).json({
        code: 0,
        message: 'success',
        data: {
          outTradeNo,
          paid: cached.paid,
          paidAt: cached.paidAt ?? null,
          productName: cached.productName,
          finalPrice: cached.finalPrice,
          unit: '元',
        },
      })
    }

    // ---- 2. fallback 查 Notion 订单 DB（容器冷启动场景）----
    const notionOrder = await queryNotionOrder(outTradeNo)

    if (!notionOrder) {
      return res.status(404).json({
        code: ErrorCode.E_ORDER_NOT_FOUND,
        message: 'E_ORDER_NOT_FOUND',
        data: null,
      })
    }

    return res.status(200).json({
      code: 0,
      message: 'success',
      data: {
        outTradeNo,
        paid: notionOrder.paid,
        paidAt: notionOrder.paidAt,
        productName: notionOrder.productName,
        finalPrice: notionOrder.finalPrice,
        unit: '元',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'E_INTERNAL'
    if (message.startsWith('E_NOTION_FAIL')) {
      return res.status(500).json({
        code: ErrorCode.E_NOTION_FAIL,
        message: 'E_NOTION_FAIL',
        data: null,
      })
    }
    console.error('[query-order] internal error', err)
    return res.status(500).json({
      code: ErrorCode.E_INTERNAL,
      message: 'E_INTERNAL',
      data: null,
    })
  }
}
