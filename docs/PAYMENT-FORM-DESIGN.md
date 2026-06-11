# Payment Form + Notion Sync — Design Spec

> 状态: Draft v0.1 (2026-06-11) — 等待用户 sign-off
> 规模: Option B. 标准 (3-4 天, 完整 Harness)
> 前置: Z-Pay Option A MVP (`b0e7290b`)

---

## 1. Context & Scope

本 spec 描述在 PayModal 加 **Step 1 表单** (姓名/邮箱/优惠码) + **付款成功后异步写 Notion 订单表** 的完整设计。

**In Scope**:
- PayModal Step 1 (表单) UI
- 服务端二次校验 (优惠码)
- 异步写 Notion (Notion 官方 Workers)
- Sentry 错误追踪
- 测试 / env / 部署 / 回滚

**Out of Scope** (见 §14): 邮件 / 退款 / 优惠码后台 UI / 多币种 / 多支付渠道

**Baseline** (引用, 不重述):
- Z-Pay Native 支付: `docs/ARCHITECTURE-payment.md` (架构基线)
- 安全审计: `docs/SECURITY-REVIEW-payment.md` (F1 已修, W1/W2/W3 过度设计)
- 回调方案选型: `docs/PAYMENT-CALLBACK-COMPARISON.html` (维持方案 4: EdgeOne notify.ts)

**已完成的前置** (2026-06-11):
- ✅ `ntn` (Notion 官方 CLI v0.16.0 Beta) 装到 `~/.local/bin/ntn`
- ✅ `ntn whoami` + `ntn datasources query` 验证调通, 复用 `NOTION_TOKEN`
- ✅ 真实 data 观察确认状态字段实际值 = "待发送" / "已发送" (非 "待发货" / 非 select)

**10 决策回顾** (sign-off 见 `project/payment-form-session-checkpoint-2026-06-10`):

| # | 决策 |
|---|---|
| 1 | Notion 持久化 = Notion 官方 Workers (沙箱) |
| 2 | 优惠码 = 1 码 = 1 经销商 (全产品通用) |
| 3 | 优惠码存储 = 静态 JSON lookup, 不单表 |
| 4 | 优惠码 = 无限次 |
| 5 | 表单 UX = PayModal 内分步 (Step 1 → Step 2) |
| 6 | 产品数 = 3 个付费 SKU (第 3 个名/价 P1 再定) |
| 7 | Notion DB = 沿用 "模板客户管理" 模板 |
| 8 | 写库时机 = 仅 markPaid 后 (notify fire-and-forget POST) |
| 9 | 失败处理 = Notify 200 + Workers 内部 3 次重试 + Sentry |
| 10 | 优惠码校验 = 硬阻止 (未匹配/disabled 弹错, 不出 QR) |

---

## 2. User Flow & PayModal State Machine

PayModal 状态机叠加 Step 1。状态总览: `IDLE → STEP1_FORM → STEP2_QR → (SUCCESS | EXPIRED | FAILED)`。Step 2 沿用现有, 不动。

### 2.1 状态转移图

```
IDLE (mount)
   │
   ├──[用户点"立即支付"按钮 (Step 1 完成)]──→ STEP1_FORM
   │                                              │
   │                                              ├──[Step 1 valid]──→ STEP2_QR (existing)
   │                                              │                       │
   │                                              │                       ├──[poll paid]──→ SUCCESS
   │                                              │                       ├──[5min timeout]──→ EXPIRED
   │                                              │                       └──[net err/Z-Pay 拒]──→ FAILED
   │                                              │
   │                                              └──[用户关弹窗/ESC/backdrop]──→ unmount
```

### 2.2 Step 1 表单字段

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| 姓名 | text | ✅ | 1-50 字符, 前后 trim |
| 邮箱 | email | ✅ | RFC5322, 后端用 `validator.isEmail` 兜底 |
| 优惠码 | text | ❌ | A-Z0-9- 格式, 6-20 字符; 留空 = 无码 |

**blur 校验流程** (优惠码字段):
1. 客户端格式校验 (regex)
2. 客户端立即查本地缓存 `lib/discount-codes.ts` 的 public 视图 (仅 `partnerName`)
3. 服务端 `/api/pay/lookup-discount` 二次校验 (防止客户端绕过) — *新增轻 endpoint*
4. 不匹配/disabled: 输入框下方红字 "优惠码无效或已停用", 禁用"立即支付"按钮
5. 留空: 无错误, 视为"无码"

### 2.3 Step 1 → Step 2 转移

1. POST `/api/pay/create-order`, 扩展入参: `{ productId, customer: {name, email}, discountCode? }`
2. 服务端二次校验 (decision 10 防御)
3. 返 `{ outTradeNo, qrUrl, amountFen, expiresAt, discountApplied? }`
4. 客户端进入 Step 2 (现有流程, 不变)

### 2.4 Step 2 (沿用 `themes/starter/components/PayModal.js:51-175`)

