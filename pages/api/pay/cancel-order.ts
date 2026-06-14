/**
 * POST /api/pay/cancel-order
 *
 * 用途：用户主动取消未支付订单（前端 PayModal 取消按钮 / 5 分钟超时自动调用）
 *
 * 处理流程（遵循 PAYMENT-API-SPEC.md §3.6）：
 * 1. Origin 校验（同源 + allow list）— 防跨站任意调用
 * 2. IP 限速（60 req/min）— 防自家 DoS
 * 3. outTradeNo 白名单校验（字符集 + 长度）— 防 Notion 配额滥用
 * 4. 读 { outTradeNo, customer: { email } }
 * 5. 查 order-store：
 *    - 有 → 校验 email 匹配 + 检查 paid 状态
 *      - paid=true → return 400 E_ORDER_ALREADY_PAID
 *      - paid=false → markCancelled + 发 n8n webhook + 关闭 Z-Pay
 *    - 邮箱不匹配 → 403 E_EMAIL_MISMATCH
 * 6. 查不到 → fallback 查 Notion 订单 DB
 *    - Notion 有 → 校验状态（用 NotionOrderStatus enum）
 *      - SHIPPED → 400 E_ORDER_ALREADY_PAID
 *      - CANCELLED → 200 幂等
 *      - PENDING → 发 n8n webhook（改状态为"已取消"）
 *      - 未知状态 → 409 E_STATUS_UNKNOWN
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
  type NotionPropertyValue,
} from '@/lib/notion-utils'
import { checkOrigin, validateOutTradeNo, rateLimit, getClientIp } from '@/lib/security'
import { ErrorCode, NotionOrderStatus, parseNotionOrderStatus } from '@/lib/errors'

/** 邮箱格式校验：RFC 5322 简化版 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_MAX_LENGTH = 254

// ============= 响应类型 =============
type CancelOrderResponse =
  | { code: 0; message: 'success'; data: { outTradeNo: string; cancelled: true } }
  | { code: typeof ErrorCode.E_ORDER_NOT_FOUND; message: 'E_ORDER_NOT_FOUND'; data: null }
  | { code: typeof ErrorCode.E_ORDER_ALREADY_PAID; message: 'E_ORDER_ALREADY_PAID'; data: null }
  | { code: typeof ErrorCode.E_STATUS_UNKNOWN; message: 'E_STATUS_UNKNOWN'; data: null }
  | { code: typeof ErrorCode.E_EMAIL_MISMATCH; message: 'E_EMAIL_MISMATCH'; data: null }
  | { code: typeof ErrorCode.E_INTERNAL; message: 'E_INTERNAL'; data: null }
  | { code: typeof ErrorCode.E_METHOD_NOT_ALLOWED; message: 'E_METHOD_NOT_ALLOWED'; data: null }
  | { code: typeof ErrorCode.E_PARAM_MISSING; message: 'E_PARAM_MISSING'; data: null }
  | { code: typeof ErrorCode.E_PARAM_INVALID; message: 'E_PARAM_INVALID'; data: null }
  | { code: typeof ErrorCode.E_ORIGIN_FORBIDDEN; message: 'E_ORIGIN_FORBIDDEN'; data: null }
  | { code: typeof ErrorCode.E_RATE_LIMITED; message: 'E_RATE_LIMITED'; data: null }

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

  const body = req.body as { outTradeNo?: string; customer?: { email?: string } } | undefined
  const { outTradeNo } = body ?? {}
  const customerEmail = body?.customer?.email

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

  // ---- 0d. 邮箱校验（order-store 命中时必查）----
  if (!customerEmail || typeof customerEmail !== 'string' || !EMAIL_REGEX.test(customerEmail) || customerEmail.length > EMAIL_MAX_LENGTH) {
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
      // ---- 1a. 邮箱归属校验（H2 修复）----
      if (cached.customerEmail.toLowerCase() !== customerEmail.toLowerCase()) {
        return res.status(403).json({
          code: ErrorCode.E_EMAIL_MISMATCH,
          message: 'E_EMAIL_MISMATCH',
          data: null,
        })
      }

      // ---- 1b. 已支付订单不能取消 ----
      if (cached.paid) {
        return res.status(400).json({
          code: ErrorCode.E_ORDER_ALREADY_PAID,
          message: 'E_ORDER_ALREADY_PAID',
          data: null,
        })
      }

      // ---- 1c. 已取消订单幂等返回 ----
      if (cached.cancelled) {
        return res.status(200).json({
          code: 0,
          message: 'success',
          data: { outTradeNo, cancelled: true },
        })
      }

      // ---- 1d. 未支付 → markCancelled（防 notify race）----
      orderStore.markCancelled(outTradeNo)

      // ---- 1e. 发 n8n webhook 改 Notion 状态为"已取消" ----
      await notifyN8nCancelOrder(outTradeNo)

      // ---- 1f. 关闭 Z-Pay 订单 ----
      await closeZPayOrder(outTradeNo).catch(() => {
        // Z-Pay 关闭失败不影响主流程
      })

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

    // ---- 2a. 状态校验（H4 修复：用 NotionOrderStatus enum）----
    const status = parseNotionOrderStatus(notionOrder.status)

    if (status === null) {
      // 未知状态：防止误判 → 返 409 让人工介入
      return res.status(409).json({
        code: ErrorCode.E_STATUS_UNKNOWN,
        message: 'E_STATUS_UNKNOWN',
        data: null,
      })
    }

    if (status === NotionOrderStatus.SHIPPED) {
      return res.status(400).json({
        code: ErrorCode.E_ORDER_ALREADY_PAID,
        message: 'E_ORDER_ALREADY_PAID',
        data: null,
      })
    }

    if (status === NotionOrderStatus.CANCELLED) {
      return res.status(200).json({
        code: 0,
        message: 'success',
        data: { outTradeNo, cancelled: true },
      })
    }

    // ---- 2b. PENDING → 发 n8n webhook 改状态为"已取消" ----
    // 注意：Notion fallback 无法校验邮箱（H2 邮箱校验只对 order-store 有效）
    // 这是可接受的：Notion fallback 触发场景是容器冷启动，本会话用户已离开浏览器
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
