/**
 * themes/starter/components/__tests__/PayModal.test.js
 *
 * TDD 测试 — PayModal 改用 Z-Pay imgUrl + 3s 轮询 + 5min 自动停 + 成功后 3s 自动关闭
 *
 * 覆盖 6 个 case：
 *   1. 初始渲染：显示"立即支付"按钮
 *   2. 点立即支付：fetch create-order 返 {imgUrl}，渲染 <img src={imgUrl}>
 *   3. 轮询命中 status=1：UI 切"支付成功" 横幅
 *   4. 轮询 3 次未命中：仍显示二维码
 *   5. 5min 自动停轮询 + 显示"订单已创建..."文案
 *   6. 成功后 3s 自动调 onClose
 *
 * 测试工具：React Testing Library + Jest fake timers（项目已装）
 * 关键：fetch 已在 jest.setup.js 全局 mock；这里只 mock 返回值
 */

import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PayModal } from '../PayModal'

/** 构造一个 fetch 响应：跟 PayModal 内的 `r.ok` / `r.json()` 调用对齐 */
function fetchResponse(body, { ok = true } = {}) {
  return {
    ok,
    json: async () => body
  }
}

const PRODUCT = { id: 'starter-full', name: '知行合一·完整版', price: 10 }
const CREATE_ORDER_BODY = {
  outTradeNo: 'OUT-TEST-001',
  qrcode: 'weixin://wxpay/bizpayurl?pr=xxx',
  imgUrl: 'https://zpayz.cn/qrcode/OUT-TEST-001.png',
  productId: 'starter-full',
  productName: '知行合一·完整版',
  totalFen: 10
}

describe('PayModal', () => {
  let onClose

  beforeEach(() => {
    jest.useFakeTimers()
    onClose = jest.fn()
    global.fetch.mockReset()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  /**
   * 公共动作：点击"立即支付"按钮 → 等到 <img> 渲染（说明 create-order 成功 + setOrder 完成）
   */
  async function clickPayAndWaitForQrImg(user) {
    await user.click(screen.getByRole('button', { name: '立即支付' }))
    await waitFor(() => {
      expect(screen.getByRole('img')).toBeInTheDocument()
    })
  }

  it('1. 初始渲染：显示"立即支付"按钮', () => {
    render(<PayModal product={PRODUCT} onClose={onClose} />)
    expect(screen.getByRole('button', { name: '立即支付' })).toBeInTheDocument()
  })

  it('2. 点立即支付：fetch create-order 返 {imgUrl} 后渲染 <img src={imgUrl}>', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })

    global.fetch.mockResolvedValueOnce(fetchResponse(CREATE_ORDER_BODY))

    render(<PayModal product={PRODUCT} onClose={onClose} />)
    await clickPayAndWaitForQrImg(user)

    // 关键断言：<img> 的 src 必须是后端返回的 imgUrl（不再是前端 QRCode.toDataURL 生成的 data: URL）
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'https://zpayz.cn/qrcode/OUT-TEST-001.png')

    // 订单号和金额也要展示
    expect(screen.getByText(/订单号：OUT-TEST-001/)).toBeInTheDocument()
  })

  it('3. 轮询命中 status=1：UI 切"支付成功" 横幅', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })

    // create-order 返 200
    global.fetch.mockResolvedValueOnce(fetchResponse(CREATE_ORDER_BODY))
    // 后续所有 fetch（query-order）返 status=1
    global.fetch.mockImplementation(async () =>
      fetchResponse({ status: 1, money: '0.10', tradeNo: 'ZPAY-OK', msg: 'ok' })
    )

    render(<PayModal product={PRODUCT} onClose={onClose} />)
    await clickPayAndWaitForQrImg(user)

    // 推进 3s，触发一次 setInterval 回调
    await act(async () => {
      jest.advanceTimersByTime(3000)
    })

    // 等待 React 把 status=1 渲染出来
    await waitFor(() => {
      expect(screen.getByText(/支付成功/)).toBeInTheDocument()
    })

    // 验证 query-order 至少被调了 1 次
    const queryOrderCalls = global.fetch.mock.calls.filter(([url]) =>
      String(url).includes('/api/pay/query-order')
    )
    expect(queryOrderCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('4. 轮询 3 次未命中：仍显示二维码，不出现"支付成功"', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })

    global.fetch.mockResolvedValueOnce(fetchResponse(CREATE_ORDER_BODY))
    global.fetch.mockImplementation(async () =>
      fetchResponse({ status: 0, money: '0.10', tradeNo: 't', msg: 'wait' })
    )

    render(<PayModal product={PRODUCT} onClose={onClose} />)
    await clickPayAndWaitForQrImg(user)

    // 推进 9s = 3 个 poll 周期
    await act(async () => {
      jest.advanceTimersByTime(9000)
    })

    // 二维码仍在，没切"支付成功"
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.queryByText(/支付成功/)).not.toBeInTheDocument()

    // query-order 应该被调了 3 次
    const queryOrderCalls = global.fetch.mock.calls.filter(([url]) =>
      String(url).includes('/api/pay/query-order')
    )
    expect(queryOrderCalls.length).toBe(3)
  })

  it('5. 5min 自动停轮询：超时后不再调 query-order + 显示"订单已创建"文案', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })

    global.fetch.mockResolvedValueOnce(fetchResponse(CREATE_ORDER_BODY))

    // 计数 query-order 调用次数
    let queryCallCount = 0
    global.fetch.mockImplementation(async (url) => {
      if (String(url).includes('/api/pay/query-order')) {
        queryCallCount++
      }
      return fetchResponse({ status: 0, money: '0.10', tradeNo: 't', msg: 'wait' })
    })

    render(<PayModal product={PRODUCT} onClose={onClose} />)
    await clickPayAndWaitForQrImg(user)

    // 推进 5min + 100ms（刚过 5min 边界，确保 clearInterval 已触发）
    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000 + 100)
    })

    // 记录此时 query-order 调用次数
    const callsAfter5Min = queryCallCount

    // 再推进 30s，setInterval 已被 clear，不应再产生新的 query-order 调用
    await act(async () => {
      jest.advanceTimersByTime(30 * 1000)
    })

    expect(queryCallCount).toBe(callsAfter5Min)

    // 同时显示"订单已创建..."超时文案
    expect(screen.getByText(/订单已创建/)).toBeInTheDocument()
  })

  it('6. 成功后 3s 自动调 onClose', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })

    global.fetch.mockResolvedValueOnce(fetchResponse(CREATE_ORDER_BODY))
    global.fetch.mockImplementation(async () =>
      fetchResponse({ status: 1, money: '0.10', tradeNo: 'ZPAY-OK', msg: 'ok' })
    )

    render(<PayModal product={PRODUCT} onClose={onClose} />)
    await clickPayAndWaitForQrImg(user)

    // 推进 3s → setInterval 触发 → status=1 → order.paid = true
    await act(async () => {
      jest.advanceTimersByTime(3000)
    })

    // 等"支付成功"渲染
    await waitFor(() => {
      expect(screen.getByText(/支付成功/)).toBeInTheDocument()
    })

    // 此时 onClose 还没被调（需要再等 3s）
    expect(onClose).not.toHaveBeenCalled()

    // 推进 3s（setTimeout 触发）→ onClose 被调
    await act(async () => {
      jest.advanceTimersByTime(3000)
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