- 3s 轮询 `GET /api/pay/query-order?outTradeNo=...`
- 5min 超时
- 成功后 3s auto-close + toast "购买成功"
- 错误态: 超时 / 网络错 / Z-Pay 拒

### 2.5 关键不变量

- 切换产品清空表单 + 订单 (沿用 `PayModal.js:42-49`)
- ESC + 背景点击随时关闭 (沿用 `PayModal.js:32-39, 114`)
- 表单数据**不跨弹窗持久化** (隐私: 最小化 PII 留存)

---

## 3. `lib/discount-codes.json` Schema

**文件**: `lib/discount-codes.json` (新, 静态 lookup 表)

### 3.1 格式

```json
{
  "<CODE>": {
    "partnerName": "<string, required>",
    "discountPct": <number 0-100, optional, 互斥 fixedOffFen>,
    "fixedOffFen": <number, optional, 互斥 discountPct, 单位"分">,
    "disabled": <boolean, required>,
    "note": "<string, optional, 仅内部>"
  }
}
```

### 3.2 种子数据

```json
{
  "PARTNER01": {
    "partnerName": "张三的数码店",
    "discountPct": 0,
    "disabled": false,
    "note": "创始期合作方, 无限次"
  }
}
```

### 3.3 规则

- `discountPct` 与 `fixedOffFen` **互斥**, MVP 只用 `discountPct` (decision 2: 全产品通用 → 折扣是该码的字段, 不是产品的字段)
- `disabled: true` → 硬阻止 (decision 10)
- 无 DB, 无后台 UI, 改码走 PR
- `partnerName` 可经 `NEXT_PUBLIC_` 前缀暴露给客户端 (用于提示"使用张三的数码店优惠"), 但 `disabled` / `note` **必须** server-only

### 3.4 Loader (`lib/discount-codes.ts`, 新, server-only)

```ts
export type DiscountCode = {
  partnerName: string;
  discountPct?: number;
  fixedOffFen?: number;
  disabled: boolean;
  note?: string;
};

// 命中返 DiscountCode, 抛出 E_DC_NOT_FOUND / E_DC_DISABLED
export function lookupDiscount(code: string): DiscountCode;

// 仅返 partnerName 字段 (client bundle 安全)
export function lookupPartnerName(code: string): string | null;
```

---

## 4. Notion DB Schema & Field Mapping

**目标**: data_source_id `de84f4cf-c8e2-83dc-a33c-873e7f83f872` (database `6ab4f4cf-c8e2-825e-bde8-016c2d9be1c2`)

### 4.1 部署前必做: 加 3 字段

通过 Notion UI (Settings → Data sources → + Add field) 或 `ntn` 命令添加:

| 字段名 | 类型 | 用途 |
|---|---|---|
| 订单号 | rich_text | Z-Pay outTradeNo, 唯一索引, 查询键 |
| 商品名 | rich_text | 来自 `products.config.js` 的产品名 |
| 金额 | number | 单位"元", 步进 0.01 (如 79.00) |

### 4.2 复用字段 (7 个, 无变化)

- **Name** (title) — 页面标题
- **客户名** (rich_text)
- **客户邮箱** (email) — 格式校验
- **购买日期** (date) — 仅日期 (时分秒塞备注)
- **状态** (status) — ⚠️ 关键修正
- **交付时间** (date) — Workers 留空, 后续发货人工填
- **备注** (rich_text) — 拼接优惠码 + 付款时分秒

### 4.3 状态字段修正 (重要!)

| 项 | 旧 brainstorm 误记 | 实际 schema (2026-06-11 用 MCP + ntn 验过) |
|---|---|---|
| 字段类型 | Select (电商标准) | **status** (Notion 原生状态字段, 有 To-do/In-progress/Complete 分组) |
| 写入值 | "待发货" | **"待发送"** |
| 选项 | (假设) | **待发送** (灰, To-do) / **已发送** (蓝, In progress) / **已取消** (绿, Complete) |

**Workers 硬编码写 "待发送"**。流程: 客户付款 → 待发送 → 人工发货 → 已发送。

### 4.4 模板原生字段 (4 个, Workers 不写)

保留 (因为 DB 是模板, 不能删 schema), Workers 写入时**不传这些字段**:
- **Token** (rich_text) — 模板专属 FIZE-XXXXXX
- **源链接** (url) — 模板专属
- **发送唯一链接** (formula) — 自动算
- **交付产品369** (button) — 模板按钮

### 4.5 字段映射表 (Workers write 8 字段)

| 数据来源 | Notion 字段 | 类型 | 示例 |
|---|---|---|---|
| `customer.name` | **Name** (title) | title | "张三" |
| `customer.name` | 客户名 | rich_text | "张三" |
| `customer.email` | 客户邮箱 | email | "[email protected]" |
| `paidAt` (ISO date) | 购买日期 | date | "2026-06-11" |
| literal `"待发送"` | 状态 | status | "待发送" |
| `outTradeNo` | **订单号** (NEW) | rich_text | "20260611143025ABCDEF" |
| `product.name` | **商品名** (NEW) | rich_text | "基础版" |
| `money` (Yuan) | **金额** (NEW) | number | 79.00 |
| 拼接字符串 | 备注 | rich_text | "[code:PARTNER01 张三的数码店] 付款于 14:30:25" |

