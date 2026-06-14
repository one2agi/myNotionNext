# 支付系统实施级架构补充（PAYMENT-IMPLEMENTATION-NOTES.md）

> 📋 **目的**：system-architect 对前端 6 项实现的设计验证 + 实施级架构补充
> **版本**：v1.0
> **日期**：2026-06-14
> **分支**：`feat/discount-code-notion`
> **范围**：query-order / cancel-order / PayModal / Pricing / env.ts / n8n cancel-order workflow
> **配合文档**：
> - `docs/PAYMENT-ARCHITECTURE.md` v1.0
> - `docs/PAYMENT-API-SPEC.md` v1.0
> - `docs/PAYMENT-FRONTEND-DESIGN.md` v1.0

---

## A. 设计验证 Checklist

> 每条对照已有 3 份设计文档（架构/API/前端）+ 现有后端代码 + 业务规则需求文档（REQUIREMENTS-payment v2.0）

### A.1 后端 API 端

| # | 项 | 文档位置 | 验证结果 | 备注 |
|---|----|---------|---------|------|
| 1 | query-order 走 order-store 优先 + Notion fallback | API-SPEC §3.5.5 | ✅ | 与 notify fallback 一致；性能：内存读 < 50ms |
| 2 | query-order 404 用 `E_ORDER_NOT_FOUND` (40011) | API-SPEC §3.5.4 / §1.3 | ✅ | codeMap 一致 |
| 3 | query-order 响应字段 `outTradeNo / paid / paidAt / productName / finalPrice` | API-SPEC §3.5.2/3 | ✅ | 但缺 `unit`（前端渲染 ¥ 需要）— 补 |
| 4 | cancel-order 幂等：已取消订单重复 POST 返回成功 | API-SPEC §3.6 | ⚠️ 部分 | 设计仅说"删 order-store + 发 webhook"，未明确幂等策略 — 补 |
| 5 | cancel-order 拒绝已支付订单（`E_ORDER_ALREADY_PAID` 40012） | API-SPEC §3.6.3 / §3.6.6 | ✅ | 新增错误码已注册 |
| 6 | cancel-order fallback 查 Notion 处理"冷启动后超时订单" | API-SPEC §3.6.5 | ✅ | 与 notify 同一套 fallback 路径 |
| 7 | 错误响应统一 `{ code, message, data }` 格式 | API-SPEC §1.2 | ✅ | 与 create-order/notify 一致 |

### A.2 前端 PayModal

| # | 项 | 文档位置 | 验证结果 | 备注 |
|---|----|---------|---------|------|
| 1 | 5 状态机 IDLE/STEP1_FORM/STEP2_QR/SUCCESS/EXPIRED/FAILED | FRONTEND §4.2 / REQ §3.2 | ⚠️ | 设计文档 §4.2 用 4 状态（form/qrcode/success/error），需求文档 §3.2 用 5 状态（IDLE/STEP1/STEP2/SUCCESS/EXPIRED/FAILED），**状态机需统一** |
| 2 | 5s 轮询订单状态 | FRONTEND §6.2 | ✅ | Stripe/PayPal 业界标准 |
| 3 | 5 分钟超时调 cancel-order 自动清理 | FRONTEND §6.3 | ✅ | 防遗留订单 |
| 4 | 优惠码 blur 不调 API（防枚举） | FRONTEND §4.4 / REQ §2.2 | ⚠️ | REQ §2.2 描述"blur 校验 + 服务端 lookup-discount"与 FRONTEND §4.4 描述"不调 API"**直接矛盾**；以 FRONTEND（更安全）为准，blur 仅做格式校验 |
| 5 | 提交期间禁用按钮防重复 | FRONTEND §12 | ✅ | |
| 6 | 焦点陷阱 + ESC 关闭 + role=dialog + aria-modal | FRONTEND §10 | ✅ | 可访问性 |
| 7 | 关闭 modal 清理所有 timer + state | FRONTEND §11 | ✅ | 防内存泄漏 |
| 8 | QR Code 渲染方案 A：ZPay imgUrl | FRONTEND §5.1 | ✅ | 推荐 |
| 9 | 错误码 → 用户文案映射 | FRONTEND §7 | ✅ | 11 条 |
| 10 | 货币符号 ¥ 走 siteConfig | FRONTEND §9 | ✅ | |

