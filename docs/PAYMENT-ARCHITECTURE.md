# 支付系统架构设计文档（PAYMENT-ARCHITECTURE.md）

> 📋 **目的**：全 n8n 架构的支付系统设计文档，作为维护手册
> **版本**：v1.0
> **最后更新**：2026-06-14
> **状态**：已完成

---

## 1. 架构概述

### 1.1 设计原则

- **n8n 统一 Notion 写入**：create-order 和 notify 的 Notion 写入全部走 n8n
- **EdgeOne 职责单一**：只做验签、金额校验、markPaid、发 webhook
- **Cloudflare Worker 反代**：n8n 写 Notion 通过 CF Worker 绕 GFW
- **避免过度设计**：不用额外消息队列、不用 KV 持久化 order-store（内存 Map 60min TTL 足够）
- **order-store fallback**：容器冷启动时 order-store 为空，notify 回调时 fallback 查 Notion 订单 DB 作金额校验
- **折扣计算在 EdgeOne**：优惠码查询与折扣计算在 `create-order` 流程内一并完成（EdgeOne → `lib/discount-codes.ts` → Notion 优惠码 DB），**不提供独立的 `lookup-discount` API**（避免优惠码枚举风险）

### 1.2 整体数据流

```
[用户浏览器]
    ↓ POST /api/pay/create-order
[EdgeOne Pages]
    ↓ 校验参数 + 折扣计算（查 Notion 优惠码 DB）
    ↓ POST ZPay mapi.php 下单
    ↓ return qrcode
    ↓ POST n8n /webhook/create-order
[n8n (VPS)]
    ↓ 写 Notion 订单 DB（幂等：outTradeNo 唯一键）
    ↓ end

[用户扫码支付]

[Z-Pay 异步回调]
    ↓ GET /api/pay/notify
[EdgeOne Pages]
    ↓ MD5 验签 + 金额 ×100 校验 + markPaid
    ↓ POST n8n /webhook/notify
[n8n (VPS)]
    ↓ IF discountCode → PATCH 优惠码 page 使用次数+1
    ↓ UPDATE Notion 订单 DB（写购买日期）
    ↓ end
```

### 1.3 基础设施清单

| 组件 | 位置 | 职责 |
|------|------|------|
| EdgeOne Pages | www.one2agi.com | 云函数：验签、折扣计算、ZPay 下单/查询 |
| n8n 自托管 | n8n.one2agi.com (VPS) | Notion 写入统一入口 |
| CF Worker | notion-proxy.faiz-world.com | Notion API 反代（绕 GFW） |
| Notion | api.notion.com | 订单 DB + 优惠码 DB |
| Z-Pay | merchant.z-pay.cn | 微信 Native 支付 |

---

## 2. 数据库 schema

### 2.1 订单数据库（已有）

| 字段 | 类型 | 说明 |
|------|------|------|
| Name (title) | title | 客户姓名 |
| 客户邮箱 | email | 客户邮箱 |
| 购买日期 | date | 支付成功日期 |
| 状态 | status | "待发送" / "已发送" / "已取消" |
| 订单号 | rich_text | outTradeNo（唯一键） |
| 商品名 | rich_text | 产品名称 |
| 金额 | number | 实际支付金额（元） |

**Database ID**：`6ab4f4cf-c8e2-825e-bde8-016c2d9be1c2`

### 2.2 优惠码数据库（已有）

| 字段 | 类型 | 说明 |
|------|------|------|
| 达人名称 | title | 合作伙伴名称 |
| 优惠码 | rich_text | 优惠码代码（唯一键） |
| 启用优惠码 | checkbox | 打勾 = 启用 |
| 减免金额 | number | 固定减免金额，**单位元**（如 10 = 减 ¥10） |
| 使用次数 | number | 使用计数器 |

**Database ID**：`37e4f4cf-c8e2-8073-aea5-f390b5b2c53d`
**Notion Token**：`<redacted - see INFRASTRUCTURE.md>`（集成"我不叫龙虾"）

---

## 3. API 规格

> **完整 API 规格见 `PAYMENT-API-SPEC.md`**，本节仅列概要。

