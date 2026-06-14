/**
 * Unit tests: lib/security.ts
 *
 * 覆盖:
 * - checkOrigin: 同源通过、跨域拒绝、空 Origin 拒绝、dev 模式允许 localhost
 * - validateOutTradeNo: 合法通过、过长拒绝、特殊字符拒绝、空字符串拒绝、非字符串拒绝
 * - rateLimit: 第 N+1 次请求拒绝、窗口过期后重置、不同 IP 独立计数
 * - getClientIp: x-forwarded-for 优先、x-real-ip 兜底、socket 兜底
 */

import { checkOrigin, validateOutTradeNo, rateLimit, _resetRateLimit, getClientIp, OUT_TRADE_NO_MAX_LENGTH } from '@/lib/security'
import type { NextApiRequest } from 'next'

// ============= helpers =============

function makeReq(headers: Record<string, string | string[] | undefined> = {}): NextApiRequest {
  return { headers } as unknown as NextApiRequest
}

// ============= checkOrigin =============

describe('checkOrigin', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
  })

  test('rejects when Origin/Referer missing (non-browser call)', () => {
    process.env.NODE_ENV = 'production'
    expect(checkOrigin(makeReq({}))).toBe(false)
  })

  test('accepts same-origin https://www.one2agi.com in production', () => {
    process.env.NODE_ENV = 'production'
    expect(checkOrigin(makeReq({ origin: 'https://www.one2agi.com' }))).toBe(true)
  })

  test('accepts path-prefix same-origin', () => {
    process.env.NODE_ENV = 'production'
    expect(checkOrigin(makeReq({ origin: 'https://www.one2agi.com/some/path' }))).toBe(true)
  })

  test('rejects cross-origin', () => {
    process.env.NODE_ENV = 'production'
    expect(checkOrigin(makeReq({ origin: 'https://evil.com' }))).toBe(false)
  })

  test('rejects http:// in production', () => {
    process.env.NODE_ENV = 'production'
    expect(checkOrigin(makeReq({ origin: 'http://www.one2agi.com' }))).toBe(false)
  })

  test('allows localhost in dev mode', () => {
    process.env.NODE_ENV = 'development'
    expect(checkOrigin(makeReq({ origin: 'http://localhost:3000' }))).toBe(true)
  })

  test('rejects localhost in production', () => {
    process.env.NODE_ENV = 'production'
    expect(checkOrigin(makeReq({ origin: 'http://localhost:3000' }))).toBe(false)
  })

  test('falls back to Referer when Origin missing', () => {
    process.env.NODE_ENV = 'production'
    expect(checkOrigin(makeReq({ referer: 'https://www.one2agi.com/page' }))).toBe(true)
  })
})

// ============= validateOutTradeNo =============

describe('validateOutTradeNo', () => {
  test('accepts valid format (date-random format)', () => {
    const result = validateOutTradeNo('1781285606178-cbsz3n')
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  test('accepts plain alphanumeric', () => {
    expect(validateOutTradeNo('ABC123').valid).toBe(true)
  })

  test('accepts underscores and hyphens', () => {
    expect(validateOutTradeNo('a-b_c-1_2').valid).toBe(true)
  })

  test('rejects empty string', () => {
    const result = validateOutTradeNo('')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('empty')
  })

  test('rejects non-string input', () => {
    const result = validateOutTradeNo(12345)
    expect(result.valid).toBe(false)
  })

  test('rejects null', () => {
    const result = validateOutTradeNo(null)
    expect(result.valid).toBe(false)
  })

  test('rejects undefined', () => {
    const result = validateOutTradeNo(undefined)
    expect(result.valid).toBe(false)
  })

  test('rejects too-long string', () => {
    const tooLong = 'a'.repeat(OUT_TRADE_NO_MAX_LENGTH + 1)
    const result = validateOutTradeNo(tooLong)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('length')
  })

  test('accepts string at exact max length', () => {
    const maxLen = 'a'.repeat(OUT_TRADE_NO_MAX_LENGTH)
    expect(validateOutTradeNo(maxLen).valid).toBe(true)
  })

  test('rejects special characters (SQL/XSS injection attempt)', () => {
    expect(validateOutTradeNo('abc;DROP TABLE').valid).toBe(false)
    expect(validateOutTradeNo('abc<svg>').valid).toBe(false)
    expect(validateOutTradeNo('abc def').valid).toBe(false)  // space
    expect(validateOutTradeNo('abc/def').valid).toBe(false) // slash
    expect(validateOutTradeNo('abc.def').valid).toBe(false) // dot
  })
})

// ============= rateLimit =============

describe('rateLimit', () => {
  beforeEach(() => {
    _resetRateLimit()
  })

  test('allows first N requests within window', () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit('1.2.3.4', 5, 60_000)).toBe(true)
    }
  })

  test('rejects the (N+1)th request', () => {
    for (let i = 0; i < 5; i++) {
      rateLimit('1.2.3.4', 5, 60_000)
    }
    expect(rateLimit('1.2.3.4', 5, 60_000)).toBe(false)
  })

  test('resets after window expires', () => {
    // Use a small window
    for (let i = 0; i < 3; i++) {
      rateLimit('1.2.3.4', 3, 50)
    }
    expect(rateLimit('1.2.3.4', 3, 50)).toBe(false)

    // Wait for window to expire
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(rateLimit('1.2.3.4', 3, 50)).toBe(true)
        resolve()
      }, 60)
    })
  })

  test('tracks different IPs independently', () => {
    for (let i = 0; i < 3; i++) {
      rateLimit('1.1.1.1', 3, 60_000)
    }
    // 1.1.1.1 is now exhausted
    expect(rateLimit('1.1.1.1', 3, 60_000)).toBe(false)
    // But 2.2.2.2 has its own budget
    expect(rateLimit('2.2.2.2', 3, 60_000)).toBe(true)
  })
})

// ============= getClientIp =============

describe('getClientIp', () => {
  test('extracts first IP from x-forwarded-for', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' })
    expect(getClientIp(req)).toBe('1.2.3.4')
  })

  test('handles x-forwarded-for as array', () => {
    const req = makeReq({ 'x-forwarded-for': ['1.2.3.4, 10.0.0.1'] })
    expect(getClientIp(req)).toBe('1.2.3.4')
  })

  test('falls back to x-real-ip', () => {
    const req = makeReq({ 'x-real-ip': '5.6.7.8' })
    expect(getClientIp(req)).toBe('5.6.7.8')
  })

  test('returns "unknown" when no IP headers', () => {
    const req = makeReq({})
    expect(getClientIp(req)).toBe('unknown')
  })
})
