import codes from './discount-codes.json'

export type DiscountCode = {
  partnerName: string
  discountPct?: number
  fixedOffFen?: number
  disabled: boolean
  note?: string
}

export class DiscountNotFoundError extends Error {
  code = 'E_DC_NOT_FOUND' as const
  constructor(public discountCode: string) {
    super(`Discount code not found: ${discountCode}`)
  }
}

export class DiscountDisabledError extends Error {
  code = 'E_DC_DISABLED' as const
  constructor(public discountCode: string) {
    super(`Discount code disabled: ${discountCode}`)
  }
}

const CODE_FORMAT = /^[A-Z0-9-]{6,20}$/

function validateFormat(code: string): void {
  if (!code || !CODE_FORMAT.test(code)) {
    throw new DiscountNotFoundError(code)
  }
}

export function lookupDiscount(code: string): DiscountCode {
  validateFormat(code)
  const entry = (codes as Record<string, DiscountCode>)[code]
  if (!entry) {
    throw new DiscountNotFoundError(code)
  }
  if (entry.disabled) {
    throw new DiscountDisabledError(code)
  }
  return entry
}

export function lookupPartnerName(code: string): string | null {
  try {
    validateFormat(code)
  } catch {
    return null
  }
  const entry = (codes as Record<string, DiscountCode>)[code]
  return entry?.partnerName ?? null
}
