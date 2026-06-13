# 支付系统 API 接口规格（PAYMENT-API-SPEC.md）

> 📋 **目的**：详细记录支付系统所有 API 的请求/响应格式、字段、错误码
> **配合文档**：`PAYMENT-ARCHITECTURE.md`（架构设计）
> **Z-Pay 文档**：https://member.z-pay.cn/member/doc.html

---

## 1. 概述

### 1.1 基础信息

| 项目 | 值 |
|------|-----|
| 基础路径 | `https://www.one2agi.com/api/pay` |
| 编码 | UTF-8 |
| Content-Type | `application/json` |
| Z-Pay 提交URL | `https://z-pay.cn/submit.php` |
| Z-Pay 文档 | https://member.z-pay.cn/member/doc.html（需登录） |

### 1.2 通用响应格式

**成功**：
```json
{
  "code": 0,
  "message": "success",
  "data": { ... }
}
```

**失败**：
```json
{
  "code": 40001,
  "message": "E_NAME_EMPTY",
  "data": null
}
```

### 1.3 通用错误码

| code | message | 说明 |
|------|---------|------|
| 0 | success | 成功 |
| 40001 | E_NAME_EMPTY | 姓名为空 |
| 40002 | E_NAME_TOO_LONG | 姓名超过 50 字符 |
| 40003 | E_EMAIL_INVALID | 邮箱格式错误 |
| 40004 | E_DC_NOT_FOUND | 优惠码不存在 |
| 40005 | E_DC_DISABLED | 优惠码未启用 |
| 40006 | E_DC_AMOUNT_INVALID | 折扣后金额 < 0 |
| 40007 | E_DC_FORMAT_INVALID | 优惠码格式错误（A-Z0-9-，6-20字符） |
| 40008 | E_PRODUCT_NOT_FOUND | 商品不存在 |
| 40009 | E_ZPAY_FAIL | Z-Pay 下单失败 |
| 40010 | E_NOTION_FAIL | Notion 查询失败 |
| 40011 | E_ORDER_NOT_FOUND | 订单不存在（fallback 查 Notion 也找不到） |
| 50001 | E_INTERNAL | 服务器内部错误 |

---

## 2. `POST /api/pay/create-order`

### 2.1 功能

创建支付订单，返回微信支付二维码。

### 2.2 请求

```json
{
  "productId": "starter-full",
  "customer": {
    "name": "张三",
    "email": "test@example.com"
  },
  "discountCode": "DFDSA26"
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| productId | string | ✅ | 商品 ID，对应 products.config.js 中的 key |
| customer.name | string | ✅ | 客户姓名，1-50 字符，trim 后验证 |
| customer.email | string | ✅ | 客户邮箱，RFC5322 简化版正则 |
| discountCode | string | ❌ | 优惠码，A-Z0-9-，6-20字符；留空 = 无优惠 |

### 2.3 处理流程

```
1. 参数校验（name、email、discountCode 格式）
2. 若有 discountCode → 查询 Notion 优惠码 DB
   - 查不到 → E_DC_NOT_FOUND
   - 未启用（启用优惠码 != true）→ E_DC_DISABLED
   - 折扣后金额 finalPrice < 0 → E_DC_AMOUNT_INVALID
3. 计算 finalPrice = totalPrice - 减免金额
4. 生成 outTradeNo（时间戳 + 随机字符串）
5. 记录 order-store[outTradeNo] = { ..., discountCode, finalPrice, paid: false }
6. POST Z-Pay submit.php 下单
7. POST n8n /webhook/create-order（携带完整 order info）
8. 返回 qrcode
```

### 2.4 成功响应（200）

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "outTradeNo": "1750000000000-abc123",
    "qrcode": "weixin://wxpay/bizpayurl?pr=xxx",
    "imgUrl": "https://z-payz.cn/qrcode/xxx.jpg",
    "productId": "starter-full",
    "productName": "基础版",
    "totalPrice": 79,
    "discountAmount": 10,
    "finalPrice": 69,
    "unit": "元"
  }
}
```

**data 字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| outTradeNo | string | 订单号（唯一），格式：时间戳-随机字符串 |
| qrcode | string | 微信支付链接（扫码支付） |
| imgUrl | string | 二维码图片 URL（可选） |
| productId | string | 商品 ID |
| productName | string | 商品名称 |
| totalPrice | number | 商品原价（元） |
| discountAmount | number | 减免金额（元），无优惠时为 0 |
| finalPrice | number | 最终支付金额（元） |
| unit | string | 固定值 "元" |

### 2.5 失败响应（400/500）

