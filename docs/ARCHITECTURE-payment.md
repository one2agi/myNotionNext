# 支付接入架构

> 📋 本文档是支付接入的架构参考。详细 commit 历史见 `git log --grep="pay" --oneline`（含决策过程 / trade-off / 验证步骤）。

## 1. 概述

NotionNext 项目的收费流程由前端 PayModal 发起，经 EdgeOne Pages Cloud Function 中转，调用第三方支付服务生成二维码，用户扫码后由支付平台异步回调通知后端完成订单。

2026-06-03，支付链路从 **微信支付 V3 直连** 迁移到 **Z-Pay 第四方聚合支付**。V3 直连模式需要 RSA-SHA256 签名 + 1680 字符 PEM 私钥 + EdgeOne Blob Storage 私钥传递链路 + 平台证书管理，且回调解密链路（RSA + AEAD_AES_256_GCM）从未真正实现（`WECHAT_NOTIFY_URL` 仍是占位）。Z-Pay 仅需 MD5 签名 + form-data POST，私钥问题彻底消失。

接入时间 2026-06-03，关联 commit 见 `git log --grep="pay"`，Z-Pay 商户后台已绑定 AppID 与商户号（具体值见 Z-Pay 控制台）。

## 2. 架构对比

### 旧架构：微信支付 V3 直连

```
[NotionNext 前端 PayModal]
        |
        | POST /api/pay/create-order {productId}
        v
[EdgeOne Cloud Function: create-order.ts]
        |                        |
        | 读 6 个 WECHAT_* env   | @edgeone/pages-blob 拉 PEM
        v                        v
   [私钥加载 + RSA-SHA256 签名]   [Blob bucket: wxpay-secrets]
        |
        v
[api.mch.weixin.qq.com] ----> (无回调，notify URL 是占位)
```

痛点：私钥传递链路重（KV 不支持 Cloud Function，私钥走 Blob + 一次性 bootstrap 端点 + token 鉴权）、回调解密从未实现、个人开发者难以申请直连资质。

### 新架构：Z-Pay 第四方聚合

```
[NotionNext 前端 PayModal]
        |                                   [Z-Pay 异步回调]
        | POST /api/pay/create-order        |
        v                                   |
[EdgeOne Cloud Function: create-order.ts]   |
        |                                   |
        | 读 3 个 ZPAY_* env                |
        v                                   v
   [MD5 签名 + form-data POST]   [Cloud Function: notify.ts]
        |                                   |
        v                                   v
   [zpayz.cn/mapi.php] -----> [zpayz.cn] ---> 验签 + 金额校验 + 幂等
        |
        | 返回 {qrcode, imgUrl}
        v
[前端 <img src=imgUrl> + 3s 轮询]
        |
        v
[Cloud Function: query-order.ts] ---> [zpayz.cn/api.php]
```

收益：MD5 签名替代 RSA，env 变量替代 Blob 私钥传递，回调链路完整实现（验签 + 金额校验 + 幂等），无需营业执照即可接入。

## 3. 关键文件清单

| 状态 | 路径 | 作用 |
|------|------|------|
| 新增 | `lib/zpay.js` | 自封装 Z-Pay SDK（signParams / verifySign / createNativeOrder / queryOrder） |
| 新增 | `lib/order-store.js` | 内存 Map 幂等 + 金额校验（outTradeNo → priceFen） |
| 新增 | `cloud-functions/api/pay/notify.ts` | 回调端点，GET+POST 双 method |
| 新增 | `cloud-functions/api/pay/query-order.ts` | 订单查询代理，隐藏 ZPAY_KEY |
| 新增 | `docs/ARCHITECTURE-payment.md` | 本文件 |
| 修改 | `cloud-functions/api/pay/create-order.ts` | 完全重写：删 Blob / 删 WECHAT_* / 加 ZPAY_* |
| 修改 | `themes/starter/components/PayModal.js` | 改 `<img>` 渲染 + 3s 轮询 + 成功后 3s 自动关闭 |
| 修改 | `themes/starter/components/Pricing.js` | 按钮文案 "立即购买" → "立即支付" |
| 修改 | `package.json` | 删 `@edgeone/pages-blob` + 删 `qrcode` |
| 修改 | `products.config.js` | 顶部注释更新（内部金额单位仍为"分"） |

> 历史清理记录（已完成）：`zpay.config.js`、`lib/wechatpay.js`、`cloud-functions/api/_internal/`、`pages/api/pay/` 均已在迁移期间 `git rm`。

