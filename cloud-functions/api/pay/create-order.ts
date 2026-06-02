/**
 * EdgeOne Pages Cloud Functions（Node 20 runtime）
 *
 * 路径映射：cloud-functions/api/pay/create-order.ts → POST /api/pay/create-order
 * 前端 fetch('/api/pay/create-order', { method: 'POST' }) 不变
 *
 * env 读取：context.env.WECHAT_*（不是 process.env）
 * 入参：context.request.json()
 * 响应：new Response(JSON.stringify(...), { status, headers })
 *
 * 业务流程：
 *   1. 读 productId
 *   2. 校验 6 个 WECHAT_* env
 *   3. 查 products.config.js 找商品
 *   4. 调 lib/wechatpay.js 的 createNativeOrder（注入 env）
 *   5. 返回 codeUrl 等
 */

interface EventContext {
  request: Request
  env: Record<string, string>
  params: Record<string, string>
}

interface WxPayEnv {
  WECHAT_APPID: string
  WECHAT_MCHID: string
  WECHAT_SERIAL_NO: string
  WECHAT_NOTIFY_URL: string
  WECHAT_API_V3_KEY: string
  WECHAT_PRIVATE_KEY: string
}

interface Product {
  id: string
  name: string
  description?: string
  price: number
  currency: string
}

function pickEnv(env: Record<string, string>): WxPayEnv {
  return {
    WECHAT_APPID: env.WECHAT_APPID,
    WECHAT_MCHID: env.WECHAT_MCHID,
    WECHAT_SERIAL_NO: env.WECHAT_SERIAL_NO,
    WECHAT_NOTIFY_URL: env.WECHAT_NOTIFY_URL,
    WECHAT_API_V3_KEY: env.WECHAT_API_V3_KEY,
    WECHAT_PRIVATE_KEY: env.WECHAT_PRIVATE_KEY
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' }
  })
}

export async function onRequestPost(context: EventContext): Promise<Response> {
  try {
    // 1. 入参
    const body = (await context.request.json().catch(() => ({}))) as {
      productId?: string
    }
    const { productId } = body

    // 2. env 校验
    const env = pickEnv(context.env)
    const missing = (Object.entries(env) as [string, string | undefined][])
      .filter(([_, v]) => !v)
      .map(([k]) => k)
    if (missing.length) {
      return jsonResponse(
        {
          error: `Missing EdgeOne env: ${missing.join(', ')}. 请去 console.cloud.tencent.com/edgeone → Pages → one2agi → 项目设置 → 环境变量 配置。`
        },
        500
      )
    }

    // 3. 查商品（动态 import 避免 ESM 解析 @/）
    const productsModule = await import('../../../products.config.js')
    const products: Product[] = productsModule.products
    const product = products.find(p => p.id === productId)
    if (!product) {
      return jsonResponse({ error: `Unknown productId: ${productId}` }, 400)
    }
    if (product.price === 0 || !Number.isInteger(product.price) || product.price < 1) {
      return jsonResponse(
        { error: `Product ${product.id} has no payable price` },
        400
      )
    }

    // 4. 创建订单
    const outTradeNo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const wechatpayModule = await import('../../../lib/wechatpay.js')
    const { codeUrl } = await wechatpayModule.createNativeOrder({
      outTradeNo,
      description: product.name,
      totalFen: product.price,
      notifyUrl: env.WECHAT_NOTIFY_URL,
      env
    })

    // 5. 返回
    return jsonResponse({
      outTradeNo,
      codeUrl,
      productId: product.id,
      productName: product.name,
      totalFen: product.price,
      currency: product.currency
    })
  } catch (e: any) {
    console.error('[pay/create-order]', e)
    return jsonResponse(
      { error: e?.message || 'Internal Server Error' },
      500
    )
  }
}