| 端点 | 用途 | 详细规格 |
|------|------|---------|
| `POST /api/pay/create-order` | 创建订单，返回 qrcode | §3.1 本节 |
| `GET /api/pay/notify` | Z-Pay 异步回调 | §3.2 本节 |
| `GET /api/pay/query-order` | 前端轮询订单状态（兜底） | §3.3 本节 |
| `POST /api/pay/cancel-order` | 取消未支付订单 | §3.4 本节 |

### 3.1 `POST /api/pay/create-order`

**用途**：创建订单，返回微信支付二维码

**请求**：
```json
{
  "productId": "starter-full",
  "customer": { "name": "张三", "email": "test@test.com" },
  "discountCode": "DFDSA26"
}
```

**处理流程**（EdgeOne）：
1. 校验 name（1-50字符）、email（正则）、discountCode（可选）
2. 若有 discountCode → 查询 Notion 优惠码 DB，验启用状态
3. 计算 finalPrice = totalPrice - 减免金额（≥ 0）
4. POST ZPay mapi.php 下单
5. 记录 order-store（outTradeNo → order info，含 discountCode）
6. POST n8n /webhook/create-order
7. 返回 qrcode

**响应 200**：
```json
{
  "outTradeNo": "1750000000000-abc123",
  "qrcode": "weixin://wxpay/bizpayurl?pr=xxx",
  "productName": "基础版",
  "totalPrice": 79,
  "discountAmount": 10,
  "finalPrice": 69,
  "unit": "元"
}
```

**错误码**：
- `E_NAME_EMPTY` / `E_NAME_TOO_LONG` (400)
- `E_EMAIL_INVALID` (400)
- `E_DC_DISABLED` / `E_DC_NOT_FOUND` (400)
- `E_DC_AMOUNT_INVALID`（折扣后 < 0）(400)
- 500（ZPay / n8n / Notion 查询失败）

---

### 3.2 `GET /api/pay/notify`

**用途**：Z-Pay 异步回调

**URL**：`https://www.one2agi.com/api/pay/notify?pid=...&trade_no=...&out_trade_no=...&type=...&name=...&money=...&trade_status=...&sign=...&sign_type=...`

**处理流程**（EdgeOne）：
1. MD5 验签（参数 ASCII 排序 + 排除 sign/sign_type/空值 + md5(arg+KEY) 小写）
2. 若验签失败 → return `sign error`（400），阻止 ZPay 重试
3. 金额校验：
   - 先查 order-store[outTradeNo]
     → 有：用 stored finalPrice 校验
     → 无：查 Notion 订单 DB（fallback），用 DB 里的金额字段校验
   - 公式：`ZPay money == finalPrice`（单位元）
4. 若金额校验失败 → return `amount mismatch`（400）
5. 若 trade_status != TRADE_SUCCESS → return `success`（早 ack）
6. 若 order 已 paid → 幂等 return `success`
7. markPaid（标记 order-store[outTradeNo].paid = true，或更新 Notion page paid 标记）
8. POST n8n /webhook/notify（携带 outTradeNo + paidAmount + discountCode）
9. return `success`

**响应**：
- `200 text/plain success`（通知成功）
- `400 sign error`（验签失败）
- `400 amount mismatch`（金额校验失败）

---

### 3.3 `GET /api/pay/query-order`

**用途**：前端 PayModal 轮询订单支付状态（兜底 Z-Pay 异步回调）

**处理流程**（EdgeOne）：
1. 读 outTradeNo 参数
2. 优先查 order-store.get(outTradeNo)
   - 有 → 返回 { paid, paidAt, productName, finalPrice }
   - 无 → fallback 查 Notion 订单 DB（订单号 = outTradeNo）
3. Notion 有 → 用购买日期判断 paid，返回订单信息
4. 都查不到 → 返回 404 E_ORDER_NOT_FOUND

**响应**：
- 200：`{ code: 0, data: { outTradeNo, paid, paidAt, productName, finalPrice, unit: "元" } }`
- 404：`{ code: 40011, message: "E_ORDER_NOT_FOUND" }`

**性能**：< 50ms（纯内存读 + 可选 Notion fallback）

---

### 3.4 `POST /api/pay/cancel-order`

**用途**：用户主动取消未支付订单（前端 PayModal 取消按钮 / 5 分钟超时自动调用）

