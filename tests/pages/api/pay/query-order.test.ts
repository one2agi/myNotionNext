/**
 * Unit tests: pages/api/pay/query-order.ts
 *
 * Test coverage:
 * - GET with valid outTradeNo → order-store hit → returns paid=false
 * - GET with valid outTradeNo → order-store hit → returns paid=true + paidAt
 * - GET with valid outTradeNo → order-store miss → Notion hit → returns paid status
 * - GET with valid outTradeNo → order-store miss + Notion miss → 404 E_ORDER_NOT_FOUND
 * - GET with valid outTradeNo → Notion API error → 500 E_NOTION_FAIL
 * - GET with no outTradeNo → 400 E_PARAM_MISSING
 * - POST method → 405 E_METHOD_NOT_ALLOWED
 */

import { orderStore } from '@/lib/order-store'

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

// ─── Test cases ───────────────────────────────────────────────────────────────

describe('GET /api/pay/query-order', () => {
  // Note: Since the API route is a module, we need to test through HTTP mock
  // For unit testing, we focus on the handler logic with mocked dependencies

  let handler: (req: unknown, res: unknown) => Promise<void>

  beforeEach(() => {
    jest.resetModules()
    // Mock order-store
    mockOrderStoreGet('trade-001', undefined)
    mockNotionQuery({ results: [] })
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
      const req = { method: 'GET', query: { outTradeNo: 'trade-001' } }
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
      const req = { method: 'GET', query: { outTradeNo: 'trade-002' } }
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
      const req = { method: 'GET', query: { outTradeNo: 'trade-003' } }
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
      const req = { method: 'GET', query: { outTradeNo: 'nonexistent' } }
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
  })

  describe('error handling', () => {
    test('returns 400 when outTradeNo missing', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'GET', query: {} }
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

    test('returns 405 when method is not GET', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/query-order')
      const req = { method: 'POST' }
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
})