/**
 * Z-Pay 第四方支付 SDK 自封装（自写 MD5 签名 + form-data POST，零外部 HTTP 依赖）
 *
 * 兼容性：不读 process.env，不依赖 @/ 别名，env 由调用方注入（多 runtime 友好）。
 *
 * 算法：参数按 ASCII 升序排序，排除 sign / sign_type / 空值 / null，
 *      拼接为 a=b&c=d（不 URL 编码），md5(a=b&c=d + KEY)，小写。
 */

import crypto from 'crypto'
import { md5 } from 'js-md5'

// Z-Pay 回调的"规范字段"白名单 — verifySign 只对这些字段重算签名，
// 任何不在此集合的"额外"参数（如未来 Z-Pay 新增字段）都会被忽略。
// sign / sign_type 仍会保留在白名单里以便剔除，但 signParams 内部会再 exclude 一次。
const ZPAY_CANONICAL_FIELDS = new Set([
  'pid', 'type', 'out_trade_no', 'notify_url', 'name', 'money', 'clientip',
  'trade_status', 'trade_no', 'sign_type', 'sign'
])

/** 对参数生成 MD5 签名（小写 hex）。@param {Object} params @param {string} key @returns {string} */
export function signParams(params, key) {
  const pairs = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type')
    .filter(k => {
      const v = params[k]
      return v !== '' && v !== null && v !== undefined
    })
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&')
  return md5(pairs + key).toLowerCase()
}

/**
 * 验证回调签名：跟 signParams 同样算法重算比对。
 * 先用 ZPAY_CANONICAL_FIELDS 白名单过滤掉"额外"参数，再调用 signParams 重算。
 * @returns {boolean}
 */
export function verifySign(receivedParams, key) {
  if (!receivedParams || !receivedParams.sign) return false
  const canonical = Object.fromEntries(
    Object.entries(receivedParams).filter(([k]) => ZPAY_CANONICAL_FIELDS.has(k))
  )
  const { sign, ...rest } = canonical
  const expected = signParams(rest, key)
  const received = String(sign)
  if (expected.length !== received.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}

/**
 * Native 扫码下单：POST zpayz.cn/mapi.php，返回 {outTradeNo, tradeNo, qrcode, imgUrl, payurl}。
 * @param {{outTradeNo, name, money, notifyUrl, clientIp, env: {ZPAY_PID, ZPAY_KEY}}} args
 */
export async function createNativeOrder({ outTradeNo, name, money, notifyUrl, clientIp, env }) {
  const params = {
    pid: env.ZPAY_PID,
    type: 'wxpay',
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    name,
    money,
    clientip: clientIp,
    sign_type: 'MD5'
  }
  params.sign = signParams(params, env.ZPAY_KEY)

  const response = await fetch('https://zpayz.cn/mapi.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  })
  const data = await response.json()
  if (data.code !== 1) {
    throw new Error('zpay createOrder failed: ' + JSON.stringify(data))
  }
  return {
    outTradeNo: data.out_trade_no,
    tradeNo: data.trade_no,
    qrcode: data.qrcode,
    imgUrl: data.img,
    payurl: data.payurl
  }
}

/**
 * 查询订单状态：GET zpayz.cn/api.php，返回原始 Z-Pay 响应（含 status: 0|1）。
 * 注意：key 在 query string 里是 Z-Pay 官方设计，不要"修复"。
 * @param {{outTradeNo, env: {ZPAY_PID, ZPAY_KEY}}} args
 */
export async function queryOrder({ outTradeNo, env }) {
  const url = new URL('https://zpayz.cn/api.php')
  url.searchParams.set('act', 'order')
  url.searchParams.set('pid', env.ZPAY_PID)
  url.searchParams.set('key', env.ZPAY_KEY)
  url.searchParams.set('out_trade_no', outTradeNo)
  const response = await fetch(url.toString(), { method: 'GET' })
  return response.json()
}
