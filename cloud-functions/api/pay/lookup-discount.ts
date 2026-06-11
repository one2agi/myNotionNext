/**
 * EdgeOne Pages Cloud Function：GET /api/pay/lookup-discount?code=XXX
 *
 * 用途：PayModal Step 1 blur 时**预校验**优惠码（不创建订单，不调 Z-Pay）。
 *      服务端二次校验防止客户端绕过。
 *
 * 契约（见 docs/PAYMENT-FORM-DESIGN.md §8.2）：
 *   - 200 命中   → { code, partnerName, discountPct, valid: true }
 *   - 400 disabled → { code: 'E_DC_DISABLED', valid: false }
 *   - 404 未匹配  → { code: 'E_DC_NOT_FOUND', valid: false }
 *   - 400 缺参数  → { code: 'E_DC_FORMAT', valid: false }
 *
 * 失败/未匹配 4xx 响应，不返 5xx（用户输入错误非服务端故障）。
 */
import { lookupDiscount, DiscountNotFoundError, DiscountDisabledError } from '../../../lib/discount-codes'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' }

export async function onRequestGet({ request }: { request: Request; env: Record<string, string> }): Promise<Response> {
  const code = new URL(request.url).searchParams.get('code')

  if (!code) {
    return new Response(
      JSON.stringify({ code: 'E_DC_FORMAT', message: 'code param required', valid: false }),
      { status: 400, headers: JSON_HEADERS }
    )
  }

  try {
    const entry = lookupDiscount(code)
    return new Response(
      JSON.stringify({
        code,
        partnerName: entry.partnerName,
        discountPct: entry.discountPct,
        valid: true,
      }),
      { status: 200, headers: JSON_HEADERS }
    )
  } catch (e) {
    if (e instanceof DiscountDisabledError) {
      return new Response(
        JSON.stringify({ code: 'E_DC_DISABLED', valid: false }),
        { status: 400, headers: JSON_HEADERS }
      )
    }
    if (e instanceof DiscountNotFoundError) {
      return new Response(
        JSON.stringify({ code: 'E_DC_NOT_FOUND', valid: false }),
        { status: 404, headers: JSON_HEADERS }
      )
    }
    // 真未知错误（lookup 内部 bug）— 让 EdgeOne 5xx，自然触发告警
    throw e
  }
}
