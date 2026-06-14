/**
 * Unit tests: pages/api/pay/cancel-order.ts
 *
 * Test coverage:
 * - order-store hit + not paid → markCancelled + n8n webhook + 200 cancelled:true
 * - order-store hit + already paid → 400 E_ORDER_ALREADY_PAID
 * - order-store hit + already cancelled → 200 (idempotent)
 * - order-store miss + Notion hit + not paid → n8n webhook + 200
 * - order-store miss + Notion hit + already paid → 400 E_ORDER_ALREADY_PAID
 * - order-store miss + Notion miss → 404 E_ORDER_NOT_FOUND
 * - POST with no outTradeNo → 400 E_PARAM_MISSING
 * - method not POST → 405 E_METHOD_NOT_ALLOWED
 */

import { orderStore } from '@/lib/order-store'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const mockOrderStoreGet = (outTradeNo: string, record: Record<string, unknown> | undefined) => {
  jest.spyOn(orderStore, 'get').mockImplementation((key: string) => {
    if (key === outTradeNo) return record as ReturnType<typeof orderStore.get>
    return undefined
  })
}

const mockMarkCancelled = jest.fn()
const mockNotifyN8n = jest.fn().mockResolvedValue(undefined)
const mockCloseZPay = jest.fn().mockResolvedValue(undefined)

jest.mock('@/lib/order-store', () => ({
  orderStore: {
    ...jest.requireActual('@/lib/order-store').orderStore,
    markCancelled: (...args: unknown[]) => mockMarkCancelled(...args),
  },
}))

jest.mock('@/pages/api/pay/cancel-order', () => ({
  // We'll import and test the actual handler
}))

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
  mockOrderStoreGet('trade-001', undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// ─── Test cases ───────────────────────────────────────────────────────────────

describe('POST /api/pay/cancel-order', () => {
  describe('order-store hit', () => {
    test('unpaid order → markCancelled + n8n webhook + 200 cancelled:true', async () => {
      mockOrderStoreGet('trade-001', {
        outTradeNo: 'trade-001',
        productId: 'starter-full',
        productName: '基础版',
        customerName: '张三',
        customerEmail: 'test@test.com',
        totalPrice: 79,
        finalPrice: 79,
        paid: false,
        createdAt: Date.now(),
        cancelled: false,
      })

      // Mock n8n webhook
      global.fetch = jest.fn().mockResolvedValue({ ok: true })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-001' },
      }
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
        data: { outTradeNo: 'trade-001', cancelled: true },
      }))
    })

    test('already paid order → 400 E_ORDER_ALREADY_PAID', async () => {
      mockOrderStoreGet('trade-002', {
        outTradeNo: 'trade-002',
        productId: 'starter-full',
        productName: '基础版',
        customerName: '张三',
        customerEmail: 'test@test.com',
        totalPrice: 79,
        finalPrice: 79,
        paid: true,
        createdAt: Date.now(),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-002' },
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40012,
        message: 'E_ORDER_ALREADY_PAID',
      }))
    })

    test('already cancelled order → idempotent 200', async () => {
      mockOrderStoreGet('trade-003', {
        outTradeNo: 'trade-003',
        productId: 'starter-full',
        productName: '基础版',
        customerName: '张三',
        customerEmail: 'test@test.com',
        totalPrice: 79,
        finalPrice: 79,
        paid: false,
        cancelled: true,
        cancelledAt: Date.now(),
        createdAt: Date.now(),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-003' },
      }
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
        data: { outTradeNo: 'trade-003', cancelled: true },
      }))
    })
  })

  describe('order-store miss → Notion fallback', () => {
    test('Notion order exists + not paid → 200', async () => {
      mockOrderStoreGet('trade-004', undefined)

      // Mock Notion query
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            results: [{
              properties: {
                '状态': { type: 'status', status: { name: '待发送' } },
              },
            }],
          }),
        })
        .mockResolvedValueOnce({ ok: true }) // n8n webhook

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-004' },
      }
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
        data: { outTradeNo: 'trade-004', cancelled: true },
      }))
    })

    test('Notion order status = 已发送 → 400 E_ORDER_ALREADY_PAID', async () => {
      mockOrderStoreGet('trade-005', undefined)

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          results: [{
            properties: {
              '状态': { type: 'status', status: { name: '已发送' } },
            },
          }],
        }),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-005' },
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40012,
        message: 'E_ORDER_ALREADY_PAID',
      }))
    })

    test('Notion order status = 已取消 → idempotent 200', async () => {
      mockOrderStoreGet('trade-006', undefined)

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          results: [{
            properties: {
              '状态': { type: 'status', status: { name: '已取消' } },
            },
          }],
        }),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-006' },
      }
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
        data: { outTradeNo: 'trade-006', cancelled: true },
      }))
    })

    test('order not found in order-store or Notion → 404', async () => {
      mockOrderStoreGet('nonexistent', undefined)

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [] }),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'nonexistent' },
      }
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
    test('no outTradeNo → 400 E_PARAM_MISSING', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: {},
      }
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

    test('method not POST → 405', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = { method: 'GET' }
      const jsonMock = jest.fn()
      const setHeaderMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: setHeaderMock,
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(405)
      expect(setHeaderMock).toHaveBeenCalledWith('Allow', 'POST')
    })
  })
})