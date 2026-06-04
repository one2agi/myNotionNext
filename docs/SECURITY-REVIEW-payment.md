# 支付迁移安全评审报告

> 评审日期:2026-06-04
> 评审范围:本次 Z-Pay 迁移所有 commit (c76d15dc..1bc1a4a5)
> 评审人:security-engineer (harness 阶段 4)
> 评审方法:逐文件阅读 + git 历史 grep + 测试用例审计

## 总结

**整体评价: 1 个 CRITICAL FAIL（必修）+ 4 个 WARN（建议修）+ 大量 PASS**。

核心安全机制（MD5 验签 / 金额校验 / KEY 隔离 / 幂等 / 重发阻断）设计方向正确，KEY
没有泄露到 git 或前端 bundle，验签算法有白名单防御，测试覆盖了核心场景。
**但有一个**会让生产 100% 失败的实现断链：`create-order.ts` 在生成订单后**没有调用**
`recordOrder(outTradeNo, product.price)` 落单，导致 `notify.ts` 回调时
`orderStore.markPaid` 内部 `store.get(outTradeNo)` 永远返 `undefined`，金额校验永远
判定为不匹配，每次合法 Z-Pay 回调都会被 `notify.ts` 拒为 `400 'amount mismatch'`，用户
永远不会看到支付成功。

**不能上线**。必须先修 F1（不是修测试、不是放宽校验、是把 `recordOrder` 调用加回去）。
其他 4 个 WARN 单独修复后不阻塞上线，但建议本轮顺手处理。

## 必须修（FAIL，影响生产）

- [ ] **F1 [CRITICAL] — `create-order.ts` 漏调 `recordOrder`，notify 金额校验全失效**
  - **文件**:`cloud-functions/api/pay/create-order.ts` (line 22-68)
  - **证据**:
    1. `lib/order-store.js:14` 定义了 `recordOrder(outTradeNo, priceFen)`，plan §A5
       明确"create-order 落单时记录 `{amountFen, createdAt}`"
    2. `lib/order-store.js:23-37` 的 `markPaid` 实现要求 `store.get(outTradeNo)`
       命中已存在记录才能做金额比对，否则直接 `return false`
    3. `create-order.ts:22-68` 整文件 **没有** 任何 `recordOrder` 调用，也没有
       `import { recordOrder } from '../../../lib/order-store.js'`
    4. `notify.ts:46` 调用 `markPaid(outTradeNo, parseFloat(params.money))` →
       `store.get(outTradeNo)` → `undefined` → `return false` → 通知 400 'amount mismatch'
  - **生产影响**:
    - **D3 模拟回调必失败**（plan 的验证步骤之一）
    - **D5 浏览器扫码支付后** PayModal 永远停在轮询（status 永远不是 1）
    - **真实用户永远收不到"支付成功"事件**
  - **测试盲区**:`notify.test.ts` 用了 `jest.mock` 完全替换 `markPaid`，从不触发
    `store.get(...)` 这条真实链路，所以测试绿了但生产炸
  - **建议修法**:
    ```ts
    // create-order.ts 顶部加
    import { recordOrder } from '../../../lib/order-store.js'
    // ... onRequestPost 内、createNativeOrder 之后、加 recordOrder 落单
    const { qrcode, imgUrl } = await createNativeOrder({ ... } as any)
    recordOrder(outTradeNo, product.price)  // ← 关键：先 record 再返 200
    return jsonResponse({ outTradeNo, qrcode, imgUrl, ... })
    ```
  - **额外建议**:在 `create-order.test.ts` 加一个集成断言 "create-order 后
    `orderStore.recordOrder` 被调用 1 次，参数 `(outTradeNo, 10)`"——这条能挡住未来
    任何人不小心删掉这行

- [ ] **F2 [HIGH] — `create-order.test.ts` 测试断言不充分，漏了 recordOrder 调用**
  - **文件**:`cloud-functions/api/pay/__tests__/create-order.test.ts`
  - **问题**:即使 F1 修了，测试套件里没有任何 case 验证 `recordOrder` 被调过——这
    就是为什么 F1 一直没被发现的根因
  - **建议修法**:`jest.mock` `order-store.js`，加 1 个 case 断言
    `expect(recordOrder).toHaveBeenCalledWith(outTradeNo, 10)`

## 建议修（WARN，降低风险）

