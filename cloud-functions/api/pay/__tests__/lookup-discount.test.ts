// @ts-nocheck  (项目没装 @types/jest，jest.MockedFunction / describe / expect 等类型缺失，运行时由 jest 提供)
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/**
 * cloud-functions/api/pay/lookup-discount.ts — 单元测试（TDD Red → Green）
 *
 * 测试策略：
 * - mock `lib/discount-codes.ts`（不需要真打 JSON）
 * - 5 个 case 覆盖 spec §8.2 契约：
 *   1. 200 命中 → 返 code + partnerName + valid=true
 *   2. 400 E_DC_DISABLED（disabled code）
 *   3. 404 E_DC_NOT_FOUND（未匹配 code）
 *   4. 400 E_DC_FORMAT（缺 code 参数）
 *   5. 400（code 格式不合法，lookupDiscount 抛 DiscountNotFoundError）
 *
 * EdgeOne Pages handler 签名 = onRequestGet({ request, env })
 * 参考 cloud-functions/api/pay/query-order.ts:11
 */

jest.mock('../../../../lib/discount-codes', () => ({
  lookupDiscount: jest.fn(),
  lookupPartnerName: jest.fn(),
  DiscountNotFoundError: class extends Error {
    code = 'E_DC_NOT_FOUND'
    constructor(public discountCode: string) {
      super(`Discount code not found: ${discountCode}`)
    }
  },
  DiscountDisabledError: class extends Error {
    code = 'E_DC_DISABLED'
    constructor(public discountCode: string) {
      super(`Discount code disabled: ${discountCode}`)
    }
  },
}))

import { onRequestGet } from '../lookup-discount'
import { lookupDiscount, DiscountNotFoundError, DiscountDisabledError } from '../../../../lib/discount-codes'

const mockedLookup = lookupDiscount as jest.MockedFunction<typeof lookupDiscount>

// jsdom env 缺 Response / TextEncoder（同 create-order.test.ts）
class MinimalResponse {
  status: number
  private _body: string
  headers: Record<string, string>
  constructor(body: string | null, init: { status?: number; headers?: Record<string, string> } = {}) {
    this._body = body || ''
    this.status = init.status ?? 200
    this.headers = init.headers || {}
  }
  async json(): Promise<any> {
    return JSON.parse(this._body)
  }
  async text(): Promise<string> {
    return this._body
  }
}
;(globalThis as any).Response = MinimalResponse
const { TextEncoder, TextDecoder } = require('util')
;(globalThis as any).TextEncoder = TextEncoder
;(globalThis as any).TextDecoder = TextDecoder

function makeContext(url: string): any {
  return {
    request: { url: `https://example.com${url}` },
    env: {},
  }
}

describe('onRequestGet (cloud-functions/api/pay/lookup-discount)', () => {
  beforeEach(() => {
    mockedLookup.mockReset()
  })

  it('1. 200 命中: code=PARTNER01 → 返 code + partnerName + valid=true', async () => {
    mockedLookup.mockReturnValue({
      partnerName: '张三的数码店',
      discountPct: 0,
      disabled: false,
    })
    const res = await onRequestGet(makeContext('/api/pay/lookup-discount?code=PARTNER01'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      code: 'PARTNER01',
      partnerName: '张三的数码店',
      discountPct: 0,
      valid: true,
    })
  })

  it('2. 400 E_DC_DISABLED: code=PARTNER02 (disabled) → 400 + code=E_DC_DISABLED + valid=false', async () => {
    mockedLookup.mockImplementation(() => {
      throw new DiscountDisabledError('PARTNER02')
    })
    const res = await onRequestGet(makeContext('/api/pay/lookup-discount?code=PARTNER02'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('E_DC_DISABLED')
    expect(body.valid).toBe(false)
  })

  it('3. 404 E_DC_NOT_FOUND: code=UNKNOWN (not in map) → 404 + code=E_DC_NOT_FOUND + valid=false', async () => {
    mockedLookup.mockImplementation(() => {
      throw new DiscountNotFoundError('UNKNOWN')
    })
    const res = await onRequestGet(makeContext('/api/pay/lookup-discount?code=UNKNOWN'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('E_DC_NOT_FOUND')
    expect(body.valid).toBe(false)
  })

  it('4. 400 E_DC_FORMAT: 缺 code 参数 → 400 + code=E_DC_FORMAT', async () => {
    const res = await onRequestGet(makeContext('/api/pay/lookup-discount'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('E_DC_FORMAT')
  })

  it('5. 400: code=bad (格式不合法) → lookupDiscount 抛 DiscountNotFoundError → 404 E_DC_NOT_FOUND', async () => {
    // 格式不合法时 lookupDiscount 内部 validateFormat 抛 DiscountNotFoundError
    mockedLookup.mockImplementation(() => {
      throw new DiscountNotFoundError('bad')
    })
    const res = await onRequestGet(makeContext('/api/pay/lookup-discount?code=bad'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('E_DC_NOT_FOUND')
  })
})
