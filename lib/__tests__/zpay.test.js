/**
 * Z-Pay SDK 自封装 — 单元测试
 *
 * 测试策略：
 * 1. signParams / verifySign — 纯函数，无副作用，直接断言字符串
 * 2. createNativeOrder / queryOrder — 注入 mock fetch，断言 URL/headers/body/响应映射
 *
 * 关键约束（lib/zpay.js 必须遵守）：
 * - 完全不读 process.env，所有 env 由调用方注入
 * - 签名排除 sign / sign_type / 空值 / null
 * - 签名按参数名 ASCII 升序，不做 URL 编码
 */

import { md5 } from 'js-md5'
import {
  signParams,
  verifySign,
  createNativeOrder,
  queryOrder
} from '@/lib/zpay'

const ENV = { ZPAY_PID: '12345', ZPAY_KEY: 'secret-key-abc' }

describe('signParams', () => {
  it('sorts params alphabetically (a-z) and concatenates as key=value&...', () => {
    // 故意乱序传入，期望按字母序排
    const result = signParams(
      { type: 'wxpay', money: '0.10', out_trade_no: 'abc123', pid: '100' },
      'KEY'
    )
    // 期望：money=0.10&out_trade_no=abc123&pid=100&type=wxpay + KEY
    // 签名 = md5("money=0.10&out_trade_no=abc123&pid=100&type=wxpayKEY")
    const expected = md5('money=0.10&out_trade_no=abc123&pid=100&type=wxpayKEY')
    expect(result).toBe(expected)
    expect(result).toBe(result.toLowerCase()) // 必须小写
  })

  it('excludes the sign field from the signature input', () => {
    const withSign = signParams(
      { pid: '100', money: '0.1', sign: 'WRONG_SIGN_TO_BE_EXCLUDED' },
      'KEY'
    )
    const withoutSign = signParams({ pid: '100', money: '0.1' }, 'KEY')
    expect(withSign).toBe(withoutSign)
  })

  it('excludes the sign_type field from the signature input', () => {
    const withSignType = signParams(
      { pid: '100', money: '0.1', sign_type: 'MD5' },
      'KEY'
    )
    const withoutSignType = signParams({ pid: '100', money: '0.1' }, 'KEY')
    expect(withSignType).toBe(withoutSignType)
  })

  it('excludes empty string values', () => {
    const withEmpty = signParams(
      { pid: '100', money: '0.1', name: '' },
      'KEY'
    )
    const withoutEmpty = signParams({ pid: '100', money: '0.1' }, 'KEY')
    expect(withEmpty).toBe(withoutEmpty)
  })

  it('excludes null and undefined values', () => {
    const withNulls = signParams(
      { pid: '100', money: '0.1', name: null, type: undefined },
      'KEY'
    )
    const withoutNulls = signParams({ pid: '100', money: '0.1' }, 'KEY')
    expect(withNulls).toBe(withoutNulls)
  })

  it('produces a deterministic 32-character lowercase hex string', () => {
    const result = signParams({ pid: '100', money: '0.1' }, 'KEY')
    expect(result).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is order-independent — different input order produces the same signature', () => {
    const a = signParams({ pid: '100', type: 'wxpay', money: '0.1', name: 'test' }, 'KEY')
    const b = signParams({ name: 'test', money: '0.1', type: 'wxpay', pid: '100' }, 'KEY')
    expect(a).toBe(b)
  })

  it('is case-sensitive on values but not on keys (keys are already normalized)', () => {
    // 不同 value 大小写 → 不同签名
    const a = signParams({ pid: '100', name: 'Test' }, 'KEY')
    const b = signParams({ pid: '100', name: 'test' }, 'KEY')
    expect(a).not.toBe(b)
  })
})

