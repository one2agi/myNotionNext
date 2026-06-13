/**
 * EdgeOne Pages Cloud Function (Node 20) · Z-Pay Native 下单
 * 路径: cloud-functions/api/pay/create-order.ts → POST /api/pay/create-order
 * Env（3 个，全走 context.env，ZPAY_KEY **绝不**进 git）: ZPAY_PID / ZPAY_KEY / ZPAY_NOTIFY_URL
 * 流程: 入参 → env 校验 → 客户校验 → 查商品 → 拒 free → 折扣二次校验 → 调 lib/zpay.createNativeOrder（金额 分→元）→ 返 7 字段（含 discountApplied?）
 * H-4 扩展 (2026-06-11): 客户必填校验 + 优惠码服务端二次校验 + discountApplied 返参
 */
interface EventContext {
  request: Request
  env: Record<string, string>
  params: Record<string, string>
}

const REQUIRED_ENV = ['ZPAY_PID', 'ZPAY_KEY', 'ZPAY_NOTIFY_URL'] as const

// 基础邮箱校验 (RFC5322 简化版, 服务端兜底; 客户端 blur 时也会校验)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' }
  })
}

export async function onRequestPost(context: EventContext): Promise<Response> {
  try {
    const body = (await context.request.json().catch(() => ({}))) as {
      productId?: string
      customer?: { name?: string; email?: string }
      discountCode?: string
    }
    const { productId, customer, discountCode } = body
    const env = context.env
    const missing = REQUIRED_ENV.filter(k => !env[k])
    if (missing.length) {
      return jsonResponse({ error: `Missing env: ${missing.join(', ')}` }, 500)
    }

    // 客户必填校验 (H-4): name 非空 (trim 后), email 符合基础邮箱格式
    if (!customer || !customer.name || !customer.name.trim()) {
      return jsonResponse({ code: 'E_NAME_EMPTY' }, 400)
    }
    if (customer.name.trim().length > 50) {
      return jsonResponse({ code: 'E_NAME_TOO_LONG' }, 400)
    }
    if (!customer.email || !EMAIL_RE.test(customer.email.trim()) || customer.email.length > 254) {
      return jsonResponse({ code: 'E_EMAIL_INVALID' }, 400)
    }

    // 动态 import 避免 ESM 解析 @/
    const productsModule = await import('../../../products.config.js')
    const product = productsModule.products.find((p: any) => p.id === productId)
    if (!product) {
      return jsonResponse({ error: `Unknown productId: ${productId}` }, 400)
    }
    if (!Number.isInteger(product.price) || product.price < 1) {
      return jsonResponse(
        { error: `Product ${product.id} is free/unpaid` },
        400
      )
    }

    // 折扣二次校验 (H-4): 服务端硬阻止未匹配/disabled 优惠码 (decision 10)
    let discountApplied:
      | { code: string; partnerName: string; discountPct: number; originalFen: number }
      | undefined
    let finalPriceFen = product.price
    if (discountCode) {
      const { lookupDiscount, DiscountNotFoundError, DiscountDisabledError } =
        await import('../../../lib/discount-codes')
      try {
        const entry = lookupDiscount(discountCode)
        const originalFen = product.price
        if (entry.discountPct && entry.discountPct > 0) {
          finalPriceFen = Math.round((product.price * (100 - entry.discountPct)) / 100)
        } else if (entry.fixedOffFen && entry.fixedOffFen > 0) {
          finalPriceFen = Math.max(0, product.price - entry.fixedOffFen)
        }
        discountApplied = {
          code: discountCode,
          partnerName: entry.partnerName,
          discountPct: entry.discountPct ?? 0,
          originalFen,
        }
      } catch (e: any) {
        if (e?.code === 'E_DC_DISABLED' || e instanceof DiscountDisabledError) {
          return jsonResponse({ code: 'E_DC_DISABLED' }, 400)
        }
        if (e?.code === 'E_DC_NOT_FOUND' || e instanceof DiscountNotFoundError) {
          return jsonResponse({ code: 'E_DC_NOT_FOUND' }, 400)
        }
        throw e
      }
    }

    const outTradeNo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // 关键落单：notify.ts 的 markPaid 内部要 store.get(outTradeNo) 命中已存在记录
    // 才能做金额比对；不调 recordOrder → notify 100% 报 amount mismatch。
    // recordOrder 是同步函数，直接调（不 await）。
    // H-4: 折扣后金额 finalPriceFen 落单, notify 端金额校验按折扣后价比对
    // H-5: 存 customerInfo 让 notify.ts 能读 name/email/discountCode/partnerName 调 Workers
    const { recordOrder } = await import('../../../lib/order-store.js')
    recordOrder(outTradeNo, finalPriceFen, {
      name: customer.name.trim(),
      email: customer.email.trim(),
      discountCode: discountCode ?? undefined,
      partnerName: discountApplied?.partnerName,
      productName: product.name,
    })
    const { createNativeOrder } = await import('../../../lib/zpay.js')
    const customerName = customer.name.trim()
    const { qrcode, imgUrl } = await createNativeOrder({
      outTradeNo,
      name: `${product.name}-${customerName.slice(0, 20)}`.slice(0, 127),
      money: (finalPriceFen / 100).toFixed(2),
      notifyUrl: env.ZPAY_NOTIFY_URL!,
      env
    } as any)

    // 立即调 Notion API 创建 page（状态="待发送"）—— 客户信息永不丢失
    // 失败仅 console.warn，不阻塞响应（n8n 兜底 CREATE）
    try {
      const { createOrderPage } = await import('../../../lib/notion.js')
      const notionResult = await createOrderPage({
        outTradeNo,
        name: customerName,
        email: customer.email.trim(),
        productName: product.name,
        totalFen: finalPriceFen,
        env: env as any,
      })
      console.log(`[create-order] Notion page created: ${notionResult.pageId} for ${outTradeNo}`)
    } catch (e: any) {
      console.warn(`[create-order] Notion write failed for ${outTradeNo} (n8n will 兜底): ${e?.message}`)
    }

    return jsonResponse({
      outTradeNo,
      qrcode,
      imgUrl,
      productId: product.id,
      productName: product.name,
      totalFen: finalPriceFen,
      discountApplied
    })
  } catch (e: any) {
    console.error('[pay/create-order]', e)
    return jsonResponse(
      { error: e?.message || 'Internal Server Error' },
      500
    )
  }
}