### 4.6 幂等 + 并发写竞态

- **基础幂等**: Workers 写前先 query 订单号; 命中 → 跳过, 返 200 `idempotent: true`
- 防 Z-Pay 11 次重发 (decision 9 副作用)
- **G4 并发写竞态 (已知, 接受)**: Z-Pay 11 次重发间隔 5min+, Workers 单次写 < 2s, query-write 窗口内撞并发概率 < 1%。**若撞, 产生重复 page**, Notion page title 允许重名, 人工巡检可去重 (备注含 paidAt 可分辨先后)。**Out of Scope: 不做乐观锁/唯一索引**, 真出现再处理 (P1)。

### 4.7 F1 [CRITICAL] 状态

- 已修 (`cloud-functions/api/pay/create-order.ts:48-49` 调 `recordOrder`)
- 本 spec 假定其生效, 安全评审不再重测
- 新增回归测试: `notify-e2e.test.ts` 断言 `recordOrder` 被调

---

## 5. Notion Workers (Async Notify)

**触发位置**: `cloud-functions/api/pay/notify.ts` `markPaid` 返回 true 之后

**机制**: fire-and-forget `fetch(WORKER_URL, { method: 'POST', body, headers: { 'X-Signature': HMAC } })`。本地代码 **不 await 响应体**, 仅 await HTTP 状态码 (5s timeout)。

### 5.1 请求 payload (POST body)

```json
{
  "outTradeNo": "20260611143025ABCDEF",
  "name": "张三",
  "email": "[email protected]",
  "productId": "starter-full",
  "productName": "基础版",
  "amountYuan": 79.00,
  "paidAt": "2026-06-11T14:30:25+08:00",
  "discountCode": "PARTNER01",
  "partnerName": "张三的数码店"
}
```

### 5.2 鉴权

`X-Signature: <hex(HMAC-SHA256(NOTION_WORKER_SECRET, raw_body))>`。算法 coder 定 (Node `crypto.createHmac` 或 Notion Workers 内置)。

### 5.3 端点契约 (Workers 返)

| 状态 | 含义 | retryable |
|---|---|---|
| 200 `{ ok: true, pageId, idempotent? }` | 写入成功 / 幂等跳过 | n/a |
| 400 `{ ok: false, code, retryable: false }` | 客户端错 (payload/字段) | no |
| 401 `{ ok: false, code, retryable: false }` | HMAC 失败 | no |
| 429 `{ ok: false, code, retryable: true, retryAfter }` | Notion 限流 | yes (Workers 用 `Retry-After`) |
| 5xx `{ ok: false, code, retryable: true }` | Notion / Workers 内部错 | yes |

### 5.4 重试 (Workers 侧)

- 3 次指数退避 + 抖动: **1s → 2s → 4s** (总 7s, 受 EdgeOne 3s 函数超时约束, 见 G3)
- 3 次全败 → `Sentry.captureException({ tags: { 'error.kind': 'E_NOTIFY_GIVEUP' } })`, 返 200 给 notify (Z-Pay 停重发)
- 本地 notify.ts **永远返 200** 给 Z-Pay, 即使 Workers fetch 失败
- **G3 备注**: 之所以用 1+2+4 而非 1+4+16, 是因为 EdgeOne Cloud Function 默认超时 3s, 我们的 `AbortController` 设 2.5s 留 0.5s 缓冲, Workers 第一次响应必须在 2.5s 内启动, 重试节奏要能在 EdgeOne 函数生命周期内跑完

### 5.5 本地 notify.ts 改动

新增 env: `NOTION_WORKER_URL`, `NOTION_WORKER_SECRET`
新增依赖: 无 (Node 20 fetch 原生)
新增 import: `crypto` (HMAC 计算)

伪代码:
```ts
// markPaid 成功之后:
const payload = { outTradeNo, name, email, productId, productName, amountYuan: money, paidAt, discountCode, partnerName };
const rawBody = JSON.stringify(payload);
const sig = crypto.createHmac('sha256', env.NOTION_WORKER_SECRET).update(rawBody).digest('hex');

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 2500);  // G3: 2.5s (EdgeOne 默认 3s 函数超时, 留 0.5s 缓冲)
try {
  const res = await fetch(env.NOTION_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': sig },
    body: rawBody,
    signal: ac.signal,
  });
  if (!res.ok) Sentry.captureMessage(`E_NOTIFY_HTTP ${res.status}`, 'warning');
} catch (e) {
  Sentry.captureMessage('E_NOTIFY_TIMEOUT', 'warning');
} finally {
  clearTimeout(timer);
}
// 不论结果都返 200 'success' 给 Z-Pay
return new Response('success');
```