### A.3 Pricing.js 改造

| # | 项 | 文档位置 | 验证结果 | 备注 |
|---|----|---------|---------|------|
| 1 | PRICING_1（免费）保持 SmartLink | FRONTEND §3.2 | ✅ | |
| 2 | PRICING_2/3 改 `<button onClick={openPayModal}>` | FRONTEND §3.2 | ✅ | |
| 3 | productId 配置走 `themes/starter/config.js` `STARTER_PRICING_X_PRODUCT_ID` | FRONTEND §3.3 | ✅ | 防止硬编码 |

### A.4 lib/env.ts

| # | 项 | 文档位置 | 验证结果 | 备注 |
|---|----|---------|---------|------|
| 1 | 集中校验 8 个 env 变量 | ARCH §12.5 | ✅ | 含 `NOTION_DISCOUNT_DATABASE_ID` |
| 2 | Fail-Fast 启动即抛错 | ARCH §12.5.1 | ✅ | 教训：2026-06-14 漏配 30min 排查 |
| 3 | TS 接口 + 导出 `env` 对象 | ARCH §12.5.2 | ✅ | IDE 自动补全 |
| 4 | 当前用 TS 原生校验（不引 zod） | ARCH §12.5.5 | ✅ | 0 依赖 |

### A.5 n8n /webhook/cancel-order workflow

| # | 项 | 文档位置 | 验证结果 | 备注 |
|---|----|---------|---------|------|
| 1 | 改 Notion 状态为"已取消"（不删 page） | API-SPEC §3.6.7 | ✅ | MVP 推荐保留审计记录 |
| 2 | 已支付订单不修改状态 | API-SPEC §3.6.5 | ✅ | IF 分支判断 paid |

---

## B. 实施级架构补充

### B.1 query-order 缓存策略

**决策**：**不走 order-store 缓存**（不需要）。order-store 本身已是内存 Map（O(1) 读），加 KV/Redis 反而引入新依赖与冷启动一致性问题。**直接 order-store.get(outTradeNo)** 即可，fallback Notion 仅在容器冷启动场景触发（罕见）。

**接口形态（伪代码）**：

```typescript
// pages/api/pay/query-order.ts
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ code: 40501, message: 'E_METHOD_NOT_ALLOWED' })

  const { outTradeNo } = req.query
  if (!outTradeNo || typeof outTradeNo !== 'string') {
    return res.status(400).json({ code: 40000, message: 'E_PARAM_MISSING', data: null })
  }

  // 1. order-store 优先
  const cached = orderStore.get(outTradeNo)
  if (cached) {
    return res.status(200).json({
      code: 0,
      message: 'success',
      data: {
        outTradeNo,
        paid: cached.paid,
        paidAt: cached.paidAt ?? null,
        productName: cached.productName,
        finalPrice: cached.finalPrice,
        unit: '元',
      },
    })
  }

  // 2. fallback 查 Notion 订单 DB（容器冷启动场景）
  try {
    const notion = await getNotionClient()
    const page = await notion.databases.query({
      database_id: env.NOTION_DATABASE_ID,
      filter: { property: '订单号', rich_text: { equals: outTradeNo } },
      page_size: 1,
    })
    if (page.results.length === 0) {
      return res.status(404).json({ code: 40011, message: 'E_ORDER_NOT_FOUND', data: null })
    }
    const p = page.results[0]
    const 购买日期 = getNotionProperty(p, '购买日期', 'date')  // notion-utils
    return res.status(200).json({
      code: 0,
      message: 'success',
      data: {
        outTradeNo,
        paid: Boolean(购买日期),
        paidAt: 购买日期?.start ?? null,
        productName: getRichText(p, '商品名'),
        finalPrice: getNumber(p, '金额'),
        unit: '元',
      },
    })
  } catch (err) {
    return res.status(500).json({ code: 40010, message: 'E_NOTION_FAIL', data: null })
  }
}
```

**关键点**：
- 响应补 `unit: '元'`（前端渲染 ¥ 必需）
- `paidAt` 用 `date.start` 字段，无值则 null
- 限流：本期不加（只查自己生成的 outTradeNo，无枚举面）

