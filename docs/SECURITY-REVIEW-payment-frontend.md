# Security Review — Payment Frontend Integration

**分支**: `feat/discount-code-notion`
**审计日期**: 2026-06-14
**审计范围**:
- `/mnt/d/workspace/notionnext/myNotionNext/pages/api/pay/query-order.ts`
- `/mnt/d/workspace/notionnext/myNotionNext/pages/api/pay/cancel-order.ts`
- `/mnt/d/workspace/notionnext/myNotionNext/themes/starter/components/PayModal.js`
- `/mnt/d/workspace/notionnext/myNotionNext/themes/starter/components/Pricing.js`
- `/mnt/d/workspace/notionnext/myNotionNext/lib/env.ts`

**关联文件 (上下文参考, 非本次审计目标)**:
- `/mnt/d/workspace/notionnext/myNotionNext/pages/api/pay/create-order.ts`
- `/mnt/d/workspace/notionnext/myNotionNext/themes/starter/components/PayModalProvider.js`
- `/mnt/d/workspace/notionnext/myNotionNext/lib/order-store.ts`

---

## 风险摘要

| 等级 | 数量 |
|------|------|
| High | 4 |
| Medium | 5 |
| Low | 4 |

---

## HIGH

### H1. query-order 无身份校验 — 任意订单状态可被枚举查询

**文件**: `pages/api/pay/query-order.ts:127-191`

**问题**: `outTradeNo` 通过 `req.query` 直接传入, 任意人调用 `GET /api/pay/query-order?outTradeNo=...` 即可读取订单的:
- 是否支付 (`paid`)
- 支付时间 (`paidAt`)
- 商品名 (`productName`)
- 实际成交金额 (`finalPrice`)

**业务危害**:
1. **订单号格式可被预测** — `create-order.ts:128-130` 使用 `Date.now()-${randomStr}` (`Math.random().toString(36).slice(2,8)` ≈ 6 位 base36 ≈ 36^6 ≈ 21 亿组合), 攻击者可对近期订单号做时间窗口+枚举爆破
2. **支付状态/金额泄露** — 竞品/外部用户可探测"谁在何时买了什么、花了多少钱", 违反隐私与商业机密
3. **配合 H2 形成完整攻击链** — 查到的 `outTradeNo` 可直接喂给 `cancel-order`

**建议**:
- 引入 session/cookie 鉴权 (NextAuth 或自建), 把 `outTradeNo` 与 `customerEmail` 绑定, 仅本人或管理员可查
- 或使用短时效签名 token: 创建订单时返回 `queryToken = HMAC(orderId, secret)`, 轮询时必带, 防止枚举
- 如短期无法上鉴权, 至少加入速率限制 (例如同一 IP 每分钟 ≤ 30 次) + Cloudflare Turnstile

---

### H2. cancel-order 无身份校验 — 任何人可取消任意未支付订单 (DoS + 状态混淆)

**文件**: `pages/api/pay/cancel-order.ts:177-282`

**问题**: `cancel-order` 接受 `{outTradeNo}` 即可触发, 不校验调用者身份, 也未校验调用者邮箱/姓名是否匹配订单持有人。

**业务危害**:
1. **拒绝服务**: 恶意用户持续 POST `/api/pay/cancel-order {outTradeNo: <刚创建的订单>}`, 让其他用户永远无法支付 (点开已是 EXPIRED/已取消)
2. **状态混淆**: 攻击者调用 cancel 改 Notion 状态为"已取消", 真实用户虽然已扫码付了款, 但因为状态被改, 后续发货流程被打乱
3. **关闭 Z-Pay 订单**: `cancel-order.ts:230-232` 调用 `closeZPayOrder` — 攻击者可借此批量调用 Z-Pay close 接口, 触发 Z-Pay 速率限制, 影响全站
4. **n8n webhook 滥用**: `notifyN8nCancelOrder` 会被频繁触发, 对 n8n VPS 形成流量放大

**建议**:
- 强制要求前端 cancel 时携带 `customerEmail`, 服务端二次比对 `order-store`/`Notion` 中 `customerEmail` 是否匹配 (大小写不敏感)
- 或返回创建订单时签发的 `cancelToken`, 仅持有 token 可调用 cancel
- Z-Pay close 仅在 order 真正处于"未支付"且 5 分钟内才调用, 加上频控

---

### H3. Pricing.js 价格由 siteConfig 控制 — 价格可在前端被伪造

**文件**: `themes/starter/components/Pricing.js:131-184`

