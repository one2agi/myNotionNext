/**
 * EdgeOne Pages Cloud Functions (Node 20) · Z-Pay Native 下单
 * 路径: cloud-functions/api/pay/create-order.ts → POST /api/pay/create-order
 * Env（3 个，全走 context.env，ZPAY_KEY **绝不**进 git）: ZPAY_PID / ZPAY_KEY / ZPAY_NOTIFY_URL
 * 流程: 入参 → env 校验 → 查商品 → 拒 free → 调 lib/zpay.createNativeOrder（金额 分→元）→ 返 6 字段
 */
interface EventContext {
  request: Request
  env: Record<string, string>
  params: Record<string, string>
}

const REQUIRED_ENV = ['ZPAY_PID', 'ZPAY_KEY', 'ZPAY_NOTIFY_URL'] as const

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' }
  })
}

export async function onRequestPost(context: EventContext): Promise<Response> {
  try {
    const { productId } = (await context.request.json().catch(() => ({}))) as {
      productId?: string
    }
    const env = context.env
    const missing = REQUIRED_ENV.filter(k => !env[k])
    if (missing.length) {
      return jsonResponse({ error: `Missing env: ${missing.join(', ')}` }, 500)
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
    const outTradeNo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // 关键落单：notify.ts 的 markPaid 内部要 store.get(outTradeNo) 命中已存在记录
    // 才能做金额比对；不调 recordOrder → notify 100% 报 amount mismatch。
    // recordOrder 是同步函数，直接调（不 await）。
    const { recordOrder } = await import('../../../lib/order-store.js')
    recordOrder(outTradeNo, product.price)
    const { createNativeOrder } = await import('../../../lib/zpay.js')
    const { qrcode, imgUrl } = await createNativeOrder({
      outTradeNo,
      name: product.name.slice(0, 127),
      money: (product.price / 100).toFixed(2),
      notifyUrl: env.ZPAY_NOTIFY_URL!,
      env
    } as any)
    return jsonResponse({
      outTradeNo,
      qrcode,
      imgUrl,
      productId: product.id,
      productName: product.name,
      totalFen: product.price
    })
  } catch (e: any) {
    console.error('[pay/create-order]', e)
    return jsonResponse(
      { error: e?.message || 'Internal Server Error' },
      500
    )
  }
}