**处理流程**（EdgeOne）：
1. 读 outTradeNo
2. 查 order-store：
   - 有 → 检查 paid 状态
     - paid=true → return 400 E_ORDER_ALREADY_PAID
     - cancelled=true → 幂等 return 200（已取消）
     - paid=false → markCancelled（防 notify race） + 发 n8n webhook + 调 ZPay close + return 200
3. order-store miss → fallback 查 Notion 订单 DB
   - Notion 状态=已发送 → return 400 E_ORDER_ALREADY_PAID
   - Notion 状态=已取消 → 幂等 return 200
   - Notion 状态=待发送 → 发 n8n webhook（改状态为"已取消"） + return 200
4. Notion 也查不到 → return 404 E_ORDER_NOT_FOUND

**幂等设计**：
- 同一 outTradeNo 多次 cancel：order-store 已删 → Notion fallback → 状态已是"已取消" → 返 200
- cancel 与 notify race：先 markCancelled 防 notify 写入

**响应**：
- 200：`{ code: 0, data: { outTradeNo, cancelled: true } }`
- 400：`{ code: 40012, message: "E_ORDER_ALREADY_PAID" }`
- 404：`{ code: 40011, message: "E_ORDER_NOT_FOUND" }`

---

## 4. n8n Workflow 设计（3 个）

### 4.1 Workflow 1: create-order

**Webhook URL**：`https://n8n.one2agi.com/webhook/create-order`
**触发方式**：POST

**输入 payload**：
```json
{
  "outTradeNo": "1750000000000-abc123",
  "productId": "starter-full",
  "productName": "基础版",
  "customerName": "张三",
  "customerEmail": "test@test.com",
  "totalPrice": 79,
  "discountCode": "DFDSA26",
  "finalPrice": 69,
  "unit": "元",
  "createdAt": "2026-06-14"
}
```

**节点流**：
```
Webhook Trigger
  ↓
Notion: Create Page (订单 DB)
  parent: { database_id: NOTION_DATABASE_ID }
  properties:
    Name (title): customerName
    客户邮箱 (email): customerEmail
    状态 (status): { name: "待发送" }
    订单号 (rich_text): outTradeNo
    商品名 (rich_text): productName
    金额 (number): finalPrice
  → outTradeNo 作幂等键（重复 POST 会报错 409，workflow 继续不报错）
```

**幂等保证**：Notion DB 建唯一索引（订单号唯一），重复创建返回 409，n8n 吞掉错误继续执行。

---

### 4.2 Workflow 2: notify

**Webhook URL**：`https://n8n.one2agi.com/webhook/notify`
**触发方式**：POST

**输入 payload**：
```json
{
  "outTradeNo": "1750000000000-abc123",
  "paidAmount": 69,
  "paidAt": "2026-06-14",
  "discountCode": "DFDSA26"
}
```

**节点流**：
```
Webhook Trigger
  ↓
IF: discountCode 存在且不为空?
  → Yes:
      Notion: Search Pages (优惠码 DB)
        filter: 优惠码 = discountCode
        limit: 1
          ↓
      Code: 计算 newCount = (currentCount || 0) + 1
          ↓
      Notion: Update Page
        使用次数: newCount
      → proceed
  → No: (跳过优惠码计数)

Notion: Search Pages (订单 DB)
  filter: 订单号 = outTradeNo
  limit: 1
    ↓
Notion: Update Page
  购买日期: paidAt
```

**幂等保证**：
- 订单 DB 已由 create-order 创建，notify 只做 UPDATE
- IF 分支防止 discountCode 为空时查不到 page 报错

---

### 4.3 Workflow 3: cancel-order

**Webhook URL**：`https://n8n.one2agi.com/webhook/cancel-order`
**触发方式**：POST

**输入 payload**：
```json
{
  "outTradeNo": "1750000000000-abc123",
  "cancelledAt": "2026-06-14"
}
```

**节点流**：
```
Webhook Trigger
  ↓
Notion: Search Pages (订单 DB)
  filter: 订单号 = outTradeNo
  limit: 1
    ↓
IF: 状态 != 已发送?
  → Yes:
      IF: 状态 != 已取消?
        → Yes:
            Notion: Update Page
              状态: "已取消"
        → No: (幂等跳过)
  → No: (幂等跳过，已发货订单不处理)
```

**幂等保证**：
- 两层 IF 判断（已发送/已取消）避免重复 UPDATE
- 已发货（已支付）订单不处理cancel
- 找不到订单时 IF 节点输出空，workflow 正常结束

