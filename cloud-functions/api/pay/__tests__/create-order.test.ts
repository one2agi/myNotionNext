// @ts-nocheck  (项目没装 @types/jest，jest.MockedFunction / describe / expect 等类型缺失，运行时由 jest 提供)
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/**
 * cloud-functions/api/pay/create-order.ts — 集成测试（TDD Red 阶段）
 *
 * 测试策略：
 * - mock `lib/zpay.js` 的 `createNativeOrder`（不能真打 zpayz.cn）
 * - 用 plain object mock 喂 request（jsdom env 没有 Request global，handler 只用 .json()）
 * - 真实 `products.config.js`（零依赖，纯静态数据，monkey-patch 收益小）
 *
 * 覆盖 4 个分支：
 *   1. 正常下单（50 分 → money "0.50" 元，调 createNativeOrder，返 200 + 完整字段）
 *   2. 缺 env（ZPAY_PID 空 → 500 + error 含 "ZPAY_PID" / "Missing env"，不调 createNativeOrder）
 *   3. 商品未找到（productId 不存在 → 400 + error 含 "Unknown" / "not found"，不调 createNativeOrder）
 *   4. 商品免费（starter-free price=0 → 400 + error 含 "free" / "unpaid"，不调 createNativeOrder）
 */

// 关键：jest.mock 路径 = 从测试文件位置到被 mock 模块的相对路径
// 测试文件: cloud-functions/api/pay/__tests__/create-order.test.ts
// 目标模块: lib/zpay.js
// 相对路径: ../../../lib/zpay.js
jest.mock('../../../../lib/zpay.js', () => ({
  createNativeOrder: jest.fn(),
}))

// 关键：jest.mock 路径 = 从测试文件位置到被 mock 模块的相对路径
// 测试文件: cloud-functions/api/pay/__tests__/create-order.test.ts
// 目标模块: lib/order-store.js
// 相对路径: ../../../lib/order-store.js（与 lib/zpay.js 同级）
// 背景: lib/order-store.recordOrder 在 notify.ts 链路上被 markPaid / alreadyPaid
// 读 store.get(outTradeNo) 命中已存在记录才能做金额比对；create-order 必须先
// 调 recordOrder(outTradeNo, product.price) 落单，否则 notify 100% 失败。
jest.mock('../../../../lib/order-store.js', () => ({
  recordOrder: jest.fn(),
}))

// jsdom env 缺 Response / TextEncoder。
// 写一个 minimal Response polyfill（项目不允许加新依赖；undici 也没装）。
// handler 用法是 new Response(body, {status, headers}) + .json() / .status
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

// 必须 import 完 mock 才能 import 被测模块（jest 自动 hoist jest.mock，但显式 import 在前更易读）
import { onRequestPost } from '../create-order'
import { createNativeOrder } from '../../../../lib/zpay.js'
import { recordOrder } from '../../../../lib/order-store.js'

const mockedCreateNativeOrder =
  createNativeOrder as jest.MockedFunction<typeof createNativeOrder>

const mockedRecordOrder = recordOrder as unknown as jest.Mock

const FULL_ENV = {
  ZPAY_PID: 'test-pid-12345',
  ZPAY_KEY: 'test-key-secret',
  ZPAY_NOTIFY_URL: 'https://example.com/api/pay/notify',
}

/**
 * 构造 mock Request（plain object，handler 只用 .json()）
 * 用 plain object 而非 new Request() 的原因：jsdom env 没有 Request global，
 * 切到 node env 会被 jest.setup.js 的 window.matchMedia 拦掉。plain mock 等价。
 */
function makeRequest(body: unknown): any {
  return {
    json: jest.fn().mockResolvedValue(body),
  }
}

async function readJson(response: Response): Promise<any> {
  return await response.json()
}

