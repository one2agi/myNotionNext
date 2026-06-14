/**
 * Unit tests: lib/discount-codes.ts
 *
 * Test coverage:
 * - isValidDiscountCodeFormat: valid codes, invalid formats
 * - calculateDiscount: invalid format, not found, disabled, discount brings total < 0, normal discount
 */

import { isValidDiscountCodeFormat, calculateDiscount } from '@/lib/discount-codes'

// ─── Mock Notion API ──────────────────────────────────────────────────────────

const mockNotionResponse = (body: unknown, ok = true) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  })
}

// ─── isValidDiscountCodeFormat ───────────────────────────────────────────────

describe('isValidDiscountCodeFormat', () => {
  test.each([
    ['ABCDEF', true],
    ['ABC123', true],
    ['A1B2C3', true],
    ['AB-CD-E', true],
    ['ABCDEFGH', true],
    ['A', false],           // too short
    ['ABC', false],         // too short (min 6)
    ['ABCDE', false],       // 5 chars
    ['abcdef', true],       // lowercase → uppercased by fn
    ['abc-123', true],      // mixed case + hyphen
    ['ABC DEF', false],     // space not allowed
    ['ABC/DEF', false],     // slash not allowed
    ['ABC_DEF', false],     // underscore not allowed
    ['ABC.DEF', false],     // dot not allowed
    ['A'.repeat(21), false],// 21 chars > max 20
    ['A'.repeat(20), true], // exactly 20
  ])('code %s → expected %s', (code, expected) => {
    expect(isValidDiscountCodeFormat(code)).toBe(expected)
  })
})

// ─── calculateDiscount ────────────────────────────────────────────────────────

describe('calculateDiscount', () => {

  test('E_DC_FORMAT_INVALID: too short code', async () => {
    await expect(calculateDiscount(100, 'ABC')).rejects.toMatchObject({
      code: 'E_DC_FORMAT_INVALID',
    })
  })

  test('E_DC_FORMAT_INVALID: code with spaces', async () => {
    await expect(calculateDiscount(100, 'ABC DEF')).rejects.toMatchObject({
      code: 'E_DC_FORMAT_INVALID',
    })
  })

  test('E_DC_NOT_FOUND: code not in Notion DB', async () => {
    mockNotionResponse({ results: [] })
    await expect(calculateDiscount(100, 'NOTFOUND')).rejects.toMatchObject({
      code: 'E_DC_NOT_FOUND',
    })
  })

  test('E_DC_DISABLED: code exists but checkbox is false', async () => {
    mockNotionResponse({
      results: [{
        properties: {
          '优惠码': { rich_text: [{ plain_text: 'DISABLED1' }] },
          '启用优惠码': { checkbox: false },
          '减免金额': { number: 10 },
          '使用次数': { number: 0 },
        },
      }],
    })
    await expect(calculateDiscount(100, 'DISABLED1')).rejects.toMatchObject({
      code: 'E_DC_DISABLED',
    })
  })

  test('E_DC_AMOUNT_INVALID: discount brings total below 0', async () => {
    mockNotionResponse({
      results: [{
        properties: {
          '优惠码': { rich_text: [{ plain_text: 'BIGDISC' }] },
          '启用优惠码': { checkbox: true },
          '减免金额': { number: 500 }, // > 100 totalPrice
          '使用次数': { number: 0 },
        },
      }],
    })
    await expect(calculateDiscount(100, 'BIGDISC')).rejects.toMatchObject({
      code: 'E_DC_AMOUNT_INVALID',
    })
  })

  test('normal: valid code reduces price correctly', async () => {
    mockNotionResponse({
      results: [{
        properties: {
          '优惠码': { rich_text: [{ plain_text: 'SAVE20' }] },
          '启用优惠码': { checkbox: true },
          '减免金额': { number: 20 },
          '使用次数': { number: 5 },
        },
      }],
    })

    const result = await calculateDiscount(100, 'SAVE20')
    expect(result).toEqual({ discountAmount: 20, finalPrice: 80 })
  })

  test('normal: discount exactly equals total → finalPrice = 0 (edge, >= 0 allowed)', async () => {
    mockNotionResponse({
      results: [{
        properties: {
          '优惠码': { rich_text: [{ plain_text: 'FREE' }] },
          '启用优惠码': { checkbox: true },
          '减免金额': { number: 100 },
          '使用次数': { number: 0 },
        },
      }],
    })

    const result = await calculateDiscount(100, 'FREE')
    expect(result).toEqual({ discountAmount: 100, finalPrice: 0 })
  })

  test('E_DC_NOT_FOUND: Notion API returns error', async () => {
    mockNotionResponse(null, false)
    await expect(calculateDiscount(100, 'APIFAIL')).rejects.toMatchObject({
      code: 'E_NOTION_FAIL',
    })
  })

  test('case insensitive: lowercase code is uppercased before DB lookup', async () => {
    mockNotionResponse({
      results: [{
        properties: {
          '优惠码': { rich_text: [{ plain_text: 'SAVE20' }] },
          '启用优惠码': { checkbox: true },
          '减免金额': { number: 20 },
          '使用次数': { number: 0 },
        },
      }],
    })

    const result = await calculateDiscount(100, 'save20')
    expect(result).toEqual({ discountAmount: 20, finalPrice: 80 })
    // Verify the fetch was called with uppercased code
    const fetchCalls = (global.fetch as jest.Mock).mock.calls
    const lastCallBody = JSON.parse(fetchCalls[fetchCalls.length - 1][1]?.body)
    expect(lastCallBody.filter.property['rich_text'].equals).toBe('SAVE20')
  })
})