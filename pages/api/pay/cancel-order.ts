/**
 * POST /api/pay/cancel-order
 *
 * 用途：用户主动取消未支付订单（前端 PayModal 取消按钮 / 5 分钟超时自动调用）
 *
 * 处理流程（遵循 PAYMENT-API-SPEC.md §3.6）：
 * 1. 读 outTradeNo
 * 2. 查 order-store：
 *    - 有 → 检查 paid 状态
 *      - paid=true → return 400 E_ORDER_ALREADY_PAID
 *      - paid=false → markCancelled + 发 n8n webhook + 删除 order-store
 * 3. 查不到 → fallback 查 Notion 订单 DB
 *    - Notion 有 → 发 n8n webhook（改状态为"已取消"）
 *    - Notion 没 → return 404 E_ORDER_NOT_FOUND
 *
 * 幂等设计（遵循 PAYMENT-IMPLEMENTATION-NOTES.md B.2）：
 * - 同一 outTradeNo 多次 cancel POST：order-store 已删 → Notion fallback → 状态已是"已取消" → 返 200
 * - cancel 与 notify race：先 markCancelled 防 notify 写入
 *
 * @module pages/api/pay/cancel-order
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { orderStore } from '@/lib/order-store'
import {
  getNotionProperty,
  getRichText,
  type NotionPropertyValue,
} from '@/lib/notion-utils'

// ============= 错误码 =============
const ErrorCode = {
  E_ORDER_NOT_FOUND: 40011,
  E_ORDER_ALREADY_PAID: 40012,
  E_INTERNAL: 50001,
  E_METHOD_NOT_ALLOWED: 40501,
  E_PARAM_MISSING: 40000,
} as const

// ============= 响应类型 =============
type CancelOrderResponse =
  | { code: 0; message: 'success'; data: { outTradeNo: string; cancelled: true } }
  | { code: typeof ErrorCode.E_ORDER_NOT_FOUND; message: 'E_ORDER_NOT_FOUND'; data: null }
  | { code: typeof ErrorCode.E_ORDER_ALREADY_PAID; message: 'E_ORDER_ALREADY_PAID'; data: null }
  | { code: typeof ErrorCode.E_INTERNAL; message: 'E_INTERNAL'; data: null }
  | { code: typeof ErrorCode.E_METHOD_NOT_ALLOWED; message: 'E_METHOD_NOT_ALLOWED'; data: null }
  | { code: typeof ErrorCode.E_PARAM_MISSING; message: 'E_PARAM_MISSING'; data: null }

// ============= Z-Pay 关闭订单 =============
/**
 * 调用 Z-Pay 关闭订单接口
 * @param outTradeNo 商户订单号
 */
async function closeZPayOrder(outTradeNo: string): Promise<void> {
  const pid = process.env.ZPAY_PID
  const zpayKey = process.env.ZPAY_KEY

  if (!pid || !zpayKey) {
    throw new Error('E_INTERNAL: ZPAY_PID or ZPAY_KEY not set')
  }

  // Z-Pay 关闭订单参数（MD5 签名）
  const crypto = await import('crypto')
  const params: Record<string, string> = {
    pid,
    out_trade_no: outTradeNo,
  }

  // 过滤空值并 ASCII 排序
  const filtered = Object.entries(params)
    .filter(([k, v]) => v !== undefined && v !== '' && k !== 'sign' && k !== 'sign_type')
    .sort(([a], [b]) => a.localeCompare(b))

  const prestr = filtered.map(([k, v]) => `${k}=${v}`).join('&')
  const sign = crypto.createHash('md5').update(prestr + zpayKey, 'utf8').digest('hex')

  const closeUrl = 'https://z-pay.cn/api.php?act=close'
  const response = await fetch(closeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, sign }).toString(),
  })

  // Z-Pay 关闭接口可能无返回值或返回非 JSON，忽略错误（幂等）
  if (response.ok) {
    try {
      await response.json()
    } catch {
      // 非 JSON 响应，忽略
    }
  }
}

// ============= n8n webhook =============
/**
 * 发送取消订单 webhook 到 n8n（改 Notion 状态为"已取消"）
 */
