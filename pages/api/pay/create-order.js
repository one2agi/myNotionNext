import type { NextApiRequest, NextApiResponse } from 'next'
import { createNativeOrder } from '@/lib/wechatpay'
import { products } from '@/products.config'

/**
 * POST /api/pay/create-order
 *
 * MVP 写死：始终用 products[0]（即 1 分钱测试商品）。
 * 后续要支持多 SKU 时，从 req.body.productId 查 products 数组即可。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const product = products[0]
    if (!product) {
      return res.status(500).json({ error: 'No product configured' })
    }

    // 商户订单号：时间戳 + 6 位随机串，避免重复
    const outTradeNo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // MVP 不接回调，notify_url 用占位值。后续接入 notify 时换成真实公网 URL。
    const notifyUrl = process.env.WECHAT_NOTIFY_URL || 'https://example.com/api/pay/notify'

    const { codeUrl } = await createNativeOrder({
      outTradeNo,
      description: product.name,
      totalFen: product.price,
      notifyUrl
    })

    return res.status(200).json({
      outTradeNo,
      codeUrl,
      productId: product.id,
      productName: product.name,
      totalFen: product.price
    })
  } catch (e: any) {
    console.error('[pay/create-order]', e)
    return res.status(500).json({ error: e?.message || 'Internal Server Error' })
  }
}
