/**
 * 微信支付商品配置（MVP · 单 SKU 模式）
 *
 * 重要约定：
 * 1. price 单位是「分」整数（微信支付 V3 要求）
 * 2. description 长度 ≤ 127 字符（微信字段限制）
 * 3. 正式发布前删除 test-1fen 测试项
 */
const products = [
  {
    id: 'test-1fen',
    name: '测试商品（1 分钱）',
    description: 'MVP 链路联调，正式发布前删除',
    price: 1,
    currency: 'CNY'
  }
]

module.exports = { products }