## 4. 数据流

### 4.1 n8n 自托管方案（当前生产）

```
[Z-Pay 异步回调]
        ↓ GET/POST
[EdgeOne Cloud Function: notify.ts]
        ├── verifySign / verifySignRaw（中文签名修复）
        ├── alreadyPaid（幂等：同一订单只处理一次）
        └── markPaid（金额校验，写入内存 store）
                ↓ 通过后
        POST n8n webhook（fire-and-forget, 2s AbortController）
                ↓
        [n8n VPS Docker 自托管]
                ├── 接收 JSON（outTradeNo, money, name, email, ...）
                └── 写入 Notion 数据库（状态="待发送"）
                        ↓
        Notion 数据库（客户管理模板）
```

**优势**：
- n8n 跑在用户自己的 VPS，不经过 GFW
- 幂等由 `alreadyPaid` 保证（同一订单只转发一次 n8n）
- n8n 内部可开启 Retry（1s/2s/4s）+ Dead Letter + Sentry 上报
- 不依赖 Notion Workers Beta（教育版计划无资格）

### 4.2 `POST /api/pay/create-order`

**请求**（前端 → 后端）：
```json
{ "productId": "starter-full" }
```

**内部处理**：
1. 查 `products.config.js` 拿商品名 + 价格（分）
2. 生成 `outTradeNo = <时间戳><随机数>`
3. 调 `lib/zpay.js` 的 `createNativeOrder` → form-data POST `https://zpayz.cn/mapi.php`，MD5 签名
4. `lib/order-store.js` 记录 `{outTradeNo → amountFen}`

**响应**（后端 → 前端）：
```json
{
  "outTradeNo": "1748912345678abcd",
  "qrcode": "weixin://wxpay/bizpayurl?pr=xxx",
  "imgUrl": "https://zpayz.cn/qrcode/xxx.jpg",
  "productId": "starter-full",
  "productName": "知行合一 · 完整版",
  "totalFen": 10
}
```

### 4.3 `GET|POST /api/pay/notify`

Z-Pay 官方文档写 GET，但 PHP/Java 服务商 SDK 经常 POST，因此 `notify.ts` 同时导出 `onRequestGet` + `onRequestPost`，两者转给同一个 `handle(ctx)`。

**处理流程**：
1. 解析参数（GET 从 `URL.searchParams`，POST 从 `request.formData()`）
2. `verifySign(params, env.ZPAY_KEY)`，失败返 400 `sign error`
3. 幂等检查（`orderStore.alreadyPaid(outTradeNo)`），命中直接回 `success`
4. 金额校验：反查 `outTradeNo` 对应的 `priceFen`，比对 Z-Pay 回调的 `money`（元）`× 100`（已转换）
5. `orderStore.markPaid(outTradeNo, money)`
6. `forwardToN8n`：POST 到 n8n webhook（fire-and-forget，2s AbortController）
7. **必须** `return new Response('success')` plain text（否则 Z-Pay 按指数退避重发 11 次）

**响应**：plain text `success`

**n8n 转发数据**（POST body）：
```json
{
  "outTradeNo": "1781200904493-13bmw7",
  "money": "0.10",
  "name": "张三",
  "email": "zhangsan@example.com",
  "productName": "基础版",
  "discountCode": "PARTNER01",
  "partnerName": "张三的店",
  "paidAt": "2026-06-12"
}
```

### 4.4 `GET /api/pay/query-order?outTradeNo=...`

**作用**：代理 Z-Pay 订单查询，**防止 `ZPAY_KEY` 暴露到前端**（GET 拼接 `key=...` 不能进前端代码，会被抓包），同时绕过 Z-Pay 的 CORS 限制。

**响应**（只透传必要字段）：
```json
{ "status": 0, "money": "0.10", "tradeNo": "...", "msg": "..." }
```

`status: 1` = 已支付，前端 3s 轮询命中后切绿色横幅 + 3s 后自动关闭弹窗。

## 5. 安全要点

