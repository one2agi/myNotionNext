/**
 * Notion API 客户端（EdgeOne Pages Cloud Function 兼容）
 * 不依赖 axios / @notionhq/client，纯 fetch。
 *
 * 用途：create-order 阶段直接调 Notion API 写 page（状态="待发送"），
 *       客户信息（email/姓名/商品名）永不丢失。
 *
 * 关键约束：
 * - 状态字段是 To-do 模板，"待发送"是初始状态（不是"待支付"，因为只有付款后才写）
 * - fetch 直连 api.notion.com；若 EdgeOne→Notion 被 GFW 阻，
 *   改 NOTION_API_BASE 为 https://notion-proxy.faiz-world.com/v1
 */

const NOTION_API_VERSION = '2022-06-28'
const NOTION_API_BASE = process.env.NOTION_API_BASE || 'https://api.notion.com/v1'

function getHeaders(env) {
  const token = env.NOTION_TOKEN
  if (!token) throw new Error('NOTION_TOKEN env not set')
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_API_VERSION,
    'Content-Type': 'application/json',
  }
}

/**
 * 创建 Notion page（状态="待发送"）
 * @param {{outTradeNo, name, email, productName, totalFen, env}} args
 * @returns {Promise<{pageId: string, url: string}>}
 */
export async function createOrderPage({ outTradeNo, name, email, productName, totalFen, env }) {
  const databaseId = env.NOTION_DATABASE_ID
  if (!databaseId) throw new Error('NOTION_DATABASE_ID env not set')

  const body = {
    parent: { database_id: databaseId },
    properties: {
      // Name (title) — 客户姓名
      Name: {
        title: [{ text: { content: name || '匿名' } }],
      },
      // 客户邮箱
      '客户邮箱': email ? { email } : { email: null },
      // 状态 = "待发送"（不是"待支付"——To-do 模板的初始状态）
      状态: { status: { name: '待发送' } },
      // 订单号
      订单号: { rich_text: [{ text: { content: outTradeNo } }] },
      // 商品名
      商品名: { rich_text: [{ text: { content: productName } }] },
      // 金额（元）
      金额: { number: totalFen / 100 },
    },
  }

  const res = await fetch(`${NOTION_API_BASE}/pages`, {
    method: 'POST',
    headers: getHeaders(env),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion create page failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }

  const data = await res.json()
  return { pageId: data.id, url: data.url }
}

/**
 * 按 outTradeNo 查 pageId（用于 Upsert 语义）
 * @param {{outTradeNo, env}} args
 * @returns {Promise<string|null>} pageId 或 null（不存在）
 */
export async function findPageByOutTradeNo({ outTradeNo, env }) {
  const databaseId = env.NOTION_DATABASE_ID
  if (!databaseId) throw new Error('NOTION_DATABASE_ID env not set')

  const body = {
    filter: {
      property: '订单号',
      rich_text: { equals: outTradeNo },
    },
    page_size: 1,
  }

  const res = await fetch(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
    method: 'POST',
    headers: getHeaders(env),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion query failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }

  const data = await res.json()
  if (data.results && data.results.length > 0) {
    return data.results[0].id
  }
  return null
}

/**
 * PATCH page（更新 购买日期 + 客户姓名/邮箱/商品名 兜底补全）
 * @param {{pageId, paidAt, name?, email?, productName?, env}} args
 */
export async function updateOrderPage({ pageId, paidAt, name, email, productName, env }) {
  const properties = {
    '购买日期': { date: { start: paidAt } },
  }
  // 兜底：如果 page 里这些字段为空，补全
  if (name) properties.Name = { title: [{ text: { content: name } }] }
  if (email) properties['客户邮箱'] = { email }
  if (productName) properties['商品名'] = { rich_text: [{ text: { content: productName } }] }

  const res = await fetch(`${NOTION_API_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: getHeaders(env),
    body: JSON.stringify({ properties }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion update page failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  return await res.json()
}