**G3 备注**:
- EdgeOne Pages Cloud Function 默认超时 3s (不是 5s, 此前 spec 写错)
- AbortController 设 2.5s, 函数返 200 留 0.5s 缓冲
- 若 3 次重试仍超时, 走 Sentry `E_NOTIFY_GIVEUP`, Z-Pay 那边正常 (因本地返 200)
- Fallback: 若 EdgeOne 函数超时无法调长, 改方案 — 改用 Z-Pay 同步回调路径 + 本地 cron 定时重试队列 (P1 优化, 不进本 spec)

### 5.6 Workers 部署 (ntn CLI 流程)

1. `mkdir cloud-functions/notion-worker && cd $_`
2. `ntn workers new .` — 脚手架 (生成 `workers.json`, `src/index.ts`, `package.json`)
3. 编辑 `src/index.ts` (handler) + `workers.json` (capabilities, env refs)
4. `ntn workers env set NOTION_WORKER_SECRET <random32bytes>` (一次)
5. `ntn workers deploy` — 构建 + 上传
6. `ntn workers list` 拿到 URL → 写回 `NOTION_WORKER_URL` env (EdgeOne 控制台)
7. 烟测: `curl -X POST $URL -d '{}' -H 'X-Signature: bad' -i` 期望 401

**Worker 类型**: webhook (HTTP 收 POST), 非 sync / 非 agent tool。

---

## 6. Sentry Setup (新增依赖)

**SDK**: `@sentry/nextjs` ^8.x (TBD, coder 验 Next 15 兼容性后定, 9.x 不锁)

### 6.1 配置文件 (4 新)

- `next.config.js` — 包 `withSentryConfig(...)`
- `sentry.client.config.ts` — 浏览器
- `sentry.server.config.ts` — Node
- `sentry.edge.config.ts` — Edge runtime (EdgeOne Functions)

### 6.2 采样

- `tracesSampleRate = 0.1` (生产)
- `replaysSessionSampleRate = 0` (关回放, PII 风险)

### 6.3 PII 过滤 (`beforeSend`)

剥离:
- `customer.email` / `customer.name`
- `request.body.email` / `request.body.name`
- `extra.*` 里所有 `email` / `name` 字段

保留:
- `outTradeNo` (订单号, 非 PII)
- `productId`
- `error.code` / `error.kind`
- `error.retryable`

### 6.4 触发点

- Workers 写库 3 次失败
- 优惠码 lookup 异常
- notify.ts fetch Workers 网络错
- Notion 5xx (从 Workers 转报)

### 6.5 标签约定

- `pay.productId`
- `pay.outTradeNo` (订单号, 24 字符)
- `error.kind`, `error.retryable`
- `release` = git SHA (auto)

---

## 7. Environment Variables

### 7.1 新增 5 项

| 变量 | 必填 | 用途 | 暴露 |
|---|---|---|---|
| `NOTION_TOKEN` | ✅ | 已存在, 挪入 `.env.example` | server only |
| `NOTION_WORKER_URL` | ✅ | Workers 端点 URL | server only |
| `NOTION_WORKER_SECRET` | ✅ | HMAC 共享密钥 (≥ 32 字节随机) | server only |
| `NEXT_PUBLIC_SENTRY_DSN` | ✅ | Sentry 项目 DSN | public (安全) |
| `SENTRY_AUTH_TOKEN` | ❌ | CI source map 上传 | server only |

### 7.2 存储位置

- **本地**: `.env.local` (gitignored)
- **EdgeOne Pages**: 控制台注入
- **Cloud Functions**: `tccli deploy --params`
- **CI**: GitHub Actions secrets

### 7.3 `.env.example` 更新 (7 行)

```bash
# Notion (existing)
NOTION_TOKEN=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Notion Workers (new)
NOTION_WORKER_URL=https://workers.notion.com/...
NOTION_WORKER_SECRET=replace-with-32-byte-random

# Sentry (new)
NEXT_PUBLIC_SENTRY_DSN=https://[email protected]/123
SENTRY_AUTH_TOKEN=sntrys_xxx
```

### 7.4 CI 兜底

- 缺 `NOTION_TOKEN` → build 失败
- `next.config.js` `withSentryConfig` 缺 `NEXT_PUBLIC_SENTRY_DSN` → 生产 build 失败
- `grep` 兜底防硬编码:
  ```bash
  ! grep -rE "(NOTION_TOKEN|NOTION_WORKER_SECRET|SENTRY_AUTH_TOKEN)\s*=" \
       --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" \
       lib/ cloud-functions/ themes/ next.config.js
  ```

---

## 8. Interface Contracts (Front ↔ Back ↔ Workers)

### 8.1 POST `/api/pay/create-order` (扩展入参)

- **Input**: `{ productId: string, customer: {name: string, email: string}, discountCode?: string }`
- **Output**: `{ outTradeNo, qrUrl, amountFen, expiresAt, discountApplied?: {code, partnerName, discountPct, originalFen} }`
- **行为**:
  - 服务端二次校验优惠码 (decision 10 防御, 不能信客户端)
  - 优惠码 disabled / 不存在 → 返 400 `E_DC_NOT_FOUND` / `E_DC_DISABLED`
  - `amountFen` 是**折后**金额 (服务端权威)

