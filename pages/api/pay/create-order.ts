/**
 * POST /api/pay/create-order
 *
 * 用途：创建订单，返回微信支付二维码
 *
 * 处理流程：
 * 1. 参数校验（name、email、discountCode 格式）
 * 2. 若有 discountCode → 查询 Notion 优惠码 DB，验启用状态，计算 finalPrice
 * 3. 生成 outTradeNo，记录 order-store
 * 4. POST ZPay 下单
 * 5. POST n8n /webhook/create-order
 * 6. 返回 qrcode
 *
 * 错误码（遵循 PAYMENT-API-SPEC.md）：
 * - E_NAME_EMPTY (40001)
 * - E_NAME_TOO_LONG (40002)
 * - E_EMAIL_INVALID (40003)
 * - E_DC_NOT_FOUND (40004)
 * - E_DC_DISABLED (40005)
 * - E_DC_AMOUNT_INVALID (40006)
 * - E_DC_FORMAT_INVALID (40007)
 * - E_PRODUCT_NOT_FOUND (40008)
 * - E_ZPAY_FAIL (40009)
 * - E_NOTION_FAIL (40010)
 * - E_INTERNAL (50001)
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import * as crypto from 'crypto'
import { orderStore } from '@/lib/order-store'
import { calculateDiscount, isValidDiscountCodeFormat } from '@/lib/discount-codes'

// ============= 商品配置（内联） =============
const PRODUCTS: Record<string, { name: string; price: number }> = {
  'starter-full': { name: '基础版', price: 79 },
  'pro-full':     { name: '专业版', price: 299 },
}

// ============= Z-Pay 签名 =============
/**
 * 生成 ZPay 签名（MD5，参数 ASCII 排序，排除空值/sign/sign_type）
 * @param params 参数字典（不含 sign）
 * @param key ZPAY_KEY
 */
function signZPay(params: Record<string, string>, key: string): string {
  const filtered = Object.entries(params)
    .filter(([k, v]) => v !== undefined && v !== '' && k !== 'sign' && k !== 'sign_type')
    .sort(([a], [b]) => a.localeCompare(b))

  const prestr = filtered.map(([k, v]) => `${k}=${v}`).join('&')
  return crypto.createHash('md5').update(prestr + key, 'utf8').digest('hex')
}

// ============= 响应格式 =============
interface SuccessData {
  outTradeNo: string
  qrcode: string
  imgUrl?: string
  productId: string
  productName: string
  totalPrice: number
  discountAmount: number
  finalPrice: number
  unit: string
}

interface ApiResponse {
  code: number
  message: string
  data: SuccessData | null
}

