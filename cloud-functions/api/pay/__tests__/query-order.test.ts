// @ts-nocheck  (项目没装 @types/jest，jest.MockedFunction / describe / expect 等类型缺失，运行时由 jest 提供)
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/**
 * cloud-functions/api/pay/query-order.ts — 集成测试
 *
 * 测试策略（不直接 mock fetch，mock lib/zpay.js 的 queryOrder 即可）：
 *   - mock lib/zpay.js → 完全控制 queryOrder 行为，避免依赖真实 Z-Pay
 *   - 注入 mock env (ZPAY_PID / ZPAY_KEY) → 验证 env 正确透传给 lib
 *   - 喂入 mock Request (GET + searchParams) → 验证 onRequestGet 解析 / 路由
 *
 * 关键约束（与 create-order.test 同源，必须 100% 覆盖）：
 *   - ZPAY_KEY / ZPAY_PID 绝不能出现在**响应体**里（防泄漏到前端）
 *   - 响应体必须**白名单过滤**：只返 status / money / tradeNo / msg
 *   - 缺 outTradeNo → 400 + 不调 queryOrder
 *   - env 注入是 {ZPAY_PID, ZPAY_KEY} 两个字段，**不**多不少
 */

// jsdom env 没有原生 Request/Response/Headers — 用极简 polyfill
// （实现里只用 request.url；测试里只需要 status / headers.get / json，足够）
class PolyRequest {
  url: string
  method: string
  constructor(url: string, init?: { method?: string }) {
    this.url = url
    this.method = init?.method ?? 'GET'
  }
}
class PolyHeaders {
  private map = new Map<string, string>()
  constructor(init?: Record<string, string>) {
    if (init) for (const [k, v] of Object.entries(init)) this.map.set(k.toLowerCase(), v)
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null
  }
}
class PolyResponse {
  status: number
  headers: PolyHeaders
  private body: string
  constructor(body?: BodyInit | null, init?: { status?: number; headers?: Record<string, string> }) {
    this.body = typeof body === 'string' ? body : ''
    this.status = init?.status ?? 200
    this.headers = new PolyHeaders(init?.headers)
  }
  async json(): Promise<any> {
    return JSON.parse(this.body)
  }
  async text(): Promise<string> {
    return this.body
  }
}
;(globalThis as any).Request = PolyRequest
;(globalThis as any).Response = PolyResponse
;(globalThis as any).Headers = PolyHeaders

jest.mock('../../../../lib/zpay.js', () => ({
  queryOrder: jest.fn()
}))

// 必须在 jest.mock 之后 import（jest 才会把 mock 工厂注入到模块）
import { onRequestGet } from '../query-order'
import { queryOrder } from '../../../../lib/zpay.js'

const mockedQueryOrder = queryOrder as jest.MockedFunction<typeof queryOrder>

const ENV = {
  ZPAY_PID: 'test-pid-12345',
  ZPAY_KEY: 'test-key-DO-NOT-LEAK'
}

function makeRequest(outTradeNo?: string): Request {
  const url = outTradeNo
    ? `https://example.com/api/pay/query-order?outTradeNo=${outTradeNo}`
    : 'https://example.com/api/pay/query-order'
  return new Request(url, { method: 'GET' })
}

beforeEach(() => {
  mockedQueryOrder.mockReset()
})