- [ ] **W1 — `markPaid` 金额不匹配时设 `paid=true` 是"粘性"决策，需注释明确**
  - **文件**:`lib/order-store.js:34-36`
  - **行为**:
    ```js
    if (Math.round(moneyYuan * 100) === rec.amountFen) { ... return true }
    rec.paid = true  // ← 设为 true
    return false     // ← 但返 false
    ```
  - **效果**:`notify.ts:43-45` 的 `alreadyPaid` 检查会通过 → 后续 Z-Pay 重发被
    早 ack `200 'success'`，**不再做金额校验**
  - **风险**:如果攻击者能伪造一次"金额不对"的回调（验签过的——需要 Z-Pay 私钥），
    后续 Z-Pay 重发都会被静默接受（虽然 Z-Pay 重发参数相同所以不会"修正"金额，但
    如果某天 Z-Pay 在重试中调整金额——不会发生——就有问题）
  - **判断**:**当前是合理设计**（防 Z-Pay 重试风暴 + 防攻击者再次注入），但应该
    在代码注释里写清楚这是有意为之，而不是"看起来像 bug"。已部分注释（line 35）
    但可以更明确
  - **建议**:注释里加一句"即使 amount mismatch 也一次性封堵，避免攻击者通过重发
    累积脏数据进入 paid Map"

- [ ] **W2 — `query-order.ts` 无 try/catch，Z-Pay 不可达时返 500 暴露内部错误**
  - **文件**:`cloud-functions/api/pay/query-order.ts:19`
  - **行为**:`const data = await queryOrder({ ... })` 无错误捕获
  - **风险**:Z-Pay 服务抖动 → Cloud Function 抛 500 → 前端轮询每次都打 console error
    （虽然 PayModal silent 吞了，但日志会污染）
  - **更严重的情况**:如果 Z-Pay 返回的 JSON 不是合法对象（比如 HTML 错误页），`data.status`
    会是 `undefined`，前端 `if (d.status === 1)` 永远不命中——这其实是想要的，但
    500 比 200+ `{status: 0}` 更难排查
  - **建议**:包 try/catch，失败时返 `{ status: 0, msg: 'query failed' }` 让前端
    静默继续轮询；同时不要把 `error.message` 透出（防止泄漏 Z-Pay 内部 URL / 错误格式）

- [ ] **W3 — `create-order.ts` 不传 `clientIp` 给 Z-Pay，行为未对齐 Z-Pay 文档**
  - **文件**:`cloud-functions/api/pay/create-order.ts:46-52`
  - **行为**:`createNativeOrder` 调用没传 `clientIp`，`lib/zpay.js:60` 是
    `clientip: clientIp`（undefined）→ `signParams` 排除 undefined → 签名里没有
    clientip 字段
  - **风险**:不是安全风险（不影响验签），但是 functional risk——Z-Pay 文档可能要求
    clientip（防刷常用），不带可能导致风控拦截或更高费率。需要去 z-pay.cn 文档
    二次确认
  - **建议**:加 `clientIp: request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '0.0.0.0'`
    （从 `context.request.headers` 读 + 提供 fallback）

- [ ] **W4 — `zpay.config.js` 是 dead code，没人 import 它**
  - **文件**:`zpay.config.js`
  - **行为**:文件存在（带"不存 KEY"注释），但 `create-order.ts` / `notify.ts` /
    `query-order.ts` 全部直接读 `context.env`，没有任何 `await import('zpay.config.js')`
  - **风险**:**安全零风险**（多此一举反而是好事——多一层防御提醒），但会让 reviewer
    困惑"为什么有这个文件不用"
  - **建议**:在文件顶部 JSDoc 补一句"**本文件目前不参与运行时**，作为部署文档 / 字面量
    参考保留；实际 env 注入由 EdgeOne 控制台 `context.env` 完成"。或直接 `git rm` 删掉
    （安全角度无副作用）

## 已确认（PASS，符合预期）

- ✅ **P1 — `signParams` 签名算法符合 Z-Pay 规范**
  - `lib/zpay.js:21-32` —— 排序、排除规则、拼接格式、md5+KEY 小写输出全部正确
  - 测试覆盖 8 个 case（`lib/__tests__/zpay.test.js:24-91`）

- ✅ **P2 — `verifySign` 用白名单防御未来新增字段**
  - `lib/zpay.js:15-18` 定义 `ZPAY_CANONICAL_FIELDS` 白名单（11 个字段）
  - `lib/zpay.js:39-46` 先白名单过滤再 `signParams(rest, key)` 重算
  - 测试 `zpay.test.js:110-116` 显式断言"extra / sign_type 字段被忽略"
  - 这是 plan 没明确要求的安全加固，**值得保留**

