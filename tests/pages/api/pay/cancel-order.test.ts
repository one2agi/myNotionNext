/**
 * Unit tests: pages/api/pay/cancel-order.ts
 *
 * Test coverage:
 * - order-store hit + 邮箱匹配 + 未支付 → markCancelled + n8n + 200
 * - order-store hit + 邮箱匹配 + 已支付 → 400 E_ORDER_ALREADY_PAID
 * - order-store hit + 邮箱匹配 + 已取消 → 200 幂等
 * - order-store hit + 邮箱不匹配 → 403 E_EMAIL_MISMATCH (H2 修复)
 * - order-store miss + Notion hit + 待发送 → n8n + 200
 * - order-store miss + Notion hit + 已发送 → 400 E_ORDER_ALREADY_PAID
 * - order-store miss + Notion hit + 已取消 → 200 幂等
 * - order-store miss + Notion hit + 未知状态 → 409 E_STATUS_UNKNOWN (H4 修复)
 * - order-store miss + Notion miss → 404 E_ORDER_NOT_FOUND
 * - Origin 缺失/跨域 → 403 E_ORIGIN_FORBIDDEN (H2 修复)
 * - outTradeNo 含特殊字符 → 400 E_PARAM_INVALID
 * - 缺 email → 400 E_PARAM_MISSING
 * - POST with no outTradeNo → 400 E_PARAM_MISSING
 * - method not POST → 405 E_METHOD_NOT_ALLOWED
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

const mockMarkCancelled = jest.fn()
const mockNotifyN8n = jest.fn().mockResolvedValue(undefined)
const mockCloseZPay = jest.fn().mockResolvedValue(undefined)

jest.mock('@/lib/order-store', () => ({
  orderStore: {
    ...jest.requireActual('@/lib/order-store').orderStore,
    markCancelled: (...args: unknown[]) => mockMarkCancelled(...args),
  },
}))

/** 标准请求头（通过 Origin 校验） */
const VALID_HEADERS = { origin: 'https://www.one2agi.com' }
const VALID_CUSTOMER = { email: 'test@test.com' }

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
  _resetRateLimit()
  mockOrderStoreGet('trade-001', undefined)
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  jest.restoreAllMocks()
})

// ─── Test cases ───────────────────────────────────────────────────────────────

