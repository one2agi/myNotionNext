/**
 * Notion API 工具函数
 *
 * 提供类型安全的 Notion 属性值读取，避免使用 `as any`
 *
 * @module lib/notion-utils
 */

/** Notion rich_text 属性值 */
export interface NotionRichText {
  type: 'rich_text'
  rich_text: Array<{
    type: 'text'
    text: { content: string; link: null }
    plain_text: string
    href: null
  }>
  annotations: {
    bold: boolean; italic: boolean; strikethrough: boolean; underline: boolean; code: boolean; color: string
  }
  plain_text: string
  href: null
}

/** Notion checkbox 属性值 */
export interface NotionCheckbox {
  type: 'checkbox'
  checkbox: boolean
}

/** Notion number 属性值 */
export interface NotionNumber {
  type: 'number'
  number: number | null
}

/** Notion 属性值联合类型 */
export type NotionPropertyValue =
  | NotionRichText
  | NotionCheckbox
  | NotionNumber
  | { type: string; [key: string]: unknown }

/**
 * 安全的 Notion 属性值读取器
 * @param props Notion page 的 properties 对象
 * @param key 属性名
 */
export function getNotionProperty(
  props: Record<string, unknown>,
  key: string
): NotionPropertyValue | null {
  const prop = props[key]
  if (!prop || typeof prop !== 'object') return null
  return prop as NotionPropertyValue
}

/** 从 rich_text 属性提取纯文本 */
export function getRichText(prop: NotionPropertyValue | null): string {
  if (!prop || prop.type !== 'rich_text') return ''
  const rt = prop.rich_text as Array<{ plain_text: string }> | undefined
  return rt?.[0]?.plain_text ?? ''
}

/** 从 checkbox 属性提取布尔值 */
export function getCheckbox(prop: NotionPropertyValue | null): boolean {
  if (!prop || prop.type !== 'checkbox') return false
  return (prop as NotionCheckbox).checkbox ?? false
}

/** 从 number 属性提取数字 */
export function getNumber(prop: NotionPropertyValue | null): number {
  if (!prop || prop.type !== 'number') return 0
  return (prop as NotionNumber).number ?? 0
}
