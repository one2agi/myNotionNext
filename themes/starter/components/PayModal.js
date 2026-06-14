/**
 * PayModal - 支付弹窗组件
 *
 * 4 状态机：IDLE / STEP1_FORM / STEP2_QR / SUCCESS / EXPIRED / FAILED
 * - IDLE: 隐藏状态
 * - STEP1_FORM: 表单（姓名 + 邮箱 + 优惠码）
 * - STEP2_QR: 显示二维码 + 5s 轮询
 * - SUCCESS: 支付成功
 * - EXPIRED: 订单超时
 * - FAILED: 支付失败
 *
 * 遵循 PAYMENT-FRONTEND-DESIGN.md §4 UI 结构
 * 遵循 PAYMENT-IMPLEMENTATION-NOTES.md B.6 统一 6 态
 *
 * @module themes/starter/components/PayModal
 */

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { usePayModal } from './PayModalProvider'
import { DISCOUNT_CODE_REGEX } from '@/lib/discount-codes'

/** 错误码 → 用户文案映射（遵循 FRONTEND §7） */
const ERROR_MESSAGES = {
  E_NAME_EMPTY: '请填写姓名',
  E_NAME_TOO_LONG: '姓名不能超过 50 个字符',
  E_EMAIL_INVALID: '邮箱格式错误',
  E_DC_NOT_FOUND: '优惠码不存在',
  E_DC_DISABLED: '优惠码已停用',
  E_DC_AMOUNT_INVALID: '折扣金额超出',
  E_DC_FORMAT_INVALID: '优惠码格式错误（6-20位字母数字）',
  E_PRODUCT_NOT_FOUND: '商品不存在',
  E_ZPAY_FAIL: '支付创建失败，请重试',
  E_NOTION_FAIL: '系统繁忙，请稍后再试',
  E_INTERNAL: '系统繁忙，请稍后再试',
  E_PARAM_MISSING: '参数错误',
  E_ORDER_ALREADY_PAID: '订单已支付，无法取消',
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 获取错误用户提示文案
 * @param {string|null} code
 * @returns {string}
 */
function getErrorMessage(code) {
  if (!code) return '操作失败，请重试'
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.E_INTERNAL
}

/**
 * PayModal 弹窗主体
 */
export function PayModal() {
  const {
    open,
    step,
    productName,
    totalPrice,
    discountAmount,
    finalPrice,
    outTradeNo,
    qrcode,
    imgUrl,
    errorMessage,
    cancelError,    // HIGH 1
    closePayModal,
    submitForm,
    cancelOrder,
    clearCancelError, // HIGH 1
  } = usePayModal()

  // 表单字段
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [discountCode, setDiscountCode] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // focus trap ref
  const modalRef = useRef(null)

  // ESC / 遮罩关闭
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (step === 'STEP2_QR') {
          // 二维码阶段：关闭 modal 不取消订单（用户可能去微信支付）
          closePayModal()
        } else {
          closePayModal()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    // 锁定 body scroll
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [open, step, closePayModal])

  // 重置表单
  useEffect(() => {
    if (step === 'STEP1_FORM') {
      setName('')
      setEmail('')
      setDiscountCode('')
      setFormError('')
      setSubmitting(false)
    }
  }, [step])

  /**
   * 优惠码 blur 格式校验（不调 API，防枚举）
   */
  const handleDiscountCodeBlur = useCallback(() => {
    if (!discountCode) return
    if (!DISCOUNT_CODE_REGEX.test(discountCode.toUpperCase())) {
      setFormError('优惠码格式错误（6-20位字母数字）')
    } else {
      setFormError('')
    }
  }, [discountCode])

  /**
   * 表单提交
   */
  const handleSubmit = useCallback(async (e) => {
    e.preventDefault()
    setFormError('')

    // 必填校验
    if (!name.trim()) {
      setFormError('请填写姓名')
      return
    }
    if (name.trim().length > 50) {
      setFormError('姓名不能超过 50 个字符')
      return
    }
    if (!email || !EMAIL_REGEX.test(email)) {
      setFormError('邮箱格式错误')
      return
    }

    setSubmitting(true)
    await submitForm({ name: name.trim(), email: email.trim(), discountCode: discountCode.trim() })
    setSubmitting(false)
  }, [name, email, discountCode, submitForm])

  if (!open) return null

  return (
    <div
      className="pay-modal-overlay fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={(e) => {
        // 点击遮罩关闭（非二维码阶段）
        if (e.target === e.currentTarget && step !== 'STEP2_QR') {
          closePayModal()
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pay-modal-title"
    >
      <div
        ref={modalRef}
        className="pay-modal-content relative w-full max-w-md rounded-xl bg-white dark:bg-dark-2 shadow-2xl overflow-hidden"
      >
        {/* 关闭按钮 */}
        <button
          onClick={() => {
            if (step === 'STEP2_QR') {
              // 二维码阶段：关闭不取消
              closePayModal()
            } else {
              closePayModal()
            }
          }}
          className="absolute right-4 top-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          aria-label="关闭"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* ===== STEP1: 表单 ===== */}
        {step === 'STEP1_FORM' && (
          <div className="p-8">
            <h2 id="pay-modal-title" className="text-xl font-semibold text-dark dark:text-white mb-1">
              购买 {productName}
            </h2>
            <p className="text-sm text-body-color dark:text-dark-6 mb-6">
              填写以下信息获取购买链接
            </p>

            {/* H3 安全提示：前端价格可被 DevTools 篡改，以 Z-Pay 实际收款金额为准 */}
            <p className="text-xs text-gray-400 dark:text-dark-6 mb-4 italic">
              * 最终支付金额以 Z-Pay 实际收款为准
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* 姓名 */}
              <div>
                <label className="block text-sm font-medium text-dark dark:text-white mb-1">
                  姓名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="请输入您的姓名"
                  maxLength={50}
                  className="w-full rounded-md border border-gray-200 dark:border-dark-3 bg-white dark:bg-dark-1 px-4 py-2 text-dark dark:text-white placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
                />
              </div>

              {/* 邮箱 */}
              <div>
                <label className="block text-sm font-medium text-dark dark:text-white mb-1">
                  邮箱 <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="资料将发送到此邮箱"
                  className="w-full rounded-md border border-gray-200 dark:border-dark-3 bg-white dark:bg-dark-1 px-4 py-2 text-dark dark:text-white placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
                />
              </div>

              {/* 优惠码 */}
              <div>
                <label className="block text-sm font-medium text-dark dark:text-white mb-1">
                  优惠码 <span className="text-gray-400">(可选)</span>
                </label>
                <input
                  type="text"
                  value={discountCode}
                  onChange={e => setDiscountCode(e.target.value.toUpperCase())}
                  onBlur={handleDiscountCodeBlur}
                  placeholder="输入优惠码享折扣"
                  maxLength={20}
                  className="w-full rounded-md border border-gray-200 dark:border-dark-3 bg-white dark:bg-dark-1 px-4 py-2 text-dark dark:text-white placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
                />
              </div>

              {/* 错误提示 */}
              {formError && (
                <p className="text-sm text-red-500">{formError}</p>
              )}

              {/* 价格信息 */}
              <div className="pt-2 border-t border-gray-100 dark:border-dark-3">
                <div className="flex justify-between text-sm text-body-color dark:text-dark-6">
                  <span>原价</span>
                  <span>¥{totalPrice}</span>
                </div>
                {discountAmount > 0 && (
                  <div className="flex justify-between text-sm text-green-500 mt-1">
                    <span>优惠</span>
                    <span>-¥{discountAmount}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-semibold text-dark dark:text-white mt-1">
                  <span>合计</span>
                  <span>¥{finalPrice}</span>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-md bg-primary px-7 py-3 text-center text-base font-medium text-white transition hover:bg-blue-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? '提交中...' : `立即支付 ¥${finalPrice}`}
              </button>
            </form>
          </div>
        )}

        {/* ===== STEP2: 二维码 ===== */}
        {step === 'STEP2_QR' && (
          <div className="p-8 text-center">
            <h2 id="pay-modal-title" className="text-xl font-semibold text-dark dark:text-white mb-2">
              请使用微信扫码支付
            </h2>
            <p className="text-sm text-body-color dark:text-dark-6 mb-4">
              支付成功后资料将在 24 小时内发送到您的邮箱
            </p>

            {/* 二维码 */}
            <div className="flex justify-center mb-4">
              {imgUrl ? (
                <img src={imgUrl} alt="支付二维码" className="w-64 h-64 rounded-lg" />
              ) : qrcode ? (
                // weixin:// 链接渲染为图片（ZPay 返回 imgUrl 时使用）
                <div className="w-64 h-64 flex items-center justify-center bg-gray-50 rounded-lg text-sm text-gray-400">
                  正在加载二维码...
                </div>
              ) : null}
            </div>

            {/* 订单信息 */}
            <div className="text-sm text-body-color dark:text-dark-6 space-y-1 mb-6">
              <p>订单号：{outTradeNo}</p>
              <p className="text-base font-semibold text-dark dark:text-white">
                支付金额：<span className="text-primary">¥{finalPrice}</span>
              </p>
              <p className="text-xs text-gray-400">二维码有效期 5 分钟</p>
            </div>

            {/* HIGH 1: 取消失败错误提示 */}
            {cancelError && (
              <div className="mb-4 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">
                <p>{cancelError}</p>
                <button
                  onClick={clearCancelError}
                  className="mt-1 text-xs underline hover:no-underline"
                >
                  知道了
                </button>
              </div>
            )}

            {/* 取消按钮 */}
            <button
              onClick={cancelOrder}
              className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors underline"
            >
              取消订单
            </button>
          </div>
        )}

        {/* ===== SUCCESS ===== */}
        {step === 'SUCCESS' && (
          <div className="p-8 text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
                <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <h2 className="text-xl font-semibold text-dark dark:text-white mb-2">
              支付成功
            </h2>
            <p className="text-sm text-body-color dark:text-dark-6 mb-6">
              订单已确认，资料将在 24 小时内<br />发送到您的邮箱
            </p>
            <button
              onClick={closePayModal}
              className="w-full rounded-md bg-primary px-7 py-3 text-center text-base font-medium text-white transition hover:bg-blue-dark"
            >
              关闭
            </button>
          </div>
        )}

        {/* ===== EXPIRED ===== */}
        {step === 'EXPIRED' && (
          <div className="p-8 text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 rounded-full bg-yellow-100 dark:bg-yellow-900 flex items-center justify-center">
                <svg className="w-8 h-8 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
            <h2 className="text-xl font-semibold text-dark dark:text-white mb-2">
              订单已超时
            </h2>
            <p className="text-sm text-body-color dark:text-dark-6 mb-6">
              超过 5 分钟未支付，订单已自动取消<br />请重新发起支付
            </p>
            <button
              onClick={() => {
                closePayModal()
              }}
              className="w-full rounded-md bg-gray-100 dark:bg-dark-3 px-7 py-3 text-center text-base font-medium text-dark dark:text-white hover:bg-gray-200 dark:hover:bg-dark-4 transition-colors"
            >
              关闭
            </button>
          </div>
        )}

        {/* ===== FAILED ===== */}
        {step === 'FAILED' && (
          <div className="p-8 text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center">
                <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
            </div>
            <h2 className="text-xl font-semibold text-dark dark:text-white mb-2">
              支付失败
            </h2>
            <p className="text-sm text-red-500 mb-6">
              {getErrorMessage(errorMessage)}
            </p>
            <div className="flex gap-3">
              <button
                onClick={closePayModal}
                className="flex-1 rounded-md bg-primary px-7 py-3 text-center text-base font-medium text-white transition hover:bg-blue-dark"
              >
                重试
              </button>
              <button
                onClick={closePayModal}
                className="flex-1 rounded-md bg-gray-100 dark:bg-dark-3 px-7 py-3 text-center text-base font-medium text-dark dark:text-white hover:bg-gray-200 dark:hover:bg-dark-4 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}