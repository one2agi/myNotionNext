/**
 * 内存订单存储：幂等 + 金额校验 + 60 分钟 TTL 惰性清理
 * 限制：容器重启会丢记录（接受多收一次"成功"事件，钱已落 Z-Pay 不重扣）
 */
const TTL_MS = 60 * 60 * 1000
const store = new Map() // outTradeNo → { amountFen, paid, createdAt, notifiedAt, customerInfo? }

type CustomerInfo = { name: string; email: string; discountCode?: string; partnerName?: string; productName?: string }

function evictExpired(now) {
  for (const [k, r] of store) {
    if (now - r.createdAt > TTL_MS) store.delete(k)
  }
}

export function recordOrder(outTradeNo, priceFen, customerInfo?: CustomerInfo) {
  store.set(outTradeNo, {
    amountFen: priceFen,
    paid: false,
    createdAt: Date.now(),
    notifiedAt: 0,
    customerInfo: customerInfo ?? null,
  })
}

export function markPaid(outTradeNo, moneyYuan) {
  evictExpired(Date.now())
  const rec = store.get(outTradeNo)
  if (!rec) return false
  if (rec.paid) return true // 幂等：已 paid 直接通过
  // 金额比对：元×100 转分（Math.round 容忍浮点误差）
  if (Math.round(moneyYuan * 100) === rec.amountFen) {
    rec.paid = true
    rec.notifiedAt = Date.now()
    return true
  }
  // 金额不匹配：仍标 paid=true 防 Z-Pay 重发时再次失败
  rec.paid = true
  return false
}

export function alreadyPaid(outTradeNo) {
  evictExpired(Date.now())
  const rec = store.get(outTradeNo)
  return Boolean(rec && rec.paid)
}

export function getOrder(outTradeNo): { amountFen: number; paid: boolean; createdAt: number; notifiedAt: number; customerInfo: CustomerInfo | null } | undefined {
  evictExpired(Date.now())
  return store.get(outTradeNo) as any
}