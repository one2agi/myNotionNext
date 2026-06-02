/**
 * EdgeOne Pages Cloud Functions（Node 20 runtime）
 *
 * 路径映射：cloud-functions/api/pay/create-order.ts → POST /api/pay/create-order
 * 前端 fetch('/api/pay/create-order', { method: 'POST' }) 不变
 *
 * Env 读取：
 *   - context.env.WECHAT_APPID / MCHID / SERIAL_NO / NOTIFY_URL / API_V3_KEY（普通 env）
 *   - context.env.WECHAT_KV（EdgeOne KV namespace binding，专用存储）
 *   - 从 KV 拿私钥：await WECHAT_KV.get('wechatpay_private_key', { type: 'text' })
 *
 * 为什么私钥放 KV 不放 env：
 *   - EdgeOne Pages Cloud Functions env 单值上限约 1000 字符，1680 字符 PEM 装不下
 *   - KV 单 value 上限 25 MB，私钥 / 证书类配置天然归属
 *   - 改私钥不需 redeploy
 *
 * 业务流程：
 *   1. 读 productId
 *   2. 校验 6 个 WECHAT_* env（其中 PRIVATE_KEY 来自 KV）
 *   3. 查 products.config.js 找商品
 *   4. 调 lib/wechatpay.js 的 createNativeOrder（注入 env）
 *   5. 返回 codeUrl 等
 *
 * 缓存：模块级缓存 WxPayEnv 60s，避免每请求打 KV（KV 走边缘节点缓存，也很快）
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

/** EdgeOne KV Storage binding 的运行时形态（简化版） */
interface EdgeOneKV {
  get(key: string, opts?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }): Promise<any>
  put(key: string, value: any): Promise<void>
}

const KV_VAR_NAME = 'WECHAT_KV'
const PEM_KEY = 'wechatpay_private_key'
const CACHE_TTL_MS = 60_000

/** 模块级缓存：避免每请求都打 KV */
let cachedEnv: WxPayEnv | null = null
let cachedAt = 0

/** 从 context.env + KV namespace 拼出完整 WxPayEnv */
async function loadWxPayEnv(rawEnv: Record<string, any>): Promise<WxPayEnv> {
  // 从 KV 拿私钥
  const kv = rawEnv[KV_VAR_NAME] as EdgeOneKV | undefined
  let privateKey = ''
  if (kv && typeof kv.get === 'function') {
    try {
      const got = await kv.get(PEM_KEY, { type: 'text' })
      privateKey = typeof got === 'string' ? got : ''
    } catch (e) {
      console.error('[pay/create-order] KV get failed:', e)
    }
  }

  return {
    WECHAT_APPID: rawEnv.WECHAT_APPID || '',
    WECHAT_MCHID: rawEnv.WECHAT_MCHID || '',
    WECHAT_SERIAL_NO: rawEnv.WECHAT_SERIAL_NO || '',
    WECHAT_NOTIFY_URL: rawEnv.WECHAT_NOTIFY_URL || '',
    WECHAT_API_V3_KEY: rawEnv.WECHAT_API_V3_KEY || '',
    WECHAT_PRIVATE_KEY: privateKey
  }
}

/** 带 TTL 的缓存读取 */
async function getEnvWithCache(rawEnv: Record<string, any>): Promise<WxPayEnv> {
  const now = Date.now()
  if (cachedEnv && now - cachedAt < CACHE_TTL_MS) return cachedEnv
  cachedEnv = await loadWxPayEnv(rawEnv)
  cachedAt = now
  return cachedEnv
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

    // 2. env 校验（含 KV 私钥）
    const env = await getEnvWithCache(context.env as any)
    const missing = (Object.entries(env) as [string, string | undefined][])
      .filter(([_, v]) => !v)
      .map(([k]) => k)
    if (missing.length) {
      return jsonResponse(
        {
          error:
            `Missing WECHAT_* env: ${missing.join(', ')}. ` +
            `检查：1) 控制台 6 个 WECHAT_* env 是否齐；2) KV namespace 是否绑到 one2agi 项目，变量名是否填 ${KV_VAR_NAME}；3) KV key ${PEM_KEY} 是否已 put PEM。`
        },
        500
      )
    }

    // 2.5 PEM 格式快速校验（只暴露 length + first/last 几个字符，不泄漏 key）
    const pem = env.WECHAT_PRIVATE_KEY
    if (!pem.includes('PRIVATE KEY')) {
      return jsonResponse(
        {
          error: 'KV 里的值不含 "PRIVATE KEY" 字符串。是不是贴错了文件（贴成证书 / 公钥 / 其他格式）？',
          diag: {
            length: pem.length,
            first60: pem.slice(0, 60),
            last60: pem.slice(-60),
            hasNewline: pem.includes('\n'),
            lineCount: pem.split('\n').length
          }
        },
        500
      )
    }
    if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) {
      return jsonResponse(
        {
          error: 'KV 里的私钥 header 不是 "-----BEGIN PRIVATE KEY-----"。微信支付 V3 要求 PKCS#8 格式（不带 RSA/EC 前缀）。',
          diag: {
            length: pem.length,
            first60: pem.slice(0, 60),
            hasNewline: pem.includes('\n'),
            lineCount: pem.split('\n').length
          }
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
