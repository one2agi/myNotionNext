/**
 * cloud-functions/api/pay/notify.ts 集成测试
 *
 * 测什么：
 * - GET / POST 双 method 都接 Z-Pay 异步回调
 * - 验签失败 → 400
 * - 验签通过 + TRADE_SUCCESS + 未 paid + 金额匹配 → 200 plain text "success"
 * - 重复通知幂等（已 paid）→ 200 success，不调 markPaid
 * - 金额不匹配 → 400
 * - 非 TRADE_SUCCESS（WAIT/REFUND 等中间态）→ 早 ack 200 success
 *
 * Mock 策略：
 * - zpay.js / order-store.js 全部 jest.mock，注入 env 不读 process.env
 * - 用一个最小的 FakeRequest（实现只依赖 .url 和 .formData()），不引 Node 18+ 全局 Request
 *   （jsdom test env 不暴露它，避免 @jest-environment node 跟 jest.setup.js 的 window 冲突）
 */

jest.mock('../../../../lib/zpay.js', () => ({
  verifySign: jest.fn(),
}))

jest.mock('../../../../lib/order-store.js', () => ({
  recordOrder: jest.fn(),
  markPaid: jest.fn(),
  alreadyPaid: jest.fn(),
}))

// jsdom test env doesn't expose Node 18+ Response/Request globals.
// Cloud Function runs on Node 20 (which has them); the implementation uses `new Response(...)`.
// Polyfill with a minimal shim — test only inspects .status and .text().
class FakeResponse {
  status: number
  private _body: string
  constructor(body: string = '', init: { status?: number } = {}) {
    this._body = body
    this.status = init.status ?? 200
  }
  async text(): Promise<string> {
    return this._body
  }
}
;(globalThis as any).Response = FakeResponse

import { onRequestGet, onRequestPost } from '../notify'
import { verifySign as verifySignReal } from '../../../../lib/zpay.js'
import {
  recordOrder as recordOrderReal,
  markPaid as markPaidReal,
  alreadyPaid as alreadyPaidReal,
} from '../../../../lib/order-store.js'

const verifySign = verifySignReal as unknown as jest.Mock
const recordOrder = recordOrderReal as unknown as jest.Mock
const markPaid = markPaidReal as unknown as jest.Mock
const alreadyPaid = alreadyPaidReal as unknown as jest.Mock

const env = {
  ZPAY_PID: 'test-pid',
  ZPAY_KEY: 'test-key',
  ZPAY_NOTIFY_URL: 'https://example.com/api/pay/notify',
}

/** Minimal Request-like class for the test (impl only uses .url + .formData()). */
class FakeRequest {
  url: string
  private _body: string
  constructor(url: string, body: string = '') {
    this.url = url
    this._body = body
  }
  async formData(): Promise<URLSearchParams> {
    return new URLSearchParams(this._body)
  }
}

function makeGetRequest(params: Record<string, string>): FakeRequest {
  const qs = new URLSearchParams(params).toString()
  return new FakeRequest(`https://example.com/api/pay/notify?${qs}`)
}

function makePostRequest(params: Record<string, string>): FakeRequest {
  const form = new URLSearchParams(params)
  return new FakeRequest('https://example.com/api/pay/notify', form.toString())
}

const successParams: Record<string, string> = {
  pid: 'test-pid',
  type: 'wxpay',
  out_trade_no: 'TEST001',
  name: 'product',
  money: '0.10',
  trade_status: 'TRADE_SUCCESS',
  trade_no: 'ZPAYTEST123',
  sign: 'mock-sign',
  sign_type: 'MD5',
}

