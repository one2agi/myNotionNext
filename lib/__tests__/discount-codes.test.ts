// @ts-nocheck  (项目没装 @types/jest)
import { lookupDiscount, lookupPartnerName, DiscountNotFoundError, DiscountDisabledError } from '../discount-codes'

describe('lookupDiscount', () => {
  it('returns the discount entry for a valid code', () => {
    const result = lookupDiscount('PARTNER01')
    expect(result.partnerName).toBe('张三的数码店')
    expect(result.disabled).toBe(false)
  })

  it('throws DiscountDisabledError for disabled code', () => {
    expect(() => lookupDiscount('PARTNER02DISABLED')).toThrow(DiscountDisabledError)
  })

  it('throws DiscountNotFoundError for unknown code', () => {
    expect(() => lookupDiscount('UNKNOWN')).toThrow(DiscountNotFoundError)
  })

  it('treats empty string as not found', () => {
    expect(() => lookupDiscount('')).toThrow(DiscountNotFoundError)
  })

  it('throws for invalid format (lowercase)', () => {
    expect(() => lookupDiscount('partner01')).toThrow(DiscountNotFoundError)
  })

  it('allows unlimited usage (1000 calls all succeed)', () => {
    for (let i = 0; i < 1000; i++) {
      expect(() => lookupDiscount('PARTNER01')).not.toThrow()
    }
  })
})

describe('lookupPartnerName', () => {
  it('returns partner name for valid code', () => {
    expect(lookupPartnerName('PARTNER01')).toBe('张三的数码店')
  })

  it('returns null for unknown code (does not throw)', () => {
    expect(lookupPartnerName('UNKNOWN')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(lookupPartnerName('')).toBeNull()
  })
})