async function notifyN8nCancelOrder(outTradeNo: string): Promise<void> {
  const webhookUrl = process.env.N8N_WEBHOOK_URL
  const webhookSecret = process.env.N8N_WEBHOOK_SECRET

  if (!webhookUrl || !webhookSecret) {
    // n8n webhook 失败不影响主流程（异步，幂等）
    console.warn('[cancel-order] N8N_WEBHOOK_URL or N8N_WEBHOOK_SECRET not set, skipping n8n notify')
    return
  }

  await fetch(`${webhookUrl}/cancel-order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-n8n-secret': webhookSecret,
    },
    body: JSON.stringify({
      outTradeNo,
      cancelledAt: new Date().toISOString().slice(0, 10),
    }),
  })
}

// ============= Notion 查询（fallback） =============
/**
 * 查询 Notion 订单 DB，检查订单是否存在以及状态
 */
async function queryNotionOrderStatus(outTradeNo: string): Promise<{
  exists: boolean
  status: string | null
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

  const pStatus = getNotionProperty(props, '状态')
  const status = (pStatus as NotionPropertyValue & { type: 'status'; status?: { name: string } })?.status?.name ?? null

  return { exists: true, status }
}

// ============= 主处理函数 =============
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CancelOrderResponse>
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({
      code: ErrorCode.E_METHOD_NOT_ALLOWED,
      message: 'E_METHOD_NOT_ALLOWED',
      data: null,
    })
  }

  const { outTradeNo } = req.body as { outTradeNo?: string }

  if (!outTradeNo || typeof outTradeNo !== 'string') {
    return res.status(400).json({
      code: ErrorCode.E_PARAM_MISSING,
      message: 'E_PARAM_MISSING',
      data: null,
    })
  }

  try {
    // ---- 1. 查 order-store ----
    const cached = orderStore.get(outTradeNo)

    if (cached) {
      // ---- 1a. 已支付订单不能取消 ----
      if (cached.paid) {
        return res.status(400).json({
          code: ErrorCode.E_ORDER_ALREADY_PAID,
          message: 'E_ORDER_ALREADY_PAID',
          data: null,
        })
      }

      // ---- 1b. 已取消订单幂等返回 ----
      if (cached.cancelled) {
        return res.status(200).json({
          code: 0,
          message: 'success',
          data: { outTradeNo, cancelled: true },
        })
      }

      // ---- 1c. 未支付 → markCancelled（防 notify race）----
      orderStore.markCancelled(outTradeNo)

      // ---- 1d. 发 n8n webhook 改 Notion 状态为"已取消" ----
      await notifyN8nCancelOrder(outTradeNo)

      // ---- 1e. 关闭 Z-Pay 订单 ----
      await closeZPayOrder(outTradeNo).catch(() => {
        // Z-Pay 关闭失败不影响主流程
      })

      // ---- 1f. 从 order-store 删除 ----
      // 直接删除（orderStore 没有 delete 方法，用 set + TTL 模拟）
      // 由于有 60min TTL 清理，不手动删除也可以；但为了保持一致性，使用 markCancelled 后不清理
      // order-store 中保留 cancelled=true 的记录，60min 后自动清理

      return res.status(200).json({
        code: 0,
        message: 'success',
        data: { outTradeNo, cancelled: true },
      })
    }

    // ---- 2. order-store miss → fallback 查 Notion ----
    const notionOrder = await queryNotionOrderStatus(outTradeNo)

    if (!notionOrder) {
      return res.status(404).json({
        code: ErrorCode.E_ORDER_NOT_FOUND,
        message: 'E_ORDER_NOT_FOUND',
        data: null,
      })
    }

    // ---- 2a. 已支付订单不能取消 ----
    if (notionOrder.status === '已发送') {
      return res.status(400).json({
        code: ErrorCode.E_ORDER_ALREADY_PAID,
        message: 'E_ORDER_ALREADY_PAID',
        data: null,
      })
    }

    // ---- 2b. 已取消订单幂等返回 ----
    if (notionOrder.status === '已取消') {
      return res.status(200).json({
        code: 0,
        message: 'success',
        data: { outTradeNo, cancelled: true },
      })
    }

    // ---- 2c. 未支付（待发送）→ 发 n8n webhook 改状态为"已取消" ----
    await notifyN8nCancelOrder(outTradeNo)

    return res.status(200).json({
      code: 0,
      message: 'success',
      data: { outTradeNo, cancelled: true },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'E_INTERNAL'
    if (message.startsWith('E_NOTION_FAIL')) {
      return res.status(500).json({
        code: ErrorCode.E_INTERNAL,
        message: 'E_INTERNAL',
        data: null,
      })
    }
    console.error('[cancel-order] internal error', err)
    return res.status(500).json({
      code: ErrorCode.E_INTERNAL,
      message: 'E_INTERNAL',
      data: null,
    })
  }
}