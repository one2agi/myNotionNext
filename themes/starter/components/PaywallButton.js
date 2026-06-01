import { useState } from 'react'
import QRCode from 'qrcode'

/**
 * 微信支付 MVP 按钮（仅用于「创建订单 + 显示二维码」最小链路测试）
 *
 * 流程：
 *   1. 用户点按钮
 *   2. POST /api/pay/create-order  → 拿到 { codeUrl, outTradeNo, ... }
 *   3. 用 qrcode 库把 codeUrl 渲染为 dataURL
 *   4. <img> 显示二维码，用户拿微信扫码付款
 *
 * 后续接入回调后，可在 polling state 里加 setInterval 查单 / 显示支付结果。
 */
export const PaywallButton = () => {
  const [loading, setLoading] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState(null)
  const [err, setErr] = useState(null)
  const [orderInfo, setOrderInfo] = useState(null)

  const onPay = async () => {
    setLoading(true)
    setErr(null)
    setQrDataUrl(null)
    setOrderInfo(null)
    try {
      const r = await fetch('/api/pay/create-order', { method: 'POST' })
      const data = await r.json()
      if (!r.ok) {
        throw new Error(data.error || `HTTP ${r.status}`)
      }
      const dataUrl = await QRCode.toDataURL(data.codeUrl, { width: 260, margin: 1 })
      setQrDataUrl(dataUrl)
      setOrderInfo(data)
    } catch (e) {
      setErr(e?.message || '创建订单失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='my-8 rounded-xl shadow-pricing bg-white dark:bg-dark p-6 border border-gray-100 dark:border-gray-700'>
      <h3 className='text-xl font-bold mb-2 text-body-color dark:text-white'>
        微信支付测试
      </h3>
      <p className='text-sm text-gray-500 dark:text-gray-400 mb-4'>
        MVP 链路验证：1 分钱测试商品。支付成功后请到微信支付商户平台「交易中心」查单。
      </p>

      <button
        onClick={onPay}
        disabled={loading}
        className='px-6 py-2 rounded-lg bg-primary text-white font-medium transition hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed'>
        {loading ? '创建订单中…' : '点此支付 1 分钱'}
      </button>

      {err && (
        <p className='mt-4 text-red-500 text-sm'>错误：{err}</p>
      )}

      {qrDataUrl && orderInfo && (
        <div className='mt-6 flex flex-col items-center'>
          <p className='text-sm mb-3 text-gray-500 dark:text-gray-400'>
            用微信「扫一扫」扫描下方二维码
          </p>
          <img
            src={qrDataUrl}
            alt='wechat pay qrcode'
            className='border p-2 rounded bg-white'
            width={260}
            height={260}
          />
          <div className='mt-3 text-xs text-gray-400 text-center'>
            <div>订单号：{orderInfo.outTradeNo}</div>
            <div>商品：{orderInfo.productName}（{orderInfo.totalFen} 分）</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default PaywallButton