- ✅ **P3 — `notify.ts` 验签失败返 400，阻止 Z-Pay 11 次重试**
  - `cloud-functions/api/pay/notify.ts:36-38` —— `verifySign === false` → 400 'sign error'
  - 测试 `notify.test.ts:145-158` 覆盖

- ✅ **P4 — `notify.ts` 金额不匹配返 400（不静默通过）**
  - `cloud-functions/api/pay/notify.ts:46-48` —— `markPaid === false` → 400 'amount mismatch'
  - 测试 `notify.test.ts:174-188` 覆盖

- ✅ **P5 — 重复通知幂等**：`alreadyPaid` 命中 → 200 'success'，不调 `markPaid`
  - `cloud-functions/api/pay/notify.ts:42-45` + 测试 `notify.test.ts:160-172`

- ✅ **P6 — 非 `TRADE_SUCCESS` 状态早 ack 200**
  - `cloud-functions/api/pay/notify.ts:39-41` + 测试 `notify.test.ts:190-203`
  - 防止 Z-Pay 中间态（WAIT_BUYER_PAY 等）反复重发

- ✅ **P7 — 响应是 plain text 'success'**，无 Content-Type / JSON 包装
  - `cloud-functions/api/pay/notify.ts:40, 44, 49` 全部用 `new Response('success')`
  - 测试 `notify.test.ts:113-116` 用 `.text()` 断言 `=== 'success'`

- ✅ **P8 — GET / POST 双 method 验签**（Z-Pay 文档不一致的兼容）
  - `cloud-functions/api/pay/notify.ts:52-58` —— `onRequestGet` + `onRequestPost` 转
    同一个 `handle`
  - 测试覆盖 GET + POST 两条路径（`notify.test.ts:106-143`）

- ✅ **P9 — `ZPAY_KEY` 绝不在 git 历史**：`git log --all -p | grep -iE 'zpay.*key|89unJUB'`
  无密钥字面量
  - 所有 `ZPAY_KEY` 出现都是**测试用的** mock 字面量（`'test-key-DO-NOT-LEAK'`）或
    **注释 / 文档** 提及
  - 真实 KEY 只能从 EdgeOne 控制台注入

- ✅ **P10 — `ZPAY_KEY` 绝不在前端 bundle**：`themes/starter/components/PayModal.js`
  全文件**零** `ZPAY_KEY` / `process.env` 引用
  - PayModal 只调 `/api/pay/query-order?outTradeNo=...`，KEY 由 Cloud Function 在后端
    拼上（`lib/zpay.js:92`），浏览器抓包只能看到 outTradeNo

- ✅ **P11 — `query-order.ts` 响应体白名单过滤**
  - `cloud-functions/api/pay/query-order.ts:20-25` —— 只显式列 `status / money / tradeNo / msg`
  - **没有** 用 `...data` spread（防 Z-Pay 未来加字段意外泄漏）
  - 测试 `query-order.test.ts:108-124` 显式断言 keys 严格等于 `['money', 'msg', 'status', 'tradeNo']`
  - 测试 `query-order.test.ts:192-212` 还断言"即使 lib 返回的对象里塞了 `ZPAY_KEY` /
    `secret: 'test-key-DO-NOT-LEAK'`，响应 JSON 也 grep 不到"——是 plan 明确要求的
    防御测试，**已实现**

- ✅ **P12 — `query-order.ts` 缺 outTradeNo 返 400（不是 500）**
  - `cloud-functions/api/pay/query-order.ts:13-18` —— 显式 `if (!outTradeNo) return 400`
  - 测试 `query-order.test.ts:169-190` 覆盖（含空字符串情况）

- ✅ **P13 — Cloud Function 用 `context.env` 注入**，不读 `process.env`
  - 4 个 Cloud Function 文件**零** `process.env` 引用
  - 测试 `zpay.test.js:256-286` 显式断言 "delete process.env.ZPAY_KEY 后用
    注入 env 仍能跑"
  - 避免构建期泄漏（如果用 `process.env` 会被 webpack inline 到前端 bundle）

- ✅ **P14 — `zpay.config.js` 顶部"不存 KEY"注释明确**
  - `zpay.config.js:1-10` 3 处强调"KEY 必须走 EdgeOne 控制台 env，绝对不要写进这里"
  - 实际只放了 `ZPAY_PID: '填你的商户ID'` 占位

