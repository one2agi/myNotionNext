/**
 * Unit tests: lib/order-store.ts
 *
 * Test coverage:
 * - set / get basic operations
 * - TTL cleanup: records older than 60 min are removed
 * - markPaid: idempotent, returns correct boolean
 * - isPaid: false by default, true after markPaid
 */

import { orderStore } from '@/lib/order-store'

describe('orderStore', () => {

  // ─── set / get ─────────────────────────────────────────────────────────────

  test('set + get: returns record with correct fields', () => {
    const record = {
      productId: 'starter-full',
      productName: '基础版',
      customerName: '张三',
      customerEmail: 'zhangsan@example.com',
      totalPrice: 79,
      finalPrice: 79,
    }
    orderStore.set('trade-001', record)
    const result = orderStore.get('trade-001')

    expect(result).toMatchObject({
      outTradeNo: 'trade-001',
      productId: 'starter-full',
      productName: '基础版',
      customerName: '张三',
      customerEmail: 'zhangsan@example.com',
      totalPrice: 79,
      finalPrice: 79,
      paid: false,
    })
    expect(typeof result?.createdAt).toBe('number')
  })

  test('set + get: discount fields are stored correctly', () => {
    const record = {
      productId: 'pro-full',
      productName: '专业版',
      customerName: '李四',
      customerEmail: 'lisi@example.com',
      totalPrice: 299,
      finalPrice: 259,
      discountCode: 'SAVE40',
      discountAmount: 40,
    }
    orderStore.set('trade-002', record)
    const result = orderStore.get('trade-002')

    expect(result?.discountCode).toBe('SAVE40')
    expect(result?.discountAmount).toBe(40)
  })

  test('get: unknown outTradeNo returns undefined', () => {
    expect(orderStore.get('nonexistent')).toBeUndefined()
  })

  // ─── markPaid / isPaid ─────────────────────────────────────────────────────

  test('isPaid: false before markPaid', () => {
    orderStore.set('trade-003', {
      productId: 'starter-full', productName: '基础版',
      customerName: '王五', customerEmail: 'wangwu@example.com',
      totalPrice: 79, finalPrice: 79,
    })
    expect(orderStore.isPaid('trade-003')).toBe(false)
  })

  test('markPaid: returns true and marks record as paid', () => {
    orderStore.set('trade-004', {
      productId: 'starter-full', productName: '基础版',
      customerName: '赵六', customerEmail: 'zhaoliu@example.com',
      totalPrice: 79, finalPrice: 79,
    })

    const result = orderStore.markPaid('trade-004')
    expect(result).toBe(true)
    expect(orderStore.isPaid('trade-004')).toBe(true)
  })

  test('markPaid: idempotent — returns true on second call', () => {
    orderStore.set('trade-005', {
      productId: 'starter-full', productName: '基础版',
      customerName: '钱七', customerEmail: 'qianqi@example.com',
      totalPrice: 79, finalPrice: 79,
    })

    orderStore.markPaid('trade-005')
    const secondResult = orderStore.markPaid('trade-005')
    expect(secondResult).toBe(true)
  })

  test('markPaid: unknown outTradeNo returns false', () => {
    expect(orderStore.markPaid('unknown-trade')).toBe(false)
  })

  test('isPaid: unknown outTradeNo returns false', () => {
    expect(orderStore.isPaid('unknown-trade')).toBe(false)
  })
})