describe('onRequestPost (cloud-functions/api/pay/create-order)', () => {
  beforeEach(() => {
    // 每个 case 前重置 mock 状态（jest.setup.js 的 clearMocks 也会清，但显式更清晰）
    mockedCreateNativeOrder.mockReset()
    mockedRecordOrder.mockReset()
  })

  it('1. 正常下单: env 完整 + starter-full (50 分) → 200 + 完整字段 + money "0.50" 元 + name 是商品名', async () => {
    mockedCreateNativeOrder.mockResolvedValue({
      outTradeNo: 'mock-123',
      tradeNo: 'ZPAY456',
      qrcode: 'weixin://wxpay/bizpayurl?pr=MOCK',
      imgUrl: 'https://zpayz.cn/qrcode/mock.jpg',
      payurl: 'https://zpayz.cn/pay/wxpay/MOCK/',
    })

    const request = makeRequest({ productId: 'starter-full', customer: { name: '张三', email: 'a' + '@' + 'b.com' } })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body).toEqual(
      expect.objectContaining({
        outTradeNo: expect.any(String),
        qrcode: 'weixin://wxpay/bizpayurl?pr=MOCK',
        imgUrl: 'https://zpayz.cn/qrcode/mock.jpg',
        productId: 'starter-full',
        productName: '标准版',
        totalFen: 50,
      })
    )
    // outTradeNo 应非空（handler 内部生成）
    expect(body.outTradeNo.length).toBeGreaterThan(0)

    // createNativeOrder 调用断言
    expect(mockedCreateNativeOrder).toHaveBeenCalledTimes(1)
    const call = mockedCreateNativeOrder.mock.calls[0][0] as any
    expect(call.money).toBe('0.50') // 分 → 元 字符串, 2 位小数
    expect(call.name).toBe('标准版-张三') // H-4: 拼接 customer.name
    expect(call.notifyUrl).toBe(FULL_ENV.ZPAY_NOTIFY_URL)
    expect(call.env.ZPAY_PID).toBe(FULL_ENV.ZPAY_PID)
    expect(call.env.ZPAY_KEY).toBe(FULL_ENV.ZPAY_KEY)
  })

  it('2. 缺 env: ZPAY_PID 为空 → 500 + error 含 "ZPAY_PID" + 不调 createNativeOrder', async () => {
    const request = makeRequest({ productId: 'starter-full', customer: { name: '张三', email: 'a' + '@' + 'b.com' } })
    const response = await onRequestPost({
      request,
      env: { ...FULL_ENV, ZPAY_PID: '' },
      params: {},
    })

    expect(response.status).toBe(500)
    const body = await readJson(response)
    expect(body.error).toMatch(/ZPAY_PID|Missing env/i)
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
  })

  it('3. 商品未找到: productId "nonexistent" → 400 + error 含 "Unknown"/"not found" + 不调 createNativeOrder', async () => {
    const request = makeRequest({ productId: 'nonexistent', customer: { name: '张三', email: 'a' + '@' + 'b.com' } })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.error).toMatch(/Unknown|not found/i)
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
  })

  it('4. 商品未找到: starter-free (已删除) → 400 + error 含 "Unknown"/"not found"', async () => {
    // starter-free 已从 products.config.js 移除（改为付费三档）
    const request = makeRequest({ productId: 'starter-free', customer: { name: '张三', email: 'a' + '@' + 'b.com' } })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.error).toMatch(/Unknown|not found/i)
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
  })

  it('5. 落单: 调 createNativeOrder 前先 recordOrder(outTradeNo, product.price=50) 给 notify 金额校验用', async () => {
    // 回归测试:防 F1 CRITICAL（漏调 recordOrder 导致 notify 金额校验全失效）
    // notify.ts 内部 markPaid → store.get(outTradeNo) 必须命中已存在记录才能做金额比对，
    // 因此 create-order 必须先 recordOrder(outTradeNo, product.price) 落单。
    mockedCreateNativeOrder.mockResolvedValue({
      outTradeNo: 'mock-123',
      tradeNo: 'ZPAY456',
      qrcode: 'weixin://wxpay/bizpayurl?pr=MOCK',
      imgUrl: 'https://zpayz.cn/qrcode/mock.jpg',
      payurl: 'https://zpayz.cn/pay/wxpay/MOCK/',
    })

    const request = makeRequest({ productId: 'starter-full', customer: { name: '张三', email: 'a' + '@' + 'b.com' } })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(mockedRecordOrder).toHaveBeenCalledTimes(1)
    // 关键断言:recordOrder 的 outTradeNo 必须跟响应里返的 outTradeNo 一致
    //（即 create-order 内部生成的同一 outTradeNo 被同时用于落单和返 200）
    // + 第二参数必须是 product.price 的整数值 50（starter-full 标准版）
    // H-4: recordOrder 现在传 3 个参数 (outTradeNo, finalPriceFen, customerInfo)
    expect(mockedRecordOrder).toHaveBeenCalledWith(body.outTradeNo, 50, expect.objectContaining({ name: '张三', email: expect.any(String) }))
  })
})