describe('verifySign', () => {
  it('returns true when receivedParams.sign matches the recomputed signature', () => {
    const params = { pid: '100', money: '0.1', type: 'wxpay' }
    const sign = signParams(params, 'KEY')
    expect(verifySign({ ...params, sign }, 'KEY')).toBe(true)
  })

  it('returns false when receivedParams.sign is wrong', () => {
    const params = { pid: '100', money: '0.1', sign: 'badbadbadbadbadbadbadbadbadb' }
    expect(verifySign(params, 'KEY')).toBe(false)
  })

  it('returns false when sign field is missing', () => {
    const params = { pid: '100', money: '0.1' }
    expect(verifySign(params, 'KEY')).toBe(false)
  })

  it('ignores extra fields (e.g. sign_type) — only the canonical fields matter', () => {
    const params = { pid: '100', money: '0.1', type: 'wxpay' }
    const sign = signParams(params, 'KEY')
    // 添加多余字段（包括 sign_type）
    const received = { ...params, sign, sign_type: 'MD5', extra: 'ignored' }
    expect(verifySign(received, 'KEY')).toBe(true)
  })

  it('returns false when the KEY is wrong (signatures are key-bound)', () => {
    const params = { pid: '100', money: '0.1' }
    const sign = signParams(params, 'KEY')
    // 用不同的 key 验证 → false
    expect(verifySign({ ...params, sign }, 'OTHER_KEY')).toBe(false)
  })
})

describe('createNativeOrder', () => {
  beforeEach(() => {
    // 每个测试前显式重置 fetch mock 的实现（clearMocks+restoreMocks 配置已部分处理，
    // 但 mockReset 更稳，确保上一个测试的 mockResolvedValue 不残留）
    fetch.mockReset()
  })

  it('returns mapped fields on success (code=1)', async () => {
    const zpayResponse = {
      code: 1,
      msg: 'success',
      trade_no: 'ZPAY_TRADE_999',
      out_trade_no: 'order-001',
      qrcode: 'weixin://wxpay/bizpayurl?pr=xxx',
      img: 'https://zpayz.cn/qrcode/xxx.jpg',
      payurl: 'https://zpayz.cn/pay/xxx'
    }
    fetch.mockResolvedValueOnce({
      json: () => Promise.resolve(zpayResponse)
    })

    const result = await createNativeOrder({
      outTradeNo: 'order-001',
      name: '知行合一 · 完整版',
      money: '0.10',
      notifyUrl: 'https://example.com/api/pay/notify',
      clientIp: '1.2.3.4',
      env: ENV
    })

    expect(result).toEqual({
      outTradeNo: 'order-001',
      tradeNo: 'ZPAY_TRADE_999',
      qrcode: 'weixin://wxpay/bizpayurl?pr=xxx',
      imgUrl: 'https://zpayz.cn/qrcode/xxx.jpg',
      payurl: 'https://zpayz.cn/pay/xxx'
    })
  })

  it('throws on failure (code=0) with the full response in the error message', async () => {
    const zpayResponse = { code: 0, msg: 'invalid pid' }
    fetch.mockResolvedValueOnce({
      json: () => Promise.resolve(zpayResponse)
    })

    await expect(
      createNativeOrder({
        outTradeNo: 'order-002',
        name: 'test',
        money: '0.10',
        notifyUrl: 'https://example.com/notify',
        clientIp: '1.2.3.4',
        env: ENV
      })
    ).rejects.toThrow(/zpay createOrder failed.*invalid pid/)
  })

  it('POSTs to https://zpayz.cn/mapi.php', async () => {
    fetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 1, trade_no: 't', out_trade_no: 'o', qrcode: 'q', img: 'i', payurl: 'p' })
    })

    await createNativeOrder({
      outTradeNo: 'o',
      name: 'n',
      money: '0.1',
      notifyUrl: 'https://x.com/n',
      clientIp: '1.1.1.1',
      env: ENV
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url] = fetch.mock.calls[0]
    expect(url).toBe('https://zpayz.cn/mapi.php')
  })

  it('uses POST method and form-urlencoded Content-Type', async () => {
    fetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 1, trade_no: 't', out_trade_no: 'o', qrcode: 'q', img: 'i', payurl: 'p' })
    })

    await createNativeOrder({
      outTradeNo: 'o',
      name: 'n',
      money: '0.1',
      notifyUrl: 'https://x.com/n',
      clientIp: '1.1.1.1',
      env: ENV
    })

    const [, init] = fetch.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  it('sends all required fields with correct values and a valid signature in the body', async () => {
    fetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 1, trade_no: 't', out_trade_no: 'o', qrcode: 'q', img: 'i', payurl: 'p' })
    })

    await createNativeOrder({
      outTradeNo: 'order-XYZ',
      name: 'product-name',
      money: '0.10',
      notifyUrl: 'https://example.com/notify',
      clientIp: '5.6.7.8',
      env: ENV
    })

    const [, init] = fetch.mock.calls[0]
    const body = init.body
    expect(typeof body).toBe('string')

    // 必填参数
    expect(body).toContain('pid=12345')
    expect(body).toContain('type=wxpay')
    expect(body).toContain('out_trade_no=order-XYZ')
    expect(body).toContain('notify_url=https%3A%2F%2Fexample.com%2Fnotify') // form-urlencoded 会编码
    expect(body).toContain('name=product-name')
    expect(body).toContain('money=0.10')
    expect(body).toContain('clientip=5.6.7.8')
    expect(body).toContain('sign_type=MD5')

    // 签名：从 body 里抽出 sign 字段，手工重算，验证一致
    const params = Object.fromEntries(new URLSearchParams(body))
    const { sign, ...rest } = params
    const expectedSign = signParams(rest, ENV.ZPAY_KEY)
    expect(sign).toBe(expectedSign)
  })

  it('does NOT read process.env (injected env is the only source of pid/key)', async () => {
    // 临时清空 process.env 上的 ZPAY_*（确保没有 fallback）
    const originalPid = process.env.ZPAY_PID
    const originalKey = process.env.ZPAY_KEY
    delete process.env.ZPAY_PID
    delete process.env.ZPAY_KEY

    try {
      fetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ code: 1, trade_no: 't', out_trade_no: 'o', qrcode: 'q', img: 'i', payurl: 'p' })
      })

      // 注入一个跟 env 完全不同的 pid，确保请求 body 用的是注入值
      const injectedEnv = { ZPAY_PID: 'INJECTED_PID', ZPAY_KEY: 'INJECTED_KEY' }
      await createNativeOrder({
        outTradeNo: 'o',
        name: 'n',
        money: '0.1',
        notifyUrl: 'https://x.com/n',
        clientIp: '1.1.1.1',
        env: injectedEnv
      })

      const [, init] = fetch.mock.calls[0]
      expect(init.body).toContain('pid=INJECTED_PID')
    } finally {
      // 恢复（不污染其他测试）
      if (originalPid !== undefined) process.env.ZPAY_PID = originalPid
      if (originalKey !== undefined) process.env.ZPAY_KEY = originalKey
    }
  })
})