- **MD5 签名**：参数按 ASCII 排序拼接 `a=b&c=d + KEY`，**排除** `sign` / `sign_type` / 空值，**小写**输出。验签时用相同算法重算比对。**不要**对参数做 URL 编码（Z-Pay 文档明确）。
- **金额校验**：防伪造回调。`order-store` 在 create-order 落单时记录 `outTradeNo → priceFen`，notify 时反查比对 Z-Pay 回调的 `money`（元）× 100 vs 记录的 `priceFen`（分）。不匹配返 400 不 `markPaid`。
- **幂等**：无 DB，内存 `Map<outTradeNo, {amountFen, paid, notifiedAt}>`，60 分钟 TTL，每次访问惰性清理。**接受**容器重启导致多发一次"成功"事件（钱在 Z-Pay 端已落，不重扣），要严格持久化需接 DB。
- **ZPAY_KEY 永远走 env**：不进入 git（`.env*` 在 `.gitignore`），不进入前端 bundle，不进入任何 git 跟踪配置文件。前端通过 `query-order` 代理访问，永远不直接接触 KEY。
- **回调 URL 必须公网 HTTPS**：Z-Pay 通知不到 localhost 或内网 IP。

## 6. 部署 / 运维

### 6.1 前置条件 / 一次性配置（迁移期已完成）

| # | 动作 | 状态 |
|---|------|------|
| 1 | EdgeOne 控制台清掉 6 个 `WECHAT_*` + `BLOB_BOOTSTRAP_TOKEN`，加 3 个 `ZPAY_*` | ✅ 完成（2026-06-04） |
| 2 | EdgeOne 控制台删 Blob bucket `wxpay-secrets`（旧 V3 私钥载体） | ⚠️ 待控制台核实（CLI 无 Blob 子命令） |
| 3 | Z-Pay 商户后台填 `notify_url` = `https://www.one2agi.com/api/pay/notify` | ✅ 完成（生产已收款） |
| 4 | n8n 部署到 VPS（docker compose） | ⏳ 待用户操作 |
| 5 | EdgeOne Pages 控制台加 `N8N_WEBHOOK_URL` + `N8N_WEBHOOK_SECRET` | ⏳ 待用户操作 |
| 6 | n8n workflow 导入并激活 | ⏳ 待用户操作 |
| 7 | （可选）把 `products.config.js` 价格从测试金额（10/30 分）改回真实价格 | ⏳ 暂不改 |

> **注意**：EdgeOne Pages 部署 Next.js 项目**只支持静态导出**（`yarn export`），不要改 build 命令。`cloud-functions/` 是平台层独立部署的，不受 build 模式影响。

### 6.2 env 当前状态

**当前生产 env（3 个 ZPAY_* + 2 个 N8N_*）**：
- `ZPAY_PID` — Z-Pay 商户 ID
- `ZPAY_KEY` — **只走 env**，绝不进 git
- `ZPAY_NOTIFY_URL` — 回调地址（必须公网 HTTPS）
- `N8N_WEBHOOK_URL` — n8n webhook 地址（例：`https://n8n.yourdomain.com/webhook/zpay-order`）
- `N8N_WEBHOOK_SECRET` — n8n 校验 secret（静态随机字符串，两端一致）

**可选**：
- `ZPAY_RETURN_URL` — 支付完成后跳转地址

**已废弃**（迁移期已从控制台移除）：`WECHAT_APPID` / `WECHAT_MCHID` / `WECHAT_SERIAL_NO` / `WECHAT_NOTIFY_URL` / `WECHAT_API_V3_KEY` / `WECHAT_PRIVATE_KEY` / `WECHAT_PRIVATE_KEY_PATH` / `BLOB_BOOTSTRAP_TOKEN`

**优先级**（后端内部统一）：`context.env.X` > 任何字面量配置。**KEY 永远只走 env**。

### 6.3 验证步骤

完整 curl 脚本与断言见 plan 文件 §阶段 D（D1-D6）：

- **D1** 部署前 `grep` + `yarn install` + `yarn tsc --noEmit` + `yarn export`
- **D2** `POST /api/pay/create-order` 验证下单
- **D3** 模拟 Z-Pay 回调，验签 + 金额校验
- **D4** 同回调连发 5 次，验证幂等
- **D5** 浏览器端到端：扫码 → 支付 → 弹窗自动关闭
- **D6** Z-Pay 商户后台核单

## 7. n8n 部署（Notion 写入层）

### 7.1 文件清单

| 文件 | 说明 |
|------|------|
| `n8n/docker-compose.yml` | n8n + Redis，Docker Compose 部署 |
| `n8n/.env` | 环境变量（HOST、加密密钥、Sentry DSN） |
| `n8n/README.md` | 部署操作手册 |
| `n8n/workflow-zpay-order.json` | n8n workflow（Webhook → Notion 写入） |

### 7.2 部署前置条件

