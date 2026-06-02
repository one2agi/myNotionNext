/**
 * EdgeOne Pages Cloud Functions（Node 20 runtime）
 *
 * 路径映射：cloud-functions/api/pay/create-order.ts → POST /api/pay/create-order
 * 前端 fetch('/api/pay/create-order', { method: 'POST' }) 不变
 *
 * Env 读取：
 *   - context.env.WECHAT_APPID / MCHID / SERIAL_NO / NOTIFY_URL / API_V3_KEY（普通 env）
 *   - 私钥从 EdgeOne Blob Storage 拿：getStore('wxpay-secrets').get('apiclient_key.pem', { type: 'text' })
 *   - Blob 鉴权**全自动**（deploy credentials），**无需** env var / binding
 *
 * 为什么私钥放 Blob 不放 env：
 *   - EdgeOne Pages Cloud Functions env 单值上限约 1000 字符，1680 字符 PEM 装不下
 *   - Blob 单 value 上限 25 MB，私钥 / 证书类配置天然归属
 *   - 改私钥不需 redeploy
 *
 * 为什么不用 KV Storage：
 *   - EdgeOne KV **只支持 Edge Functions**（V8 isolate），不支持 Cloud Functions (Node.js)
 *   - 官方文档原话："Currently, it is only supported for use within Edge Functions"
 *
 * 业务流程：
 *   1. 读 productId
 *   2. 校验 6 个 WECHAT_* env（PRIVATE_KEY 来自 Blob）
 *   3. 校验 PEM 格式（PKCS#8, startsWith "-----BEGIN PRIVATE KEY-----")
 *   4. 查 products.config.js 找商品
 *   5. 调 lib/wechatpay.js 的 createNativeOrder（注入 env）
 *   6. 返回 codeUrl 等
 *
 * 缓存：模块级缓存 WxPayEnv 60s，空值不缓存（防止冷启动把空值冻住）
 */
import { getStore } from '@edgeone/pages-blob'

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

const BUCKET_NAME = 'wxpay-secrets'
const BLOB_KEY = 'apiclient_key.pem'
const CACHE_TTL_MS = 60_000

/** 模块级缓存：避免每请求都打 Blob */
let cachedEnv: WxPayEnv | null = null
let cachedAt = 0
/** 上次 Blob 错误信息，用于诊断返回 */
let lastBlobError: string | null = null

/** 从 context.env + Blob Storage 拼出完整 WxPayEnv */
async function loadWxPayEnv(rawEnv: Record<string, any>): Promise<WxPayEnv> {
  // 从 Blob 拿私钥
  let privateKey = ''
  try {
    const store = getStore(BUCKET_NAME)
    const got = await store.get(BLOB_KEY, { type: 'text' })
    privateKey = typeof got === 'string' ? got : ''
    lastBlobError = null
  } catch (e: any) {
    lastBlobError = String(e?.message || e)
    console.error('[pay/create-order] Blob get failed:', e)
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

/** 带 TTL 的缓存读取 — 但**空值不缓存**（防止冷启动/绑定延迟把空值冻住） */
async function getEnvWithCache(rawEnv: Record<string, any>): Promise<WxPayEnv> {
  const now = Date.now()
  if (cachedEnv && now - cachedAt < CACHE_TTL_MS) return cachedEnv
  const fresh = await loadWxPayEnv(rawEnv)
  // 只在所有必填字段都有值时才缓存
  const allFilled = Object.values(fresh).every(v => typeof v === 'string' && v.length > 0)
  if (allFilled) {
    cachedEnv = fresh
    cachedAt = now
  } else {
    // 至少一个字段空，**不缓存**，下次重试
    cachedEnv = null
    cachedAt = 0
  }
  return fresh
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

    // 2. env 校验（含 Blob 私钥）
    const env = await getEnvWithCache(context.env as any)
    const missing = (Object.entries(env) as [string, string | undefined][])
      .filter(([_, v]) => !v)
      .map(([k]) => k)
    if (missing.length) {
      return jsonResponse(
        {
          error:
            `Missing WECHAT_* env: ${missing.join(', ')}. ` +
            `检查：1) 控制台 5 个非敏感 WECHAT_* env 是否齐；2) Blob bucket ${BUCKET_NAME} 是否已创建；3) 对象 ${BLOB_KEY} 是否已上传 PEM 内容。`,
          blobDiag: {
            bucket: BUCKET_NAME,
            objectKey: BLOB_KEY,
            lastBlobError,
            cachedEnvPresent: !!cachedEnv,
            cachedAgeMs: cachedAt ? Date.now() - cachedAt : null
          }
        },
        500
      )
    }

    // 2.5 PEM 格式快速校验（只暴露 length + first/last 几个字符，不泄漏 key）
    const pem = env.WECHAT_PRIVATE_KEY
    if (!pem.includes('PRIVATE KEY')) {
      return jsonResponse(
        {
          error: 'Blob 里的值不含 "PRIVATE KEY" 字符串。是不是上传错了文件（证书 / 公钥 / 其他格式）？',
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
          error: 'Blob 里的私钥 header 不是 "-----BEGIN PRIVATE KEY-----"。微信支付 V3 要求 PKCS#8 格式（不带 RSA/EC 前缀）。',
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
