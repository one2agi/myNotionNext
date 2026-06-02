import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/**
 * 微信支付弹窗
 *
 * 用法：
 *   <PayModal product={product} onClose={() => setProduct(null)} />
 *
 * Props:
 *   product: { id, name, price, currency } 来自 products.config.js
 *   onClose: () => void  关闭时回调（父组件清掉 product 状态）
 */
export const PayModal = ({ product, onClose }) => {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [order, setOrder] = useState(null)

  // ESC 关闭
  useEffect(() => {
    if (!product) return
    const onKey = e => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [product, onClose])

  // 切换 product 时清空上一次的订单/错误
  useEffect(() => {
    setOrder(null)
    setErr(null)
    setLoading(false)
  }, [product?.id])

  if (!product) return null

  const onPay = async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await fetch('/api/pay/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id })
      })
      const data = await r.json()
      if (!r.ok) {
        throw new Error(data.error || `HTTP ${r.status}`)
      }
      const dataUrl = await QRCode.toDataURL(data.codeUrl, { width: 240, margin: 1 })
      setOrder({ ...data, qrDataUrl: dataUrl })
    } catch (e) {
      setErr(e?.message || '创建订单失败')
    } finally {
      setLoading(false)
    }
  }

  const priceYuan = (product.price / 100).toFixed(2)

  return (
    <div
      role='dialog'
      aria-modal='true'
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4'
      onClick={onClose}>
      <div
        className='relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-dark-2'
        onClick={e => e.stopPropagation()}>
        {/* 关闭按钮 */}
        <button
          type='button'
          aria-label='关闭'
          onClick={onClose}
          className='absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200'>
          ✕
        </button>

        {/* 标题 + 价格 */}
        <h3 className='mb-1 pr-8 text-lg font-bold text-dark dark:text-white'>
          {product.name}
        </h3>
        <p className='mb-5 text-sm text-gray-500 dark:text-gray-400'>
          ¥ {priceYuan}（测试金额，正式发布后会改回真实价格）
        </p>

        {/* 状态分支：未付款 → 按钮 / 已付款 → 二维码 */}
        {!order ? (
          <button
            type='button'
            onClick={onPay}
            disabled={loading}
            className='w-full rounded-lg bg-primary px-6 py-3 font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'>
            {loading ? '创建订单中…' : '立即支付'}
          </button>
        ) : (
          <div className='flex flex-col items-center'>
            <p className='mb-3 text-sm text-gray-500 dark:text-gray-400'>
              用微信「扫一扫」扫描下方二维码
            </p>
            <img
              src={order.qrDataUrl}
              alt='wechat pay qrcode'
              className='rounded border bg-white p-2'
              width={240}
              height={240}
            />
            <div className='mt-3 w-full text-center text-xs text-gray-400'>
              <div>订单号：{order.outTradeNo}</div>
              <div>金额：¥ {priceYuan}</div>
            </div>
          </div>
        )}

        {err && <p className='mt-4 text-sm text-red-500'>错误：{err}</p>}
      </div>
    </div>
  )
}

export default PayModal