### B.2 cancel-order 幂等策略

**3 个幂等维度**：

| 场景 | 幂等处理 |
|------|---------|
| 同一 outTradeNo 多次 cancel POST | order-store 已删 → 后续查询落 Notion → 状态已是"已取消" → 返 200 `{ cancelled: true }` |
| 取消时恰好 notify 到达（race） | 必须**先 markPaid 再查 paid**（用 read-then-write 不可靠，**需用 check-after-delete 模式**） |
| n8n cancel workflow 重复触发 | Notion 状态已是"已取消" → IF 节点判断 currentStatus ≠ "已取消" 才 UPDATE，**n8n 自身也需幂等** |

**race condition 缓解**（见 D.2）：
```typescript
// cancel-order.ts
const cached = orderStore.get(outTradeNo)
if (cached?.paid) return 400 E_ORDER_ALREADY_PAID  // 先查 paid

// 1. 标记 cancelled（防 notify 写入）
orderStore.set(outTradeNo, { ...cached, paid: false, cancelled: true })

// 2. 发 n8n webhook 改 Notion 状态
await fetch(`${env.N8N_WEBHOOK_URL}/cancel-order`, { ... })

// 3. 删除 order-store（最后删，防 race）
orderStore.delete(outTradeNo)

return 200 { cancelled: true }
```

**order-store 记录扩展**：需新增 `cancelled?: boolean` 与 `paidAt?: string` 字段。

### B.3 PayModal 时序图

```
用户          Pricing.js      PayModal         query-order API      create-order API      Z-Pay       notify API       n8n
 │                │              │                    │                    │                 │            │            │
 │─click PRICING─→│              │                    │                    │                 │            │            │
 │                │─openPayModal→│                    │                    │                 │            │            │
 │                │              │ step=IDLE→STEP1    │                    │                 │            │            │
 │                │              │                    │                    │                 │            │            │
 │─填表 submit────┼──────────────│                    │                    │                 │            │            │
 │                │              │─POST /create-order──────────────────────→│                 │            │            │
 │                │              │                    │                    │─Z-Pay mapi.php→│            │            │
 │                │              │                    │                    │←─qrcode────────│            │            │
 │                │              │                    │                    │─n8n create-order────────────────────→│ (Notion "待发送")
 │                │              │←────200 qrcode/价格/订单号─────────────────────────────────────────│            │
 │                │              │ step=STEP2_QR      │                    │                 │            │            │
 │                │              │ 启动 5s 轮询       │                    │                 │            │            │
 │                │              │                    │                    │                 │            │            │
 │─打开微信扫─────│              │                    │                    │                 │            │            │
 │                │              │─GET /query-order──→│ (order-store hit) │                 │            │            │
 │                │              │←─paid:false───────│                    │                 │            │            │
 │                │              │                    │                    │                 │            │            │
 │                │              │  ... (重复轮询) ...                    │                 │            │            │
 │                │              │                    │                    │                 │            │            │
 │                │              │                    │                    │            (用户支付)   │            │
 │                │              │                    │                    │                 │─notify GET─→│            │
 │                │              │                    │                    │                 │            │─n8n notify→│ (Notion 购买日期)
 │                │              │                    │                    │                 │            │            │
 │                │              │─GET /query-order──→│ (paid:true)       │                 │            │            │
 │                │              │←─paid:true────────│                    │                 │            │            │
 │                │              │ step=SUCCESS       │                    │                 │            │            │
 │                │              │ 清理 interval      │                    │                 │            │            │
 │                │              │                    │                    │                 │            │            │
 │─点关闭─────────│              │ step=IDLE          │                    │                 │            │            │
```

**5 种退出路径**：
1. **成功**：paid=true → SUCCESS → 用户点关闭
2. **超时**：5min 60 次轮询未命中 → EXPIRED → 自动调 cancel-order
3. **失败**：create-order 4xx/5xx → FAILED → 重试/关闭
4. **用户主动取消**：点"取消订单"按钮 → 调 cancel-order → IDLE
5. **Modal 关闭**（X / 遮罩 / ESC）：**不调 cancel-order**（用户可能去微信支付）— **潜在风险**，见 D.3

### B.4 env.ts 字段清单