### 8.2 GET `/api/pay/lookup-discount` (新增轻 endpoint)

- **Input**: `?code=PARTNER01`
- **Output** (命中): `{ code, partnerName, discountPct, valid: true }`
- **Output** (禁用): 400 `{ code: 'E_DC_DISABLED', valid: false }`
- **Output** (未命中): 404 `{ code: 'E_DC_NOT_FOUND', valid: false }`
- **用途**: Step 1 blur 时校验, 不创建订单

### 8.3 POST `/api/pay/notify` (签名不变, 内部追加)

- **Input**: Z-Pay form-encoded (沿用)
- **Output**: text `success` (200) 或 400 (沿用)
- **内部追加**: `markPaid` 成功后 fire `fetch(NOTION_WORKER_URL, ...)` (见 §5)

### 8.4 GET `/api/pay/query-order` (不变)

- **Input**: `?outTradeNo=`
- **Output**: `{ status, money, tradeNo, msg }` (沿用白名单)

### 8.5 POST `${NOTION_WORKER_URL}` (新, Workers 侧)

- **Input**: 见 §5.1
- **Output**: 见 §5.3

### 8.6 统一错误响应 (前端统一处理)

```ts
type ApiError = {
  code: 'E_DC_NOT_FOUND' | 'E_DC_DISABLED' | 'E_DUP' | 'E_ZPAY_UP'
        | 'E_NOTIFY_HTTP' | 'E_HMAC' | 'E_NOTIFY_GIVEUP' | ...;
  message: { zh: string; en: string };
  retryable: boolean;
  sentryEventId?: string;  // "联系客服" 用
};
```

---

## 9. Error Matrix (Client × Server × Workers)

~24 条错误, 按层组织。每行: code | trigger | UI action | Sentry level | retry?

### 9.1 客户端校验 (PayModal Step 1, 6 条)

| Code | Trigger | UI | Sentry |
|---|---|---|---|
| `E_NAME_EMPTY` | 姓名为空 | inline 红字 | none |
| `E_NAME_TOO_LONG` | > 50 chars | inline 红字 | none |
| `E_EMAIL_INVALID` | 邮箱格式错 | inline 红字 | none |
| `E_DC_FORMAT` | 优惠码非 A-Z0-9- | inline 红字 | none |
| `E_DC_BLANK_OK` | 优惠码空 | 无提示 (允许) | none |
| `E_DC_HARD_BLOCK` | 服务端返 E_DC_NOT_FOUND/DISABLED | 弹错, 禁用按钮 | warn |

### 9.2 服务端 create-order (5 条)

| Code | Trigger | UI | Sentry | retry? |
|---|---|---|---|---|
| `E_DC_NOT_FOUND` | 优惠码不在 map | 弹错, 阻 QR | warn | no (用户改) |
| `E_DC_DISABLED` | 优惠码 disabled | 弹错, 阻 QR | warn | no |
| `E_DUP` | 同 outTradeNo 重复 | 弹错, 重试按钮 | info | yes |
| `E_ZPAY_UP` | Z-Pay 5xx | 弹错, 重试按钮 | error | yes |
| `E_PROD_NOT_FOUND` | productId 不在 config | 500 (开发期) | error | no |

### 9.3 服务端 notify (3 条, 全非阻塞)

| Code | Trigger | UI | Sentry |
|---|---|---|---|
| `E_NOTIFY_HTTP` | Workers fetch 非 200 | (无 UI 影响, 仍 200 给 Z-Pay) | warn |
| `E_NOTIFY_TIMEOUT` | Workers fetch > 5s | 同上 | warn |
| `E_HMAC` | 本地 HMAC 计算失败 (内部 bug) | 同上 | error |

### 9.4 Workers 侧 (10 条, 带 retry 语义)

| Code | Trigger | retry? | Sentry |
|---|---|---|---|
| `E_DB_WRITE` | Notion 5xx | yes 3x | error |
| `E_DB_VALIDATION` | Notion 4xx (字段错) | no | error |
| `E_NOTION_429` | Notion 限流 | yes, 用 `Retry-After` | warn |
| `E_IDEMPOTENT_OK` | 订单已存在 | no, 返 200 | info |
| `E_PAYLOAD_INVALID` | 请求体字段缺失 | no | error |
| `E_AUTH_MISSING` | X-Signature 缺失 | no | warn |
| `E_AUTH_INVALID` | HMAC 验签失败 | no | warn |
| `E_NOTIFY_GIVEUP` | 3 次重试全败 | n/a (终态) | error |
| `E_INTERNAL` | Workers 代码 throw | yes 1x | error |
| `E_DB_TIMEOUT` | Notion 10s 超时 | yes | warn |

### 9.5 用户视角分类