---

## 5. Cloudflare Worker

### 5.1 作用

n8n 在国内 VPS，访问 `api.notion.com` 可能被 GFW 干扰。通过 CF Worker 中转：

```
n8n → https://notion-proxy.faiz-world.com/v1/pages
  ↓
CF Worker (边缘节点) → https://api.notion.com/v1/pages
```

### 5.2 n8n Notion 凭证配置

n8n 中的 Notion API 凭证，API URL 填：
```
https://notion-proxy.faiz-world.com/v1
```

### 5.3 CF Worker 源码

```typescript
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  const notionUrl = `https://api.notion.com${url.pathname}${url.search}`
  
  const response = await fetch(notionUrl, {
    method: request.method,
    headers: {
      ...request.headers,
      'Authorization': request.headers.get('Authorization'),
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: request.body
  })
  
  return new Response(response.body, {
    status: response.status,
    headers: response.headers
  })
}
```

**注意**：此 Worker 源码已在 `notion-proxy.faiz-world.com` 部署，**不需要重新部署**。

---

## 6. 文件结构（精简版）

```
myNotionNext/
├── pages/api/pay/
│   ├── create-order.ts  # POST：校验参数 + 折扣计算 + ZPay下单 + 发 n8n webhook
│   ├── notify.ts        # GET：MD5验签 + 金额校验 + markPaid + 发 n8n webhook
│   ├── query-order.ts   # GET：order-store优先 + Notion fallback（PayModal轮询兜底）
│   └── cancel-order.ts  # POST：markCancelled + n8n webhook + ZPay close
│
├── lib/
│   ├── discount-codes.ts  # 优惠码查询 + 折扣计算（被 create-order 调用）
│   ├── order-store.ts     # 内存订单存储（60min TTL，paid/cancelled标记）
│   └── env.ts              # 启动时校验9个env变量（fail-fast）
│
├── n8n/
│   ├── workflow-zpay-order.json     # create-order webhook
│   ├── workflow-zpay-notify.json    # notify webhook
│   └── workflow-cancel-order.json   # cancel-order webhook
│
└── themes/starter/components/
    ├── PayModal.js          # 支付弹窗（6态机）
    └── PayModalProvider.js  # Context provider
```

**4 个 API 文件 + 3 个 lib 文件 + 3 个 n8n workflow + 2 个前端组件。**

**EdgeOne 环境变量**（控制台配置，不进 git）：
```
ZPAY_PID=2026050116254529
ZPAY_KEY=<redacted - see INFRASTRUCTURE.md>
ZPAY_NOTIFY_URL=https://www.one2agi.com/api/pay/notify
NOTION_TOKEN=<redacted - see INFRASTRUCTURE.md>
NOTION_DATABASE_ID=6ab4f4cf-c8e2-825e-bde8-016c2d9be1c2
NOTION_DISCOUNT_DATABASE_ID=37e4f4cf-c8e2-8073-aea5-f390b5b2c53d
N8N_WEBHOOK_URL=https://n8n.one2agi.com/webhook
N8N_WEBHOOK_SECRET=<redacted - see INFRASTRUCTURE.md>
```

---

## 7. 折扣计算规则

### 7.1 公式

```
finalPrice = totalPrice - 减免金额
```

- `totalPrice` 和 `减免金额` 单位均为**元**
- Z-Pay 下单时：`money = finalPrice`（元），内部 ×100 转为分

### 7.2 校验规则

| 校验 | 条件 | 错误码 | 处理 |
|------|------|--------|------|
| 优惠码存在 | Notion 能查到 | - | 继续 |
| 优惠码启用 | 启用优惠码 = true | E_DC_DISABLED | 弹错，不出 QR |
| 折扣后金额 ≥ 0 | finalPrice >= 0 | E_DC_AMOUNT_INVALID | 弹错，不出 QR |
| 优惠码格式 | A-Z0-9-，6-20字符 | E_DC_FORMAT_INVALID | blur 时前端校验 |

### 7.3 折扣计算时机

| 时机 | 操作 | 说明 |
|------|------|------|
| create-order | 查询 Notion 优惠码 DB + 计算 finalPrice | 校验失败返 400，校验成功返回折扣信息 |
| notify | 不重新计算 | 信任 create-order 的金额 + 金额校验 |

---

## 8. 幂等设计

### 8.1 order-store（内存 Map）

```typescript
// lib/order-store.ts
const store = new Map<string, {
  outTradeNo: string
  productId: string
  productName: string
  customerName: string
  customerEmail: string
  totalPrice: number      // 元
  discountCode?: string
  discountAmount?: number // 元
  finalPrice: number      // 元，ZPay 下单金额
  createdAt: number       // timestamp
  paid: boolean
}>()

