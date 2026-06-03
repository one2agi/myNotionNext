import { useEffect, useRef, useState } from 'react'

/**
 * 微信支付弹窗（Z-Pay 聚合支付版）
 *
 * 用法：
 *   <PayModal product={product} onClose={() => setProduct(null)} />
 *
 * Props:
 *   product: { id, name, price, currency } 来自 products.config.js
 *   onClose: () => void  关闭时回调（父组件清掉 product 状态）
 *
 * 流程：
 *   1. 点"立即支付" → POST /api/pay/create-order → 返 {outTradeNo, imgUrl, ...}
 *   2. 渲染 <img src={imgUrl}> 展示 Z-Pay 直接提供的二维码图片
 *   3. 每 3s GET /api/pay/query-order?outTradeNo=... 轮询
 *   4. 命中 status=1 → 切"支付成功 ✓" 横幅 + 3s 后调 onClose()
 *   5. 5min 未命中 → 停轮询 + 显示"订单已创建..."提示
 */
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
const SUCCESS_AUTO_CLOSE_MS = 3000

export const PayModal = ({ product, onClose }) => {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [order, setOrder] = useState(null)
  const [timedOut, setTimedOut] = useState(false)
  const startedAtRef = useRef(null)

  // ESC 关闭
  useEffect(() => {
    if (!product) return
    const onKey = e => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [product, onClose])

  // 切换 product 时清空上一次的订单/错误/超时状态
  useEffect(() => {
    setOrder(null)
    setErr(null)
    setLoading(false)
    setTimedOut(false)
    startedAtRef.current = null
  }, [product?.id])

  // 轮询订单状态
  useEffect(() => {
    if (!order?.outTradeNo || order.paid) return
    startedAtRef.current = Date.now()

    const t = setInterval(async () => {
      // 5min 自动停
      if (startedAtRef.current && Date.now() - startedAtRef.current >= POLL_TIMEOUT_MS) {
        clearInterval(t)
        setTimedOut(true)
        return
      }
      try {
        const r = await fetch(`/api/pay/query-order?outTradeNo=${order.outTradeNo}`)
        const d = await r.json()
        if (d.status === 1) {
          setOrder(o => ({ ...o, paid: true }))
          clearInterval(t)
        }
      } catch (e) {
        // 静默吞掉轮询错误，下次重试
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(t)
  }, [order?.outTradeNo, order?.paid])

  // 支付成功后 3s 自动关闭
  useEffect(() => {
    if (!order?.paid) return
    const t = setTimeout(() => onClose(), SUCCESS_AUTO_CLOSE_MS)
    return () => clearTimeout(t)
  }, [order?.paid, onClose])

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
      setOrder({ ...data, paid: false })
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

        {/* 支付成功横幅 */}
        {order?.paid && (
          <div
            role='status'
            className='mb-4 rounded-md bg-green-500 px-3 py-2 text-center text-sm font-medium text-white'>
            支付成功 ✓
          </div>
        )}

        {/* 标题 + 价格 */}
        <h3 className='mb-1 pr-8 text-lg font-bold text-dark dark:text-white'>
          {product.name}
        </h3>
        <p className='mb-5 text-sm text-gray-500 dark:text-gray-400'>
          ¥ {priceYuan}（测试金额，正式发布后会改回真实价格）
        </p>

        {/* 状态分支：未点支付 → 按钮 / 已点支付 → 二维码 */}
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
              src={order.imgUrl}
              alt='z-pay 微信支付二维码'
              className='rounded border bg-white p-2'
              width={240}
              height={240}
            />
            <div className='mt-3 w-full text-center text-xs text-gray-400'>
              <div>订单号：{order.outTradeNo}</div>
              <div>金额：¥ {priceYuan}</div>
            </div>

            {/* 5min 超时提示 */}
            {timedOut && (
              <p className='mt-3 text-center text-xs text-gray-500 dark:text-gray-400'>
                订单已创建，请在微信中完成支付；如已完成请手动关闭弹窗
              </p>
            )}
          </div>
        )}

        {err && <p className='mt-4 text-sm text-red-500'>错误：{err}</p>}
      </div>
    </div>
  )
}

export default PayModal
