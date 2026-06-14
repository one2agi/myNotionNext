# 支付前端集成设计文档（PAYMENT-FRONTEND-DESIGN.md）

> 📋 **目的**：定义 starter 主题 Pricing 区域 + PayModal 弹窗的前端 UX
> **版本**：v1.0
> **最后更新**：2026-06-14
> **状态**：待实现
> **配合文档**：`PAYMENT-ARCHITECTURE.md` / `PAYMENT-API-SPEC.md`

---

## 1. 设计目标

把 starter 主题的 Pricing 区域从纯静态链接改为**触发 PayModal**，用户填表 → 调 `create-order` API → 拿二维码 → 微信扫码 → 3s 轮询订单状态 → 支付成功关闭弹窗。

---

## 2. 用户流程

```
[1] 用户访问首页 /starter 价格区
        ↓
[2] 点击 "立即支付" 按钮（PRICING_2 / PRICING_3）
        ↓ 触发 PayModal
[3] PayModal 显示：表单（姓名 / 邮箱 / 优惠码）
        ↓
[4] 用户填写 → 提交
        ↓ POST /api/pay/create-order
[5] EdgeOne 校验 + 调 ZPay + 发 n8n webhook
        ↓ return { outTradeNo, qrcode, productName, finalPrice, ... }
[6] PayModal 显示二维码（qrcode 字段）
        ↓ 自动 3s 轮询订单状态
[7] 用户微信扫码支付
        ↓
[8] ZPay 异步回调 EdgeOne /api/pay/notify
        ↓ 触发 n8n notify workflow
        ↓ n8n 写 Notion "待发送" → "已发送"（人工处理）
        ↓
[9] PayModal 轮询到 status=paid
        ↓
[10] 显示成功提示 + 关闭按钮
```

---

## 3. Pricing.js 改造

### 3.1 当前现状

每个按钮是 `<SmartLink href={...}>`，链接到 `notion.site` 或 `#`。

### 3.2 改造方案

- PRICING_1（免费版）：保持 SmartLink 不变（无支付）
- PRICING_2 / PRICING_3（付费版）：改为 `<button onClick={() => openPayModal(productId)}>`

### 3.3 productId 映射

| 按钮 | productId | productName | price |
|------|-----------|-------------|-------|
| PRICING_2 | `starter-full` | 知行合一 · 完整版 | ¥79 |
| PRICING_3 | `pro-full` | 启动陪跑 | ¥299 |

**在 `themes/starter/config.js` 中通过 `STARTER_PRODUCT_ID` 变量配置**：

```javascript
STARTER_PRICING_2_PRODUCT_ID: 'starter-full',
STARTER_PRICING_3_PRODUCT_ID: 'pro-full',
```

---

## 4. PayModal 组件设计

### 4.1 组件路径

`themes/starter/components/PayModal.js`

### 4.2 组件状态

```typescript
type PayStep = 'form' | 'qrcode' | 'success' | 'error'
type PayModalState = {
  step: PayStep
  productId: string
  productName: string
  totalPrice: number
  discountAmount: number
  finalPrice: number
  outTradeNo: string
  qrcode: string
  errorMessage: string
}
```

### 4.3 UI 结构

```
┌──────────────────────────────────────┐
│  ✕                              [关闭]│
├──────────────────────────────────────┤
│                                      │
│  [Step 1: 表单]                      │
│  ┌────────────────────────────────┐  │
│  │ 姓名 *                          │  │
│  │ [____________________]         │  │
│  │                                 │  │
│  │ 邮箱 *                          │  │
│  │ [____________________]         │  │
│  │                                 │  │
│  │ 优惠码 (可选)                   │  │
│  │ [____________________]         │  │
│  │  折扣: -¥10  最终: ¥69          │  │
│  │                                 │  │
│  │     [   立即支付 ¥79   ]        │  │
│  └────────────────────────────────┘  │
│                                      │
│  [Step 2: 二维码]                    │
│  ┌────────────────────────────────┐  │
│  │     ┌──────────────┐           │  │
│  │     │              │           │  │
│  │     │  QR Code     │           │  │
│  │     │              │           │  │
│  │     └──────────────┘           │  │
│  │  请使用微信扫码支付              │  │
│  │  订单号: 1750000000-abc123      │  │
│  │  金额: ¥69                      │  │
│  │  [ 取消订单 ]                   │  │
│  └────────────────────────────────┘  │
│                                      │
│  [Step 3: 成功]                      │
│  ┌────────────────────────────────┐  │
│  │       ✓ 支付成功                │  │
│  │  订单已确认，资料将在 24 小时内  │  │
│  │  发送到您的邮箱                 │  │
│  │  [   关闭   ]                  │  │
│  └────────────────────────────────┘  │
│                                      │
│  [Step 4: 错误]                      │
│  ┌────────────────────────────────┐  │
│  │  ✕ 支付失败                    │  │
│  │  [errorMessage]                │  │
│  │  [   重试   ] [   关闭   ]    │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

### 4.4 关键交互

| 交互 | 触发 | 行为 |
|------|------|------|
| 打开 Modal | Pricing 按钮 onClick | `setStep('form')` + 重置 state |
| 输入优惠码 | onBlur (debounce 500ms) | 调 `lookup-discount` API（可选）或调 `create-order` 时一并校验 |
| 提交表单 | onClick "立即支付" | `POST /api/pay/create-order` |
| 显示二维码 | API 返回成功 | `setStep('qrcode')` + 启动 3s 轮询 |
| 轮询 | setInterval 3s | `GET /api/pay/query-order?outTradeNo=xxx` |
| 检测支付成功 | 轮询返回 `paid=true` | `setStep('success')` + 清除 interval |
| 用户取消 | onClick "取消订单" | 关闭 modal + 清除 interval + 清空 state |
| 错误 | API 返 4xx/5xx | `setStep('error')` + 显示 errorMessage |

---

## 5. QR Code 渲染

### 5.1 方案 A：用 ZPay 返回的 `imgUrl`

```tsx
{step === 'qrcode' && (
  <img src={imgUrl} alt="支付二维码" className="w-64 h-64" />
)}
```

简单，但依赖 ZPay 服务稳定性。

### 5.2 方案 B：用 `weixin://` deep link + 二维码库

