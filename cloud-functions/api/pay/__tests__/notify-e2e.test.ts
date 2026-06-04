// @ts-nocheck  (项目没装 @types/jest，jest.MockedFunction / describe / expect 等类型缺失，运行时由 jest 提供)
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/**
 * E2E: create-order → 真实 order-store → notify 全链路
 *
 * 目的：回归 security 评审 F1 (CRITICAL)
 *   "create-order.ts 漏调 recordOrder，notify 金额校验全失效"
 *
 * 跟 notify.test.ts 的区别：
 *   - notify.test.ts: 单测，全部 jest.mock (order-store / zpay)，只验控制流
 *   - notify-e2e.test.ts: 集成测,只 mock 外部 HTTP 边界 (zpay.verifySign / createNativeOrder)
 *     真实 order-store.js 走完整 recordOrder / markPaid / alreadyPaid 链路
 *     真实 products.config.js (测试金额 0.10/0.30 走 ¥0.10 starter-full)
 *
 * 用例:
 *   1. happy path: create-order + TRADE_SUCCESS notify → 200 'success'
 *   2. F1 regression: notify 回调从未 record 的 outTradeNo → 400 'amount mismatch'
 *      (如果 create-order 漏调 recordOrder,用例 1 也会 fail,根因明确)
 *   3. 幂等: 同一笔回调 2 次 → 都 200 'success'
 *   4. 金额错: ordered 0.10 但 callback 说 99.99 → 400
 *   5. 中间态: WAIT_BUYER_PAY 早 ack 200,后续 TRADE_SUCCESS 仍能 markPaid
 */

jest.mock('../../../../lib/zpay.js', () => ({
  verifySign: jest.fn().mockReturnValue(true),
  createNativeOrder: jest.fn().mockResolvedValue({
    qrcode: 'weixin://wxpay/bizpayurl?pr=fake',
    imgUrl: 'https://example.com/fake-qr.png',
  }),
}))

// 最小 Response 实现:同时支持 text() 和 json() (create-order 返 JSON,notify 返 plain text)
class FakeResponse {
  status: number
  private _body: string
  headers: Record<string, string>
  constructor(body: string = '', init: { status?: number; headers?: Record<string, string> } = {}) {
    this._body = body
    this.status = init.status ?? 200
    this.headers = init.headers || {}
  }
  async text(): Promise<string> {
    return this._body
  }
  async json(): Promise<any> {
    return JSON.parse(this._body)
  }
}
// 覆盖 jsdom test env 的 Response 全局 (EdgeOne Pages Cloud Function 走 globalThis.Response)
;(globalThis as any).Response = FakeResponse

// 最小 Request 实现:同时支持 url (notify GET 读 query string) + json() (create-order POST 读 body)
class FakeRequest {
  url: string
  private _body: string
  constructor(url: string, body: string = '') {
    this.url = url
    this._body = body
  }
  async json(): Promise<any> {
    return JSON.parse(this._body)
  }
  async formData(): Promise<URLSearchParams> {
    return new URLSearchParams(this._body)
  }
}

import { onRequestPost as createOrder } from '../create-order'
import { onRequestGet as notifyGet } from '../notify'

const ENV = {
  ZPAY_PID: 'test-pid-E2E',
  ZPAY_KEY: 'test-key-DO-NOT-LEAK',
  ZPAY_NOTIFY_URL: 'https://example.com/api/pay/notify',
} as Record<string, string>

async function placeOrder(productId: string): Promise<string> {
  const req = new FakeRequest(
    'https://example.com/api/pay/create-order',
    JSON.stringify({ productId })
  )
  const res = await createOrder({ request: req, env: ENV, params: {} } as any)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.outTradeNo).toBeTruthy()
  return body.outTradeNo
}

function notifyCallback(params: Record<string, string>): Promise<FakeResponse> {
  const qs = new URLSearchParams(params).toString()
  const url = `https://example.com/api/pay/notify?${qs}`
  return notifyGet({ request: new FakeRequest(url), env: ENV } as any) as Promise<FakeResponse>
}

describe('pay E2E — create-order recordOrder → notify markPaid', () => {
  it('1. happy path: order then TRADE_SUCCESS notify → 200 "success"', async () => {
    const outTradeNo = await placeOrder('starter-full')
    const res = await notifyCallback({
      out_trade_no: outTradeNo,
      money: '0.10',
      trade_status: 'TRADE_SUCCESS',
      sign: 'x',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('success')
  })

  it('2. F1 regression: notify for an outTradeNo never recorded → 400 amount mismatch', async () => {
    // 不调 placeOrder,直接 notify 一个虚假 outTradeNo
    // order-store 内部 store.get(...) 返 undefined → markPaid 返 false → 400
    // 这正是 F1 (CRITICAL) 漏掉的链路
    const res = await notifyCallback({
      out_trade_no: 'never-recorded-' + Date.now(),
      money: '0.10',
      trade_status: 'TRADE_SUCCESS',
      sign: 'x',
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/mismatch/)
  })

  it('3. idempotent: replay TRADE_SUCCESS → second call still 200 "success"', async () => {
    const outTradeNo = await placeOrder('starter-full')
    const params = {
      out_trade_no: outTradeNo,
      money: '0.10',
      trade_status: 'TRADE_SUCCESS',
      sign: 'x',
    }
    const r1 = await notifyCallback(params)
    expect(r1.status).toBe(200)
    const r2 = await notifyCallback(params)
    expect(r2.status).toBe(200)
    expect(await r2.text()).toBe('success')
  })

  it('4. wrong amount: ordered 0.10 but callback says 99.99 → 400', async () => {
    const outTradeNo = await placeOrder('starter-full')
    const res = await notifyCallback({
      out_trade_no: outTradeNo,
      money: '99.99',
      trade_status: 'TRADE_SUCCESS',
      sign: 'x',
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('amount mismatch')
  })

  it('5. intermediate state: WAIT_BUYER_PAY early-ack 200, then TRADE_SUCCESS still works', async () => {
    const outTradeNo = await placeOrder('starter-full')
    // 中间态: 早 ack,但不 markPaid
    const r1 = await notifyCallback({
      out_trade_no: outTradeNo,
      money: '0.10',
      trade_status: 'WAIT_BUYER_PAY',
      sign: 'x',
    })
    expect(r1.status).toBe(200)
    // 后续 TRADE_SUCCESS 仍能正常 markPaid
    const r2 = await notifyCallback({
      out_trade_no: outTradeNo,
      money: '0.10',
      trade_status: 'TRADE_SUCCESS',
      sign: 'x',
    })
    expect(r2.status).toBe(200)
    expect(await r2.text()).toBe('success')
  })
})