```typescript
// lib/env.ts 实施级 schema
interface EnvSchema {
  // Z-Pay
  ZPAY_PID: string                    // 商户 ID
  ZPAY_KEY: string                    // 签名密钥
  ZPAY_NOTIFY_URL: string             // 回调 URL（公网 HTTPS）
  // n8n
  N8N_WEBHOOK_URL: string             // base URL（自动拼 /webhook/xxx）
  N8N_WEBHOOK_SECRET: string          // x-n8n-secret header 鉴权
  // Notion
  NOTION_TOKEN: string                // integration token
  NOTION_DATABASE_ID: string          // 订单 DB
  NOTION_DISCOUNT_DATABASE_ID: string // 优惠码 DB（2026-06-14 新增）
}

const SCHEMA: Array<[keyof EnvSchema, boolean]> = [
  ['ZPAY_PID', true],
  ['ZPAY_KEY', true],
  ['ZPAY_NOTIFY_URL', true],
  ['N8N_WEBHOOK_URL', true],
  ['N8N_WEBHOOK_SECRET', true],
  ['NOTION_TOKEN', true],
  ['NOTION_DATABASE_ID', true],
  ['NOTION_DISCOUNT_DATABASE_ID', true],
]
```

**校验增强（vs 现有 ARCH §12.5 设计）**：

| 增强项 | 理由 | 实施 |
|--------|------|------|
| ZPAY_NOTIFY_URL 格式校验 | 防止非 HTTPS | `^https://` regex |
| NOTION_TOKEN 前缀校验 | 早暴露错配 | `startsWith('ntn_')` |
| NOTION_DATABASE_ID UUID 格式 | 早暴露粘贴错 | `^[0-9a-f-]{36}$` |
| 启动 banner 输出 env 摘要 | 部署时一眼确认 | `console.log('[env] loaded:', { ZPAY_PID: '***'+pid.slice(-4), ... })` |

**注意**：当前 ARCH §12.5.5 写"暂不引 zod"，但本期用户原始需求清单第 5 项是 **"lib/env.ts (zod 集中校验)"**。**建议实施 zod 方案**（与用户清单一致，5 行 schema，0 学习成本），同时保留 TS 接口（zod 推导 `z.infer<typeof schema>`）。

### B.5 Pricing.js → PayModal 注入方式

**3 个方案对比**：

| 方案 | 实施成本 | 耦合度 | 推荐 |
|------|---------|--------|------|
| A. Pricing.js 内部 useState 渲染 PayModal | 低 | 高（PayModal 锁在 Pricing 里） | ❌ |
| B. theme.js 顶层 context + PayModal 单例 | 中 | 低（PayModal 可被其他组件触发） | ✅ |
| C. 单独的 `<PayModalRoot />` 挂在 `LayoutProvider` | 中 | 低 | ✅（与 B 等价） |

**推荐方案 B/C**：

```javascript
// themes/starter/index.js 或 LayoutProvider
import { PayModalProvider, PayModalRoot } from './components/PayModalProvider'

// 在 layout 顶层包一层
<PayModalProvider>
  {children}
  <PayModalRoot />  {/* 单例挂载，监听 context.open */}
</PayModalProvider>
```

```javascript
// themes/starter/components/Pricing.js
import { usePayModal } from './PayModalProvider'

<button onClick={() => openPayModal({ productId: STARTER_PRICING_2_PRODUCT_ID, ... })}>
  立即支付
</button>
```

**优点**：Pricing 改造成本极低（仅 onClick 3 行），未来其他场景（Footer CTA / ArticleLock 解锁）可复用。

### B.6 PayModal 状态机统一

**3 份文档状态机不一致**：

| 文档 | 状态机 |
|------|--------|
| FRONTEND §4.2 | `form / qrcode / success / error`（4 态） |
| REQ §3.2 | `IDLE / STEP1_FORM / STEP2_QR / SUCCESS / EXPIRED / FAILED`（6 态） |
| 本期需求 | 6 态（与 REQ 一致） |

**统一采用 6 态**（与 REQ 业务规则一致）：

```typescript
type PayStep = 'IDLE' | 'STEP1_FORM' | 'STEP2_QR' | 'SUCCESS' | 'EXPIRED' | 'FAILED'
```

---

## C. 接口契约