// ============= 邮件正则（简化版 RFC5322） =============
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ============= 主处理函数 =============
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 40501, message: 'method not allowed', data: null })
  }

  try {
    // ---- 1. 解析参数 ----
    const { productId, customer, discountCode } = req.body as {
      productId?: string
      customer?: { name?: string; email?: string }
      discountCode?: string
    }

    const name  = customer?.name?.trim() ?? ''
    const email = customer?.email?.trim() ?? ''

    // ---- 2. name 校验 ----
    if (!name) {
      return res.status(400).json({ code: 40001, message: 'E_NAME_EMPTY', data: null })
    }
    if (name.length > 50) {
      return res.status(400).json({ code: 40002, message: 'E_NAME_TOO_LONG', data: null })
    }

    // ---- 3. email 校验 ----
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ code: 40003, message: 'E_EMAIL_INVALID', data: null })
    }

    // ---- 4. productId 校验 ----
    const product = PRODUCTS[productId ?? '']
    if (!product) {
      return res.status(400).json({ code: 40008, message: 'E_PRODUCT_NOT_FOUND', data: null })
    }

    const totalPrice = product.price
    let discountAmount = 0
    let finalPrice = totalPrice

    // ---- 5. 优惠码处理（可选） ----
    if (discountCode && discountCode.trim()) {
      const trimmedCode = discountCode.trim().toUpperCase()
      const disc = await calculateDiscount(totalPrice, trimmedCode)
      discountAmount = disc.discountAmount
      finalPrice = disc.finalPrice
    }

    // ---- 6. 生成 outTradeNo ----
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).slice(2, 8)
    const outTradeNo = `${timestamp}-${randomStr}`

    // ---- 7. 记录 order-store ----
    const storeRecord: Parameters<typeof orderStore.set>[1] = {
      productId: productId as string,
      productName: product.name,
      customerName: name,
      customerEmail: email,
      totalPrice,
      finalPrice,
    }
    if (discountCode) {
      storeRecord.discountCode = discountCode.trim()
    }
    if (discountAmount > 0) {
      storeRecord.discountAmount = discountAmount
    }
    orderStore.set(outTradeNo, storeRecord)

    // ---- 8. ZPay 下单 ----
    const pid = process.env.ZPAY_PID
    const zpayKey = process.env.ZPAY_KEY
    const notifyUrl = process.env.ZPAY_NOTIFY_URL

    if (!pid || !zpayKey || !notifyUrl) {
      return res.status(500).json({ code: 50001, message: 'E_INTERNAL', data: null })
    }

    const zpayParams: Record<string, string> = {
      pid: pid,
      out_trade_no: outTradeNo,
      money: finalPrice.toFixed(2),
      name: encodeURIComponent(product.name),
      notify_url: notifyUrl,
      return_url: 'https://www.one2agi.com',
      sitename: 'one2agi',
      type: 'wxpay',
    }
    zpayParams.sign = signZPay(zpayParams, zpayKey)

    const zpayUrl = 'https://z-pay.cn/submit.php'
    const zpayForm = new URLSearchParams(
      Object.entries(zpayParams).map(([k, v]) => [k, v])
    ).toString()

    // ZPay 返回 HTML（直接重定向到二维码页面），提取 qrcode 从 Location header
    const zpayResponse = await fetch(`${zpayUrl}?${zpayForm}`, {
      method: 'POST',
      redirect: 'manual',
    })

    let qrcode = ''
    let imgUrl = ''

    // ZPay 可能通过 302 + Location 返回二维码链接；或从 HTML body 提取
    const locationHeader = zpayResponse.headers.get('location')
    if (locationHeader) {
      qrcode = locationHeader
    } else {
      // 从响应 body 尝试提取 qrcode URL（备选方案）
      const bodyText = await zpayResponse.text()
      const qrMatch = bodyText.match(/(weixin:\/\/wxpay\/[^\s"']+)/)
      if (qrMatch && qrMatch[1]) {
        qrcode = qrMatch[1]
      }
    }

    if (!qrcode) {
      return res.status(500).json({ code: 40009, message: 'E_ZPAY_FAIL', data: null })
    }

    // ---- 9. 发 n8n webhook（失败不影响主流程） ----
    const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL
    const n8nSecret = process.env.N8N_WEBHOOK_SECRET

    if (n8nWebhookUrl && n8nSecret) {
      fetch(`${n8nWebhookUrl}/create-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-n8n-secret': n8nSecret,
        },
        body: JSON.stringify({
          outTradeNo,
          productId: productId as string,
          productName: product.name,
          customerName: name,
          customerEmail: email,
          totalPrice,
          discountCode: discountCode?.trim() || '',
          discountAmount,
          finalPrice,
          unit: '元',
          createdAt: new Date().toISOString().slice(0, 10),
        }),
      }).catch(() => {
        // n8n webhook 失败不影响主流程，忽略
      })
    }

    // ---- 10. 返回 qrcode ----
    return res.status(200).json({
      code: 0,
      message: 'success',
      data: {
        outTradeNo,
        qrcode,
        imgUrl,
        productId: productId as string,
        productName: product.name,
        totalPrice,
        discountAmount,
        finalPrice,
        unit: '元',
      },
    })
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : 'E_INTERNAL'

    // 已知业务错误码直接透出
    if (code && /^E_/.test(code)) {
      const codeMap: Record<string, number> = {
        E_DC_NOT_FOUND:      40004,
        E_DC_DISABLED:      40005,
        E_DC_AMOUNT_INVALID: 40006,
        E_DC_FORMAT_INVALID: 40007,
        E_NOTION_FAIL:       40010,
        E_ORDER_NOT_FOUND:   40011,
      }
      return res.status(400).json({ code: codeMap[code] ?? 40099, message: code, data: null })
    }

    console.error('[create-order] internal error', err)
    return res.status(500).json({ code: 50001, message: 'E_INTERNAL', data: null })
  }
}