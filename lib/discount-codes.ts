/**
 * 优惠码查询与折扣计算
 *
 * 查询 Notion 优惠码数据库，校验启用状态，计算折扣后金额
 *
 * @module lib/discount-codes
 */

import {
  type NotionPropertyValue,
  getNotionProperty,
  getRichText,
  getCheckbox,
  getNumber,
} from './notion-utils'

interface DiscountCodeRecord {
  优惠码: string
  启用优惠码: boolean
  减免金额: number   // 元
  使用次数: number
}

/** 优惠码格式校验：A-Z 0-9 -，6-20字符 */
const DISCOUNT_CODE_REGEX = /^[A-Z0-9\-]{6,20}$/

/** 创建带错误码的业务错误（用于 throw） */
function discountError(code: string): never {
  const err = new Error(code) as Error & { code: string }
  err.code = code
  throw err
}

/**
 * 校验优惠码格式（前端 blur 时调用，或 create-order 前置校验）
 */
export function isValidDiscountCodeFormat(code: string): boolean {
  return DISCOUNT_CODE_REGEX.test(code.toUpperCase())
}

/**
 * 查询 Notion 优惠码 DB，返回记录或 null
 *
 * @param discountCode 优惠码字符串
 * @returns 记录对象或 null（查不到或格式错误返回 null）
 */
export async function lookupDiscountCode(
  discountCode: string
): Promise<DiscountCodeRecord | null> {
  const token = process.env.NOTION_TOKEN
  const dbId = process.env.NOTION_DISCOUNT_DATABASE_ID

  if (!token || !dbId) {
    throw new Error('E_NOTION_FAIL: NOTION_TOKEN or NOTION_DISCOUNT_DATABASE_ID not set')
  }

  const upperCode = discountCode.toUpperCase()

  const response = await fetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          property: '优惠码',
          rich_text: { equals: upperCode },
        },
        page_size: 1,
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`E_NOTION_FAIL: Notion API ${response.status}`)
  }

  const data = await response.json() as { results: Array<{ properties: Record<string, unknown> }> }

  if (data.results.length === 0) {
    return null
  }

  const props = data.results[0]?.properties
  if (!props) return null

  const pCode = getNotionProperty(props, '优惠码')
  const pEnabled = getNotionProperty(props, '启用优惠码')
  const pDiscountAmount = getNotionProperty(props, '减免金额')
  const pUsageCount = getNotionProperty(props, '使用次数')

  return {
    优惠码: getRichText(pCode),
    启用优惠码: getCheckbox(pEnabled),
    减免金额: getNumber(pDiscountAmount),
    使用次数: getNumber(pUsageCount),
  }
}

/**
 * 计算折扣后金额
 *
 * @param totalPrice 原价（元）
 * @param discountCode 优惠码（未校验）
 * @returns 折扣信息 { discountAmount, finalPrice } | null（优惠码无效时）
 *
 * @throws { Error } 错误码 E_DC_NOT_FOUND / E_DC_DISABLED / E_DC_AMOUNT_INVALID / E_NOTION_FAIL
 */
export async function calculateDiscount(
  totalPrice: number,
  discountCode: string
): Promise<{ discountAmount: number; finalPrice: number }> {
  if (!isValidDiscountCodeFormat(discountCode)) {
    discountError('E_DC_FORMAT_INVALID')
  }

  const record = await lookupDiscountCode(discountCode)

  if (!record) {
    discountError('E_DC_NOT_FOUND')
  }

  if (!record['启用优惠码']) {
    discountError('E_DC_DISABLED')
  }

  const discountAmount = record['减免金额']
  const finalPrice = totalPrice - discountAmount

  if (finalPrice < 0) {
    discountError('E_DC_AMOUNT_INVALID')
  }

  return { discountAmount, finalPrice }
}