### C.1 函数签名（TS）

```typescript
// pages/api/pay/query-order.ts
import type { NextApiRequest, NextApiResponse } from 'next'

type QueryOrderResponse =
  | { code: 0; message: 'success'; data: QueryOrderData }
  | { code: 40011; message: 'E_ORDER_NOT_FOUND'; data: null }
  | { code: 40010; message: 'E_NOTION_FAIL'; data: null }
  | { code: 50001; message: 'E_INTERNAL'; data: null }

interface QueryOrderData {
  outTradeNo: string
  paid: boolean
  paidAt: string | null  // YYYY-MM-DD
  productName: string
  finalPrice: number
  unit: '元'
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<QueryOrderResponse>
): Promise<void>

// pages/api/pay/cancel-order.ts
type CancelOrderRequest = { outTradeNo: string }
type CancelOrderResponse =
  | { code: 0; message: 'success'; data: { outTradeNo: string; cancelled: true } }
  | { code: 40011; message: 'E_ORDER_NOT_FOUND'; data: null }
  | { code: 40012; message: 'E_ORDER_ALREADY_PAID'; data: null }
  | { code: 50001; message: 'E_INTERNAL'; data: null }

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CancelOrderResponse>
): Promise<void>
```

### C.2 PayModal Context API

```typescript
// themes/starter/components/PayModalProvider.js
interface PayModalContextValue {
  open: boolean
  step: PayStep
  productId: string
  productName: string
  totalPrice: number
  discountAmount: number
  finalPrice: number
  outTradeNo: string
  qrcode: string
  imgUrl: string
  errorMessage: string
  openPayModal: (params: {
    productId: string
    productName: string
    totalPrice: number
  }) => void
  closePayModal: () => void
  submitForm: (form: { name: string; email: string; discountCode: string }) => Promise<void>
  cancelOrder: () => Promise<void>
}
```

### C.3 n8n cancel-order workflow payload

**输入**：
```json
{
  "outTradeNo": "1750000000-abc123",
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
IF: 当前状态 != "已支付"
  (注：Notion "已发送" 或 "已取消" 都视为已结案，不动)
  → Yes: 状态 != "已取消"?
    → Yes: Notion: Update Page 状态 = "已取消"
    → No: 幂等跳过
  → No: (订单已发货/已取消，幂等跳过)
  ↓
end
```

**幂等保证**：
- IF 分支判断当前状态，避免重复 UPDATE
- 多次调用同一 outTradeNo：第 1 次改"已取消"，后续看到已是"已取消"直接跳过

### C.4 错误码枚举

```typescript
// lib/errors.ts
export const ErrorCode = {
  // 业务错误 4xxxx
  E_NAME_EMPTY: 40001,
  E_NAME_TOO_LONG: 40002,
  E_EMAIL_INVALID: 40003,
  E_DC_NOT_FOUND: 40004,
  E_DC_DISABLED: 40005,
  E_DC_AMOUNT_INVALID: 40006,
  E_DC_FORMAT_INVALID: 40007,
  E_PRODUCT_NOT_FOUND: 40008,
  E_ZPAY_FAIL: 40009,
  E_NOTION_FAIL: 40010,
  E_ORDER_NOT_FOUND: 40011,
  E_ORDER_ALREADY_PAID: 40012,  // 新增
  E_METHOD_NOT_ALLOWED: 40501,
  E_PARAM_MISSING: 40000,
  // 系统错误 5xxxx
  E_INTERNAL: 50001,
} as const
```

---

## D. 风险点 + 缓解方案

### D.1 [HIGH] 轮询导致 EdgeOne 函数调用费飙升

**描述**：100 并发用户，每 5s 轮询 = 720 次/小时/用户。1000 用户 = 72 万次/天。

**缓解**：
- ✅ 5s 间隔（vs 3s 省 40%，设计已采用）
- ✅ 关闭 modal 时 clearInterval（已设计）
- ✅ 用户关闭 modal 不再支付 → 浪费的轮询次数（**本期接受**，未来加 LRU 内存计数器 + 主动停止）
- ❌ 不引 Redis 缓存（架构文档 §1.1 "避免过度设计"）
- 🔜 真实量大时改 SSE / WebSocket（future）

