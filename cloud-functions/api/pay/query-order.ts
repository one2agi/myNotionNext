/**
 * EdgeOne Pages Cloud Function：GET /api/pay/query-order?outTradeNo=XXX
 *
 * 代理 Z-Pay 订单查询 — 防 ZPAY_KEY 暴露到前端 + 绕过浏览器 CORS。
 * （Z-Pay 官方 query 接口要求 key 在 URL，浏览器直连会泄漏）
 *
 * 响应**白名单**过滤：只返 status / money / tradeNo / msg。
 */
import { queryOrder } from '../../../lib/zpay.js'

export async function onRequestGet({ request, env }: { request: Request; env: Record<string, string> }): Promise<Response> {
  const outTradeNo = new URL(request.url).searchParams.get('outTradeNo')
  if (!outTradeNo) {
    return new Response(JSON.stringify({ error: 'Missing outTradeNo' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' }
    })
  }
  const data = await queryOrder({ outTradeNo, env: env as any })
  return new Response(JSON.stringify({
    status: data.status,
    money: data.money,
    tradeNo: data.trade_no,
    msg: data.msg
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' }
  })
}
