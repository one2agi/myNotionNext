/**
 * EdgeOne → Notion 连通性测试
 * GET /api/test/notion-ping
 * 返回 {direct: {...}, proxy: {...}, verdict: "ok"|"proxy_only"|"none"}
 */
export async function onRequestGet({ env }) {
  const token = env.NOTION_TOKEN || ''
  const results = {}

  // 测试 1: EdgeOne → Notion 直连
  try {
    const t0 = Date.now()
    const r = await fetch('https://api.notion.com/v1/users/me', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
      },
    })
    const ms = Date.now() - t0
    const text = await r.text()
    results.direct = { ok: r.ok, status: r.status, ms, body: text.slice(0, 150) }
  } catch (e) {
    results.direct = { ok: false, error: e?.message, name: e?.name }
  }

  // 测试 2: EdgeOne → CF Worker 反代 → Notion
  try {
    const t0 = Date.now()
    const r = await fetch('https://notion-proxy.faiz-world.com/v1/users/me', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
      },
    })
    const ms = Date.now() - t0
    const text = await r.text()
    results.proxy = { ok: r.ok, status: r.status, ms, body: text.slice(0, 150) }
  } catch (e) {
    results.proxy = { ok: false, error: e?.message, name: e?.name }
  }

  // 判定
  let verdict = 'none'
  if (results.direct?.ok) verdict = 'ok'
  else if (results.proxy?.ok) verdict = 'proxy_only'

  return new Response(JSON.stringify({ verdict, results }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  })
}