// 60min TTL 清理
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [key, val] of store) {
    if (val.createdAt < cutoff) store.delete(key)
  }
}, 5 * 60 * 1000)
```

### 8.2 幂等场景

| 场景 | 处理 |
|------|------|
| 同订单 N 次 ZPay 回调 | 验签通过 + order 已 paid → 幂等 return success |
| 同 outTradeNo 重复 POST create-order | ZPay 会报订单号重复，EdgeOne 返回原 qrcode |
| n8n create-order 重复触发 | Notion DB 订单号唯一键 → 409 冲突，n8n 吞掉 |

---

## 9. 错误处理

### 9.1 EdgeOne 错误

| 错误 | HTTP 状态 | 返回 | 用户影响 |
|------|-----------|------|----------|
| 参数校验失败 | 400 | `{ error: "E_XXX" }` | 弹表单错误提示 |
| ZPay 下单失败 | 500 | `{ error: "E_ZPAY_FAIL" }` | 弹"支付创建失败" |
| n8n webhook 失败 | 200 | 仍返 qrcode（异步写入不阻塞） | 不影响支付，后续人工补 |
| Notion 查询失败（create-order 内的优惠码查询） | 500 | `{ error: "E_NOTION_FAIL" }` | 弹"优惠码校验失败" |
| Notion 查询失败（order-store miss fallback） | 500 | `order not found` | 内存+DB 都查不到，不处理该回调 |
| 金额校验失败 | 400 | `amount mismatch` | 不写 Notion，ZPay 不重发 |

### 9.2 n8n 错误

| 错误 | 处理 |
|------|------|
| Notion API 超时 | n8n 内置重试（3次） |
| Notion 409 冲突 | 吞掉，继续执行 |
| 优惠码 page 查不到 | IF 分支跳过使用次数+1 |

---

## 10. 安全规范

| 维度 | 规则 |
|------|------|
| 签名算法 | MD5（小写 hex），参数 ASCII 排序 + 排除 sign/sign_type/空值 + md5(arg+KEY) |
| 验签算法 | crypto.timingSafeEqual 防时序攻击 |
| 金额校验 | ZPay money × 100 == order-store 记录的 finalPrice |
| KEY 存储 | ZPAY_KEY / NOTION_TOKEN 只在 EdgeOne 控制台和 .env.local，不进 git |
| n8n Webhook 鉴权 | x-n8n-secret header，n8n Code 节点校验 |
| notify_url | 公网 HTTPS，不带 query string |

---

## 11. 故障排查

| 症状 | 排查步骤 |
|------|----------|
| create-order 返回 QR 但 Notion 没 page | 查 EdgeOne 日志看 n8n webhook 是否发出去；查 n8n workflow 执行记录 |
| n8n workflow 失败 | n8n 管理后台 → 该 workflow → Last node → 看 error |
| 优惠码查询 500 | EdgeOne 日志；查 Notion Token 是否有效；查优惠码 DB 是否共享给集成 |
| 金额校验失败 | 确认 order-store 中 finalPrice 与 ZPay 回调 money 一致（注意单位：元 vs 分） |
| 使用次数没 +1 | n8n workflow 是否执行到 PATCH 节点；discountCode 是否正确传递 |
| CF 反代不通 | `curl -I https://notion-proxy.faiz-world.com/v1/pages` 测连通性 |

---

## 12. 部署清单

### 12.1 EdgeOne（需要部署的云函数）

1. `create-order.ts` → `POST /api/pay/create-order`
2. `notify.ts` → `GET /api/pay/notify`

### 12.2 n8n（需要创建的 workflow）

1. `create-order` workflow → webhook: `/webhook/create-order`
2. `notify` workflow → webhook: `/webhook/notify`

### 12.3 环境变量（EdgeOne 控制台）

