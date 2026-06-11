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
 * 流程（Step 1 → Step 2）：
 *   Step 1 (form): 用户填姓名/邮箱/优惠码 → 点"立即支付"
 *   Step 2 (qr):   POST /api/pay/create-order → 返 {outTradeNo, imgUrl, ...}
 *   渲染 <img src={imgUrl}> 展示 Z-Pay 二维码
 *   每 3s GET /api/pay/query-order?outTradeNo=... 轮询
 *   命中 status=1 → "支付成功 ✓" 横幅 + 3s 后调 onClose()
 *   5min 未命中 → 停轮询 + 显示"订单已创建..."提示
 *
 * H-9 扩展 (2026-06-11): Step 1 表单 + 状态机 + blur 优惠码校验
 */
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
const SUCCESS_AUTO_CLOSE_MS = 3000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const PayModal = ({ product, onClose }) => {
  const [step, setStep] = useState('form') // 'form' | 'qr'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [discountCode, setDiscountCode] = useState('')
  const [discountValid, setDiscountValid] = useState(null) // null | true | false
  const [discountErr, setDiscountErr] = useState('')
  const [formTouched, setFormTouched] = useState(false) // true after first user interaction
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

  // 切换 product 时重置所有状态
  useEffect(() => {
    setStep('form')
    setName('')
    setEmail('')
    setDiscountCode('')
    setDiscountValid(null)
    setDiscountErr('')
    setFormTouched(false)
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

  // 优惠码 blur 校验：格式预检 → 服务端二次校验
  const handleDiscountBlur = async () => {
    if (!discountCode.trim()) {
      setDiscountValid(null)
      setDiscountErr('')
      return
    }
    // 客户端格式校验（与 lib/discount-codes.ts 同步）
    if (!/^[A-Z0-9-]{6,20}$/.test(discountCode.trim())) {
      setDiscountValid(false)
      setDiscountErr('优惠码无效或已停用')
      return
    }
    try {
      const r = await fetch(`/api/pay/lookup-discount?code=${encodeURIComponent(discountCode.trim())}`)
      const d = await r.json()
      if (d.valid) {
        setDiscountValid(true)
        setDiscountErr('')
      } else {
        setDiscountValid(false)
        setDiscountErr('优惠码无效或已停用')
      }
    } catch {
      setDiscountValid(false)
      setDiscountErr('优惠码无效或已停用')
    }
  }

  // Step 1 提交：POST create-order 扩展入参 → 进入 Step 2 QR
  const onPay = async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await fetch('/api/pay/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: product.id,
          customer: { name: name.trim(), email: email.trim() },
          discountCode: discountCode.trim() || undefined
        })
      })
      const data = await r.json()
      if (!r.ok) {
        throw new Error(data.code || data.error || `HTTP ${r.status}`)
      }
      setOrder({ ...data, paid: false })
      setStep('qr')
    } catch (e) {
      setErr(e?.message || '创建订单失败')
    } finally {
      setLoading(false)
    }
  }

  // 按钮禁用逻辑：
  // - formTouched=false（未交互）→ 按钮可用（向后兼容旧6 测）
  // - formTouched=true → name/email 有效才可用；discountCode 非空时 discountValid 必须 true
  const isNameValid = name.trim().length >= 1 && name.trim().length <= 50
  const isEmailValid = EMAIL_RE.test(email.trim())
  const isDiscountValid = !discountCode.trim() || discountValid === true
  const buttonDisabled =
    loading || (formTouched && (!isNameValid || !isEmailValid || !isDiscountValid))

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

        {/* Step 1 表单 (step === 'form') */}
        {step === 'form' && (
          <div className='space-y-3'>
            {/* 姓名 */}
            <div>
              <label htmlFor='pay-name' className='mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200'>
                姓名<span className='text-red-500'>*</span>
              </label>
              <input
                id='pay-name'
                type='text'
                value={name}
                onChange={e => {
                  setName(e.target.value)
                  setFormTouched(true)
                }}
                onBlur={() => setFormTouched(true)}
                placeholder='请输入您的姓名'
                maxLength={50}
                className='w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-600 dark:bg-dark-3 dark:text-white'
              />
            </div>

            {/* 邮箱 */}
            <div>
              <label htmlFor='pay-email' className='mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200'>
                邮箱 <span className='text-red-500'>*</span>
              </label>
              <input
                id='pay-email'
                type='email'
                value={email}
                onChange={e => {
                  setEmail(e.target.value)
                  setFormTouched(true)
                }}
                onBlur={() => setFormTouched(true)}
                placeholder='[email protected]'
                className='w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-600 dark:bg-dark-3 dark:text-white'
              />
            </div>

            {/* 优惠码 */}
            <div>
              <label htmlFor='pay-discount' className='mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200'>
                优惠码
              </label>
              <input
                id='pay-discount'
                type='text'
                value={discountCode}
                onChange={e => {
                  setDiscountCode(e.target.value)
                  setFormTouched(true)
                }}
                onBlur={handleDiscountBlur}
                placeholder='选填，如 PARTNER01'
                maxLength={20}
                className='w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-600 dark:bg-dark-3 dark:text-white'
              />
              {discountErr && (
                <p className='mt-1 text-xs text-red-500' role='alert'>
                  {discountErr}
                </p>
              )}
            </div>

            {/* 提交按钮 */}
            <button
              type='button'
              onClick={onPay}
              disabled={buttonDisabled}
              className='w-full rounded-lg bg-primary px-6 py-3 font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'>
              {loading ? '创建订单中…' : '立即支付'}
            </button>
          </div>
        )}

        {/* Step 2 QR /轮询 / 结果 (step === 'qr' && order) */}
        {(step === 'qr' || order) && (
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