```json
{
  "code": 40009,
  "message": "E_ZPAY_FAIL",
  "data": {
    "error": "Z-Pay 接口返回错误",
    "detail": "..."
  }
}
```

---

## 3. `GET /api/pay/notify`

### 3.1 功能

Z-Pay 异步回调，通知支付结果。

### 3.2 请求（Z-Pay 服务器 GET）

```
GET /api/pay/notify?pid=2026050116254529&trade_no=2024061400000001&out_trade_no=1750000000000-abc123&type=wxpay&name=%E5%95%86%E5%93%81%E5%90%8D&money=69.00&trade_status=TRADE_SUCCESS&sign=abc123&sign_type=MD5
```

**Z-Pay 回调参数说明**：

| 参数 | 说明 |
|------|------|
| pid | 商户 ID（ZPAY_PID） |
| trade_no | Z-Pay 交易流水号 |
| out_trade_no | 商户订单号（我们生成的那个） |
| type | 支付方式（wxpay / alipay 等） |
| name | 商品名称（URL 编码） |
| money | 支付金额（**单位：元**，字符串） |
| trade_status | 交易状态：TRADE_SUCCESS / WAIT_BUYER_PAY / TRADE_CLOSED |
| sign | MD5 签名 |
| sign_type | 签名类型（MD5） |

**trade_status 值**：

| 值 | 含义 | 处理 |
|------|------|------|
| TRADE_SUCCESS | 支付成功 | 处理回调 |
| WAIT_BUYER_PAY | 待支付 | 早 ack `success` |
| TRADE_CLOSED | 交易关闭 | 早 ack `success` |
| TRADE_FINISHED | 已结束 | 早 ack `success` |

### 3.3 签名算法（MD5）

```javascript
// Step 1: 收集所有参数，排除 sign、sign_type、 空值
// Step 2: 按 key ASCII 排序
// Step 3: 拼接成 key1=val1&key2=val2... 格式（不加分隔符）
// Step 4: MD5(prestr + KEY)，小写 hex
// Step 5: 对比 sign
```

### 3.4 处理流程

```
1. 提取所有 GET 参数
2. MD5 验签（timingSafeEqual 防时序攻击）
   - 验签失败 → return "sign error"（400），阻止 Z-Pay 重试
3. 若 trade_status != TRADE_SUCCESS → return "success"（早 ack）
4. 金额校验：
   - 先查 order-store[out_trade_no]
     → 有：用 stored finalPrice 校验 money == finalPrice
     → 无：查 Notion 订单 DB（fallback）
       → 有：用 DB 里的金额字段校验
       → 无：return "order not found"（500）
   - 金额不匹配 → return "amount mismatch"（400）
5. 若 order 已 paid → 幂等 return "success"
6. markPaid（标记 order-store[out_trade_no].paid = true）
7. POST n8n /webhook/notify（携带 outTradeNo + paidAmount + discountCode）
8. return "success"
```

### 3.5 响应

| HTTP 状态 | 返回内容 | 含义 |
|-----------|----------|------|
| 200 | `success` | 通知成功 |
| 400 | `sign error` | 验签失败 |
| 400 | `amount mismatch` | 金额校验失败 |
| 500 | `order not found` | order-store 和 Notion 都找不到订单 |

**注意**：响应格式是 **纯文本**，不是 JSON。

```
Content-Type: text/plain; charset=utf-8
```

---

## 4. Z-Pay 下单参数映射

### 4.1 EdgeOne → Z-Pay

EdgeOne 调用 `POST https://z-pay.cn/submit.php` 时，构造以下参数：

| Z-Pay 参数 | 来源 | 示例 |
|-----------|------|------|
| pid | env.ZPAY_PID | 2026050116254529 |
| money | finalPrice（元，字符串） | "69.00" |
| name | productName（URL 编码） | "%E5%9F%BA%E7%A1%80%E7%89%88" |
| notify_url | env.ZPAY_NOTIFY_URL | https://www.one2agi.com/api/pay/notify |
| out_trade_no | 生成（时间戳-随机字符串） | "1750000000000-abc123" |
| return_url | 固定 | https://www.one2agi.com |
| sitename | 固定 | one2agi |
| type | 固定 | wxpay（微信 Native） |
| sign | 动态计算 | 见签名算法 |

### 4.2 Z-Pay 响应

Z-Pay 不返回 JSON，而是**直接重定向到二维码页面**。

前端拿到的是 `https://z-pay.cn/submit.php?{params}&sign=...`，浏览器访问后看到二维码。

create-order 需要从 Z-Pay 返回的 HTML/URL 中提取二维码链接，或者让 Z-Pay 返回 JSON（需联系 Z-Pay 开通）。

