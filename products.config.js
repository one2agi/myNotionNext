/**
 * Z-Pay Native 商品配置（MVP · 3 SKU）
 *
 * Z-Pay Native 接口，金额单位为元，代码内部仍以分存储便于整数算术
 *
 * 重要约定：
 * 1. price 单位是「分」整数（前端显示 `(price/100).toFixed(2)` 转为元，API boundary 也转元）
 * 2. description 长度 ≤ 127 字符
 * 3. id 跟 Pricing 卡片 button 关联，**改 id 要同步改 Pricing.js**
 *
 * ⚠️ 当前是**测试金额**（0.1 / 0.3 元），发布前要改回真实价格（7900 / 29900 分）
 */
const products = [
  // 免费版（不走支付）
  {
    id: 'starter-free',
    name: '免费体验版',
    description: '基础 Notion 模板',
    price: 0,
    currency: 'CNY'
  },
  // ¥0.1 = 10 分（测试用）
  {
    id: 'starter-full',
    name: '知行合一 · 完整版',
    description: '完整八大模块 + 永久更新',
    price: 10,
    currency: 'CNY'
  },
  // ¥0.3 = 30 分（测试用）
  {
    id: 'starter-coaching',
    name: '启动陪跑',
    description: '完整模板 + 1v1 启动指导',
    price: 30,
    currency: 'CNY'
  }
]

module.exports = { products }
