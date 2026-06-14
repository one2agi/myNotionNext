/**
 * PayModalProvider - React Context for PayModal
 *
 * 提供全局支付弹窗状态管理，支持多个触发点（Pricing / CTA / ArticleLock）
 *
 * 使用方式：
 *   import { PayModalProvider, usePayModal } from './PayModalProvider'
 *   <PayModalProvider>{children}<PayModalRoot /></PayModalProvider>
 *
 * 遵循 PAYMENT-FRONTEND-DESIGN.md §4 设计
 * 遵循 PAYMENT-IMPLEMENTATION-NOTES.md B.5 注入方式
 *
 * @module themes/starter/components/PayModalProvider
 */

'use client'

import { createContext, useContext, useState, useCallback, useRef } from 'react'

/**
 * @typedef {'IDLE' | 'STEP1_FORM' | 'STEP2_QR' | 'SUCCESS' | 'EXPIRED' | 'FAILED'} PayStep
 */

/**
 * @typedef {Object} PayModalContextValue
 * @property {boolean} open
 * @property {PayStep} step
 * @property {string} productId
 * @property {string} productName
 * @property {number} totalPrice
 * @property {number} discountAmount
 * @property {number} finalPrice
 * @property {string} outTradeNo
 * @property {string} qrcode
 * @property {string} imgUrl
 * @property {string} errorMessage
 * @property {Function} openPayModal
 * @property {Function} closePayModal
 */

/** @type {import('react').Context<PayModalContextValue | null>} */
const PayModalContext = createContext(null)

/**
 * usePayModal hook
 * @returns {PayModalContextValue}
 */
export function usePayModal() {
  const ctx = useContext(PayModalContext)
  if (!ctx) {
    throw new Error('usePayModal must be used within <PayModalProvider>')
  }
  return ctx
}

/**
 * PayModalProvider
 * @param {{ children: import('react').ReactNode }} props
 */
export function PayModalProvider({ children }) {
  const [state, setState] = useState({
    open: false,
    step: 'IDLE',
    productId: '',
    productName: '',
    totalPrice: 0,
    discountAmount: 0,
    finalPrice: 0,
    outTradeNo: '',
    qrcode: '',
    imgUrl: '',
    errorMessage: '',
  })

  /** @type {import('react').Ref<{ poller: ReturnType<typeof setInterval> | null, timeout: ReturnType<typeof setTimeout> | null }>} */
  const timersRef = useRef({ poller: null, timeout: null })

  const clearTimers = useCallback(() => {
    if (timersRef.current.poller) {
      clearInterval(timersRef.current.poller)
      timersRef.current.poller = null
    }
    if (timersRef.current.timeout) {
      clearTimeout(timersRef.current.timeout)
      timersRef.current.timeout = null
    }
  }, [])

  /**
   * 打开支付弹窗（从 Pricing 按钮调用）
   * @param {{ productId: string, productName: string, totalPrice: number }} params
   */
  const openPayModal = useCallback(({ productId, productName, totalPrice }) => {
    clearTimers()
    setState({
      open: true,
      step: 'STEP1_FORM',
      productId,
      productName,
      totalPrice,
      discountAmount: 0,
      finalPrice: totalPrice,
      outTradeNo: '',
      qrcode: '',
      imgUrl: '',
      errorMessage: '',
    })
  }, [clearTimers])

  /**
   * 关闭弹窗
   */
  const closePayModal = useCallback(() => {
    clearTimers()
    setState(prev => ({ ...prev, open: false, step: 'IDLE' }))
  }, [clearTimers])

  /**
   * 提交表单（创建订单）
   * @param {{ name: string, email: string, discountCode: string }} formData
   */
  const submitForm = useCallback(async ({ name, email, discountCode }) => {
    setState(prev => ({ ...prev, step: 'STEP2_QR', errorMessage: '' }))

    try {
      const response = await fetch('/api/pay/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: state.productId,
          customer: { name, email },
          discountCode: discountCode || '',
        }),
      })

      const data = await response.json()

      if (data.code !== 0) {
        setState(prev => ({
          ...prev,
          step: 'FAILED',
          errorMessage: data.message || 'E_INTERNAL',
        }))
        return
      }

      setState(prev => ({
        ...prev,
        step: 'STEP2_QR',
        outTradeNo: data.data.outTradeNo,
        qrcode: data.data.qrcode,
        imgUrl: data.data.imgUrl || '',
        discountAmount: data.data.discountAmount,
        finalPrice: data.data.finalPrice,
      }))

      // 启动 5s 轮询
      const POLL_INTERVAL_MS = 5000
      const TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟
      let pollCount = 0
      const maxPolls = Math.floor(TIMEOUT_MS / POLL_INTERVAL_MS)

      timersRef.current.poller = setInterval(async () => {
        pollCount++
        if (pollCount > maxPolls) {
          // 超时 → EXPIRED + 自动调 cancel-order
          clearInterval(timersRef.current.poller)
          timersRef.current.poller = null
          setState(prev => ({ ...prev, step: 'EXPIRED' }))

          // 自动调 cancel-order
          try {
            await fetch('/api/pay/cancel-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ outTradeNo: state.outTradeNo }),
            })
          } catch {
            // cancel-order 失败不影响 UI
          }
          return
        }

        try {
          const pollRes = await fetch(`/api/pay/query-order?outTradeNo=${state.outTradeNo}`)
          const pollData = await pollRes.json()
          if (pollData.data?.paid) {
            clearInterval(timersRef.current.poller)
            timersRef.current.poller = null
            setState(prev => ({ ...prev, step: 'SUCCESS' }))
          }
        } catch {
          // 轮询失败，继续重试
        }
      }, POLL_INTERVAL_MS)

    } catch (err) {
      setState(prev => ({
        ...prev,
        step: 'FAILED',
        errorMessage: 'E_INTERNAL',
      }))
    }
  }, [state.productId, state.outTradeNo])

  /**
   * 取消订单
   */
  const cancelOrder = useCallback(async () => {
    if (!state.outTradeNo) {
      closePayModal()
      return
    }

    try {
      await fetch('/api/pay/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outTradeNo: state.outTradeNo }),
      })
    } catch {
      // n8n webhook 失败不影响本地状态
    }

    clearTimers()
    setState(prev => ({ ...prev, open: false, step: 'IDLE' }))
  }, [state.outTradeNo, closePayModal, clearTimers])

  const ctxValue = {
    ...state,
    openPayModal,
    closePayModal,
    submitForm,
    cancelOrder,
  }

  return (
    <PayModalContext.Provider value={ctxValue}>
      {children}
    </PayModalContext.Provider>
  )
}