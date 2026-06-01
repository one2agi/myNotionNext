/**
 * 微信支付 V3 自封装（自写签名，零外部依赖）
 *
 * 适用场景：MVP 阶段只调「Native 扫码下单」一个接口。
 * 后续如需回调解密、查单、退款，按同样模式补函数即可。
 *
 * 环境变量（必读 process.env）：
 * - WECHAT_APPID               公众号/小程序/开放平台 appid
 * - WECHAT_MCHID               商户号
 * - WECHAT_SERIAL_NO           商户 API 证书序列号（apiclient_cert.pem 的 serial）
 * - WECHAT_PRIVATE_KEY         商户 API 私钥的 PEM 字符串（生产环境推荐）
 * - WECHAT_PRIVATE_KEY_PATH    商户 API 私钥文件绝对路径（本地开发用）
 *   ⚠️ 两选一：WECHAT_PRIVATE_KEY 优先；都没有则启动期报错。
 * - WECHAT_API_V3_KEY          32 字节 APIv3 密钥（本 MVP 不使用，留作回调时用）
 */
import crypto from 'crypto'
import fs from 'fs'
import wechatpayConfig from '@/wechatpay.config'

const MCHID = process.env.WECHAT_MCHID || wechatpayConfig.WECHAT_MCHID
const APPID = process.env.WECHAT_APPID || wechatpayConfig.WECHAT_APPID
const SERIAL_NO = process.env.WECHAT_SERIAL_NO || wechatpayConfig.WECHAT_SERIAL_NO
const PRIVATE_KEY = process.env.WECHAT_PRIVATE_KEY
const PRIVATE_KEY_PATH = process.env.WECHAT_PRIVATE_KEY_PATH

/**
 * 校验必要的环境变量在启动期就存在。
 * 任一缺失直接抛错，避免请求飞出去再 401。
 */
function assertEnv() {
  const missing = []
  if (!MCHID) missing.push('WECHAT_MCHID')
  if (!APPID) missing.push('WECHAT_APPID')
  if (!SERIAL_NO) missing.push('WECHAT_SERIAL_NO')
  if (!PRIVATE_KEY && !PRIVATE_KEY_PATH) {
    missing.push('WECHAT_PRIVATE_KEY 或 WECHAT_PRIVATE_KEY_PATH')
  }
  if (missing.length) {
    throw new Error(`wechatpay: missing env vars: ${missing.join(', ')}`)
  }
}

/**
 * 读取商户私钥（优先 env 字符串，回退到文件路径）。
 */
function loadPrivateKey() {
  if (PRIVATE_KEY) {
    return crypto.createPrivateKey(PRIVATE_KEY)
  }
  return crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_PATH))
}

/**
 * 用商户私钥对 (method, url, ts, nonce, body) 做 RSA-SHA256 签名
 * 返回可直接放进 Authorization 请求头的字符串。
 */
function buildAuthorization(method, urlPath, body) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomBytes(16).toString('hex')
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(message), loadPrivateKey())
    .toString('base64')
  return {
    header:
      `WECHATPAY2-SHA256-RSA2048 ` +
      `mchid="${MCHID}",` +
      `nonce_str="${nonce}",` +
      `signature="${signature}",` +
      `timestamp="${ts}",` +
      `serial_no="${SERIAL_NO}"`,
    ts,
    nonce
  }
}

/**
 * Native 扫码下单
 * @param {Object} params
 * @param {string} params.outTradeNo   商户订单号（自行生成，全局唯一）
 * @param {string} params.description  商品/交易描述（≤127 字符）
 * @param {number} params.totalFen     金额（**分**整数）
 * @param {string} params.notifyUrl    支付回调 URL（MVP 占位即可）
 * @returns {Promise<{outTradeNo: string, codeUrl: string}>}
 */
export async function createNativeOrder({ outTradeNo, description, totalFen, notifyUrl }) {
  assertEnv()

  if (!Number.isInteger(totalFen) || totalFen <= 0) {
    throw new Error(`wechatpay: totalFen must be positive integer, got ${totalFen}`)
  }
  if (!outTradeNo) throw new Error('wechatpay: outTradeNo required')
  if (!description) throw new Error('wechatpay: description required')

  const urlPath = '/v3/pay/transactions/native'
  const body = JSON.stringify({
    appid: APPID,
    mchid: MCHID,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: totalFen, currency: 'CNY' }
  })

  const { header: authorization } = buildAuthorization('POST', urlPath, body)

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