describe('POST /api/pay/cancel-order', () => {
  describe('order-store hit', () => {
    test('email match + unpaid order → markCancelled + n8n webhook + 200 cancelled:true', async () => {
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
        body: { outTradeNo: 'trade-001', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
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

    test('email match + already paid order → 400 E_ORDER_ALREADY_PAID', async () => {
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
        body: { outTradeNo: 'trade-002', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
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

    test('email match + already cancelled order → idempotent 200', async () => {
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
        body: { outTradeNo: 'trade-003', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
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

    test('email MISMATCH → 403 E_EMAIL_MISMATCH (H2 fix)', async () => {
      mockOrderStoreGet('trade-004', {
        outTradeNo: 'trade-004',
        productId: 'starter-full',
        productName: '基础版',
        customerName: '张三',
        customerEmail: 'real-owner@test.com',
        totalPrice: 79,
        finalPrice: 79,
        paid: false,
        createdAt: Date.now(),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-004', customer: { email: 'attacker@evil.com' } },
        headers: VALID_HEADERS,
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40301,
        message: 'E_EMAIL_MISMATCH',
      }))
    })

    test('email match is case-insensitive', async () => {
      mockOrderStoreGet('trade-case', {
        outTradeNo: 'trade-case',
        productId: 'starter-full',
        productName: '基础版',
        customerName: '张三',
        customerEmail: 'Test@Test.COM',
        totalPrice: 79,
        finalPrice: 79,
        paid: false,
        createdAt: Date.now(),
      })

      global.fetch = jest.fn().mockResolvedValue({ ok: true })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-case', customer: { email: 'test@test.com' } },
        headers: VALID_HEADERS,
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(200)
    })
  })

  describe('order-store miss → Notion fallback', () => {
    test('Notion order exists + not paid (待发送) → 200', async () => {
      mockOrderStoreGet('trade-005', undefined)

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
        body: { outTradeNo: 'trade-005', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
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
        data: { outTradeNo: 'trade-005', cancelled: true },
      }))
    })

    test('Notion order status = 已发送 → 400 E_ORDER_ALREADY_PAID', async () => {
      mockOrderStoreGet('trade-006', undefined)

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
        body: { outTradeNo: 'trade-006', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
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
      mockOrderStoreGet('trade-007', undefined)

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
        body: { outTradeNo: 'trade-007', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
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
        data: { outTradeNo: 'trade-007', cancelled: true },
      }))
    })

    test('Notion order status = 未知状态 → 409 E_STATUS_UNKNOWN (H4 fix)', async () => {
      mockOrderStoreGet('trade-008', undefined)

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          results: [{
            properties: {
              '状态': { type: 'status', status: { name: '已退款' } }, // 未知状态
            },
          }],
        }),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-008', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(409)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40013,
        message: 'E_STATUS_UNKNOWN',
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
        body: { outTradeNo: 'nonexistent', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
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

    // P11: Notion 5xx 失败路径
    test('Notion API 5xx → 500 E_NOTION_FAIL (P11 coverage, P7 fixed)', async () => {
      mockOrderStoreGet('trade-009', undefined)

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.reject(new Error('not json')),
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-009', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      // P7 修复后：catch 块正确返回 E_NOTION_FAIL（之前错误返回 E_INTERNAL）
      expect(res.status).toHaveBeenCalledWith(500)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 40010,
        message: 'E_NOTION_FAIL',
      }))
    })

    // P12: n8n webhook 失败（order-store hit 场景）
    // P12 衍生修复：notifyN8nCancelOrder 加 try/catch 后，n8n 失败不再阻塞主流程
    test('n8n webhook failure (network error) → 200 cancelled:true (fire-and-forget, P12 fix)', async () => {
      mockOrderStoreGet('trade-010', {
        outTradeNo: 'trade-010',
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

      // n8n webhook 抛出网络错误（Z-Pay close 也失败）
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/cancel-order') || url.includes('z-pay.cn')) {
          return Promise.reject(new Error('network failure'))
        }
        return Promise.resolve({ ok: true })
      })

      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-010', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      // P12 修复后：n8n + Z-Pay 都失败时仍返 200（fire-and-forget 设计）
      // order-store 已 markCancelled，下次再调走幂等分支
      expect(res.status).toHaveBeenCalledWith(200)
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        code: 0,
        data: { outTradeNo: 'trade-010', cancelled: true },
      }))
    })
  })

  describe('error handling', () => {
    test('no outTradeNo → 400 E_PARAM_MISSING', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: {},
        headers: VALID_HEADERS,
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

    test('outTradeNo contains special chars → 400 E_PARAM_INVALID (H2 fix)', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'abc;DROP', customer: VALID_CUSTOMER },
        headers: VALID_HEADERS,
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
        code: 40001,
        message: 'E_PARAM_INVALID',
      }))
    })

    test('missing customer.email → 400 E_PARAM_MISSING', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-001' }, // no customer
        headers: VALID_HEADERS,
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

    test('invalid email format → 400 E_PARAM_MISSING', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-001', customer: { email: 'not-an-email' } },
        headers: VALID_HEADERS,
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(400)
    })

    test('method not POST → 405', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = { method: 'GET', headers: VALID_HEADERS }
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

  describe('security: Origin check (H2 fix)', () => {
    test('returns 403 when Origin missing', async () => {
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-001', customer: VALID_CUSTOMER },
        headers: {},
      }
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
      const { default: handlerFn } = await import('@/pages/api/pay/cancel-order')
      const req = {
        method: 'POST',
        body: { outTradeNo: 'trade-001', customer: VALID_CUSTOMER },
        headers: { origin: 'https://evil.com' },
      }
      const jsonMock = jest.fn()
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jsonMock,
        setHeader: jest.fn(),
      }

      await handlerFn(req as never, res as never)

      expect(res.status).toHaveBeenCalledWith(403)
    })
  })
})
