// @ts-nocheck  (项目没装 @types/jest)
jest.mock('../../../../lib/zpay.js', () => ({
  verifySign: jest.fn(),
}))

jest.mock('../../../../lib/order-store.js', () => ({
  alreadyPaid: jest.fn(() => false),
  markPaid: jest.fn(() => true),
  getOrder: jest.fn(() => ({
    customerInfo: { name: '张三', email: 'test@example.com', discountCode: 'PARTNER01', partnerName: '张三的数码店' }
  })),
}))

// jsdom test env 缺 Response global
class FakeResponse {
  status: number
  private _body: string
  constructor(body: string = '', init: { status?: number } = {}) {
    this._body = body
    this.status = init.status ?? 200
  }
  async text(): Promise<string> { return this._body }
  async json(): Promise<any> { return JSON.parse(this._body) }
}
;(globalThis as any).Response = FakeResponse

// Sentry mock
const mockCaptureMessage = jest.fn()
;(globalThis as any).__testSentryCapture = mockCaptureMessage

import { onRequestGet } from '../notify'
import { verifySign as verifySignReal } from '../../../../lib/zpay.js'
import {
  markPaid as markPaidReal,
  alreadyPaid as alreadyPaidReal,
  getOrder as getOrderReal,
} from '../../../../lib/order-store.js'

const verifySign = verifySignReal as unknown as jest.Mock
const markPaid = markPaidReal as unknown as jest.Mock
const alreadyPaid = alreadyPaidReal as unknown as jest.Mock
const getOrder = getOrderReal as unknown as jest.Mock

const ENV = {
  ZPAY_PID: 'test-pid',
  ZPAY_KEY: 'test-key',
  ZPAY_NOTIFY_URL: 'https://example.com/api/pay/notify',
  NOTION_TOKEN: 'test-notion-token',
  NOTION_DATABASE_ID: 'de84f4cf-c8e2-83dc-a33c-873e7f83f872',
} as Record<string, string>

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

function makeNotifyRequest(): FakeRequest {
  const params = new URLSearchParams({
    out_trade_no: 'TEST001',
    money: '0.10',
    trade_status: 'TRADE_SUCCESS',
    sign: 'mocksign',
    pid: 'test-pid',
  })
  return new FakeRequest(`https://example.com/api/pay/notify?${params.toString()}`)
}

describe('notify.ts direct Notion API (H-5 simplified)', () => {
  beforeEach(() => {
    mockCaptureMessage.mockReset()
    verifySign.mockReset().mockReturnValue(true)
    markPaid.mockReset().mockReturnValue(true)
    alreadyPaid.mockReset().mockReturnValue(false)
    getOrder.mockReset().mockReturnValue({
      customerInfo: { name: '张三', email: 'test@example.com', discountCode: 'PARTNER01', partnerName: '张三的数码店', productName: '基础版' }
    })
  })

  it('1. Notion API fetch called with correct headers and body after markPaid', async () => {
    const mockRes = new FakeResponse(JSON.stringify({ id: 'new-page-id', object: 'page' }), { status: 200 })
    const mockFetch = jest.fn().mockResolvedValue(mockRes)
    ;(globalThis as any).fetch = mockFetch

    const res = await onRequestGet({ request: makeNotifyRequest(), env: ENV })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('success')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, opts] = mockFetch.mock.calls[0] as [string, any]
    expect(url).toBe('https://api.notion.com/v1/pages')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Authorization']).toBe('Bearer test-notion-token')
    expect(opts.headers['Notion-Version']).toBe('2025-09-03')
    expect(opts.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(opts.body)
    expect(body.parent.database_id).toBe('de84f4cf-c8e2-83dc-a33c-873e7f83f872')
    expect(body.properties.Name.title[0].text.content).toBe('张三')
    expect(body.properties['客户邮箱'].email).toBe('test@example.com')
    expect(body.properties['订单号'].rich_text[0].text.content).toBe('TEST001')
    expect(body.properties['状态'].status.name).toBe('待发送')
  })

  it('2. fetch fails → still returns 200 to Z-Pay', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('network error'))
    ;(globalThis as any).fetch = mockFetch

    const res = await onRequestGet({ request: makeNotifyRequest(), env: ENV })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('success')
  })

  it('3. Notion API returns 500 → Sentry warning, still 200 to Z-Pay', async () => {
    const mockRes = new FakeResponse('server error', { status: 500 })
    const mockFetch = jest.fn().mockResolvedValue(mockRes)
    ;(globalThis as any).fetch = mockFetch

    const res = await onRequestGet({ request: makeNotifyRequest(), env: ENV })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('success')
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
    const [msg, level] = mockCaptureMessage.mock.calls[0] as [string, string]
    expect(msg).toContain('E_NOTIFY_HTTP 500')
    expect(level).toBe('warning')
  })

  it('4. markPaid false → not200 → no Notion fetch', async () => {
    markPaid.mockReturnValueOnce(false)
    const mockFetch = jest.fn()
    ;(globalThis as any).fetch = mockFetch

    const res = await onRequestGet({ request: makeNotifyRequest(), env: ENV })

    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('5. already paid → returns 200 immediately, no fetch', async () => {
    alreadyPaid.mockReturnValueOnce(true)
    const mockFetch = jest.fn()
    ;(globalThis as any).fetch = mockFetch

    const res = await onRequestGet({ request: makeNotifyRequest(), env: ENV })

    expect(res.status).toBe(200)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})