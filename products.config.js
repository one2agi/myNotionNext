/**
 * Z-Pay Native 商品配置（3 档套餐）
 *
 * Z-Pay Native 接口，金额单位为元，代码内部仍以分存储便于整数算术
 *
 * 重要约定：
 * 1. price 单位是「分」整数（前端显示 `(price/100).toFixed(2)` 转为元，API boundary 也转元）
 * 2. description 长度 ≤ 127 字符
 * 3. id 跟 Pricing 卡片 button 关联，**改 id 要同步改 Pricing.js**
 */
const products = [
  // ¥0.1 = 10 分
  {
    id: 'starter-basic',
    name: '基础版',
    description: '基础 Notion 模板',
    price: 10,
    currency: 'CNY'
  },
  // ¥0.5 = 50 分
  {
    id: 'starter-full',
    name: '标准版',
    description: '完整八大模块 + 永久更新',
    price: 50,
    currency: 'CNY'
  },
  // ¥0.9 = 90 分
  {
    id: 'starter-premium',
    name: '高级版',
    description: '完整模板 + 1v1 启动指导 + 优先支持',
    price: 90,
    currency: 'CNY'
  }
]

module.exports = { products }