**问题**:
```js
onClick={() => openPayModal({
  productId: siteConfig('STARTER_PRICING_2_PRODUCT_ID', 'starter-full'),
  productName: siteConfig('STARTER_PRICING_2_TITLE', '知行合一 · 完整版'),
  totalPrice: parseFloat(siteConfig('STARTER_PRICING_2_PRICE', '79')),
})}
```
`totalPrice` 来自前端 siteConfig, 攻击者通过 DevTools / Chrome 扩展 / 浏览器 console 改 React state 后传入 `openPayModal`, 即可让前端显示任意价格。

**风险**:
- 此处仅用于前端展示, `create-order.ts` 后端用 `PRODUCTS[productId]` 重新查服务端权威价格 (`create-order.ts:34-37, 110-115`), 所以**金额本身**会被服务端覆盖, 不会出现"前端把 79 改成 1 然后真的付 1 元"的情况
- 但攻击者可借此在前端看到"虚假优惠价", 配合 social engineering 实施钓鱼 (例如: 截图显示"¥1 即可获得完整版"诱导扫码 + 客服配合诈骗)

**建议**:
- 价格完全由后端返回, 前端仅展示 — 但目前架构如此亦可接受 (后端是 source of truth)
- 在 PayModal 显示价格处加上"以 Z-Pay 实际收款金额为准"提示, 避免截图钓鱼
- 进一步: 后端 create-order 在 body 里只接受 `productId`, 忽略前端任何价格字段 (当前已是, 验证 OK)

---

### H4. cancel-order 状态字段名硬编码, 与运维实际不符 — 静默误判

**文件**: `pages/api/pay/cancel-order.ts:258, 267`

**问题**:
```ts
if (notionOrder.status === '已发送') { ... E_ORDER_ALREADY_PAID ... }
if (notionOrder.status === '已取消') { ... 幂等返回 ... }
```

**业务上下文**: 项目 memory 标注 `Z-Pay 调试会话 2026-06-12` 与 `Z-Pay + Workers 迁移 2026-06-12` 明确说明实际状态字段是 **"待发送"** (默认) / **"已发送"** (发货后), 即业务流:
- 创建订单 → Notion 状态 = "待发送"
- 发货 (n8n) → 状态 = "已发送"

**cancel-order 漏洞**:
1. 当订单**未支付**时, Notion 状态是 "待发送", `cancel-order.ts:258` 检查的是 `=== '已发送'`, 此时不命中 (OK, 不会误判)
2. 但如果运维/前端用了 `notionOrder.status === '已支付'` (假设), 或 `=== 'paid'`, 等等, 都会全部失配 — 当前检查只匹配"已发送"一个值, **"已支付" 被静默视为未支付**, 任何 status 的"未发货已付"状态都会被错认为可取消
3. 若 Notion 状态机新增 "退款中"、"已退款" 状态, 此处无 else 分支, 直接走入 notify n8n 改 "已取消", 破坏财务记录

**建议**:
- 显式列出可取消的 status 白名单: `if (['待发送'].includes(notionOrder.status)) { ... 可取消 ... }`
- 未命中任何已知 status 时返回 409 E_STATUS_UNKNOWN 而非静默继续
- 把状态字段集中为 enum 常量, 跨文件共享, 避免字符串硬编码漂移

---

## MEDIUM

### M1. 5s 轮询无频控 — 自家服务器 DoS

**文件**: `themes/starter/components/PayModalProvider.js:158-195`

**问题**:
```js
const POLL_INTERVAL_MS = 5000
const maxPolls = Math.floor(TIMEOUT_MS / POLL_INTERVAL_MS)  // 60 次
```
单个支付会话最多产生 60 次 query-order 请求。若 100 个用户同时支付, 峰值 12 RPS 仅支付查询 — 不算大, 但攻击者可并发触发 create-order + query-order, 显著放大负载。

**建议**:
- 后端 `/api/pay/query-order` 加 IP 级限速 (60 req/min)
- 前端轮询间隔随机化 (5s ± 0.5s jitter), 避免请求雪崩
- 长轮询替代短轮询 (Notion webhook + SSE 推送) — 但本架构暂不具备
- 后端给 `/api/pay/query-order` 加 ETag/304, 已支付订单直接 304 短路

---

### M2. env.ts 校验失败信息泄露 — 日志回显 env 值

**文件**: `lib/env.ts:84-99, 111-115`

