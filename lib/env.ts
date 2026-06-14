/**
 * 环境变量集中校验（lib/env.ts）
 *
 * 目的：启动时一次性校验所有 env 变量，缺一即抛错，避免运行时才暴露。
 * 遵循 PAYMENT-ARCHITECTURE.md §12.5 设计。
 *
 * @module lib/env
 */

interface EnvSchema {
  ZPAY_PID: string
  ZPAY_KEY: string
  ZPAY_NOTIFY_URL: string
  N8N_WEBHOOK_URL: string
  N8N_WEBHOOK_SECRET: string
  NOTION_TOKEN: string
  NOTION_DATABASE_ID: string
  NOTION_DISCOUNT_DATABASE_ID: string
}

const SCHEMA: Array<[keyof EnvSchema, boolean]> = [
  ['ZPAY_PID', true],
  ['ZPAY_KEY', true],
  ['ZPAY_NOTIFY_URL', true],
  ['N8N_WEBHOOK_URL', true],
  ['N8N_WEBHOOK_SECRET', true],
  ['NOTION_TOKEN', true],
  ['NOTION_DATABASE_ID', true],
  ['NOTION_DISCOUNT_DATABASE_ID', true],
]

/**
 * 启动 banner 输出 env 摘要（脱敏）
 */
function logEnvBanner(result: EnvSchema): void {
  const mask = (v: string) => `***${v.slice(-4)}`
  console.info(
    '[env] loaded:',
    {
      ZPAY_PID: mask(result.ZPAY_PID),
      ZPAY_KEY: mask(result.ZPAY_KEY),
      ZPAY_NOTIFY_URL: result.ZPAY_NOTIFY_URL,
      N8N_WEBHOOK_URL: result.N8N_WEBHOOK_URL,
      N8N_WEBHOOK_SECRET: mask(result.N8N_WEBHOOK_SECRET),
      NOTION_TOKEN: mask(result.NOTION_TOKEN),
      NOTION_DATABASE_ID: result.NOTION_DATABASE_ID,
      NOTION_DISCOUNT_DATABASE_ID: result.NOTION_DISCOUNT_DATABASE_ID,
    }
  )
}

/**
 * 格式校验
 */
function validateUrl(value: string): boolean {
  return /^https:\/\//.test(value)
}

function validateNotionToken(value: string): boolean {
  return value.startsWith('ntn_')
}

function validateUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/.test(value)
}

/**
 * 校验所有 env 变量，缺一即抛错（fail-fast）
 * @returns 类型化的 env 对象
 */
function validateEnv(): EnvSchema {
  const missing: string[] = []
  const invalid: string[] = []
  const result = {} as EnvSchema

  for (const [key, required] of SCHEMA) {
    const value = process.env[key]
    if (required) {
      if (!value) {
        missing.push(key)
        continue
      }
      // 格式校验
      if (key === 'ZPAY_NOTIFY_URL' && !validateUrl(value)) {
        invalid.push(`${key}=${value} (must be https://)`)
        continue
      }
      if (key === 'NOTION_TOKEN' && !validateNotionToken(value)) {
        invalid.push(`${key}=${value} (must start with ntn_)`)
        continue
      }
      if (key === 'NOTION_DATABASE_ID' && !validateUuid(value)) {
        invalid.push(`${key}=${value} (must be UUID format)`)
        continue
      }
      if (key === 'NOTION_DISCOUNT_DATABASE_ID' && !validateUuid(value)) {
        invalid.push(`${key}=${value} (must be UUID format)`)
        continue
      }
    }
    if (value) result[key] = value as EnvSchema[keyof EnvSchema]
  }

  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required env variables: ${missing.join(', ')}\n` +
      `Please set them in EdgeOne console or .env.local`
    )
  }

  if (invalid.length > 0) {
    throw new Error(
      `[env] Invalid env variable format: ${invalid.join(', ')}\n` +
      `Please fix them before starting`
    )
  }

  logEnvBanner(result)

  return result
}

export const env = validateEnv()

export type { EnvSchema }