---

## 5. n8n Webhook Payload

### 5.1 create-order webhook

**URL**：`https://n8n.one2agi.com/webhook/create-order`
**方法**：POST

```json
{
  "outTradeNo": "1750000000000-abc123",
  "productId": "starter-full",
  "productName": "基础版",
  "customerName": "张三",
  "customerEmail": "test@example.com",
  "totalPrice": 79,
  "discountCode": "DFDSA26",
  "discountAmount": 10,
  "finalPrice": 69,
  "unit": "元",
  "createdAt": "2026-06-14"
}
```

### 5.2 notify webhook

**URL**：`https://n8n.one2agi.com/webhook/notify`
**方法**：POST

```json
{
  "outTradeNo": "1750000000000-abc123",
  "paidAmount": 69,
  "paidAt": "2026-06-14",
  "discountCode": "DFDSA26"
}
```

---

## 6. 商品配置（products.config.js）

```javascript
// lib/products.config.js
const PRODUCTS = {
  'starter-full': {
    name: '基础版',
    price: 79, // 单位：元（注意：之前是分，统一改为元后需同步更新这里）
  },
  'pro-full': {
    name: '专业版',
    price: 299,
  }
}
```

**注意**：价格单位是**元**，与折扣金额单位一致。

---

## 7. 环境变量清单

| 变量名 | 说明 | 示例 |
|--------|------|------|
| ZPAY_PID | Z-Pay 商户 ID | 2026050116254529 |
| ZPAY_KEY | Z-Pay 签名密钥 | FFOiGaR1bNuOzVtHcUFYjfQ97VKH5ieP |
| ZPAY_NOTIFY_URL | 回调地址 | https://www.one2agi.com/api/pay/notify |
| NOTION_TOKEN | Notion API Token | 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 |
| NOTION_DATABASE_ID | 订单数据库 ID | 6ab4f4cf-c8e2-825e-bde8-016c2d9be1c2 |
| NOTION_DISCOUNT_DATABASE_ID | 优惠码数据库 ID | 37e4f4cf-c8e2-8073-aea5-f390b5b2c53d |
| N8N_WEBHOOK_URL | n8n Webhook 基础 URL | https://n8n.one2agi.com/webhook |
| N8N_WEBHOOK_SECRET | n8n Webhook 鉴权 Secret | 67e7993eb338e4911cfad0d3328eba1afe2112c2365a294224baaa9adab5b411 |

---

## 8. Notion 数据库字段

### 8.1 订单数据库

| 字段名 | Notion 类型 | 说明 |
|--------|------------|------|
| Name | title | 客户姓名 |
| 客户邮箱 | email | 客户邮箱 |
| 购买日期 | date | 支付成功日期（notify 时写入） |
| 状态 | status | "待发送" / "已发送" / "已取消" |
| 订单号 | rich_text | outTradeNo |
| 商品名 | rich_text | 产品名称 |
| 金额 | number | 实际支付金额（元） |

**Database ID**：`6ab4f4cf-c8e2-825e-bde8-016c2d9be1c2`

### 8.2 优惠码数据库

| 字段名 | Notion 类型 | 说明 |
|--------|------------|------|
| 达人名称 | title | 合作伙伴名称 |
| 优惠码 | rich_text | 优惠码代码 |
| 启用优惠码 | checkbox | 打勾 = 启用 |
| 减免金额 | number | 固定减免金额，**单位元** |
| 使用次数 | number | 使用计数器 |

**Database ID**：`37e4f4cf-c8e2-8073-aea5-f390b5b2c53d`

---

## 9. 附录：Z-Pay 签名实现参考

```javascript
// Node.js / EdgeOne 签名
const crypto = require('crypto')

function signZPay(params, key) {
  // 1. 过滤空值和 sign/sign_type
  const filtered = Object.entries(params)
    .filter(([k, v]) => v !== undefined && v !== '' && k !== 'sign' && k !== 'sign_type')
    .sort(([a], [b]) => a.localeCompare(b))

  // 2. 拼接成 key=val&key=val...
  const prestr = filtered.map(([k, v]) => `${k}=${v}`).join('&')

  // 3. MD5(prestr + key)，小写
  return crypto.createHash('md5').update(prestr + key, 'utf8').digest('hex')
}

function verifyZPay(params, key) {
  const receivedSign = params.sign
  const calculatedSign = signZPay(params, key)
  return crypto.timingSafeEqual(
    Buffer.from(receivedSign, 'utf8'),
    Buffer.from(calculatedSign, 'utf8')
  )
}
```