// =====================================================================
// H-4 扩展: customer 必填校验 + discountCode 二次校验 + discountApplied 返参
// 见 docs/PAYMENT-FORM-DESIGN.md §2.3 + §8.1 + plan Task 4
// =====================================================================

jest.mock('../../../../lib/discount-codes', () => ({
  lookupDiscount: jest.fn(),
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

import {
  lookupDiscount,
  DiscountNotFoundError,
  DiscountDisabledError,
} from '../../../../lib/discount-codes'

const mockedLookupDiscount = lookupDiscount as jest.MockedFunction<typeof lookupDiscount>

describe('onRequestPost (create-order) — H-4 customer + discount', () => {
  beforeEach(() => {
    mockedCreateNativeOrder.mockReset()
    mockedRecordOrder.mockReset()
    mockedLookupDiscount.mockReset()
    // 默认 mock: 未命中抛 DiscountNotFoundError (代表 lib 内部 validateFormat 拒绝)
    mockedLookupDiscount.mockImplementation((code: string) => {
      throw new DiscountNotFoundError(code)
    })
  })

  it('6. 客户必填: body 无 customer → 400 + code=E_NAME_EMPTY + 不调 createNativeOrder', async () => {
    const request = makeRequest({ productId: 'starter-full' })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.code).toBe('E_NAME_EMPTY')
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
    expect(mockedRecordOrder).not.toHaveBeenCalled()
  })

  it('7. 邮箱格式: customer.email="not-an-email" → 400 + code=E_EMAIL_INVALID + 不调 createNativeOrder', async () => {
    const request = makeRequest({
      productId: 'starter-full',
      customer: { name: '张三', email: 'not-an-email' },
    })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.code).toBe('E_EMAIL_INVALID')
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
  })

  it('8. 客户名空: customer.name="   " (whitespace only) → 400 + code=E_NAME_EMPTY', async () => {
    const request = makeRequest({
      productId: 'starter-full',
      customer: { name: '   ', email: 'a' + '@' + 'b.com' },
    })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.code).toBe('E_NAME_EMPTY')
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
  })

  it('9. 优惠码未匹配: discountCode="UNKNOWN" + lookupDiscount 抛 DiscountNotFoundError → 400 + code=E_DC_NOT_FOUND', async () => {
    const request = makeRequest({
      productId: 'starter-full',
      customer: { name: '张三', email: 'a' + '@' + 'b.com' },
      discountCode: 'UNKNOWN',
    })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.code).toBe('E_DC_NOT_FOUND')
    expect(mockedLookupDiscount).toHaveBeenCalledWith('UNKNOWN')
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
  })

  it('10. 优惠码已禁用: discountCode="PARTNER02" + lookupDiscount 抛 DiscountDisabledError → 400 + code=E_DC_DISABLED', async () => {
    mockedLookupDiscount.mockImplementation(() => {
      throw new DiscountDisabledError('PARTNER02')
    })
    const request = makeRequest({
      productId: 'starter-full',
      customer: { name: '张三', email: 'a' + '@' + 'b.com' },
      discountCode: 'PARTNER02',
    })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.code).toBe('E_DC_DISABLED')
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
  })

  it('11. 优惠码命中: discountCode="PARTNER01" + discountPct=0 → 200 + 返 discountApplied{code, partnerName, discountPct, originalFen}', async () => {
    mockedLookupDiscount.mockReturnValue({
      partnerName: '张三的数码店',
      discountPct: 0,
      disabled: false,
    })
    mockedCreateNativeOrder.mockResolvedValue({
      outTradeNo: 'mock-123',
      tradeNo: 'ZPAY456',
      qrcode: 'weixin://wxpay/bizpayurl?pr=MOCK',
      imgUrl: 'https://zpayz.cn/qrcode/mock.jpg',
      payurl: 'https://zpayz.cn/pay/wxpay/MOCK/',
    })

    const request = makeRequest({
      productId: 'starter-full',
      customer: { name: '张三', email: 'a' + '@' + 'b.com' },
      discountCode: 'PARTNER01',
    })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.discountApplied).toEqual({
      code: 'PARTNER01',
      partnerName: '张三的数码店',
      discountPct: 0,
      originalFen: 50,
    })
    // discountPct=0 不变价,money 仍 0.50
    const call = mockedCreateNativeOrder.mock.calls[0][0] as any
    expect(call.money).toBe('0.50')
  })
})
