import type { NextApiRequest, NextApiResponse } from 'next'
import { createNativeOrder } from '@/lib/wechatpay'
import { products } from '@/products.config'
import wechatpayConfig from '@/wechatpay.config'

/**
 * POST /api/pay/create-order（Next.js Pages Router 风格）
 *
 * ⚠️ **dead code**：yarn export 静态模式下不打包。本文件保留只为：
 *   1. 兼容未来切回 yarn build（动态）
 *   2. 方便本地 dev 调试
 *
 * 当前生产路径走的是 `cloud-functions/api/pay/create-order.ts`（Cloud Functions 风格）。
 */

/** 从 process.env 拼出 lib/wechatpay.js 需要的 env 对象 */
function readWxPayEnv() {
  return {
    WECHAT_APPID: process.env.WECHAT_APPID || wechatpayConfig.WECHAT_APPID,
    WECHAT_MCHID: process.env.WECHAT_MCHID || wechatpayConfig.WECHAT_MCHID,
    WECHAT_SERIAL_NO:
      process.env.WECHAT_SERIAL_NO || wechatpayConfig.WECHAT_SERIAL_NO,
    WECHAT_NOTIFY_URL:
      process.env.WECHAT_NOTIFY_URL || wechatpayConfig.WECHAT_NOTIFY_URL,
    WECHAT_API_V3_KEY:
      process.env.WECHAT_API_V3_KEY || wechatpayConfig.WECHAT_API_V3_KEY,
    WECHAT_PRIVATE_KEY: process.env.WECHAT_PRIVATE_KEY || '',
    WECHAT_PRIVATE_KEY_PATH: process.env.WECHAT_PRIVATE_KEY_PATH || ''
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { productId } = req.body || {}
    const product = products.find(p => p.id === productId)

    if (!product) {
      return res.status(400).json({ error: `Unknown productId: ${productId}` })
    }
    if (product.price === 0 || !Number.isInteger(product.price) || product.price < 1) {
      return res
        .status(400)
        .json({ error: `Product ${product.id} has no payable price` })
    }

    // 商户订单号：时间戳 + 6 位随机串，避免重复
    const outTradeNo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // env 注入
    const env = readWxPayEnv()
    const notifyUrl = env.WECHAT_NOTIFY_URL

    const { codeUrl } = await createNativeOrder({
      outTradeNo,
      description: product.name,
      totalFen: product.price,
      notifyUrl,
      env
    })

    return res.status(200).json({
      outTradeNo,
      codeUrl,
      productId: product.id,
      productName: product.name,
      totalFen: product.price,
      currency: product.currency
    })
  } catch (e: any) {
    console.error('[pay/create-order]', e)
    return res.status(500).json({ error: e?.message || 'Internal Server Error' })
  }
}
