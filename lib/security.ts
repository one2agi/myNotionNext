/**
 * 安全工具库（lib/security.ts）
 *
 * 为 query-order / cancel-order / 其他敏感 API 提供：
 * - Origin 校验（防跨站调用）
 * - outTradeNo 白名单（防 Notion API 配额滥用）
 * - 内存 IP 限速（防自家 DoS）
 *
 * 遵循 PAYMENT-IMPLEMENTATION-NOTES.md D.1/D.5 风险缓解方案
 *
 * @module lib/security
 */

import type { NextApiRequest } from 'next'

// ============= 常量 =============

/**
 * 允许的 Origin 列表（生产域名 + dev localhost）
 * dev 模式下额外允许 localhost 与 127.0.0.1
 */
const ALLOWED_ORIGINS: readonly string[] = [
  'https://www.one2agi.com',
  'https://one2agi.com',
] as const

const DEV_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost',
  'http://127.0.0.1',
] as const

/** outTradeNo 字符白名单：A-Z a-z 0-9 _ - */
const OUT_TRADE_NO_REGEX = /^[A-Za-z0-9_-]+$/

/** outTradeNo 长度上限（创建订单格式为 `${Date.now()}-${random6} ≈ 20 字符，给 3x 余量）*/
export const OUT_TRADE_NO_MAX_LENGTH = 64

/** 默认 IP 限速：60 req / 60s */
const RATE_LIMIT_DEFAULT_MAX_REQ = 60
const RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000

// ============= Origin 校验 =============

/**
 * 检查请求的 Origin / Referer 是否在允许列表中
 *
 * @param req NextApiRequest
 * @returns true = 通过；false = 拒绝
 *
 * 注意：
 * - dev 模式（NODE_ENV !== 'production'）额外允许 localhost
 * - 浏览器 fetch 必带 Origin，但后端 curl/Postman 不会带 → 拒绝（视为可疑）
 * - Referer 兜底（部分代理会去掉 Origin）
 */
export function checkOrigin(req: NextApiRequest): boolean {
  const origin = (req.headers.origin ?? req.headers.referer ?? '').toString()

  if (!origin) {
    // 浏览器 fetch 必带 Origin；空 = 非浏览器调用 → 拒绝
    return false
  }

  const allowedList =
    process.env.NODE_ENV !== 'production'
      ? [...ALLOWED_ORIGINS, ...DEV_ALLOWED_ORIGINS]
      : [...ALLOWED_ORIGINS]

  // 精确匹配
  if (allowedList.includes(origin)) {
    return true
  }

  // 前缀匹配（允许同源路径）
  return allowedList.some(allowed => origin.startsWith(allowed + '/'))
}

// ============= outTradeNo 白名单 =============

export interface ValidateResult {
  valid: boolean
  reason?: string
}

/**
 * 校验 outTradeNo 格式
 *
 * @param no 待校验字符串
 * @returns { valid, reason? }
 *
 * 规则：
 * - 非空
 * - 长度 ≤ 64
 * - 字符集 [A-Za-z0-9_-]
 */
export function validateOutTradeNo(no: unknown): ValidateResult {
  if (typeof no !== 'string' || no.length === 0) {
    return { valid: false, reason: 'empty or not a string' }
  }
  if (no.length > OUT_TRADE_NO_MAX_LENGTH) {
    return { valid: false, reason: `length > ${OUT_TRADE_NO_MAX_LENGTH}` }
  }
  if (!OUT_TRADE_NO_REGEX.test(no)) {
    return { valid: false, reason: 'invalid characters' }
  }
  return { valid: true }
}

// ============= IP 限速 =============

/**
 * 滑动窗口 IP 限速（内存实现）
 *
 * 用途：单 IP 在窗口内超过 maxReq 次则拒绝
 * 限制：容器冷启动会丢，EdgeOne 多实例不共享（未来可换 Redis）
 *
 * @param ip 客户端 IP
 * @param maxReq 窗口内最大请求数（默认 60）
 * @param windowMs 窗口大小 ms（默认 60s）
 * @returns true = 允许；false = 限流
 */
const rateLimitStore = new Map<string, number[]>()

export function rateLimit(
  ip: string,
  maxReq: number = RATE_LIMIT_DEFAULT_MAX_REQ,
  windowMs: number = RATE_LIMIT_DEFAULT_WINDOW_MS
): boolean {
  const now = Date.now()
  const cutoff = now - windowMs

  // 读取并清理过期记录
  const timestamps = (rateLimitStore.get(ip) ?? []).filter(t => t > cutoff)

  if (timestamps.length >= maxReq) {
    rateLimitStore.set(ip, timestamps)
    return false
  }

  timestamps.push(now)
  rateLimitStore.set(ip, timestamps)
  return true
}

/**
 * 清理限速 Map（仅测试用）
 * @internal
 */
export function _resetRateLimit(): void {
  rateLimitStore.clear()
}

/**
 * 提取客户端 IP（按优先级）
 * 1. x-forwarded-for 第一段（EdgeOne 代理会设）
 * 2. x-real-ip
 * 3. req.socket.remoteAddress
 * 4. 'unknown' fallback
 */
export function getClientIp(req: NextApiRequest): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim()
  }
  if (Array.isArray(xff) && xff.length > 0 && xff[0]) {
    return xff[0].split(',')[0]!.trim()
  }

  const xri = req.headers['x-real-ip']
  if (typeof xri === 'string' && xri.length > 0) {
    return xri
  }

  // req.socket.remoteAddress 在 Node.js 17+ 是 string | undefined
  const remote = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
  return remote ?? 'unknown'
}