- **USER_RETRY** (5 条): `E_DUP`, `E_ZPAY_UP`, `E_NOTIFY_TIMEOUT`, `E_NOTIFY_HTTP`, `E_NOTION_429` — toast "重试中..." 或 "请重试"
- **USER_SHOW_ERROR** (12 条): `E_DC_*`, `E_NAME_*`, `E_EMAIL_*`, `E_PAYLOAD_INVALID`, `E_DB_VALIDATION` — inline / modal
- **USER_CONTACT** (3 条): `E_NOTIFY_GIVEUP`, `E_HMAC`, `E_INTERNAL` — 显示 Sentry eventId, "联系客服 (ref: xxx)"

---

## 10. File Inventory (New / Modified)

### 10.1 新增 (8 个)

| 路径 | 职责 |
|---|---|
| `lib/discount-codes.json` | 经销商优惠码 lookup 表 (种子 PARTNER01) |
| `lib/discount-codes.ts` | server-only lookup 函数 (lookupDiscount / lookupPartnerName) |
| `lib/__tests__/discount-codes.test.ts` | 6 单测 |
| `cloud-functions/notion-worker/src/index.ts` | Workers handler (TypeScript) |
| `cloud-functions/notion-worker/workers.json` | Workers config (capabilities, env refs) |
| `sentry.client.config.ts` | 浏览器 Sentry init |
| `sentry.server.config.ts` | Node Sentry init |
| `sentry.edge.config.ts` | Edge runtime Sentry init |

### 10.2 修改 (5 个)

| 路径 | 改动 |
|---|---|
| `themes/starter/components/PayModal.js` | 加 Step 1 表单 UI + 状态机 + blur 校验 |
| `themes/starter/components/Pricing.js` (if 触发) | 透传 product 到 PayModal (确认依赖) |
| `cloud-functions/api/pay/create-order.ts` | 接受 customer + discountCode, 二次校验, 返 discountApplied |
| `cloud-functions/api/pay/notify.ts` | markPaid 后 fire Workers fetch + HMAC |
| `next.config.js` | `withSentryConfig` 包裹 + source map |
| `.env.example` | 5 项 env 文档化 |

### 10.3 测试文件 (3 新 + 1 改)

| 路径 | 性质 |
|---|---|
| `lib/__tests__/discount-codes.test.ts` (新) | 6 case |
| `cloud-functions/api/pay/__tests__/notify-workers.test.ts` (新) | 8 case |
| `cloud-functions/notion-worker/__tests__/index.test.ts` (新) | 10 case |
| `themes/starter/components/__tests__/PayModal.test.js` (改) | 6 → 12 case |

---

## 11. Test Matrix

**基线**: 7 文件 / 95 case / 70% coverage 门禁 (Jest next/jest)
**目标**: 11+ 文件 / 130+ case / 70% coverage 维持

### 11.1 新增套件

**`lib/__tests__/discount-codes.test.ts`** (6 case):
1. 命中 (PARTNER01, enabled)
2. 不在 map → throw `E_DC_NOT_FOUND`
3. disabled → throw `E_DC_DISABLED`
4. 空字符串 → throw (视为 not-found)
5. 格式无效 (小写 / 特殊字符) → throw
6. 调 1000 次不限次

**`cloud-functions/api/pay/__tests__/notify-workers.test.ts`** (8 case):
1. markPaid 成功 → fetch 调通, payload 正确
2. markPaid 失败 → fetch 不调
3. HMAC 头计算正确
4. Workers 200 → 无 retry, 无 Sentry
5. Workers 500 → Sentry warn, 仍 200 给 Z-Pay
6. Workers timeout (5s) → Sentry warn
7. 幂等 (outTradeNo 已存在) → 跳过 Workers, 仍 200
8. 缺 customer.name/email → Sentry error, 500

**`cloud-functions/notion-worker/__tests__/index.test.ts`** (10 case):
1. 合法请求, Notion 200 → 返 200
2. 幂等 (订单存在) → 200 + `idempotent: true`
3. Notion 4xx → 不重试
4. Notion 429 → 用 `Retry-After` 重试
5. Notion 5xx → 重试 3 次
6. 3 次重试全败 → `E_NOTIFY_GIVEUP` + Sentry
7. 缺 X-Signature → 401
8. HMAC 验签失败 → 401
9. 缺 outTradeNo → 400
10. 内部 throw → 500 + 1 次重试

**`themes/starter/components/__tests__/PayModal.test.js`** (+6 case, 6→12):
1. Mount → Step 1 表单可见
2. 姓名为空 → "立即支付" 禁用
3. 邮箱无效 → "立即支付" 禁用
4. 姓名+邮箱有效, 无优惠码 → "立即支付" 启用
5. 优惠码 PARTNER01 有效 → "立即支付" 启用
6. 优惠码无效 → inline 红字, "立即支付" 禁用
7. 提交成功 → Step 2 QR 显示
8. 切换产品清空表单

### 11.2 测试基础设施

- **MSW** (Mock Service Worker) 拦截 create-order / lookup-discount / notify
- **nock** 拦截 Notion API (Workers 测)
- **jest.mock('@sentry/nextjs')** 断言 captureMessage / captureException
- **crypto.subtle** mock 简化 HMAC 测

### 11.3 CI 命令

