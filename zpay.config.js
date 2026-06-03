/**
 * Z-Pay 第四方聚合支付配置（仅非敏感值）
 *
 * ⚠️ 本仓库是 public（https://github.com/one2agi/myNotionNext），本文件会进 git。
 *    所以只放非敏感值（ZPAY_PID 占位）。ZPAY_KEY 必须走 EdgeOne 控制台 env，
 *    绝对不要写进这里。
 *
 * 优先级：process.env.X  >  本文件的字面量
 * 也就是说：在 EdgeOne 控制台配了 env 就会覆盖这里的字面量值。
 */
module.exports = {
  ZPAY_PID: '填你的商户ID'
}
