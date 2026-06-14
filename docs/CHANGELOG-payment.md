# 支付系统更新日志（CHANGELOG-payment.md）

> 记录支付系统优惠码接入功能的版本变更
> 分支：`feat/discount-code-notion`

---

## [Unreleased] - 2026-06-14

### 已完成

#### 后端 API（4个）

| 文件 | API | 说明 |
|------|-----|------|
| `pages/api/pay/create-order.ts` | `POST /api/pay/create-order` | 参数校验 + 折扣计算 + ZPay下单 + n8n webhook |
| `pages/api/pay/notify.ts` | `GET /api/pay/notify` | MD5验签 + 金额校验 + markPaid + n8n webhook |
| `pages/api/pay/query-order.ts` | `GET /api/pay/query-order` | order-store优先 + Notion fallback（PayModal轮询兜底） |
| `pages/api/pay/cancel-order.ts` | `POST /api/pay/cancel-order` | markCancelled + n8n webhook + ZPay close |

#### 核心库（3个）

| 文件 | 说明 |
|------|------|
| `lib/discount-codes.ts` | 优惠码查询 + 折扣计算 |
| `lib/order-store.ts` | 内存订单存储（60min TTL，paid/cancelled标记） |
| `lib/env.ts` | 启动时校验9个env变量（fail-fast） |

#### n8n Workflow（3个）

| 文件 | Webhook | 说明 |
|------|---------|------|
| `n8n/workflow-zpay-order.json` | `/webhook/create-order` | 创建 Notion 订单 Page |
| `n8n/workflow-zpay-notify.json` | `/webhook/notify` | 优惠码+1 + 购买日期 |
| `n8n/workflow-cancel-order.json` | `/webhook/cancel-order` | 改状态为"已取消" |

#### 前端组件（2个）

| 文件 | 说明 |
|------|------|
| `themes/starter/components/PayModal.js` | 支付弹窗（6态机：IDLE/STEP1_FORM/STEP2_QR/SUCCESS/EXPIRED/FAILED） |
| `themes/starter/components/PayModalProvider.js` | Context provider |

---

## 变更详情

### 2026-06-14 - query-order 和 cancel-order API 实现

**query-order.ts**：
- 优先查 `order-store.get(outTradeNo)` 返回 paid 状态
- order-store miss 时 fallback 查 Notion 订单 DB（购买日期存在 = 已支付）
- 返回 `{ outTradeNo, paid, paidAt, productName, finalPrice, unit: "元" }`

**cancel-order.ts**：
- `orderStore.markCancelled(outTradeNo)` 防 notify race（先于 notify 标记）
- POST n8n `/webhook/cancel-order` 改 Notion 状态为"已取消"
- 调用 ZPay `https://z-pay.cn/api.php?act=close` 关闭订单
- 已支付订单禁止取消（返回 E_ORDER_ALREADY_PAID）
- 幂等设计：同一订单多次 cancel 返回 200

**order-store.ts**：
- 新增 `markCancelled()` 方法和 `cancelled` 字段
- 新增 `isCancelled()` 方法

**PayModal.js**：
- 6态机：IDLE → STEP1_FORM → STEP2_QR → SUCCESS/EXPIRED/FAILED
- 5s 轮询 `query-order` API
- 5分钟超时自动调用 `cancel-order`

**n8n workflow-cancel-order.json**：
- 3层 IF 判断（未发货? → 未取消? → UPDATE）
- 幂等保证：已发货/已取消的订单不UPDATE

---

## 环境变量变更

### 新增（2026-06-14）

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `NOTION_DISCOUNT_DATABASE_ID` | 优惠码数据库 ID | ✅ |

### 完整清单（9个必填）

```
ZPAY_PID
ZPAY_KEY
ZPAY_NOTIFY_URL
N8N_WEBHOOK_URL
N8N_WEBHOOK_SECRET
NOTION_TOKEN
NOTION_DATABASE_ID
NOTION_DISCOUNT_DATABASE_ID
```

---

## 部署记录

| 日期 | 组件 | 状态 |
|------|------|------|
| 2026-06-14 | EdgeOne Pages (create-order/notify/query-order/cancel-order) | ✅ 已部署 |
| 2026-06-14 | n8n workflows (create-order/notify/cancel-order) | ✅ 已配置 |
| 2026-06-14 | CF Worker (notion-proxy.faiz-world.com) | ✅ 已部署 |

---

## 已知问题

| 问题 | 优先级 | 说明 |
|------|--------|------|
| 端到端真实支付测试未完成 | 高 | 需使用真实微信 Native 支付完成一次完整流程 |
| 优惠码使用次数 +1 验证 | 中 | notify 后需检查 Notion 优惠码 page 使用次数是否正确 +1 |
| n8n workflow field ID 配置 | 低 | 在 n8n UI 中根据实际 field ID 调整后重新导出 JSON |

---

## 关联文档

- `PAYMENT-ARCHITECTURE.md` - 架构设计文档
- `PAYMENT-API-SPEC.md` - API 接口规格
- `PAYMENT-FRONTEND-DESIGN.md` - 前端集成设计
- `PAYMENT-IMPLEMENTATION-NOTES.md` - 实施笔记