**残余风险**：用户扫码后 1s 内关 modal，订单已生成但永不清理。靠 60min TTL + 异常对账处理。

### D.2 [HIGH] cancel-order 与 notify 回调的 race condition

**描述**：用户在 5min 超时前 100ms 关闭 modal，触发 cancel-order；恰好 50ms 后 Z-Pay notify 到达，markPaid 成功，导致**订单已支付但 Notion 状态被改成"已取消"**。

**缓解**（3 层防御）：

1. **cancel-order 先 mark cancelled 标记**（防 notify 写入）：
   ```typescript
   orderStore.set(outTradeNo, { ...cached, cancelled: true, cancelledAt: Date.now() })
   ```
2. **notify 检测 cancelled 标志**（额外检查）：
   ```typescript
   if (cached.cancelled) return 'success'  // 已取消的订单支付忽略
   ```
3. **n8n 双重校验**：n8n cancel workflow 检查订单 Notion `状态 != "已发送"` 才改成"已取消"（已是"已发送"不覆盖）

**残余风险**：用户实际完成支付（Z-Pay 已扣款）但订单被前端取消，需**人工退款**。UI 上 cancel 时二次确认（"确定放弃支付？"）可降低发生概率。

### D.3 [MEDIUM] 用户关闭 modal 但不取消订单 → 浪费 Z-Pay 订单号

**描述**：用户扫码前关闭 modal，订单已生成 5min TTL 内无人支付，但 create-order 已写 Notion "待发送"。

**缓解**：
- ✅ 5min 后 Notion 订单仍是"待发送"，**但未实际付款**（看金额 + 无购买日期 = 可识别）
- 🔜 后台对账脚本（future）：扫"待发送" + 无购买日期 + createdAt > 10min → 自动改"已取消"（n8n 定时 workflow）
- 📝 UI 提示"已生成订单，5 分钟内未支付将自动取消"

### D.4 [MEDIUM] 优惠码 blur 校验的需求矛盾

**描述**：REQ §2.2 描述"blur 时调 /lookup-discount"与 FRONTEND §4.4 描述"blur 不调任何 API（防枚举）"**直接矛盾**。

**缓解**：
- ✅ **以 FRONTEND 为准**（更安全，避免优惠码枚举）
- 📝 实施时 REQ §2.2 标记为"deprecated"，更新 REQ 文档
- blur 仅做客户端 regex 格式校验（DISCOUNT_CODE_REGEX 6-20 字符）
- 真实折扣在 create-order 时一并校验

**残余风险**：用户输入 18 字符正确格式但 Notion 已 disabled → 表单提交时才报错，UX 略差（可接受）。

### D.5 [MEDIUM] n8n /webhook/cancel-order 未限流

**描述**：恶意用户高频调 cancel-order → n8n 工作流被刷。

**缓解**：
- ✅ n8n Webhook 本身有 x-n8n-secret 鉴权（ARCH §10）
- ✅ cancel-order 必须知道 outTradeNo（无法枚举）
- 🔜 未来加 n8n 限流节点（rate limit 10/min/IP）

### D.6 [LOW] 状态机不统一导致实现/文档漂移

**描述**：3 份文档状态机不一致（4 态 / 6 态 / 6 态），实施时易混。

**缓解**：
- ✅ 本文档 B.6 节明确"统一 6 态"
- 📝 实施时同步更新 FRONTEND-DESIGN §4.2 与 REQ §3.2
- 📝 提交时跨文档一致性检查

### D.7 [LOW] PayModal 与 NotionNext 主题样式冲突

**描述**：starter 主题的 Tailwind class 可能与 PayModal 内部样式冲突（暗色模式 / z-index）。

**缓解**：
- ✅ 弹窗 position: fixed + z-[9999]（高于任何组件）
- ✅ 内部样式 scoped（CSS modules 或 prefix `.pay-modal-*`）
- ✅ dark mode 用 `dark:` variant 与主题对齐

### D.8 [LOW] EdgeOne 函数冷启动延迟

**描述**：query-order 5s 轮询时，EdgeOne 函数冷启动可能 1-3s，导致首轮 polling 返回慢。

**缓解**：
- ✅ order-store 内存读（不依赖冷启动）— **本设计已优化**
- ✅ 5s 间隔（容忍 1-3s 冷启动）
- 📝 监控：query-order p95 < 200ms（target）

