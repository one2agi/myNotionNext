export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}))
  const { name, email, productName, totalFen } = body
  const dbId = env.NOTION_DATABASE_ID
  const token = env.NOTION_TOKEN
  if (!dbId || !token) {
    return new Response(JSON.stringify({ error: 'env missing' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
  const pageData = {
    parent: { database_id: dbId },
    properties: {
      Name: { title: [{ text: { content: name || 'TEST' } }] },
      '客户邮箱': { email: email || null },
      状态: { status: { name: '待发送' } },
      商品名: { rich_text: [{ text: { content: productName || 'TEST' } }] },
      金额: { number: (totalFen || 0) / 100 }
    }
  }
  const start = Date.now()
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(pageData)
  })
  const elapsed = Date.now() - start
  const text = await res.text()
  return new Response(JSON.stringify({
    ok: res.ok, status: res.status, elapsed_ms: elapsed,
    response: text.slice(0, 500)
  }, null, 2), { headers: { 'Content-Type': 'application/json' } })
}
export async function onRequestGet() {
  return new Response(JSON.stringify({
    usage: 'POST {name, email, productName, totalFen}'
  }, null, 2), { headers: { 'Content-Type': 'application/json' } })
}