新增 1 个：
```
NOTION_DISCOUNT_DATABASE_ID=37e4f4cf-c8e2-8073-aea5-f390b5b2c53d
```

---

## 12.5 环境变量集中校验（lib/env.ts）

**目的**：启动时一次性校验所有 env 变量，缺一即抛错，避免运行时才暴露。

### 12.5.1 设计原则

- ✅ **Fail Fast**：缺少 env 时**启动失败**而不是运行时 500
- ✅ **集中位置**：所有 env 在 `lib/env.ts` 一个文件
- ✅ **类型安全**：导出类型化的 `env` 对象，IDE 自动补全
- ✅ **运行时 + 构建时**：开发模式启动即校验，build 时也校验

### 12.5.2 实现

```typescript
// lib/env.ts
interface EnvSchema {
  ZPAY_PID: string
  ZPAY_KEY: string
  ZPAY_NOTIFY_URL: string
  N8N_WEBHOOK_URL: string
  N8N_WEBHOOK_SECRET: string
  NOTION_TOKEN: string
  NOTION_DATABASE_ID: string
  NOTION_DISCOUNT_DATABASE_ID: string  // 新增
}

const SCHEMA: Array<[keyof EnvSchema, boolean]> = [
  ['ZPAY_PID', true],
  ['ZPAY_KEY', true],
  ['ZPAY_NOTIFY_URL', true],
  ['N8N_WEBHOOK_URL', true],
  ['N8N_WEBHOOK_SECRET', true],
  ['NOTION_TOKEN', true],
  ['NOTION_DATABASE_ID', true],
  ['NOTION_DISCOUNT_DATABASE_ID', true],  // 必填，2026-06-14 新增
]

function validateEnv(): EnvSchema {
  const missing: string[] = []
  const result = {} as any
  for (const [key, required] of SCHEMA) {
    const value = process.env[key]
    if (required && !value) missing.push(key)
    if (value) result[key] = value
  }
  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required env variables: ${missing.join(', ')}\n` +
      `Please set them in EdgeOne console or .env.local`
    )
  }
  return result as EnvSchema
}

export const env = validateEnv()
```

### 12.5.3 使用方式

```typescript
// pages/api/pay/create-order.ts
import { env } from '@/lib/env'