describe('pay/notify', () => {
  beforeEach(() => {
    verifySign.mockReset()
    recordOrder.mockReset()
    markPaid.mockReset()
    alreadyPaid.mockReset()
  })

  describe('onRequestGet — 正常 GET 回调', () => {
    it('验签通过 + 未 paid + 金额匹配 → 200 + plain text "success" + 调 markPaid 1 次', async () => {
      verifySign.mockReturnValue(true)
      alreadyPaid.mockReturnValue(false)
      markPaid.mockReturnValue(true)

      const response = await onRequestGet({ request: makeGetRequest(successParams), env })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toBe('success')
      // parseFloat('0.10') === 0.1
      expect(markPaid).toHaveBeenCalledTimes(1)
      expect(markPaid).toHaveBeenCalledWith('TEST001', 0.1)
      // 回调不落单
      expect(recordOrder).not.toHaveBeenCalled()
      // Content-Type 不应被设（plain text 默认）
      // 验签用的 key
      expect(verifySign).toHaveBeenCalledWith(expect.anything(), 'test-key')
    })
  })

  describe('onRequestPost — 正常 POST 回调', () => {
    it('POST + form-urlencoded + 同上参数 → 200 + "success" + 调 markPaid 1 次', async () => {
      verifySign.mockReturnValue(true)
      alreadyPaid.mockReturnValue(false)
      markPaid.mockReturnValue(true)

      const response = await onRequestPost({ request: makePostRequest(successParams), env })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toBe('success')
      expect(markPaid).toHaveBeenCalledTimes(1)
      expect(markPaid).toHaveBeenCalledWith('TEST001', 0.1)
      expect(recordOrder).not.toHaveBeenCalled()
    })
  })

  describe('onRequestGet — 验签失败', () => {
    it('verifySign 返 false → 400 + body 含 "sign" + 不调 markPaid/alreadyPaid', async () => {
      verifySign.mockReturnValue(false)

      const response = await onRequestGet({ request: makeGetRequest(successParams), env })
      const text = await response.text()

      expect(response.status).toBe(400)
      expect(text.toLowerCase()).toContain('sign')
      expect(markPaid).not.toHaveBeenCalled()
      expect(alreadyPaid).not.toHaveBeenCalled()
      expect(recordOrder).not.toHaveBeenCalled()
    })
  })

  describe('onRequestGet — 重复通知幂等（已 paid）', () => {
    it('alreadyPaid 返 true → 200 + "success" + 不调 markPaid（避免重复处理）', async () => {
      verifySign.mockReturnValue(true)
      alreadyPaid.mockReturnValue(true)

      const response = await onRequestGet({ request: makeGetRequest(successParams), env })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toBe('success')
      expect(markPaid).not.toHaveBeenCalled()
    })
  })

  describe('onRequestGet — 金额不匹配', () => {
    it('markPaid 返 false（amount mismatch）→ 400 + body 含 amount/mismatch', async () => {
      verifySign.mockReturnValue(true)
      alreadyPaid.mockReturnValue(false)
      markPaid.mockReturnValue(false) // 内部 amount mismatch

      const response = await onRequestGet({ request: makeGetRequest(successParams), env })
      const text = await response.text()

      expect(response.status).toBe(400)
      expect(text.toLowerCase()).toMatch(/amount|mismatch/)
      // markPaid 仍被调（mismatch 在 markPaid 内部判定），但不能返 success
      expect(markPaid).toHaveBeenCalledTimes(1)
    })
  })

  describe('onRequestGet — 非 TRADE_SUCCESS 状态', () => {
    it('trade_status=WAIT_BUYER_PAY → 早 ack 200 "success" + 不调 markPaid/alreadyPaid', async () => {
      verifySign.mockReturnValue(true)
      const waitParams = { ...successParams, trade_status: 'WAIT_BUYER_PAY' }

      const response = await onRequestGet({ request: makeGetRequest(waitParams), env })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toBe('success')
      expect(markPaid).not.toHaveBeenCalled()
      expect(alreadyPaid).not.toHaveBeenCalled()
    })
  })

  describe('onRequestGet — out_trade_no 缺失', () => {
    it('回调 params 缺 out_trade_no → 400 + 不调 markPaid/alreadyPaid（防 markPaid(undefined, ...) 触发金额校验崩溃）', async () => {
      // 背景:tsconfig 启用了 noUncheckedIndexedAccess,Record<string, string> 的
      // params.out_trade_no 类型是 string | undefined。修复前 TS2345 编译失败,
      // 运行时 markPaid(undefined, ...) 会让 notify 链路 100% 失败。
      // 跟 query-order.ts 缺 outTradeNo 返 400 一致。
      // 必须 set verifySign=true 让代码路径走到 outTradeNo 那行（否则假阳性:
      // verifySign 返 undefined → !undefined=true → 提前返 400 'sign error'）
      verifySign.mockReturnValue(true)
      const paramsWithoutOutTradeNo: Record<string, string> = {
        pid: 'test-pid',
        type: 'wxpay',
        // out_trade_no 故意缺失 — 模拟 Z-Pay 字段缺失或恶意构造
        name: 'product',
        money: '0.10',
        trade_status: 'TRADE_SUCCESS',
        trade_no: 'ZPAYTEST123',
        sign: 'mock-sign',
        sign_type: 'MD5',
      }

      const response = await onRequestGet({ request: makeGetRequest(paramsWithoutOutTradeNo), env })
      const text = await response.text()

      expect(response.status).toBe(400)
      expect(markPaid).not.toHaveBeenCalled()
      expect(alreadyPaid).not.toHaveBeenCalled()
    })
  })
})
