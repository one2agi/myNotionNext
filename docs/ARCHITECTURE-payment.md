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
| 删除 | `zpay.config.js` | 仅 ZPAY_PID 占位文件，从未 import（已 `git rm`） |
| 删除 | `lib/wechatpay.js` | 整文件 |
| 删除 | `cloud-functions/api/_internal/populate-blob.ts` | 一次性 bootstrap 端点（含整个 `_internal/`） |
| 删除 | `pages/api/pay/create-order.ts` | dead code（含整个 `pages/api/pay/`） |

## 4. 数据流

### 4.1 `POST /api/pay/create-order`

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

### 4.2 `GET|POST /api/pay/notify`

Z-Pay 官方文档写 GET，但 PHP/Java 服务商 SDK 经常 POST，因此 `notify.ts` 同时导出 `onRequestGet` + `onRequestPost`，两者转给同一个 `handle(ctx)`。

**处理流程**：
1. 解析参数（GET 从 `URL.searchParams`，POST 从 `request.formData()`）
2. `verifySign(params, env.ZPAY_KEY)`，失败返 400 `sign error`
3. 幂等检查（`orderStore.alreadyPaid(outTradeNo)`），命中直接回 `success`
4. 金额校验：反查 `outTradeNo` 对应的 `priceFen`，比对 Z-Pay 回调的 `money`（元）`× 100`（已转换）
5. `orderStore.markPaid(outTradeNo, money)`
6. **必须** `return new Response('success')` plain text（否则 Z-Pay 按指数退避重发 11 次）

**响应**：plain text `success`

### 4.3 `GET /api/pay/query-order?outTradeNo=...`

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

### 6.1 前置条件（用户必做）

| # | 动作 | 位置 |
|---|------|------|
| 1 | EdgeOne 控制台**删** 6 个 `WECHAT_*` + `BLOB_BOOTSTRAP_TOKEN`，**加** 3-4 个 `ZPAY_*` | EdgeOne → 环境变量 |
| 2 | EdgeOne 控制台**删** Blob bucket `wxpay-secrets` | EdgeOne → 存储 → Blob |
| 3 | Z-Pay 商户后台填 `notify_url` = `https://<你的域名>/api/pay/notify` | z-pay.cn member 后台 |
| 4 | （可选）把 `products.config.js` 价格从测试金额（10/30 分）改回真实价格 | 仓库 |

> **注意**：EdgeOne Pages 部署 Next.js 项目**只支持静态导出**（`yarn export`），不要改 build 命令。`cloud-functions/` 是平台层独立部署的，不受 build 模式影响。

### 6.2 env 替换表

**删除（7 个）**：`WECHAT_APPID` / `WECHAT_MCHID` / `WECHAT_SERIAL_NO` / `WECHAT_NOTIFY_URL` / `WECHAT_API_V3_KEY` / `WECHAT_PRIVATE_KEY` / `WECHAT_PRIVATE_KEY_PATH` / `BLOB_BOOTSTRAP_TOKEN`

**新增（3-4 个）**：
- `ZPAY_PID` — Z-Pay 商户 ID
- `ZPAY_KEY` — **只走 env**，绝不进 git
- `ZPAY_NOTIFY_URL` — 回调地址（必须公网 HTTPS）
- `ZPAY_RETURN_URL`（可选）— 支付完成后跳转地址

**优先级**（后端内部统一）：`context.env.X` > 任何字面量配置。**KEY 永远只走 env**。

### 6.3 验证步骤

完整 curl 脚本与断言见 plan 文件 §阶段 D（D1-D6）：

- **D1** 部署前 `grep` + `yarn install` + `yarn tsc --noEmit` + `yarn export`
- **D2** `POST /api/pay/create-order` 验证下单
- **D3** 模拟 Z-Pay 回调，验签 + 金额校验
- **D4** 同回调连发 5 次，验证幂等
- **D5** 浏览器端到端：扫码 → 支付 → 弹窗自动关闭
- **D6** Z-Pay 商户后台核单

## 7. 已知限制 / 未来工作

- **内存 Map 重启丢记录**：Cloud Function 容器重启会清空 `order-store`，可能导致用户被多发一次"成功"事件（不影响扣款，钱在 Z-Pay 端已落）。要严格持久化需接 Notion DB 或外部 KV，本期不接。
- **商品价格仍是测试金额**：`products.config.js` 当前为 10/30 分，待改回真实价格（7900/29900 分）。
- **PaywallButton 未实现**：`STARTER_PAYWALL_ENABLE` 注释已标"本期未启用"，组件待后续接入。
- **支付宝/银联未接入**：本期只接微信 Native 扫码。
- **DB 持久化待评估**：如未来需要订单历史、退款、对账，需引入 Notion DB 或其他持久化层。
- **多实例不共享内存**：EdgeOne Cloud Function 可能多实例，`order-store` 跨实例不共享。单实例内幂等可保证业务正确；多实例不导致重复扣款（幂等检查在每个实例内独立完成）。

## 8. 参考

- 完整迁移方案：见 git 历史（`git log --grep="pay" --oneline`），含决策记录、风险评估、阶段 A-D 详细步骤。
- Z-Pay 官方文档：https://z-pay.cn/doc.html
- 微信支付 V3 文档（历史）：https://pay.weixin.qq.com/wiki/doc/apiv3/（保留作为"为什么我们迁走了"的历史参考）
