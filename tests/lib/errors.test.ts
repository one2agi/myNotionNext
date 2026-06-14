/**
 * Unit tests: lib/errors.ts
 *
 * 覆盖:
 * - NotionOrderStatus enum 值正确
 * - parseNotionOrderStatus: 已知值 → 返回；未知值 → null；空 → null
 */

import { NotionOrderStatus, parseNotionOrderStatus, ErrorCode } from '@/lib/errors'

describe('NotionOrderStatus enum', () => {
  test('PENDING is 待发送', () => {
    expect(NotionOrderStatus.PENDING).toBe('待发送')
  })

  test('SHIPPED is 已发送', () => {
    expect(NotionOrderStatus.SHIPPED).toBe('已发送')
  })

  test('CANCELLED is 已取消', () => {
    expect(NotionOrderStatus.CANCELLED).toBe('已取消')
  })

  test('all values are unique', () => {
    const values = Object.values(NotionOrderStatus)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('parseNotionOrderStatus', () => {
  test('returns PENDING for 待发送', () => {
    expect(parseNotionOrderStatus('待发送')).toBe('待发送')
  })

  test('returns SHIPPED for 已发送', () => {
    expect(parseNotionOrderStatus('已发送')).toBe('已发送')
  })

  test('returns CANCELLED for 已取消', () => {
    expect(parseNotionOrderStatus('已取消')).toBe('已取消')
  })

  test('returns null for unknown status', () => {
    expect(parseNotionOrderStatus('已退款')).toBeNull()
    expect(parseNotionOrderStatus('退款中')).toBeNull()
    expect(parseNotionOrderStatus('paid')).toBeNull()
    expect(parseNotionOrderStatus('SHIPPED')).toBeNull() // English not allowed
  })

  test('returns null for null/undefined/empty', () => {
    expect(parseNotionOrderStatus(null)).toBeNull()
    expect(parseNotionOrderStatus(undefined)).toBeNull()
    expect(parseNotionOrderStatus('')).toBeNull()
  })
})

describe('ErrorCode enum', () => {
  test('关键错误码值正确（避免破坏现有契约）', () => {
    expect(ErrorCode.E_PARAM_MISSING).toBe(40000)
    expect(ErrorCode.E_ORDER_NOT_FOUND).toBe(40011)
    expect(ErrorCode.E_ORDER_ALREADY_PAID).toBe(40012)
    expect(ErrorCode.E_EMAIL_MISMATCH).toBe(40301)
    expect(ErrorCode.E_ORIGIN_FORBIDDEN).toBe(40302)
    expect(ErrorCode.E_RATE_LIMITED).toBe(42901)
    expect(ErrorCode.E_STATUS_UNKNOWN).toBe(40013)
    expect(ErrorCode.E_METHOD_NOT_ALLOWED).toBe(40501)
    expect(ErrorCode.E_INTERNAL).toBe(50001)
  })

  test('所有 ErrorCode 值都是数字且唯一', () => {
    const values = Object.values(ErrorCode)
    expect(values.every(v => typeof v === 'number')).toBe(true)
    expect(new Set(values).size).toBe(values.length)
  })
})
