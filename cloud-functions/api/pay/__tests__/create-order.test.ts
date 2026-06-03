/**
 * cloud-functions/api/pay/create-order.ts — 集成测试（TDD Red 阶段）
 *
 * 测试策略：
 * - mock `lib/zpay.js` 的 `createNativeOrder`（不能真打 zpayz.cn）
 * - 用 plain object mock 喂 request（jsdom env 没有 Request global，handler 只用 .json()）
 * - 真实 `products.config.js`（零依赖，纯静态数据，monkey-patch 收益小）
 *
 * 覆盖 4 个分支：
 *   1. 正常下单（10 分 → money "0.10" 元，调 createNativeOrder，返 200 + 完整字段）
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

// 旧 create-order.ts 顶部 import '@edgeone/pages-blob'，新实现删掉这个 import 后这个 mock 也不需要
// （保留无副作用，纯粹是 test-runner compatibility 兜底）
jest.mock('@edgeone/pages-blob', () => ({
  getStore: jest.fn(),
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

const mockedCreateNativeOrder =
  createNativeOrder as jest.MockedFunction<typeof createNativeOrder>

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
  })

  it('1. 正常下单: env 完整 + starter-full (10 分) → 200 + 完整字段 + money "0.10" 元 + name 是商品名', async () => {
    mockedCreateNativeOrder.mockResolvedValue({
      outTradeNo: 'mock-123',
      tradeNo: 'ZPAY456',
      qrcode: 'weixin://wxpay/bizpayurl?pr=MOCK',
      imgUrl: 'https://zpayz.cn/qrcode/mock.jpg',
      payurl: 'https://zpayz.cn/pay/wxpay/MOCK/',
    })

    const request = makeRequest({ productId: 'starter-full' })
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
        productName: '知行合一 · 完整版',
        totalFen: 10,
      })
    )
    // outTradeNo 应非空（handler 内部生成）
    expect(body.outTradeNo.length).toBeGreaterThan(0)

    // createNativeOrder 调用断言
    expect(mockedCreateNativeOrder).toHaveBeenCalledTimes(1)
    const call = mockedCreateNativeOrder.mock.calls[0][0] as any
    expect(call.money).toBe('0.10') // 分 → 元 字符串, 2 位小数
    expect(call.name).toBe('知行合一 · 完整版') // 短商品名, 127 截断不生效
    expect(call.notifyUrl).toBe(FULL_ENV.ZPAY_NOTIFY_URL)
    expect(call.env.ZPAY_PID).toBe(FULL_ENV.ZPAY_PID)
    expect(call.env.ZPAY_KEY).toBe(FULL_ENV.ZPAY_KEY)
  })

  it('2. 缺 env: ZPAY_PID 为空 → 500 + error 含 "ZPAY_PID" + 不调 createNativeOrder', async () => {
    const request = makeRequest({ productId: 'starter-full' })
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
    const request = makeRequest({ productId: 'nonexistent' })
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

  it('4. 商品免费: starter-free (price=0) → 400 + error 含 "free"/"unpaid" + 不调 createNativeOrder', async () => {
    const request = makeRequest({ productId: 'starter-free' })
    const response = await onRequestPost({
      request,
      env: FULL_ENV,
      params: {},
    })

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.error).toMatch(/free|unpaid/i)
    expect(mockedCreateNativeOrder).not.toHaveBeenCalled()
  })
})