---

## E. 实施顺序建议

```
1. lib/env.ts (依赖最少，先做，0 改动风险)
     ↓
2. pages/api/pay/query-order.ts (复用 order-store + notion-utils)
     ↓
3. pages/api/pay/cancel-order.ts (复用 query-order 的 Notion 查询模式)
     ↓
4. n8n /webhook/cancel-order workflow (后端最后防线)
     ↓
5. themes/starter/components/PayModalProvider.js + PayModal.js (依赖 1-4)
     ↓
6. themes/starter/components/Pricing.js 改造 (依赖 5)
```

**关键路径**：5 依赖 1-4；6 依赖 5。可 1-4 并行开发（无相互依赖）。

---

## F. 验证清单（实施完成时对照）

### F.1 后端 API
- [ ] query-order：order-store hit → 返回 paid + paidAt + productName + finalPrice + unit
- [ ] query-order：order-store miss + Notion hit → 同样返回
- [ ] query-order：两边都 miss → 404 E_ORDER_NOT_FOUND
- [ ] query-order：Notion 5xx → 500 E_NOTION_FAIL
- [ ] cancel-order：未支付 → 200 cancelled=true + Notion 状态"已取消"
- [ ] cancel-order：已支付 → 400 E_ORDER_ALREADY_PAID
- [ ] cancel-order：不存在 → 404 E_ORDER_NOT_FOUND
- [ ] cancel-order：重复 cancel → 幂等返回 cancelled=true

### F.2 前端 PayModal
- [ ] 点 PRICING_2 → 弹窗打开（IDLE → STEP1_FORM）
- [ ] 必填校验：空姓名 / 错误邮箱
- [ ] 优惠码 blur → 不调 API
- [ ] 提交 → 调 create-order → STEP2_QR 显示二维码
- [ ] 5s 轮询 → 命中 paid → SUCCESS
- [ ] 5min 未支付 → EXPIRED → 自动调 cancel-order
- [ ] create-order 失败 → FAILED 显示错误
- [ ] ESC / X / 遮罩 → 关闭 + 清理 timer
- [ ] 移动端 90% 视口正常
- [ ] 暗色模式配色一致

### F.3 env.ts
- [ ] 缺 1 个 env → 启动抛错（带变量名）
- [ ] 8 个 env 都在 → 启动 banner 输出
- [ ] ZPAY_NOTIFY_URL 非 https → 启动抛错
- [ ] NOTION_TOKEN 不以 ntn_ 开头 → 启动抛错

### F.4 n8n cancel workflow
- [ ] 触发后查 Notion 订单 page
- [ ] 状态 = "待发送" → 改成"已取消"
- [ ] 状态 = "已发送" → 不动
- [ ] 状态 = "已取消" → 不动（幂等）
- [ ] 触发 Notion 搜索找不到 → IF 跳过

---

## G. 总结

**设计完整性**：
- ✅ 架构/API/前端 3 份文档覆盖 95% 实施细节
- ⚠️ 2 处明确矛盾（状态机 4 vs 6、blur 是否调 API）已在本文件统一
- ⚠️ 5 处需实施级补全（query-order 响应补 unit、cancel-order 幂等、PayModal 注入方式、env.ts 增强、状态机统一）

**关键风险**：
- HIGH: D.2 race condition（cancel vs notify）— 3 层防御方案已设计
- MEDIUM: D.4 优惠码校验矛盾 — 已选安全方案

**对 worker agents 的交接**：
- 后端实现（coder）→ B.1-B.4 实施级 schema + C 节接口契约
- n8n workflow 实现（coder / devops）→ C.3 payload + F.4 验证清单
- 前端实现（coder）→ B.3 时序图 + B.5 注入方式 + C.2 Context API + F.2 验证清单
- 安全评审（security-engineer）→ D 节风险点
- 测试（tester）→ F 节验证清单

**Harness 下一步**：
1. coder 实施 1-6（按 E 顺序）
2. security-engineer 评审 race condition + 优惠码校验
3. tester 跑 E2E
4. devops-architect 部署 + 监控
5. docs 同步更新状态机（4→6 态）+ REQ 废弃 blur API 描述