// 旧：process.env.ZPAY_KEY（运行时才发现缺）
// 新：env.ZPAY_KEY（启动时已校验）
const zpayKey = env.ZPAY_KEY
```

### 12.5.4 教训背景

2026-06-14 上线 `NOTION_DISCOUNT_DATABASE_ID` 时**漏配 EdgeOne 控制台**：
- 现象：create-order 返回 `E_NOTION_FAIL`（500）
- 排查：30 分钟
- 根因：env 分散在 3 处（代码、文档、控制台），无启动时校验
- 修复：加 `lib/env.ts` 启动即报错，**0 排查时间**

### 12.5.5 备选方案（暂不实施）

- **方案 B**：用 `zod` 库做运行时 schema 校验
- **方案 C**：在 CI/CD 加 env 完整性检查脚本
- **方案 D**：本地用 `dotenv` + 启动脚本

**当前选 A**：最简方案，TypeScript 原生，0 依赖。

---

## 13. 未来增强（本期不做）

- [ ] EdgeOne KV 持久化 order-store（容器冷启动不丢）
- [ ] n8n 发送邮件通知（支付成功/失败）
- [ ] 支付失败重试 UI
- [ ] 真实价格上线（¥79/¥299）
- [ ] ZPay 通知到达监控（定时对账）

---

## 14. 关联文档

- `REQUIREMENTS-payment.md` — 支付业务需求文档
- `INFRASTRUCTURE.md` — 基础设施清单
- `RUNBOOK.md` — 故障排查手册

---

## 15. 实现确认

> 本章节记录优惠码接入功能的实际实现状态，作为架构文档与实现代码的对账清单。

### 15.1 实现日期

- **日期**：2026-06-14
- **分支**：`feat/discount-code-notion`

### 15.2 部署环境

| 组件 | 环境 | 状态 |
|------|------|------|
| EdgeOne Pages (API) | EdgeOne 云函数 | ✅ 已部署 |
| n8n (VPS) | n8n.one2agi.com | ✅ 已配置workflow |
| CF Worker | notion-proxy.faiz-world.com | ✅ 已部署 |

### 15.3 已验证的功能

| 功能 | 文件 | 状态 | 说明 |
|------|------|------|------|
| create-order API | `pages/api/pay/create-order.ts` | ✅ | 参数校验、折扣计算、ZPay下单、n8n webhook |
| notify API | `pages/api/pay/notify.ts` | ✅ | MD5验签、金额校验、markPaid、n8n webhook |
| query-order API | `pages/api/pay/query-order.ts` | ✅ | order-store优先 + Notion fallback |
| cancel-order API | `pages/api/pay/cancel-order.ts` | ✅ | markCancelled + n8n webhook + ZPay close |
| 优惠码查询/折扣计算 | `lib/discount-codes.ts` | ✅ | Notion查询、格式校验、折扣计算 |
| 内存订单存储 | `lib/order-store.ts` | ✅ | 60min TTL、paid标记、cancelled标记 |
| 环境变量校验 | `lib/env.ts` | ✅ | 启动时fail-fast校验9个env变量 |
| n8n create-order workflow | `n8n/workflow-zpay-order.json` | ✅ | Webhook → Notion Create Page |
| n8n notify workflow | `n8n/workflow-zpay-notify.json` | ✅ | IF分支 → 优惠码+1 / 订单购买日期 |
| n8n cancel-order workflow | `n8n/workflow-cancel-order.json` | ✅ | IF未发货? → IF未取消? → 改状态为已取消 |
| PayModal 前端组件 | `themes/starter/components/PayModal.js` | ✅ | 6态机：IDLE/STEP1_FORM/STEP2_QR/SUCCESS/EXPIRED/FAILED |
| PayModalProvider | `themes/starter/components/PayModalProvider.js` | ✅ | Context provider |
| CF Worker | notion-proxy.faiz-world.com | ✅ | Notion API 反代（已部署） |

**实现一致性确认**：
- create-order 流程：参数校验 → 折扣计算 → order-store → ZPay下单 → n8n webhook → 返回qrcode ✅
- notify 流程：验签 → 金额校验 → markPaid → n8n webhook → return success ✅
- query-order 流程：order-store优先 → Notion fallback → 返回paid状态 ✅
- cancel-order 流程：markCancelled(防race) → n8n webhook(改状态) → ZPay close → order-store保留cancelled标记 ✅
- 折扣公式：`finalPrice = totalPrice - 减免金额`（单位：元） ✅
- order-store fallback：容器冷启动时查 Notion 订单 DB ✅
- n8n 幂等：Notion DB 订单号唯一键，409冲突 n8n 吞掉 ✅
- env.ts fail-fast：9个必填env，缺一启动即报错 ✅

### 15.4 待完成项

| 待完成项 | 优先级 | 说明 |
|----------|--------|------|
| 端到端真实支付测试 | 高 | 使用真实微信 Native 支付完成一次完整流程 |
| 优惠码使用次数 +1 验证 | 中 | notify 后检查 Notion 优惠码 page 使用次数是否正确 +1 |
| n8n workflow field ID 配置 | 低 | 在 n8n UI 中根据实际 field ID 调整后重新导出 JSON |

### 15.5 实现与架构差异

| 项目 | 架构设计 | 实际实现 | 差异说明 |
|------|----------|----------|----------|
| create-order n8n payload | 包含 `discountAmount`, `createdAt` | 不包含（Notion page 写入时不写这两个字段） | 不影响功能，订单页不展示这两个字段 |
| cancel-order n8n payload | 未设计 | 包含 `outTradeNo`, `cancelledAt` | n8n webhook 负责改 Notion 状态为"已取消" |
| n8n cancel-order workflow | 未设计 | 3层IF（未发货? → 未取消? → UPDATE） | 幂等保证：已发货/已取消的订单不UPDATE |
| PayModal 状态机 | 4步（form/qrcode/success/error） | 6态（IDLE/STEP1_FORM/STEP2_QR/SUCCESS/EXPIRED/FAILED） | 增加了 EXPIRED（超时）和 IDLE（隐藏）状态 |

### 15.6 备注

- n8n workflow JSON 文件为**模板**，需在 n8n UI 中打开、配置实际 field ID、测试通过后重新导出覆盖文件进 git 管理
- EdgeOne 环境变量（ZPAY_KEY 等）不进 git，由 EdgeOne 控制台管理