```bash
yarn test:ci   # 全跑 + coverage
yarn type-check  # tsc --noEmit
yarn build     # next build
```

覆盖率 < 70% → CI 失败 (沿用 `jest.config.js:77-83` 门禁)

---

## 12. Deployment & Rollback

### 12.1 部署流程 (按顺序)

**Step A: Notion DB schema 变更** (必须最先)
1. 在 Notion UI 加 3 字段 (订单号/商品名/金额)
2. 写 1 条测试 row, 验 8 字段都填
3. 截图存档

**Step B: Workers 部署**
1. `cd cloud-functions/notion-worker/`
2. `ntn workers new .` (首次脚手架)
3. 编辑 `src/index.ts` + `workers.json`
4. `ntn workers env set NOTION_WORKER_SECRET <random32bytes>`
5. `ntn workers deploy`
6. `ntn workers list` 拿 URL

**Step C: Cloud Functions 部署**
1. `tccli deploy --dry-run` (先 dry)
2. 注入 `NOTION_WORKER_URL` + `NOTION_WORKER_SECRET` env
3. `tccli deploy` (生产)
4. Z-Pay 后台通知 URL 确认 (不变, 仍是 `/api/pay/notify`)

**Step D: Frontend 部署**
1. PR → main → EdgeOne Pages auto-deploy
2. `next.config.js` 自动注入 `NEXT_PUBLIC_SENTRY_DSN` (EdgeOne 控制台已配)
3. Sentry release = git SHA (auto via `withSentryConfig`)

### 12.2 回滚

| 组件 | 回滚方式 |
|---|---|
| Frontend | `git revert` + push main, EdgeOne auto |
| Cloud Functions | `tccli deploy` 上一版本 |
| Workers | `ntn workers deploy` 上一版 (无状态, 安全) |
| Notion DB schema | **前向兼容**: 字段加完不可删, Workers 容忍缺字段 (跳过) |

### 12.3 HMAC Secret 轮换 (蓝绿)

1. 加新 secret 作 `NOTION_WORKER_SECRET_V2`
2. 部署代码同时接受 V1 + V2, 优先用 V2
3. 切流量到 V2 (改 `NOTION_WORKER_URL` 不变, 代码读 V2)
4. 24h 后删 V1

### 12.4 灰度

- **前端**: 50% Sentry release sampling 观察错误率
- **后端**: 一次性 (爆炸半径小, Z-Pay notify 验签拦截重放)
- **Workers**: 100% (无流量整形)

### 12.5 监控

- Sentry issues (Workers 失败 / HMAC 不匹配)
- EdgeOne Pages 日志 (function 错)
- Z-Pay 商户后台 (对账)
- Notion UI (人工 1x/日 spot check)

---

## 13. Risks & Open Questions

| ID | 风险 | 缓解 | 触发回顾 |
|---|---|---|---|
| R1 | Notion API 3 req/s 限流, 峰值 burst | Workers 客户端队列 + debounce | 持续 > 5 单/分 |
| R2 | 第 3 个产品名/价未定 (decision 6) | 占位 P3-PRODUCT, 单 PR 替换 | P1 阶段 |
| R3 | `partnerName` 走 `NEXT_PUBLIC_` 暴露, 可能泄 PII (如手机号) | 规则: `partnerName` 只放**商号**, 禁止手机/邮箱 | 第一个经销商入驻时 |
| R4 | HMAC secret 轮换流程未设计 | 蓝绿 V1/V2 (见 §12.3) | 上线后 90 天 |
| R5 | Sentry source map 上传到 EdgeOne Pages 链路未验 | devops 阶段必跑 dry-run | 上线前 |
| R6 | Z-Pay 测试金额 (¥0.10/¥0.30) 仍在 `products.config.js` | `products.config.js:11` 已警示, 独立 PR 改真实价 | 上线前 |
| R7 | Workers Beta (v0.16.0) | 锁版本, 关注 release notes | Notion 宣布 GA |
| R8 | `pay.outTradeNo` Sentry tag 字符串易撞 | 全 24 字符 outTradeNo 格式 | 第一次事件 |
| R9 | EdgeOne Pages + Cloud Functions 部署顺序 (Sentry 在 Frontend, Workers 独立) | 三套独立 env, 互不影响 | 无 |
| R10 | **Notion Workers 跨境网络** (G2): EdgeOne 部署在腾讯云国内节点, Workers 沙箱位置不明, 跨境 HTTP 延迟 + 偶尔超时已知 | **Pre-deploy 必须跑 spike**: 10 次 markPaid 模拟, ≥ 9 次 Notion 落单。**Fallback**: 若连通 < 80%, 改方案 — 放弃 Workers, notify.ts 直连 Notion REST API (无 Workers 沙箱, 但功能等价, 损失是失去 Notion 平台未来特性) | 上线 1 周落单率 < 95% |

---

## 14. Out of Scope + Done Criteria

### 14.1 明确不做 (Out of Scope)