- VPS（固定公网 IP）
- 域名（可新增子域名指向 VPS）
- Docker + Docker Compose
- Nginx + Let's Encrypt（生产环境 HTTPS）

### 7.3 DNS 配置

新增子域名指向 VPS：
```
n8n.yourdomain.com  A  你的VPS固定IP
```

### 7.4 n8n workflow 节点

```
Webhook Trigger（POST /webhook/zpay-order）
    ↓
IF：检查 header x-n8n-secret
    ↓（失败）→ Error Trigger（记录）
    ↓（成功）
Notion Create Page（database: 6ab4f4cf-c8e2-825e-bde8-016c2d9be1c2）
    ↓
Respond 200 {ok: true}
```

### 7.5 幂等保证

- `alreadyPaid(outTradeNo)` 在 notify.ts 层已保证，同一订单只转发一次 n8n
- n8n 内部可选加 IF 节点查询 Notion 是否已存在订单号

## 7.6 n8n 部署状态（2026-06-12 完工）

**位置**：腾讯云 VPS `124.220.65.87`，跑在 `https://n8n.one2agi.com`（nginx + Let's Encrypt 反代）。

**栈**：Docker 29.5.3（腾讯云 mirror 装）+ n8n 2.25.7 容器（**regular 模式，无 Redis/无 worker，单实例**）+ ufw 防火墙（22/80/443）。

**EdgeOne Pages 环境变量**（用 `edgeone` CLI 1.5.9 配）：
- `N8N_WEBHOOK_URL` = `https://n8n.one2agi.com/webhook/zpay-order`
- `N8N_WEBHOOK_SECRET` = 64 位 hex

**Workflow 关键 schema 经验**（n8n 2.25.7 / Notion v2 节点 `typeVersion: 2.2`）：
- **必须** `resource: "databasePage"`（缺这个报 "Could not extract page ID from URL: undefined"）
- `databaseId` 用 `__rl: true, value: <uuid>, mode: "id"` 包装
- 用 Code 节点做 secret 校验（`$json.headers['x-n8n-secret']`），不要用 IF + `typeValidation: 'strict'`
- 容器要 `TRUST_PROXY=true` 信任 nginx 注入的 X-Forwarded-For

**Notion API 不稳**（已知问题，5 次中 ~3 次 connection refused，疑似 VPS→Notion 出站被 GFW 间歇 reset）：
- n8n 节点 `settings.retryOnFail + maxTries: 4` 对 "service refused" **不生效**（n8n 视为致命错而非网络错）
- Code 节点手动 retry 走不通：n8n API PUT 含中文键名（`客户邮箱`）的 Code 节点 server 500
- **当前接受 60-70% 成功率**，失败兜底：**查 n8n executions list 找 mode=error 的，补发 Notify**
- 可选增强：EdgeOne KV 记录订单 + 周期 worker 比对 Notion 缺单 + 自动补发

**端到端验证**：TEST-017 / RETRY2-01 / CODE-01 等多次写入成功，Notion 新页面 URL 形如 `https://app.notion.com/p/{name}-...`。

## 8. 已知限制 / 未来工作

- **商品价格仍是测试金额**：`products.config.js` 当前为 10/30 分，待改回真实价格（7900/29900 分）。
- **PaywallButton 未实现**：`STARTER_PAYWALL_ENABLE` 注释已标"本期未启用"，组件待后续接入。
- **支付宝/银联未接入**：本期只接微信 Native 扫码。
- **多实例不共享内存**：EdgeOne Cloud Function 可能多实例，`order-store` 跨实例不共享。单实例内幂等可保证业务正确；多实例不导致重复扣款（幂等检查在每个实例内独立完成）。
- **n8n 单实例上限**：当前 regular 模式无 worker，订单并发 < 100/天足够；高并发需加 Redis + worker + `EXECUTIONS_MODE=queue`。
- **n8n 可选增强**：Sentry 上报、Dead Letter（Google Sheet 备用写入）、`OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true`。

## 9. 参考

- 完整迁移方案：见 git 历史（`git log --grep="pay" --oneline`），含决策记录、风险评估、阶段 A-D 详细步骤。
- Z-Pay 官方文档：https://z-pay.cn/doc.html
- 微信支付 V3 文档（历史）：https://pay.weixin.qq.com/wiki/doc/apiv3/（保留作为"为什么我们迁走了"的历史参考）
- n8n 官方文档：https://docs.n8n.io/
- Notion Workers 文档（历史，Beta 已放弃）：https://developers.notion.com/workers/
