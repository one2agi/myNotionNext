/**
 * 微信支付 V3 配置（5 个非敏感值）
 *
 * ⚠️ 这个文件会进 git（仓库 https://github.com/one2agi/myNotionNext 是 public），
 *    所以只放非敏感值。WECHAT_PRIVATE_KEY 仍然走环境变量（Vercel dashboard），
 *    绝对不要写进这里。
 *
 * 优先级：process.env.X  >  本文件的字面量
 * 也就是说：在 Vercel dashboard 配了 env 就会覆盖这里的字面量值。
 */
module.exports = {
  WECHAT_APPID: 'wx48104c8e7b1e95a3',
  WECHAT_MCHID: '1744324644',
  WECHAT_SERIAL_NO: '2F2D5CC0E9CAEB3394F8B58320F06DB2F0B3C62D',
  WECHAT_NOTIFY_URL: 'https://example.com/notify',
  WECHAT_API_V3_KEY: 'RYh7A1vDXIYOkycrKRMgdfSNAN6od2am'
}
