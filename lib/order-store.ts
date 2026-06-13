/**
 * 内存订单存储（order-store）
 *
 * 用途：create-order 与 notify 之间共享订单数据（60min TTL）
 * 容器冷启动时 order-store 为空，notify 回调会 fallback 查 Notion 订单 DB
 *
 * @module lib/order-store
 */

interface OrderRecord {
  outTradeNo: string
  productId: string
  productName: string
  customerName: string
  customerEmail: string
  totalPrice: number      // 元
  discountCode?: string
  discountAmount?: number // 元
  finalPrice: number      // 元，ZPay 下单金额
  createdAt: number       // timestamp（ms）
  paid: boolean
}

/**
 * 内存 Map，key = outTradeNo
 * 配合 setInterval 每 5 分钟清理超过 60 分钟的过期记录
 */
const store = new Map<string, OrderRecord>()

// 每 5 分钟清理一次过期记录（>60min TTL）
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const TTL_MS = 60 * 60 * 1000

setInterval(() => {
  const cutoff = Date.now() - TTL_MS
  store.forEach((val, key) => {
    if (val.createdAt < cutoff) {
      store.delete(key)
    }
  })
}, CLEANUP_INTERVAL_MS)

export const orderStore = {
  /**
   * 写入一条订单记录
   */
  set(outTradeNo: string, record: Omit<OrderRecord, 'outTradeNo' | 'createdAt' | 'paid'> & { discountAmount?: number | undefined; discountCode?: string | undefined }): void {
    store.set(outTradeNo, {
      ...record,
      outTradeNo,
      createdAt: Date.now(),
      paid: false,
    })
  },

  /**
   * 读取一条订单记录
   */
  get(outTradeNo: string): OrderRecord | undefined {
    return store.get(outTradeNo)
  },

  /**
   * 标记订单为已支付（幂等）
   */
  markPaid(outTradeNo: string): boolean {
    const record = store.get(outTradeNo)
    if (!record) return false
    record.paid = true
    return true
  },

  /**
   * 检查订单是否已支付
   */
  isPaid(outTradeNo: string): boolean {
    return store.get(outTradeNo)?.paid ?? false
  },
}

export type { OrderRecord }