- ✅ **P15 — 浮点容忍**：`Math.round(moneyYuan * 100) === rec.amountFen`
  - `lib/order-store.js:29` + 测试 `order-store.test.js:40-45` 显式覆盖 9.99 元
  - 0.10 → Math.round(0.10*100) = Math.round(10.0) = 10 = amountFen(10) ✓
  - 0.1 → Math.round(0.1*100) = Math.round(10.0) = 10 = amountFen(10) ✓
  - 边界: 0.005 → Math.round(0.5) = 0 (银行家舍入) 或 1 (四舍五入) — JS Math.round
    是后者，实际不会触发边界

- ✅ **P16 — 前端轮询 silent 失败 + 5min 自动停**
  - `themes/starter/components/PayModal.js:62-72` —— `try/catch` 静默吞
  - `themes/starter/components/PayModal.js:55-61` —— 5min 强制停

- ✅ **P17 — 前端不做金额校验，只显示**
  - PayModal 只展示 `order.imgUrl` 和 `priceYuan`，不参与支付决策

## 测试覆盖评估

**已覆盖**:
- `lib/__tests__/zpay.test.js` —— 17+ case 覆盖 `signParams` / `verifySign` /
  `createNativeOrder` / `queryOrder` 全部 4 个函数，含 KEY 注入失败、process.env
  清空防御、Z-Pay 错误响应、超额字段
- `lib/__tests__/order-store.test.js` —— 12+ case 覆盖 `recordOrder` / `markPaid` /
  `alreadyPaid` / TTL 惰性清理
- `cloud-functions/api/pay/__tests__/create-order.test.ts` —— 覆盖 4 场景（成功 /
  缺 env / 商品不存在 / Z-Pay 错误）
- `cloud-functions/api/pay/__tests__/notify.test.ts` —— 覆盖 GET/POST / 验签失败 /
  成功 / 重复 / 金额不匹配 / 非 TRADE_SUCCESS
- `cloud-functions/api/pay/__tests__/query-order.test.ts` —— 覆盖正常查询 / 缺
  outTradeNo / **KEY 泄漏防御**

**缺失 / 弱项**:
- **M1 [CRITICAL]**:没有任何 case 验证"`create-order.ts` 调用 `recordOrder`"——这是
  F1 的根因（见 FAIL 列表）
- M2:没有 `create-order` 失败时 `order-store` 状态的 case（Z-Pay 调通但 recordOrder
  失败怎么办?）
- M3:没有并发场景的 case（同一 outTradeNo 几乎同时到 notify 两次）
- M4:没有 `parseFloat(undefined)` 的 case（money 字段缺失场景）
- M5:`queryOrder` Z-Pay 不可达 / 返 HTML / 返非 JSON 的 case 缺失（W2 的根因）

## 上线前 checklist（给 lead agent 做 go/no-go）

- [ ] **F1 必修**: `create-order.ts` 加 `recordOrder(outTradeNo, product.price)` 调用
      （line ~46 后、`jsonResponse` 前）
- [ ] **F2 必修**: `create-order.test.ts` 加断言 `recordOrder` 被调用
- [ ] **D3 验证必跑**: `curl` 模拟 Z-Pay 回调 → 期望 200 'success'（不是 400 'amount
      mismatch'）。F1 没修这条必失败
- [ ] W2 建议修: `query-order.ts` 包 try/catch，失败返 `{status: 0}`
- [ ] W3 建议确认: 查 z-pay.cn 文档，clientip 字段是否必填
- [x] W4: `zpay.config.js` 已 `git rm`（commit: chore cleanup，ARCHITECTURE-payment.md 同步移除引用）
- [ ] 用户前置条件 1: EdgeOne 控制台**删** 6 个 WECHAT_* + BLOB_BOOTSTRAP_TOKEN，
      **加** ZPAY_PID / ZPAY_KEY / ZPAY_NOTIFY_URL
- [ ] 用户前置条件 2: EdgeOne 控制台**删** Blob bucket `wxpay-secrets`
- [ ] 用户前置条件 3: Z-Pay 商户后台填 `notify_url` = `https://<域名>/api/pay/notify`
      且**必须是 https**（WARN：当前代码不校验 https，需用户自查）
- [ ] 部署后 grep 验证：`grep -rn 'ZPAY_KEY\|89unJUB' .next/ out/ 2>/dev/null` 应零结果

## 评审统计

- FAIL 数量: **2**（F1 CRITICAL + F2 HIGH，但 F2 实质是 F1 的回归测试缺位）
- WARN 数量: **4**（W1 粘性 / W2 错误处理 / W3 clientip / W4 dead code）
- PASS 数量: **17**
- 评审范围 16 个 commit × 7 个关键文件 = 全面覆盖
- 报告行数: < 400（按要求）