describe('queryOrder', () => {
  beforeEach(() => {
    fetch.mockReset()
  })

  it('returns the raw Z-Pay response (no field mapping)', async () => {
    const zpayResponse = {
      code: 1,
      msg: 'success',
      trade_no: 'ZPAY_TRADE_111',
      out_trade_no: 'order-100',
      status: 1, // 1 = paid
      money: '0.10',
      type: 'wxpay'
    }
    fetch.mockResolvedValueOnce({
      json: () => Promise.resolve(zpayResponse)
    })

    const result = await queryOrder({ outTradeNo: 'order-100', env: ENV })
    expect(result).toEqual(zpayResponse)
  })

  it('GETs the right URL with act=order, pid, key, and out_trade_no', async () => {
    fetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 1, status: 0 })
    })

    await queryOrder({ outTradeNo: 'order-200', env: ENV })

    const [url] = fetch.mock.calls[0]
    expect(url).toContain('https://zpayz.cn/api.php')
    expect(url).toContain('act=order')
    expect(url).toContain('pid=12345')
    // Z-Pay 设计上 key 在 query string 里（不是 bug，是 spec）
    expect(url).toContain('key=secret-key-abc')
    expect(url).toContain('out_trade_no=order-200')
  })

  it('uses GET method', async () => {
    fetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 1, status: 0 })
    })

    await queryOrder({ outTradeNo: 'order-300', env: ENV })

    const [, init] = fetch.mock.calls[0]
    // init 可能为 undefined（GET 请求无 body），如果有 method 字段则必须是 GET
    const method = init?.method ?? 'GET'
    expect(method).toBe('GET')
  })
})
