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
 * - E_PARAM_*    40000-40009  请求参数错误
 * - E_ORDER_*    40010-40019  订单相关错误
 * - E_EMAIL_*    40300-40309  邮箱校验相关
 * - E_NOTION_*   40400-40409  Notion API 错误
 * - E_RATE_*     42900-42909  限流
 * - E_METHOD_*   40500-40509  HTTP 方法错误
 * - E_INTERNAL   50001        兜底
 */
export const ErrorCode = {
  // ========== 参数 (40000-40009) ==========
  /** 40000 请求参数缺失或格式不合法（如 outTradeNo 缺失、email 格式错误） */
  E_PARAM_MISSING: 40000,
  /** 40001 请求参数校验失败（如 outTradeNo 含特殊字符、长度超限） */
  E_PARAM_INVALID: 40001,

  // ========== 订单 (40010-40019) ==========
  /** 40010 Notion API 调用失败（fallback 场景） */
  E_NOTION_FAIL: 40010,
  /** 40011 订单不存在（order-store miss + Notion miss） */
  E_ORDER_NOT_FOUND: 40011,
  /** 40012 订单已支付，无法取消/重复支付 */
  E_ORDER_ALREADY_PAID: 40012,
  /** 40013 Notion 订单状态未登记（防止新状态静默落入 notify 逻辑） */
  E_STATUS_UNKNOWN: 40013,

  // ========== 鉴权 (40300-40309) ==========
  /** 40301 cancel-order 时请求 email 与 order-store 中 customerEmail 不匹配 */
  E_EMAIL_MISMATCH: 40301,
  /** 40302 请求 Origin / Referer 不在白名单内（防跨站调用） */
  E_ORIGIN_FORBIDDEN: 40302,

  // ========== 限流 (42900-42909) ==========
  /** 42901 单 IP 在窗口内请求次数超限（默认 60 req/min） */
  E_RATE_LIMITED: 42901,

  // ========== 方法 (40500-40509) ==========
  /** 40501 HTTP 方法不允许（如 GET /api/pay/cancel-order） */
  E_METHOD_NOT_ALLOWED: 40501,

  // ========== 兜底 (50000+) ==========
  /** 50001 未预期的内部错误（catch-all） */
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
  /** 待发送 — 订单已创建但未发货（初始状态） */
  PENDING: '待发送',
  /** 已发送 — 人工标记已发货（终态） */
  SHIPPED: '已发送',
  /** 已取消 — 用户取消或订单关闭 */
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