- 邮件发送 (welcome / 订单确认 / 发货通知)
- Notion → 外部系统数据同步
- 退款流程 (不加 `已退款` 状态选项)
- 优惠码后台管理 UI (改码走 PR)
- 多币种 (¥ only)
- 多支付渠道 (zpay only, wxpay/alipay 延后)
- 客户自助门户 (无登录, 无订单历史页)
- A/B 测试优惠力度
- Workers 入站 webhook 验签 (入站来自我们自家 notify.ts, HMAC 足矣)
- 持久化订单存储 (仍内存, 重启丢 60min 内未付款 — 既有局限)

### 14.2 Done Criteria (全部勾选才 sign-off)

- [ ] 10 决策 (1-11) 全部按 spec 落地
- [ ] 8 字段映射 100% 进 Notion (用 `ntn datasources query` 验)
- [ ] 24 条错误矩阵都有测试覆盖
- [ ] 6 个优惠码单测全绿
- [ ] 12 个 PayModal 测全绿 (6 旧 + 6 新)
- [ ] 8 个 notify-workers 集成测全绿
- [ ] 10 个 Workers handler 测全绿
- [ ] `yarn type-check` 干净
- [ ] `yarn test:ci` 绿, coverage ≥ 70%
- [ ] `yarn build` 绿
- [ ] Cloud Functions `tccli deploy --dry-run` 绿
- [ ] `ntn workers deploy` 成功, endpoint 可达
- [ ] `.env.example` 5 项 env 文档化
- [ ] Sentry source map 上传验证
- [ ] 3 笔手工 E2E (普通单 / 优惠码单 / 网络错) → Notion 8 字段全填
- [ ] **G2 跨境网络烟测**: 10 次 markPaid 模拟, ≥ 9 次 Notion 落单 (大陆节点 → Workers 端到端, 验 R10 缓解有效)
- [ ] 文档 Harness (本 spec + ARCHITECTURE 更新 + SECURITY-REVIEW 更新) 完成

### 14.3 验收命令 (一键复现)

```bash
# 1. 静态检查
yarn type-check
yarn lint

# 2. 单元 + 集成
yarn test:ci

# 3. 构建
yarn build

# 4. 部署 dry-run
tccli deploy --dry-run
ntn workers deploy --dry-run  # if supported

# 5. 端到端 (手工)
#   - 普通单: PayModal → 填表 → 扫码 ¥0.10 → 查 Notion 8 字段
#   - 优惠码单: PayModal → 填 PARTNER01 → 扫码 → 备注含 [code:PARTNER01 ...]
#   - 网络错: 断网扫码 → 查 Sentry 收到 E_NOTIFY_TIMEOUT
```

### 14.4 Harness 入口 (post sign-off)

1. spec sign-off (用户审) → 通过
2. invoke `superpowers:writing-plans` skill
3. system-architect 拆 5 子任务:
   - **Frontend**: PayModal Step 1 + Pricing 透传
   - **Backend**: create-order 扩展 + notify Workers fetch + lookup-discount endpoint
   - **Workers**: cloud-functions/notion-worker/ (handler + config + deploy)
   - **Sentry**: 4 配置文件 + .env + PII 过滤
   - **Harness validation**: 全链路 E2E + 文档更新
4. 串行走: `coder → security-engineer → reviewer → tester → devops-architect → docs`

---

## Appendix A: 引用文件速查

| 路径 | 行数 | 用途 |
|---|---|---|
| `cloud-functions/api/pay/create-order.ts` | 73 | 本次主要扩展点 |
| `cloud-functions/api/pay/notify.ts` | 66 | 本次主要修改点 |
| `cloud-functions/api/pay/query-order.ts` | 29 | 不改 |
| `lib/zpay.js` | 96 | 不改 |
| `lib/order-store.js` | 43 | 不改 |
| `products.config.js` | 40 | 不改 (P1 改真实价) |
| `themes/starter/components/PayModal.js` | 185 | 加 Step 1 |
| `themes/starter/components/__tests__/PayModal.test.js` | 208 | 加 6 case |
| `docs/ARCHITECTURE-payment.md` | 191 | 引用, 不重写 |
| `docs/SECURITY-REVIEW-payment.md` | 244 | 引用, 不重写 |
| `docs/PAYMENT-CALLBACK-COMPARISON.html` | 403 | 引用, 不重写 |

## Appendix B: 关键 ID 速查

| 资源 | ID |
|---|---|
| Notion workspace | `7dc4f4cf-c8e2-8148-a093-000319578589` |
| Notion database | `6ab4f4cf-c8e2-825e-bde8-016c2d9be1c2` |
| Notion data_source | `de84f4cf-c8e2-83dc-a33c-873e7f83f872` |
| Bot (integration) | `34e4f4cf-c8e2-817c-8471-0027807bc28e` ("我不叫龙虾") |
| EdgeOne project | `pages-qewdwgdprc3h` (one2agi) |
| Base commit | `b0e7290b` (Z-Pay Option A MVP) |

---

**Status**: Draft v0.1 — 等待用户审 (Task 7)
**Owner**: spec lead → user
**Harness 入口**: Task 8 (writing-plans skill)
