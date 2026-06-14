/**
 * 支付错误码与状态枚举（lib/errors.ts）
 *
 * 跨文件共享的错误码 + Notion 状态字面量
 * 避免硬编码字符串散落在多个文件中
 *
 * 遵循 PAYMENT-IMPLEMENTATION-NOTES.md H4 缓解方案
 *
 * @module lib/errors
 */

/**
 * 支付业务错误码（HTTP 状态码无关，仅业务语义）
 *
 * 命名规范：E_<MODULE>_<REASON>
 * - E_PARAM_*  40000-40009  请求参数错误
 * - E_ORDER_* 40010-40019  订单相关错误
 * - E_EMAIL_* 40300-40309  邮箱校验相关
 * - E_NOTION_* 40400-40409  Notion API 错误
 * - E_RATE_*  42900-42909  限流
 * - E_METHOD_* 40500-40509  HTTP 方法错误
 * - E_INTERNAL 50001        兜底
 */
export const ErrorCode = {
  // 参数
  E_PARAM_MISSING: 40000,
  E_PARAM_INVALID: 40001,

  // 订单
  E_ORDER_NOT_FOUND: 40011,
  E_ORDER_ALREADY_PAID: 40012,
  E_STATUS_UNKNOWN: 40013,
  E_ORDER_EXPIRED: 40014,

  // 鉴权 / 邮箱
  E_EMAIL_MISMATCH: 40301,
  E_ORIGIN_FORBIDDEN: 40302,

  // Notion
  E_NOTION_FAIL: 40010,

  // 限流
  E_RATE_LIMITED: 42901,

  // 方法
  E_METHOD_NOT_ALLOWED: 40501,

  // 兜底
  E_INTERNAL: 50001,
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * Notion 订单数据库「状态」字段的有效值
 *
 * 与 REQUIREMENTS-payment.md §3.1 一致
 * 任何新增状态必须先在此处登记，否则 cancel-order 会返 409 E_STATUS_UNKNOWN
 */
export const NotionOrderStatus = {
  PENDING: '待发送',
  SHIPPED: '已发送',
  CANCELLED: '已取消',
} as const

export type NotionOrderStatusValue = (typeof NotionOrderStatus)[keyof typeof NotionOrderStatus]

/**
 * 判断一个状态字符串是否合法
 * @returns NotionOrderStatusValue 或 null（未知）
 */
export function parseNotionOrderStatus(s: string | null | undefined): NotionOrderStatusValue | null {
  if (!s) return null
  const values = Object.values(NotionOrderStatus) as string[]
  return values.includes(s) ? (s as NotionOrderStatusValue) : null
}