describe('cloud-functions/api/pay/query-order', () => {
  describe('正常查询', () => {
    it('返 200 + 白名单字段（status / money / tradeNo / msg）', async () => {
      mockedQueryOrder.mockResolvedValueOnce({
        code: 1,
        status: 1,
        money: '0.10',
        trade_no: 'ZPAY123',
        out_trade_no: 'TEST001',
        msg: 'ok',
        pid: 'leaked-pid-XXXXX'  // 故意加额外字段，验证被过滤
      } as any)

      const response = await onRequestGet({ request: makeRequest('TEST001'), env: ENV })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toMatch(/application\/json/)

      const body = await response.json()
      // 必含的 4 个白名单字段
      expect(body).toEqual({
        status: 1,
        money: '0.10',
        tradeNo: 'ZPAY123',  // 注意：从 trade_no 映射成 tradeNo
        msg: 'ok'
      })
    })

    it('响应体不包含 Z-Pay 原始字段（code / out_trade_no / trade_no / pid）', async () => {
      mockedQueryOrder.mockResolvedValueOnce({
        code: 1,
        status: 1,
        money: '0.10',
        trade_no: 'ZPAY999',
        out_trade_no: 'TEST002',
        msg: 'ok',
        pid: 'should-be-filtered'
      } as any)

      const response = await onRequestGet({ request: makeRequest('TEST002'), env: ENV })
      const body = await response.json()
      const keys = Object.keys(body).sort()
      // 严格断言：只允许这 4 个 key
      expect(keys).toEqual(['money', 'msg', 'status', 'tradeNo'])
    })

    it('调用 queryOrder 1 次，参数 { outTradeNo, env }', async () => {
      mockedQueryOrder.mockResolvedValueOnce({
        code: 1,
        status: 0,
        money: '0.10',
        trade_no: 't',
        msg: 'ok'
      } as any)

      await onRequestGet({ request: makeRequest('TEST003'), env: ENV })

      expect(mockedQueryOrder).toHaveBeenCalledTimes(1)
      expect(mockedQueryOrder).toHaveBeenCalledWith({
        outTradeNo: 'TEST003',
        env: ENV
      })
    })

    it('env 注入是 {ZPAY_PID, ZPAY_KEY} 两个字段（lib 契约），其余字段透传但不影响签名', async () => {
      mockedQueryOrder.mockResolvedValueOnce({
        code: 1,
        status: 0,
        money: '0.10',
        trade_no: 't',
        msg: 'ok'
      } as any)

      // lib/zpay.js 的契约：env 至少含 ZPAY_PID + ZPAY_KEY（这俩是签名必需）
      // 其它字段透传给 lib 也不会被使用，handler 不应过滤
      const env = {
        ZPAY_PID: 'pid-A',
        ZPAY_KEY: 'key-A'
      }

      await onRequestGet({ request: makeRequest('X'), env })

      const callArgs = mockedQueryOrder.mock.calls[0][0]
      // 关键契约：ZPAY_PID 和 ZPAY_KEY 必须原样透传
      expect(callArgs.env.ZPAY_PID).toBe('pid-A')
      expect(callArgs.env.ZPAY_KEY).toBe('key-A')
    })
  })

  describe('缺 outTradeNo', () => {
    it('返 400 + body 含 error 字段提及 outTradeNo', async () => {
      const response = await onRequestGet({ request: makeRequest(), env: ENV })
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBeDefined()
      expect(body.error.toLowerCase()).toContain('outtradeno')
    })

    it('不调用 queryOrder', async () => {
      await onRequestGet({ request: makeRequest(), env: ENV })
      expect(mockedQueryOrder).not.toHaveBeenCalled()
    })

    it('空字符串 outTradeNo 也返 400', async () => {
      const url = 'https://example.com/api/pay/query-order?outTradeNo='
      const request = new Request(url, { method: 'GET' })
      const response = await onRequestGet({ request, env: ENV })
      expect(response.status).toBe(400)
      expect(mockedQueryOrder).not.toHaveBeenCalled()
    })
  })

  describe('防御性 — 响应体不泄漏 ZPAY_KEY / ZPAY_PID', () => {
    it('即使 lib 返回的对象里塞了 KEY 字样，响应 JSON 也 grep 不到', async () => {
      // 现实里 queryOrder 不会返回这种对象（lib 返回的是 Z-Pay 原始响应），
      // 但我们白名单过滤必须对**任何**输入都安全。
      mockedQueryOrder.mockResolvedValueOnce({
        code: 1,
        status: 1,
        money: '0.10',
        trade_no: 't',
        msg: 'ok',
        // 假装有人（lib bug / 升级 / 注入）让 queryOrder 把 key 也带回来
        ZPAY_KEY: ENV.ZPAY_KEY,
        secret: 'test-key-DO-NOT-LEAK'
      } as any)

      const response = await onRequestGet({ request: makeRequest('TEST004'), env: ENV })
      const body = await response.json()
      const bodyStr = JSON.stringify(body)
      expect(bodyStr).not.toMatch(/test-key|ZPAY_KEY|DO-NOT-LEAK/)
    })
  })
})
