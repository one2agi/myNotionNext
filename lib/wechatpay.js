/**
 * 微信支付 V3 自封装（自写签名，零外部依赖）
 *
 * 适用场景：MVP 阶段只调「Native 扫码下单」一个接口。
 * 后续如需回调解密、查单、退款，按同样模式补函数即可。
 *
 * 兼容性设计：
 * - **不读 process.env**——兼容 Cloud Functions（Vercel 进程 / EdgeOne Pages Functions / Workers 等）
 * - **不依赖 `@/` 别名**——兼容任何构建系统
 * - 调用方负责传入 env 对象（包含 WECHAT_APPID / MCHID / SERIAL_NO / PRIVATE_KEY / NOTIFY_URL / API_V3_KEY）
 *
 * @typedef {Object} WxPayEnv
 * @property {string} WECHAT_APPID
 * @property {string} WECHAT_MCHID
 * @property {string} WECHAT_SERIAL_NO
 * @property {string} [WECHAT_PRIVATE_KEY]    PEM 字符串（生产推荐）
 * @property {string} [WECHAT_PRIVATE_KEY_PATH] 文件路径（本地 dev 用）
 * @property {string} WECHAT_NOTIFY_URL
 * @property {string} WECHAT_API_V3_KEY
 */
import crypto from 'crypto'
import fs from 'fs'

/**
 * 校验 env 完整性，任一缺失抛错。
 */
function assertEnv(env) {
  const missing = []
  if (!env.WECHAT_MCHID) missing.push('WECHAT_MCHID')
  if (!env.WECHAT_APPID) missing.push('WECHAT_APPID')
  if (!env.WECHAT_SERIAL_NO) missing.push('WECHAT_SERIAL_NO')
  if (!env.WECHAT_PRIVATE_KEY && !env.WECHAT_PRIVATE_KEY_PATH) {
    missing.push('WECHAT_PRIVATE_KEY 或 WECHAT_PRIVATE_KEY_PATH')
  }
  if (missing.length) {
    throw new Error(`wechatpay: missing env vars: ${missing.join(', ')}`)
  }
}

/**
 * 读取商户私钥（优先 env 字符串，回退到文件路径）。
 */
function loadPrivateKey(env) {
  if (env.WECHAT_PRIVATE_KEY) {
    return crypto.createPrivateKey(env.WECHAT_PRIVATE_KEY)
  }
  return crypto.createPrivateKey(fs.readFileSync(env.WECHAT_PRIVATE_KEY_PATH))
}

/**
 * 用商户私钥对 (method, url, ts, nonce, body) 做 RSA-SHA256 签名
 * 返回可直接放进 Authorization 请求头的字符串。
 */
function buildAuthorization(env, method, urlPath, body) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomBytes(16).toString('hex')
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(message), loadPrivateKey(env))
    .toString('base64')
  return {
    header:
      `WECHATPAY2-SHA256-RSA2048 ` +
      `mchid="${env.WECHAT_MCHID}",` +
      `nonce_str="${nonce}",` +
      `signature="${signature}",` +
      `timestamp="${ts}",` +
      `serial_no="${env.WECHAT_SERIAL_NO}"`,
    ts,
    nonce
  }
}

/**
 * Native 扫码下单
 * @param {Object} params
 * @param {string} params.outTradeNo    商户订单号（自行生成，全局唯一）
 * @param {string} params.description   商品/交易描述（≤127 字符）
 * @param {number} params.totalFen      金额（**分**整数）
 * @param {string} params.notifyUrl     支付回调 URL
 * @param {WxPayEnv} params.env        微信支付环境变量（必传）
 * @returns {Promise<{outTradeNo: string, codeUrl: string}>}
 */
export async function createNativeOrder({ outTradeNo, description, totalFen, notifyUrl, env }) {
  assertEnv(env)

  if (!Number.isInteger(totalFen) || totalFen <= 0) {
    throw new Error(`wechatpay: totalFen must be positive integer, got ${totalFen}`)
  }
  if (!outTradeNo) throw new Error('wechatpay: outTradeNo required')
  if (!description) throw new Error('wechatpay: description required')

  const urlPath = '/v3/pay/transactions/native'
  const body = JSON.stringify({
    appid: env.WECHAT_APPID,
    mchid: env.WECHAT_MCHID,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: totalFen, currency: 'CNY' }
  })

  const { header: authorization } = buildAuthorization(env, 'POST', urlPath, body)

  const response = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authorization
    },
    body
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`wechat createNativeOrder failed: ${response.status} ${text}`)
  }
  const data = JSON.parse(text)
  if (!data.code_url) {
    throw new Error(`wechat response no code_url: ${text}`)
  }
  return { outTradeNo, codeUrl: data.code_url }
}
