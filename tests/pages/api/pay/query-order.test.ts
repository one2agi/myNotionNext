/**
 * Unit tests: pages/api/pay/query-order.ts
 *
 * Test coverage:
 * - order-store hit + paid/unpaid → 返 paid 状态
 * - order-store miss + Notion hit → fallback 返 paid
 * - order-store miss + Notion miss → 404 E_ORDER_NOT_FOUND
 * - Notion API error → 500 E_NOTION_FAIL
 * - 缺 outTradeNo → 400 E_PARAM_MISSING
 * - outTradeNo 含特殊字符 → 400 E_PARAM_INVALID (H1 修复)
 * - Origin 缺失/跨域 → 403 E_ORIGIN_FORBIDDEN (H1 修复)
 * - IP 限速触发 → 429 E_RATE_LIMITED (H1 修复)
 * - POST method → 405 E_METHOD_NOT_ALLOWED
 */

import { orderStore } from '@/lib/order-store'
import { _resetRateLimit } from '@/lib/security'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const mockOrderStoreGet = (outTradeNo: string, record: Record<string, unknown> | undefined) => {
  jest.spyOn(orderStore, 'get').mockImplementation((key: string) => {
    if (key === outTradeNo) return record as ReturnType<typeof orderStore.get>
    return undefined
  })
}

const mockNotionQuery = (response: { results: Array<{ properties: Record<string, unknown> }> }, ok = true) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(response),
  })
}

/** 标准请求头（通过 Origin 校验） */
const VALID_HEADERS = { origin: 'https://www.one2agi.com' }

// ─── Test cases ───────────────────────────────────────────────────────────────

describe('GET /api/pay/query-order', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>

  beforeEach(() => {
    // 不调用 jest.resetModules() — 让 spy 直接作用在共享的 orderStore 对象上
    _resetRateLimit()
    // Mock order-store
    mockOrderStoreGet('trade-001', undefined)
    mockNotionQuery({ results: [] })
    // dev 模式：允许 localhost
    process.env.NODE_ENV = 'test'
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('order-store hit', () => {
    test('returns paid=false when order not paid', async () => {
      mockOrderStoreGet('trade-001', {
        outTradeNo: 'trade-001',
        productId: 'starter-full',
        productName: '基础版',
        customerName: '张三',
        customerEmail: 'test@test.com',
        totalPrice: 79,
        finalPrice: 69,
        paid: false,
        paidAt: undefined,
        discountAmount: 10,
        discountCode: 'SAVE10',
        createdAt: Date.now(),
        cancelled: false,
      })

      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: { outTradeNo: 'trade-001' }, headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 0,
        data: expect.objectContaining({
          outTradeNo: 'trade-001',
          paid: false,
          paidAt: null,
          productName: '基础版',
          finalPrice: 69,
          unit: '元',
        }),
      }))
    })

    test('returns paid=true with paidAt when order is paid', async () => {
      mockOrderStoreGet('trade-002', {
        outTradeNo: 'trade-002',
        productId: 'starter-full',
        productName: '基础版',
        customerName: '张三',
        customerEmail: 'test@test.com',
        totalPrice: 79,
        finalPrice: 79,
        paid: true,
        paidAt: '2026-06-14',
        createdAt: Date.now(),
        cancelled: false,
      })

      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: { outTradeNo: 'trade-002' }, headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 0,
        data: expect.objectContaining({
          outTradeNo: 'trade-002',
          paid: true,
          paidAt: '2026-06-14',
        }),
      }))
    })
  })

  describe('order-store miss → Notion fallback', () => {
    test('returns Notion order data when found', async () => {
      mockOrderStoreGet('trade-003', undefined)
      mockNotionQuery({
        results: [{
          properties: {
            '商品名': { type: 'rich_text', rich_text: [{ plain_text: '专业版' }] },
            '金额': { type: 'number', number: 259 },
            '购买日期': { type: 'date', date: { start: '2026-06-14' } },
          },
        }],
      })

      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: { outTradeNo: 'trade-003' }, headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 0,
        data: expect.objectContaining({
          outTradeNo: 'trade-003',
          paid: true,
          paidAt: '2026-06-14',
          productName: '专业版',
          finalPrice: 259,
        }),
      }))
    })

    test('returns 404 when both order-store and Notion miss', async () => {
      mockOrderStoreGet('nonexistent', undefined)
      mockNotionQuery({ results: [] })

      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: { outTradeNo: 'nonexistent' }, headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40011,
        message: 'E_ORDER_NOT_FOUND',
      }))
    })

    // P13: Notion 5xx 失败场景
    test('Notion API 5xx → 500 E_NOTION_FAIL (P13 coverage)', async () => {
      mockOrderStoreGet('notion-fail', undefined)
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: { outTradeNo: 'notion-fail' }, headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40010,
        message: 'E_NOTION_FAIL',
      }))
    })
  })

  describe('error handling', () => {
    test('returns 400 when outTradeNo missing', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: {}, headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40000,
        message: 'E_PARAM_MISSING',
      }))
    })

    test('returns 400 when outTradeNo contains special characters (H1 fix)', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: { outTradeNo: 'abc;DROP TABLE' }, headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40001,
        message: 'E_PARAM_INVALID',
      }))
    })

    test('returns 400 when outTradeNo is too long (H1 fix)', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const longNo = 'a'.repeat(65)
      const req = { method: 'GET', query: { outTradeNo: longNo }, headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40001,
        message: 'E_PARAM_INVALID',
      }))
    })

    test('returns 405 when method is not GET', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'POST', headers: VALID_HEADERS }
      const jsonMock = jest.fn()
      const setHeaderMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: setHeaderMock,
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(405)
      expect(setHeaderMock).toHaveBeenCalledWith('Allow', 'GET')
    })
  })

  describe('security: Origin check (H1 fix)', () => {
    test('returns 403 when Origin missing', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: { outTradeNo: 'trade-001' }, headers: {} }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40302,
        message: 'E_ORIGIN_FORBIDDEN',
      }))
    })

    test('returns 403 for cross-origin', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: { outTradeNo: 'trade-001' }, headers: { origin: 'https://evil.com' } }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40302,
      }))
    })
  })

  describe('security: IP rate limit (H1 fix)', () => {
    test('returns 429 after 60 requests from same IP within window', async () => {
      // Mock order-store hit so 200 is returned without hitting Notion
      mockOrderStoreGet('rl-test', {
        outTradeNo: 'rl-test',
        productId: 'starter-full',
        productName: '基础版',
        customerName: '张三',
        customerEmail: 'a@a.com',
        totalPrice: 1,
        finalPrice: 1,
        paid: false,
        createdAt: Date.now(),
        cancelled: false,
      })

      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }
      const req = {
        method: 'GET',
        query: { outTradeNo: 'rl-test' },
        headers: { ...VALID_HEADERS, 'x-forwarded-for': '9.9.9.9' },
        socket: { remoteAddress: '9.9.9.9' },
      }

      // 60 successful requests
      for (let i = 0; i < 60; i++) {
        await handlerFn(req as never, res as never)
      }

      // 61st should be rate-limited
      await handlerFn(req as never, res as never)

      const lastCall = jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0]
      expect(lastCall.code).toBe(42901)
      expect(lastCall.message).toBe('E_RATE_LIMITED')
    })
  })
})
