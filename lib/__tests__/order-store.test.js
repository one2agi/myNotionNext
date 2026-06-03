import {
  recordOrder,
  markPaid,
  alreadyPaid
} from '@/lib/order-store'

describe('order-store', () => {
  beforeEach(() => {
    // Each test starts from a clean in-memory store.
    // The store is module-scoped (a single Map), so we use fake timers
    // and a fixed start time to make TTL deterministic, plus we clear
    // any residual entries by re-recording against a unique key per test.
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-03T00:00:00Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('recordOrder', () => {
    it('stores a record that can be queried by alreadyPaid (after markPaid)', () => {
      const outTradeNo = 'order-001'
      recordOrder(outTradeNo, 100) // 1.00 元
      // not paid yet
      expect(alreadyPaid(outTradeNo)).toBe(false)
    })

    it('overwrites an existing record when called twice with the same outTradeNo', () => {
      const outTradeNo = 'order-002'
      recordOrder(outTradeNo, 100)
      recordOrder(outTradeNo, 200) // 价格改了
      // 标 paid 用新价格 200 应该命中
      const result = markPaid(outTradeNo, 2.0)
      expect(result).toBe(true)
    })

    it('keeps amountFen as an integer (no floating-point corruption)', () => {
      const outTradeNo = 'order-003'
      // 价格是分，传整数
      recordOrder(outTradeNo, 999)
      // markPaid 用 9.99 元，应命中
      expect(markPaid(outTradeNo, 9.99)).toBe(true)
    })
  })

  describe('markPaid', () => {
    it('returns true and flips paid=true when the amount matches', () => {
      const outTradeNo = 'order-100'
      recordOrder(outTradeNo, 500) // 5.00 元
      const result = markPaid(outTradeNo, 5.0)
      expect(result).toBe(true)
      expect(alreadyPaid(outTradeNo)).toBe(true)
    })

    it('returns false on amount mismatch but still flips paid=true (defense against Z-Pay resend)', () => {
      const outTradeNo = 'order-101'
      recordOrder(outTradeNo, 500) // 5.00 元
      const result = markPaid(outTradeNo, 6.0) // 6.00 元 ≠ 5.00
      expect(result).toBe(false)
      // 关键：已 paid=true 防止 Z-Pay 重复发时再次失败
      expect(alreadyPaid(outTradeNo)).toBe(true)
    })

    it('returns false when the record does not exist', () => {
      const result = markPaid('never-recorded', 1.0)
      expect(result).toBe(false)
    })

    it('cleans up entries whose createdAt is older than 60 minutes, then treats a new recordOrder as a fresh order', () => {
      const outTradeNo = 'order-102'
      recordOrder(outTradeNo, 100) // createdAt = 00:00:00

      // 推进到 61 分钟后
      jest.setSystemTime(new Date('2026-06-03T01:01:00Z'))

      // 第一次 markPaid 会触发惰性 TTL 清理；记录被删，找不到，返 false
      expect(markPaid(outTradeNo, 1.0)).toBe(false)

      // 再次 recordOrder 同 outTradeNo，应视为新订单（没有 alreadyPaid）
      recordOrder(outTradeNo, 100)
      expect(alreadyPaid(outTradeNo)).toBe(false)
    })

    it('treats a second markPaid on the same outTradeNo as idempotent pass-through (returns true)', () => {
      const outTradeNo = 'order-103'
      recordOrder(outTradeNo, 300) // 3.00 元
      expect(markPaid(outTradeNo, 3.0)).toBe(true) // 第一次
      // 第二次同 outTradeNo：已 paid，幂等通过
      expect(markPaid(outTradeNo, 3.0)).toBe(true)
    })
  })

  describe('alreadyPaid', () => {
    it('returns false for an outTradeNo that was never recorded', () => {
      expect(alreadyPaid('never-seen')).toBe(false)
    })

    it('returns false when the record exists but paid=false', () => {
      const outTradeNo = 'order-200'
      recordOrder(outTradeNo, 100)
      expect(alreadyPaid(outTradeNo)).toBe(false)
    })

    it('returns true when the record exists and paid=true', () => {
      const outTradeNo = 'order-201'
      recordOrder(outTradeNo, 100)
      markPaid(outTradeNo, 1.0)
      expect(alreadyPaid(outTradeNo)).toBe(true)
    })

    it('returns false after the entry has been TTL-evicted', () => {
      const outTradeNo = 'order-202'
      recordOrder(outTradeNo, 100)
      markPaid(outTradeNo, 1.0) // paid=true

      // 推进到 61 分钟后
      jest.setSystemTime(new Date('2026-06-03T01:01:00Z'))

      // TTL 清理会在 markPaid 内部触发；用 markPaid 触发清理，然后 alreadyPaid
      markPaid('dummy-to-trigger-cleanup', 0) // dummy 触发清理
      expect(alreadyPaid(outTradeNo)).toBe(false)
    })
  })
})