```bash
yarn add qrcode.react
```

```tsx
import QRCode from 'qrcode.react'
<QRCode value={qrcode} size={256} />
```

可控，但增加依赖。**推荐方案 A**（保持简单）。

---

## 6. 订单轮询

### 6.1 轮询 API

`GET /api/pay/query-order?outTradeNo=xxx`

**响应**：
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "outTradeNo": "1750000000-abc123",
    "paid": true,
    "paidAt": "2026-06-14"
  }
}
```

### 6.2 轮询逻辑

```javascript
useEffect(() => {
  if (step !== 'qrcode') return
  const timer = setInterval(async () => {
    const res = await fetch(`/api/pay/query-order?outTradeNo=${outTradeNo}`)
    const data = await res.json()
    if (data.data?.paid) {
      setStep('success')
      clearInterval(timer)
    }
  }, 3000)
  return () => clearInterval(timer)
}, [step, outTradeNo])
```

### 6.3 超时处理

- 5 分钟（100 次轮询）未支付 → 提示"订单超时"
- 用户可关闭 modal 或重新发起

---

## 7. 错误处理

| 错误 | 来自 API | 用户提示 |
|------|---------|---------|
| E_NAME_EMPTY | 400 | "请填写姓名" |
| E_EMAIL_INVALID | 400 | "邮箱格式错误" |
| E_DC_NOT_FOUND | 400 | "优惠码不存在" |
| E_DC_DISABLED | 400 | "优惠码已停用" |
| E_DC_AMOUNT_INVALID | 400 | "折扣金额超出" |
| E_DC_FORMAT_INVALID | 400 | "优惠码格式错误" |
| E_ZPAY_FAIL | 500 | "支付创建失败，请重试" |
| E_NOTION_FAIL | 500 | "系统繁忙，请稍后再试" |
| 429 限流 | - | "请求过于频繁" |

---

## 8. 样式规范

- 复用 starter 主题现有 design system（Tailwind classes）
- 弹窗：position fixed + z-50 + backdrop blur
- 配色：primary（主按钮）+ dark mode 支持
- 响应式：移动端 modal 占满 90% 视口

---

## 9. 国际化

- 中文为主（业务目标市场）
- 文案配置化（不放死文字）
- 价格单位：¥（元）
- 货币符号从 `siteConfig` 读取

---

## 10. 可访问性

- Modal 打开时 focus trap
- ESC 键关闭
- 焦点回到触发按钮
- `role="dialog"` + `aria-modal="true"`

---

## 11. 性能

- 二维码图片懒加载
- 轮询失败重试 3 次后退避
- 关闭 modal 时清理所有 timers + state

---

## 12. 安全

- ✅ 不在前端暴露 `ZPAY_KEY` / `NOTION_TOKEN`
- ✅ 优惠码 blur 时不查真实折扣（防止枚举），仅在 create-order 时校验
- ✅ 防止重复提交（提交期间禁用按钮）
- ✅ 订单超时清理（5 分钟）

---

## 13. 待补 API

**`GET /api/pay/query-order`** 当前**未实现**！需要新建：

```
pages/api/pay/query-order.ts
- 从 order-store 查 paid 状态
- fallback 查 Notion 订单 DB
- 返回 { paid, paidAt, productName, finalPrice }
```

---

## 14. 文件清单

```
新增：
- pages/api/pay/query-order.ts         # 订单状态查询
- themes/starter/components/PayModal.js  # 支付弹窗组件

修改：
- themes/starter/components/Pricing.js    # 按钮改 onClick 触发 modal
- themes/starter/config.js                # 新增 productId 配置
- themes/starter/index.js 或 theme.js     # 引入 PayModal（可选）
```

---

## 15. 验证清单

- [ ] 点 PRICING_2 按钮 → 弹窗打开
- [ ] 不填姓名 → 提交提示错误
- [ ] 错误邮箱 → 提交提示
- [ ] 输入有效优惠码 → 显示折扣
- [ ] 输入禁用优惠码 → 提示
- [ ] 提交成功 → 显示二维码
- [ ] 用微信扫码 → 实际支付 1 分钱（测试）
- [ ] 支付完成 → 自动跳成功页
- [ ] 5 分钟超时 → 提示订单超时
- [ ] 移动端 modal 显示正常

---

## 16. 未来增强

- [ ] 真实价格上线（¥79 / ¥299）
- [ ] 支付失败重试 UI
- [ ] 优惠码输入时的实时校验（mock 数据，blur 触发）
- [ ] 邮件通知（n8n 节点）
- [ ] 订单历史（需登录态）