**问题**: 校验失败时把**完整 env 值**拼到错误信息:
```ts
invalid.push(`${key}=${value} (must be https://)`)
```
随后:
```ts
throw new Error(`[env] Invalid env variable format: ${invalid.join(', ')}\n...`)
```
这个 Error 会被 Next.js 捕获并输出到:
- Vercel/EdgeOne 部署日志 (公开日志平台如 Vercel 可被合作者看到)
- 启动控制台

虽然 `logEnvBanner` 用了 `mask()` (后 4 位脱敏), 但 `invalid` 数组里是**完整明文**。

**影响**:
- NOTION_TOKEN 完整泄露到部署日志
- N8N_WEBHOOK_SECRET 泄露
- ZPAY_KEY 泄露

**建议**:
```ts
// 改用脱敏 + key only
invalid.push(`${key}=<redacted ${value.length} chars> (must be https://)`)
```
或仅暴露 key 名 + 失败原因, 不暴露 value:
```ts
invalid.push(`${key} (must be https://)`)
```

---

### M3. Notion rich_text filter equals 未做长度限制 — 潜在 Notion API 拒绝服务

**文件**: `pages/api/pay/query-order.ts:82-87`, `cancel-order.ts:145-151`

**问题**:
```ts
filter: {
  property: '订单号',
  rich_text: { equals: outTradeNo },
},
```
`outTradeNo` 来自 `req.query` / `req.body`, 未做长度上限校验。`create-order.ts` 生成的格式 `${Date.now()}-${randomStr}` 最长约 20 字符, 但恶意调用方可传入任意长字符串。

**影响**:
- Notion API 对 rich_text filter 内容长度有限制 (4096 字符), 超长会返回 400
- 但每次 query 都会**实际打到 Notion API** — 攻击者可构造大量超长 outTradeNo 触发 Notion API 限速 (avg 3 req/s), 消耗 Notion 配额

**建议**:
```ts
if (outTradeNo.length > 64 || !/^[A-Za-z0-9_-]+$/.test(outTradeNo)) {
  return res.status(400).json({ code: ErrorCode.E_PARAM_MISSING, ... })
}
```
白名单字符集 + 长度上限。

---

### M4. create-order.ts notify n8n webhook 失败被静默吞掉

**文件**: `pages/api/pay/create-order.ts:225-228`

**问题**:
```ts
fetch(...).catch(() => {
  // n8n webhook 失败不影响主流程，忽略
})
```

虽然标为"参考上下文", 但同样的模式也存在于 `cancel-order.ts:98-119`:
```ts
await fetch(`${webhookUrl}/cancel-order`, { ... })
// 无 await, 无 catch, 无错误日志
```
`cancel-order.ts` 里 `notifyN8nCancelOrder` 是 `await` 调用, 但函数体内 `fetch` 不 throw (通常), 所以错误会丢失。

**风险**:
- Notion 状态永远停留在"待发送", 用户体感"订单消失了"
- 运营查账时找不到 cancel 记录
- 日志缺失, 排障困难

**建议**:
- 加入 console.error / 结构化日志
- 重试机制 (1 次, 5s 后)
- 把 cancel 结果持久化到 Notion 备份表, n8n 失败时手动补救

---

### M5. PayModal email 字段无 maxLength + 无 trim 服务端兜底

**文件**: `themes/starter/components/PayModal.js:224-230`, `create-order.ts:93-94`

**问题**:
- 前端 input `<input type="email" ...>` 没有 `maxLength`, 用户可粘贴超长字符串 (虽然后端 `name.length > 50` 限制了姓名, 但 email 没限制)
- `create-order.ts:94` 只对 name/email 做 `.trim()`, 但 RFC 5321 邮箱长度上限是 254, 未做服务端校验

**影响**:
- Notion `customerEmail` 字段如果类型是 title (100 字符), 超长会写入失败, create-order 表面 200 但 Notion 失败
- 邮箱超长可用于探测 Notion 字段长度限制

**建议**:
```ts
if (email.length > 254) return res.status(400).json({ code: 40003, ... })
```

---

## LOW

### L1. PayModal XSS — React JSX 自动转义, 但 imgUrl 需审计

**文件**: `themes/starter/components/PayModal.js:296-297`

**分析**: React JSX 默认对 `{expression}` 做 HTML 转义, 所有 `{name}` / `{email}` / `{outTradeNo}` / `{errorMessage}` 等用户输入都安全。`imgUrl` 通过 `<img src={imgUrl} .../>` 渲染, React 也会对 attribute 值做 JS 上下文过滤。

**残留风险**:
- `imgUrl` 来源是 `Z-Pay 返回的 Location header` 或 `bodyText.match(/(weixin:\/\/wxpay\/[^\s"']+)/)`, 都是受信任的来源 (Z-Pay 服务器响应)
- 但 Z-Pay 响应若被中间人篡改 (HTTP→HTTPS 已 OK, 但证书钉扎未启用), 可注入 `javascript:alert(1)` 协议 — 当前 `imgUrl` 不参与跳转, 仅作 `src`, 无 XSS 风险
- 真实风险点是 `qrcode` 直接来自 Z-Pay, 客户端用于 `weixin://` scheme — 仅作 `<img src>` 渲染 (虽然某些浏览器对非 http(s) src 静默失败), 不构成 XSS

**建议**: 当前实现安全, 无需修改。如未来在 PayModal 增加 `<a href={qrcode}>` (允许用户点击跳转微信), 需做协议白名单校验。

---

### L2. CSRF — Next.js Pages API 无内置 CSRF token

**文件**: 全部 3 个 `pages/api/pay/*`

**问题**:
- `create-order` / `cancel-order` 是 POST, 接受 JSON body
- Next.js Pages Router 默认无 CSRF 防护
- 攻击者在第三方网站放 `<form action="https://www.one2agi.com/api/pay/cancel-order" method="POST">` + auto-submit, 即可让已登录用户 (如有 cookie) 自动取消订单
- 当前架构**无登录态** (无需登录即可购买), 所以攻击者只能取消自己浏览器 session 内的订单 — 危害较小
- 但攻击者可借此消耗 Z-Pay close 接口配额 + Notion API 配额

**建议**:
- 短期: 检查 `Origin` / `Referer` header, 仅允许同源
- 中期: 加 double-submit cookie CSRF token
- 由于业务无登录, 同源检查即可防御 99% CSRF 场景

---

### L3. n8n webhook 鉴权 — `x-n8n-secret` 头安全性中等

**文件**: `create-order.ts:206-211`, `cancel-order.ts:108-113`

**分析**:
```ts
headers: { 'Content-Type': 'application/json', 'x-n8n-secret': n8nSecret }
```
- 使用自定义 header + shared secret, 比 URL query 参数安全 (不进 access log / referer)
- secret 通过 env 注入, 不硬编码 (OK)
- 但 secret 是对称密钥, 若泄露则 n8n webhook 可被任意调用方伪造, 包括改订单状态
- `lib/env.ts:21-30` 已将 `N8N_WEBHOOK_SECRET` 列为必需, 启动校验到位

**残留风险**:
- secret 可能在 Vercel/EdgeOne 部署日志泄露 (参见 M2)
- secret 在前端 `.env.example` 文件中**可能**留有占位符 — `.env.example` 在 git status 中显示为 `D` (已删除), OK

**建议**:
- 短期 OK
- 中期: n8n webhook 加时间戳 + HMAC 签名 (防 replay), secret 改为非对称 (n8n 公钥验签)
- 监控 n8n 端日志, 发现异常 IP 来源立即告警

---

### L4. order-store 内存 Map 无上限 — 潜在内存耗尽

**文件**: `lib/order-store.ts:31-44`

**问题**:
```ts
const store = new Map<string, OrderRecord>()
setInterval(() => { /* 清理 >60min 记录 */ }, 5 * 60 * 1000)
```
- 没有 Map size 上限, 攻击者高频调用 create-order 制造大量订单, 每条占用 ~300 bytes, 1M 条订单 ≈ 300MB
- cleanup interval 是 5min, 极端场景下短时间内堆积未到 TTL 的记录

**影响**: 单 EdgeOne 实例 OOM。

**建议**:
- Map size 上限 (例如 10k), 超过时按 LRU 淘汰
- cleanup 间隔改为 1min
- 同时监控 store.size 指标, 超阈值告警

---

## 审计结论

**前端代码整体安全性中等**。后端采用 env 集中校验 + Notion/Z-Pay 双向 fallback + 错误码规范, 设计完整。但 **query-order / cancel-order 两个端点完全无身份校验** 是核心问题 (H1+H2 攻击链), 强烈建议在本期上线前修复 — 至少加 IP 限速 + Origin 校验 + outTradeNo 格式白名单。

Pricing.js 的前端价格是已知风险但被服务端兜底, 可接受。PayModal 表单 XSS 安全 (React 默认转义)。env.ts 日志泄露 (M2) 是低成本高收益修复项。

**优先级修复顺序**:
1. **H1 + H2** — query-order / cancel-order 加最小鉴权 (Origin + 限速 + outTradeNo 白名单)
2. **M2** — env.ts 失败信息脱敏 (5 分钟改完)
3. **M3** — outTradeNo 长度+字符白名单 (10 分钟)
4. **H4** — cancel-order status 白名单 (30 分钟 + 加测试)
5. 其余列入下个 sprint

---

## 参考

- PAYMENT-API-SPEC.md §3.5 / §3.6
- PAYMENT-FRONTEND-DESIGN.md §4 / §7
- PAYMENT-IMPLEMENTATION-NOTES.md B.1 / B.2 / B.5 / B.6
- lib/env.ts §12.5
- OWASP API Top 10 (2023): API1 BOLA, API4 Resource Consumption, API5 Function Level Authorization