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
 * 2026-06-14 修复:
 *   - HIGH 1: cancelOrder 不再静默吞错，错误时显示给用户 + 不关闭 modal
 *   - HIGH 2: isSubmittingRef 防双击提交/取消
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
 * @property {string} cancelError            // HIGH 1: 取消订单错误展示
 * @property {string} customerEmail          // H2: 提交时记录，cancel-order 校验用
 * @property {string} customerName           // H2: 保留客户姓名（未来扩展用）
 * @property {Function} openPayModal
 * @property {Function} closePayModal
 * @property {Function} submitForm
 * @property {Function} cancelOrder
 * @property {Function} clearCancelError     // HIGH 1: 清除 cancelError
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

/** 轮询间隔 5s，5 分钟超时（与 Z-Pay QR 默认过期时间一致） */
const POLL_INTERVAL_MS = 5000
const TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟

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
    cancelError: '', // HIGH 1
    customerEmail: '', // H2: cancel-order 需要 customer.email
    customerName: '',
  })

  /** @type {import('react').Ref<{ poller: ReturnType<typeof setInterval> | null, timeout: ReturnType<typeof setTimeout> | null }>} */
  const timersRef = useRef({ poller: null, timeout: null })

  // HIGH 2: 同步 ref 防双击提交/取消（React state 是异步的，rapid click 会绕过 disabled）
  const isSubmittingRef = useRef(false)
  const isCancellingRef = useRef(false)

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
    isSubmittingRef.current = false
    isCancellingRef.current = false
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
      cancelError: '',
      customerEmail: '',
      customerName: '',
    })
  }, [clearTimers])

  /**
   * 关闭弹窗
   */
  const closePayModal = useCallback(() => {
    clearTimers()
    isSubmittingRef.current = false
    isCancellingRef.current = false
    setState(prev => ({ ...prev, open: false, step: 'IDLE' }))
  }, [clearTimers])

  /**
   * 提交表单（创建订单）
   * @param {{ name: string, email: string, discountCode: string }} formData
   */
  const submitForm = useCallback(async ({ name, email, discountCode }) => {
    // HIGH 2: 防双击 — 同步 ref 拦截
    if (isSubmittingRef.current) {
      return
    }
    isSubmittingRef.current = true

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
        isSubmittingRef.current = false
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
        customerEmail: email, // H2: 保存 email 用于后续 cancel-order
        customerName: name,
      }))

      // 启动 5s 轮询
      const outTradeNo = data.data.outTradeNo
      let pollCount = 0
      const maxPolls = Math.floor(TIMEOUT_MS / POLL_INTERVAL_MS)

      timersRef.current.poller = setInterval(async () => {
        pollCount++
        if (pollCount > maxPolls) {
          // 超时 → EXPIRED + 自动调 cancel-order
          clearInterval(timersRef.current.poller)
          timersRef.current.poller = null
          setState(prev => ({ ...prev, step: 'EXPIRED' }))

          // 自动调 cancel-order（也用 isCancellingRef 防重入）
          if (!isCancellingRef.current) {
            isCancellingRef.current = true
            try {
              await fetch('/api/pay/cancel-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ outTradeNo, customer: { email } }),
              })
            } catch (err) {
              console.error('[PayModal] auto-cancel failed:', err)
            } finally {
              isCancellingRef.current = false
            }
          }
          return
        }

        try {
          const pollRes = await fetch(`/api/pay/query-order?outTradeNo=${outTradeNo}`)
          // MEDIUM 1 修复：检查 HTTP 状态码
          if (!pollRes.ok) {
            // 服务端错误，继续重试
            return
          }
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

      isSubmittingRef.current = false

    } catch (err) {
      console.error('[PayModal] submitForm error:', err)
      setState(prev => ({
        ...prev,
        step: 'FAILED',
        errorMessage: 'E_INTERNAL',
      }))
      isSubmittingRef.current = false
    }
  }, [state.productId])

  /**
   * 取消订单
   * HIGH 1: 失败时显示错误给用户 + 不关闭 modal，允许重试
   * HIGH 2: 用 isCancellingRef 防双击
   */
  const cancelOrder = useCallback(async () => {
    if (!state.outTradeNo) {
      closePayModal()
      return
    }

    // HIGH 2: 防双击
    if (isCancellingRef.current) {
      return
    }
    isCancellingRef.current = true

    try {
      const res = await fetch('/api/pay/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outTradeNo: state.outTradeNo,
          customer: { email: state.customerEmail || '' },
        }),
      })

      if (!res.ok) {
        // HIGH 1: 服务端返非 200，提示用户
        let errMsg = '取消失败，请重试'
        try {
          const errBody = await res.json()
          if (errBody.message === 'E_ORDER_ALREADY_PAID') {
            errMsg = '订单已支付，无法取消'
          } else if (errBody.message === 'E_EMAIL_MISMATCH') {
            errMsg = '邮箱验证失败，无法取消'
          }
        } catch {
          // 忽略解析错误
        }
        setState(prev => ({ ...prev, cancelError: errMsg }))
        isCancellingRef.current = false
        return
      }

      clearTimers()
      setState(prev => ({ ...prev, open: false, step: 'IDLE' }))
      isCancellingRef.current = false
    } catch (err) {
      // HIGH 1: 网络错误，不再静默吞错
      console.error('[PayModal] cancelOrder failed:', err)
      setState(prev => ({
        ...prev,
        cancelError: '网络错误，请重试取消',
      }))
      isCancellingRef.current = false
    }
  }, [state.outTradeNo, state.customerEmail, closePayModal, clearTimers])

  /**
   * 清除取消错误（HIGH 1）
   */
  const clearCancelError = useCallback(() => {
    setState(prev => ({ ...prev, cancelError: '' }))
  }, [])

  const ctxValue = {
    ...state,
    openPayModal,
    closePayModal,
    submitForm,
    cancelOrder,
    clearCancelError,
  }

  return (
    <PayModalContext.Provider value={ctxValue}>
      {children}
    </PayModalContext.Provider>
  )
}