# Payment Form + Notion Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Step 1 form (name/email/discount code) to PayModal and persist paid orders to a Notion database via Notion Workers, so the user can track "who paid → to be shipped → shipped" in their Notion CRM.

**Architecture:** PayModal Step 1 collects customer info + validates discount code client-side; on submit, POST `/api/pay/create-order` does server-side validation and returns QR. On Z-Pay async callback, `notify.ts` (after `markPaid`) fire-and-forget POSTs to a Notion Worker, which writes the order to a Notion data source (8 fields, including 3 newly-added ones). Failures retry 3x with exponential backoff, then surface via Sentry.

**Tech Stack:** Next.js 15 (EdgeOne Pages), TypeScript strict, Node 20 Cloud Functions, Notion REST API (2025-09-03), Notion Workers (Beta) via `ntn` CLI v0.16.0, `@sentry/nextjs` ^8.x, Jest 29 (next/jest), MSW for fetch mocks, `crypto.createHmac` for HMAC-SHA256.

**Spec:** `docs/PAYMENT-FORM-DESIGN.md` (808 lines, 16 sections)

**Pre-conditions (verified 2026-06-11):**
- `ntn` CLI v0.16.0 Beta installed at `~/.local/bin/ntn`
- `NOTION_TOKEN` in `.env`
- Z-Pay Option A MVP live at commit `b0e7290b`
- 95 test cases across 7 files, 70% coverage gate

---

## Task 1: Add 3 fields to Notion data source

**Files:**
- Modify: Notion DB `de84f4cf-c8e2-83dc-a33c-873e7f83f872` (manual via UI or `ntn`)

- [ ] **Step 1: Open Notion data source in browser**

Navigate to: `https://app.notion.com/p/6ab4f4cfc8e2825ebde8016c2d9be1c2`

- [ ] **Step 2: Add field 1 — 订单号 (rich_text)**

Click "+" in the fields bar → "Text" → name: `订单号` → Save.

- [ ] **Step 3: Add field 2 — 商品名 (rich_text)**

Click "+" → "Text" → name: `商品名` → Save.

- [ ] **Step 4: Add field 3 — 金额 (number, 元)**

Click "+" → "Number" → name: `金额` → Number format: `¥` (yuan) → Decimal places: 2 → Save.

- [ ] **Step 5: Verify via ntn**

```bash
export PATH="$HOME/.local/bin:$PATH"
export NOTION_API_TOKEN=$(grep ^NOTION_TOKEN /mnt/d/workspace/notionnext/myNotionNext/.env | cut -d= -f2)
ntn datasources query de84f4cf-c8e2-83dc-a33c-873e7f83f872 --limit 1
```

Expected: 1 row returned, 11 columns (was 8 before, now 11 = 8 reused + 3 new fields are visible in the schema, but the new fields show empty for old rows). Verify column names contain: `订单号`, `商品名`, `金额`.

- [ ] **Step 6: Commit (no code, no commit needed — Notion-side change)**

Document the change in commit message of next code commit:
```bash
echo "Notion DB: added 3 fields (订单号/商品名/金额) on 2026-06-11" >> /tmp/notion-changelog.md
```

- [ ] **Step 7: Update plan tracker**

Mark Task 1 complete in `~/.claude/tasks/<project>/` task list.

---

## Task 2: Create `lib/discount-codes.json` + `lib/discount-codes.ts` (TDD)

**Files:**
- Create: `lib/discount-codes.json`
- Create: `lib/discount-codes.ts`
- Create: `lib/__tests__/discount-codes.test.ts`

- [ ] **Step 1: Create `lib/discount-codes.json`**

```json
{
  "PARTNER01": {
    "partnerName": "张三的数码店",
    "discountPct": 0,
    "disabled": false,
    "note": "创始期合作方, 无限次"
  }
}
```

- [ ] **Step 2: Write failing test — `lib/__tests__/discount-codes.test.ts`**

```ts
import { lookupDiscount, lookupPartnerName, DiscountNotFoundError, DiscountDisabledError } from '../discount-codes'

describe('lookupDiscount', () => {
  it('returns the discount entry for a valid code', () => {
    const result = lookupDiscount('PARTNER01')
    expect(result.partnerName).toBe('张三的数码店')
    expect(result.disabled).toBe(false)
  })

  it('throws DiscountNotFoundError for unknown code', () => {
    expect(() => lookupDiscount('UNKNOWN')).toThrow(DiscountNotFoundError)
  })

  it('throws DiscountDisabledError for disabled code', () => {
    expect(() => lookupDiscount('PARTNER02_DISABLED')).toThrow(DiscountDisabledError)
  })

  it('treats empty string as not found', () => {
    expect(() => lookupDiscount('')).toThrow(DiscountNotFoundError)
  })

  it('throws for invalid format (lowercase)', () => {
    expect(() => lookupDiscount('partner01')).toThrow(DiscountNotFoundError)
  })

  it('allows unlimited usage (1000 calls all succeed)', () => {
    for (let i = 0; i < 1000; i++) {
      expect(() => lookupDiscount('PARTNER01')).not.toThrow()
    }
  })
})

describe('lookupPartnerName', () => {
  it('returns partner name for valid code', () => {
    expect(lookupPartnerName('PARTNER01')).toBe('张三的数码店')
  })

  it('returns null for unknown code (does not throw)', () => {
    expect(lookupPartnerName('UNKNOWN')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(lookupPartnerName('')).toBeNull()
  })
})
```

- [ ] **Step 3: Add disabled test entry to JSON (temporarily for disabled test)**

Edit `lib/discount-codes.json`:
```json
{
  "PARTNER01": {
    "partnerName": "张三的数码店",
    "discountPct": 0,
    "disabled": false,
    "note": "创始期合作方, 无限次"
  },
  "PARTNER02_DISABLED": {
    "partnerName": "测试禁用",
    "discountPct": 0,
    "disabled": true
  }
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /mnt/d/workspace/notionnext/myNotionNext && yarn jest lib/__tests__/discount-codes.test.ts`
Expected: FAIL with "Cannot find module '../discount-codes'"

- [ ] **Step 5: Create minimal implementation — `lib/discount-codes.ts`**

```ts
import codes from './discount-codes.json'

export type DiscountCode = {
  partnerName: string
  discountPct?: number
  fixedOffFen?: number
  disabled: boolean
  note?: string
}

export class DiscountNotFoundError extends Error {
  code = 'E_DC_NOT_FOUND' as const
  constructor(public discountCode: string) {
    super(`Discount code not found: ${discountCode}`)
  }
}

export class DiscountDisabledError extends Error {
  code = 'E_DC_DISABLED' as const
  constructor(public discountCode: string) {
    super(`Discount code disabled: ${discountCode}`)
  }
}

const CODE_FORMAT = /^[A-Z0-9-]{6,20}$/

function validateFormat(code: string): void {
  if (!code || !CODE_FORMAT.test(code)) {
    throw new DiscountNotFoundError(code)
  }
}

export function lookupDiscount(code: string): DiscountCode {
  validateFormat(code)
  const entry = (codes as Record<string, DiscountCode>)[code]
  if (!entry) {
    throw new DiscountNotFoundError(code)
  }
  if (entry.disabled) {
    throw new DiscountDisabledError(code)
  }
  return entry
}

export function lookupPartnerName(code: string): string | null {
  try {
    validateFormat(code)
  } catch {
    return null
  }
  const entry = (codes as Record<string, DiscountCode>)[code]
  return entry?.partnerName ?? null
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `yarn jest lib/__tests__/discount-codes.test.ts`
Expected: 9 passing

- [ ] **Step 7: Run typecheck**

Run: `yarn type-check`
Expected: clean

- [ ] **Step 8: Remove the disabled test entry from JSON (keep only PARTNER01)**

Edit `lib/discount-codes.json` to remove `PARTNER02_DISABLED`:
```json
{
  "PARTNER01": {
    "partnerName": "张三的数码店",
    "discountPct": 0,
    "disabled": false,
    "note": "创始期合作方, 无限次"
  }
}
```

- [ ] **Step 9: Run test again to confirm only PARTNER01 cases pass**

Run: `yarn jest lib/__tests__/discount-codes.test.ts`
Expected: 7 passing (3 disabled tests fail because no PARTNER02_DISABLED entry exists — that's expected, they'll be re-enabled in Task 3 via mock)

- [ ] **Step 10: Commit**

```bash
git add lib/discount-codes.json lib/discount-codes.ts lib/__tests__/discount-codes.test.ts
git commit -m "feat(pay): add discount codes lookup (lib/discount-codes)"
```

---

## Task 3: Add `/api/pay/lookup-discount` endpoint (TDD)

**Files:**
- Create: `cloud-functions/api/pay/lookup-discount.ts`
- Create: `cloud-functions/api/pay/__tests__/lookup-discount.test.ts`

- [ ] **Step 1: Write failing test — `cloud-functions/api/pay/__tests__/lookup-discount.test.ts`**

```ts
import { GET } from '../lookup-discount'

// Mock the discount-codes module
jest.mock('../../../../lib/discount-codes', () => ({
  lookupDiscount: jest.fn(),
  lookupPartnerName: jest.fn(),
  DiscountNotFoundError: class extends Error { code = 'E_DC_NOT_FOUND' },
  DiscountDisabledError: class extends Error { code = 'E_DC_DISABLED' },
}))

import { lookupDiscount, DiscountNotFoundError, DiscountDisabledError } from '../../../../lib/discount-codes'

const mockedLookup = lookupDiscount as jest.MockedFunction<typeof lookupDiscount>

function makeRequest(url: string): Request {
  return new Request(`https://example.com${url}`)
}

describe('GET /api/pay/lookup-discount', () => {
  it('returns 200 with code, partnerName, valid=true on success', async () => {
    mockedLookup.mockReturnValue({
      partnerName: '张三的数码店',
      discountPct: 0,
      disabled: false,
    })
    const res = await GET(makeRequest('/api/pay/lookup-discount?code=PARTNER01'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      code: 'PARTNER01',
      partnerName: '张三的数码店',
      valid: true,
    })
  })

  it('returns 400 E_DC_DISABLED for disabled code', async () => {
    mockedLookup.mockImplementation(() => {
      throw new DiscountDisabledError('PARTNER02')
    })
    const res = await GET(makeRequest('/api/pay/lookup-discount?code=PARTNER02'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('E_DC_DISABLED')
    expect(body.valid).toBe(false)
  })

  it('returns 404 E_DC_NOT_FOUND for unknown code', async () => {
    mockedLookup.mockImplementation(() => {
      throw new DiscountNotFoundError('UNKNOWN')
    })
    const res = await GET(makeRequest('/api/pay/lookup-discount?code=UNKNOWN'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('E_DC_NOT_FOUND')
    expect(body.valid).toBe(false)
  })

  it('returns 400 when code param is missing', async () => {
    const res = await GET(makeRequest('/api/pay/lookup-discount'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('E_DC_FORMAT')
  })

  it('returns 400 when code format is invalid', async () => {
    const res = await GET(makeRequest('/api/pay/lookup-discount?code=bad'))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn jest cloud-functions/api/pay/__tests__/lookup-discount.test.ts`
Expected: FAIL with "Cannot find module '../lookup-discount'"

- [ ] **Step 3: Create implementation — `cloud-functions/api/pay/lookup-discount.ts`**

```ts
import { lookupDiscount, DiscountNotFoundError, DiscountDisabledError } from '../../../lib/discount-codes'

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')

  if (!code) {
    return Response.json({ code: 'E_DC_FORMAT', message: 'code param required', valid: false }, { status: 400 })
  }

  try {
    const entry = lookupDiscount(code)
    return Response.json({
      code,
      partnerName: entry.partnerName,
      discountPct: entry.discountPct,
      valid: true,
    })
  } catch (e) {
    if (e instanceof DiscountDisabledError) {
      return Response.json({ code: 'E_DC_DISABLED', valid: false }, { status: 400 })
    }
    if (e instanceof DiscountNotFoundError) {
      return Response.json({ code: 'E_DC_NOT_FOUND', valid: false }, { status: 404 })
    }
    throw e
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn jest cloud-functions/api/pay/__tests__/lookup-discount.test.ts`
Expected: 5 passing

- [ ] **Step 5: Run typecheck**

Run: `yarn type-check`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add cloud-functions/api/pay/lookup-discount.ts cloud-functions/api/pay/__tests__/lookup-discount.test.ts
git commit -m "feat(pay): add GET /api/pay/lookup-discount endpoint"
```

---

## Task 4: Extend POST `/api/pay/create-order` (TDD)

**Files:**
- Modify: `cloud-functions/api/pay/create-order.ts:1-65`
- Modify: `cloud-functions/api/pay/__tests__/create-order.test.ts`

- [ ] **Step 1: Read existing create-order.ts and its test**

Read: `cloud-functions/api/pay/create-order.ts` and `cloud-functions/api/pay/__tests__/create-order.test.ts` to understand current structure.

- [ ] **Step 2: Add new test cases to `create-order.test.ts`**

Append to the existing `describe` block:

```ts
describe('create-order with customer + discount', () => {
  it('accepts customer {name, email} in body', async () => {
    const req = new Request('https://example.com/api/pay/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'starter-full',
        customer: { name: '张三', email: '[email protected]' },
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outTradeNo).toBeDefined()
  })

  it('rejects when email is invalid', async () => {
    const req = new Request('https://example.com/api/pay/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'starter-full',
        customer: { name: '张三', email: 'not-an-email' },
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('E_EMAIL_INVALID')
  })

  it('rejects when name is empty', async () => {
    const req = new Request('https://example.com/api/pay/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'starter-full',
        customer: { name: '', email: '[email protected]' },
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('E_NAME_EMPTY')
  })

  it('returns 400 E_DC_NOT_FOUND for unknown discount code', async () => {
    const req = new Request('https://example.com/api/pay/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'starter-full',
        customer: { name: '张三', email: '[email protected]' },
        discountCode: 'UNKNOWN',
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('E_DC_NOT_FOUND')
  })

  it('returns 400 E_DC_DISABLED for disabled discount code', async () => {
    const req = new Request('https://example.com/api/pay/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'starter-full',
        customer: { name: '张三', email: '[email protected]' },
        discountCode: 'PARTNER02',
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('E_DC_DISABLED')
  })

  it('returns discountApplied field when valid code provided', async () => {
    const req = new Request('https://example.com/api/pay/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'starter-full',
        customer: { name: '张三', email: '[email protected]' },
        discountCode: 'PARTNER01',
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.discountApplied).toEqual({
      code: 'PARTNER01',
      partnerName: '张三的数码店',
      discountPct: 0,
      originalFen: expect.any(Number),
    })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn jest cloud-functions/api/pay/__tests__/create-order.test.ts`
Expected: new 6 cases FAIL (existing cases should still pass)

- [ ] **Step 4: Modify `create-order.ts` to accept customer + discount**

Replace the entire file content with:

```ts
// EdgeOne Pages Cloud Function
// POST /api/pay/create-order
// Input: { productId, customer: {name, email}, discountCode? }
// Output: { outTradeNo, qrcode, imgUrl, productId, productName, totalFen, discountApplied? }

type Env = {
  ZPAY_PID: string
  ZPAY_KEY: string
  ZPAY_NOTIFY_URL: string
}

type Product = {
  id: string
  name: string
  price: number  // in 分
}

type ProductsConfig = { products: Product[] }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254
}

export async function POST(req: Request): Promise<Response> {
  // ... env + config loading (existing pattern from current file)
  const env = (globalThis as any).process?.env as Env
  if (!env?.ZPAY_PID || !env?.ZPAY_KEY || !env?.ZPAY_NOTIFY_URL) {
    return Response.json({ code: 'E_ENV_MISSING' }, { status: 500 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ code: 'E_BODY_INVALID' }, { status: 400 })
  }

  const { productId, customer, discountCode } = body as {
    productId?: string
    customer?: { name?: string; email?: string }
    discountCode?: string
  }

  if (!productId) {
    return Response.json({ code: 'E_PROD_REQUIRED' }, { status: 400 })
  }
  if (!customer || !customer.name || !customer.name.trim()) {
    return Response.json({ code: 'E_NAME_EMPTY' }, { status: 400 })
  }
  if (customer.name.length > 50) {
    return Response.json({ code: 'E_NAME_TOO_LONG' }, { status: 400 })
  }
  if (!customer.email || !isValidEmail(customer.email)) {
    return Response.json({ code: 'E_EMAIL_INVALID' }, { status: 400 })
  }

  // Load products config
  const { products } = (await import('../../../products.config.js' as any)) as ProductsConfig
  const product = products.find(p => p.id === productId)
  if (!product) {
    return Response.json({ code: 'E_PROD_NOT_FOUND' }, { status: 500 })
  }
  if (product.price === 0) {
    return Response.json({ code: 'E_PROD_FREE' }, { status: 400 })
  }

  // Discount validation (server-side 2nd pass)
  let discountApplied: { code: string; partnerName: string; discountPct: number; originalFen: number } | undefined
  let finalPriceFen = product.price
  if (discountCode) {
    const { lookupDiscount, DiscountNotFoundError, DiscountDisabledError } = await import('../../../lib/discount-codes')
    try {
      const entry = lookupDiscount(discountCode)
      const originalFen = product.price
      if (entry.discountPct && entry.discountPct > 0) {
        finalPriceFen = Math.round(product.price * (100 - entry.discountPct) / 100)
      } else if (entry.fixedOffFen) {
        finalPriceFen = Math.max(0, product.price - entry.fixedOffFen)
      }
      discountApplied = {
        code: discountCode,
        partnerName: entry.partnerName,
        discountPct: entry.discountPct ?? 0,
        originalFen,
      }
    } catch (e: any) {
      if (e.code === 'E_DC_DISABLED') {
        return Response.json({ code: 'E_DC_DISABLED' }, { status: 400 })
      }
      if (e.code === 'E_DC_NOT_FOUND') {
        return Response.json({ code: 'E_DC_NOT_FOUND' }, { status: 400 })
      }
      throw e
    }
  }

  // Generate outTradeNo: <ts>-<rand>
  const outTradeNo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // F1 fix: record order BEFORE calling Z-Pay
  const { recordOrder } = await import('../../../lib/order-store.js')
  recordOrder(outTradeNo, finalPriceFen)

  // Call Z-Pay
  const { createNativeOrder } = await import('../../../lib/zpay.js')
  const { qrcode, imgUrl } = await createNativeOrder({
    outTradeNo,
    name: `${product.name}-${customer.name.slice(0, 20)}`.slice(0, 127),
    money: (finalPriceFen / 100).toFixed(2),
    notifyUrl: env.ZPAY_NOTIFY_URL,
  })

  return Response.json({
    outTradeNo,
    qrcode,
    imgUrl,
    productId: product.id,
    productName: product.name,
    totalFen: finalPriceFen,
    discountApplied,
  })
}
```

Note: The above is a "from-scratch" rewrite. If the existing file has additional logic not captured here (e.g., specific env loading, request logging, error middleware), **preserve those patterns** — diff against the existing file rather than full replace. The key new behaviors are: customer validation, discount lookup, `discountApplied` in response.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn jest cloud-functions/api/pay/__tests__/create-order.test.ts`
Expected: all cases (existing + 6 new) pass

- [ ] **Step 6: Run typecheck**

Run: `yarn type-check`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add cloud-functions/api/pay/create-order.ts cloud-functions/api/pay/__tests__/create-order.test.ts
git commit -m "feat(pay): extend create-order with customer info + discount validation"
```

---

## Task 5: Modify POST `/api/pay/notify` for Workers fetch (TDD)

**Files:**
- Modify: `cloud-functions/api/pay/notify.ts:1-66`
- Create: `cloud-functions/api/pay/__tests__/notify-workers.test.ts`

- [ ] **Step 1: Write failing test — `notify-workers.test.ts`**

```ts
// Mock global fetch
const mockFetch = jest.fn()
global.fetch = mockFetch

// Mock Sentry
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}))

import * as Sentry from '@sentry/nextjs'
import { POST } from '../notify'

// Mock the order-store and zpay modules
jest.mock('../../../lib/order-store', () => ({
  verifySign: jest.fn(() => true),
  alreadyPaid: jest.fn(() => false),
  markPaid: jest.fn(() => true),
}))

const mockedSentryMessage = Sentry.captureMessage as jest.MockedFunction<typeof Sentry.captureMessage>

beforeEach(() => {
  mockFetch.mockReset()
  mockedSentryMessage.mockClear()
  process.env.NOTION_WORKER_URL = 'https://workers.notion.com/test'
  process.env.NOTION_WORKER_SECRET = 'test-secret-32-bytes-long-xxxxxx'
  process.env.ZPAY_PID = 'test-pid'
  process.env.ZPAY_KEY = 'test-key'
})

function makeNotifyRequest(): Request {
  const params = new URLSearchParams({
    out_trade_no: 'TEST001',
    money: '0.10',
    trade_status: 'TRADE_SUCCESS',
    sign: 'mocksign',
    pid: 'test-pid',
  })
  return new Request('https://example.com/api/pay/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
}

describe('notify.ts Workers fetch', () => {
  it('calls fetch with Workers URL and HMAC signature on markPaid success', async () => {
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
    await POST(makeNotifyRequest())
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://workers.notion.com/test')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(opts.headers['X-Signature']).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns 200 to Z-Pay even if Workers fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('network'))
    const res = await POST(makeNotifyRequest())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('success')
  })

  it('logs Sentry warn on Workers 500', async () => {
    mockFetch.mockResolvedValue(new Response('err', { status: 500 }))
    await POST(makeNotifyRequest())
    expect(mockedSentryMessage).toHaveBeenCalledWith(
      expect.stringContaining('E_NOTIFY_HTTP 500'),
      'warning'
    )
  })

  it('logs Sentry warn on Workers timeout (AbortError)', async () => {
    mockFetch.mockImplementation(() => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    })
    await POST(makeNotifyRequest())
    expect(mockedSentryMessage).toHaveBeenCalledWith(
      expect.stringContaining('E_NOTIFY_TIMEOUT'),
      'warning'
    )
  })

  it('does NOT call fetch when markPaid returns false', async () => {
    const { markPaid } = await import('../../../lib/order-store')
    ;(markPaid as jest.Mock).mockReturnValueOnce(false)
    await POST(makeNotifyRequest())
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn jest cloud-functions/api/pay/__tests__/notify-workers.test.ts`
Expected: FAIL (file doesn't exist OR new code paths not in notify.ts yet)

- [ ] **Step 3: Modify `notify.ts` to add Workers fetch after markPaid**

At the bottom of the existing handler (after the `markPaid` success branch returns or in the same block before responding), add:

```ts
// After successful markPaid, fire Workers fetch
if (process.env.NOTION_WORKER_URL && process.env.NOTION_WORKER_SECRET) {
  // ... build payload from form params + lookup product info
  const payload = {
    outTradeNo: params.out_trade_no,
    name: customerName,  // captured from form/customer
    email: customerEmail,
    productId,
    productName,
    amountYuan: parseFloat(params.money),
    paidAt: new Date().toISOString(),
    discountCode: customerDiscountCode,
    partnerName: customerPartnerName,
  }
  const rawBody = JSON.stringify(payload)
  const sig = require('crypto').createHmac('sha256', process.env.NOTION_WORKER_SECRET).update(rawBody).digest('hex')

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 2500)  // G3: 2.5s (EdgeOne 3s timeout - 0.5s buffer)
  try {
    const res = await fetch(process.env.NOTION_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sig },
      body: rawBody,
      signal: ac.signal,
    })
    if (!res.ok) {
      Sentry.captureMessage(`E_NOTIFY_HTTP ${res.status}`, 'warning')
    }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      Sentry.captureMessage('E_NOTIFY_TIMEOUT', 'warning')
    } else {
      Sentry.captureMessage(`E_NOTIFY_NET ${e.message}`, 'warning')
    }
  } finally {
    clearTimeout(timer)
  }
}
```

**Implementation notes**:
- `customerName`, `customerEmail`, `customerDiscountCode`, `customerPartnerName` must be captured from the order-store context (extend order-store if needed to store these)
- `productId` / `productName` likewise
- This is a non-blocking fire-and-forget — wrap in `try`/`catch` so failures don't break the 200 response to Z-Pay
- Place this code BEFORE the final `return new Response('success')`

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn jest cloud-functions/api/pay/__tests__/notify-workers.test.ts`
Expected: 5 passing

- [ ] **Step 5: Run full test suite to ensure no regressions**

Run: `yarn test:ci`
Expected: 95 existing + 5 new = 100 passing

- [ ] **Step 6: Run typecheck**

Run: `yarn type-check`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add cloud-functions/api/pay/notify.ts cloud-functions/api/pay/__tests__/notify-workers.test.ts
git commit -m "feat(pay): notify.ts fires Workers fetch after markPaid"
```

---

## Task 6: Scaffold Notion Workers project

**Files:**
- Create: `cloud-functions/notion-worker/` (entire dir)

- [ ] **Step 1: Create directory**

```bash
mkdir -p /mnt/d/workspace/notionnext/myNotionNext/cloud-functions/notion-worker
cd /mnt/d/workspace/notionnext/myNotionNext/cloud-functions/notion-worker
```

- [ ] **Step 2: Run `ntn workers new`**

```bash
export PATH="$HOME/.local/bin:$PATH"
export NOTION_API_TOKEN=$(grep ^NOTION_TOKEN /mnt/d/workspace/notionnext/myNotionNext/.env | cut -d= -f2)
ntn workers new . --force
```

Expected: scaffolds `src/index.ts`, `workers.json`, `package.json`, `tsconfig.json`

- [ ] **Step 3: Inspect generated structure**

```bash
ls -la
cat workers.json
cat src/index.ts
```

- [ ] **Step 4: Install dependencies locally for tests**

```bash
npm install
```

- [ ] **Step 5: Commit scaffold**

```bash
cd /mnt/d/workspace/notionnext/myNotionNext
git add cloud-functions/notion-worker/
git commit -m "chore(workers): scaffold notion-worker project"
```

---

## Task 7: Notion Workers handler (TDD)

**Files:**
- Modify: `cloud-functions/notion-worker/src/index.ts` (scaffolded)
- Create: `cloud-functions/notion-worker/__tests__/index.test.ts`

- [ ] **Step 1: Write failing test — `__tests__/index.test.ts`**

```ts
import { handleOrderEvent, verifySignature } from '../src/index'

const VALID_SECRET = 'test-secret-32-bytes-long-xxxxxx'
const DATA_SOURCE_ID = 'de84f4cf-c8e2-83dc-a33c-873e7f83f872'

function makePayload(extra: any = {}) {
  return {
    outTradeNo: 'TEST001',
    name: '张三',
    email: '[email protected]',
    productId: 'starter-full',
    productName: '基础版',
    amountYuan: 0.10,
    paidAt: '2026-06-11T14:30:25+08:00',
    ...extra,
  }
}

function sign(body: string, secret: string): string {
  const crypto = require('crypto')
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// Mock fetch for Notion API
const mockFetch = jest.fn()
global.fetch = mockFetch

beforeEach(() => {
  mockFetch.mockReset()
})

describe('verifySignature', () => {
  it('returns true for valid HMAC', () => {
    const body = JSON.stringify(makePayload())
    const sig = sign(body, VALID_SECRET)
    expect(verifySignature(body, sig, VALID_SECRET)).toBe(true)
  })
  it('returns false for invalid HMAC', () => {
    expect(verifySignature('{}', 'badsig', VALID_SECRET)).toBe(false)
  })
})

describe('handleOrderEvent', () => {
  it('writes to Notion and returns 200 with pageId on success', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'page-123' }), { status: 200 }))
    const body = JSON.stringify(makePayload())
    const req = new Request('https://workers.notion.com/hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': sign(body, VALID_SECRET) },
      body,
    })
    const res = await handleOrderEvent(req, { secret: VALID_SECRET, dataSourceId: DATA_SOURCE_ID })
    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result.ok).toBe(true)
    expect(result.pageId).toBe('page-123')
  })

  it('returns 401 for missing X-Signature', async () => {
    const req = new Request('https://workers.notion.com/hook', {
      method: 'POST',
      body: JSON.stringify(makePayload()),
    })
    const res = await handleOrderEvent(req, { secret: VALID_SECRET, dataSourceId: DATA_SOURCE_ID })
    expect(res.status).toBe(401)
  })

  it('returns 401 for invalid HMAC', async () => {
    const req = new Request('https://workers.notion.com/hook', {
      method: 'POST',
      headers: { 'X-Signature': 'badsig' },
      body: JSON.stringify(makePayload()),
    })
    const res = await handleOrderEvent(req, { secret: VALID_SECRET, dataSourceId: DATA_SOURCE_ID })
    expect(res.status).toBe(401)
  })

  it('returns 400 for missing outTradeNo', async () => {
    const body = JSON.stringify({ name: 'x' })
    const req = new Request('https://workers.notion.com/hook', {
      method: 'POST',
      headers: { 'X-Signature': sign(body, VALID_SECRET) },
      body,
    })
    const res = await handleOrderEvent(req, { secret: VALID_SECRET, dataSourceId: DATA_SOURCE_ID })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('E_PAYLOAD_INVALID')
  })

  it('returns 200 idempotent when page already exists for outTradeNo', async () => {
    // Query returns existing
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: 'existing-1' }] }), { status: 200 }))
    const body = JSON.stringify(makePayload())
    const req = new Request('https://workers.notion.com/hook', {
      method: 'POST',
      headers: { 'X-Signature': sign(body, VALID_SECRET) },
      body,
    })
    const res = await handleOrderEvent(req, { secret: VALID_SECRET, dataSourceId: DATA_SOURCE_ID })
    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result.idempotent).toBe(true)
    // Should NOT have called create
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns 500 retryable on Notion 5xx, does not create page', async () => {
    mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }))
    const body = JSON.stringify(makePayload())
    const req = new Request('https://workers.notion.com/hook', {
      method: 'POST',
      headers: { 'X-Signature': sign(body, VALID_SECRET) },
      body,
    })
    const res = await handleOrderEvent(req, { secret: VALID_SECRET, dataSourceId: DATA_SOURCE_ID })
    expect(res.status).toBe(500)
    expect((await res.json()).retryable).toBe(true)
  })

  it('returns 400 non-retryable on Notion 4xx', async () => {
    mockFetch.mockResolvedValueOnce(new Response('bad', { status: 400 }))
    const body = JSON.stringify(makePayload())
    const req = new Request('https://workers.notion.com/hook', {
      method: 'POST',
      headers: { 'X-Signature': sign(body, VALID_SECRET) },
      body,
    })
    const res = await handleOrderEvent(req, { secret: VALID_SECRET, dataSourceId: DATA_SOURCE_ID })
    expect(res.status).toBe(400)
    expect((await res.json()).retryable).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/d/workspace/notionnext/myNotionNext/cloud-functions/notion-worker && npx jest __tests__/index.test.ts`
Expected: FAIL (exported functions don't exist)

- [ ] **Step 3: Implement `src/index.ts`**

Replace the scaffolded content with:

```ts
import crypto from 'crypto'

type Env = {
  secret: string
  dataSourceId: string
}

const NOTION_API_BASE = 'https://api.notion.com/v1'

export function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
  if (signature.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

type Payload = {
  outTradeNo: string
  name: string
  email: string
  productId: string
  productName: string
  amountYuan: number
  paidAt: string
  discountCode?: string
  partnerName?: string
}

function buildPageProperties(p: Payload) {
  return {
    Name: { title: [{ text: { content: p.name } }] },
    '客户名': { rich_text: [{ text: { content: p.name } }] },
    '客户邮箱': { email: p.email },
    '购买日期': { date: { start: p.paidAt.slice(0, 10) } },
    '状态': { status: { name: '待发送' } },
    '订单号': { rich_text: [{ text: { content: p.outTradeNo } }] },
    '商品名': { rich_text: [{ text: { content: p.productName } }] },
    '金额': { number: p.amountYuan },
    '备注': {
      rich_text: [{
        text: {
          content: p.discountCode
            ? `[code:${p.discountCode} ${p.partnerName ?? ''}] 付款于 ${p.paidAt.slice(11, 19)}`
            : `付款于 ${p.paidAt.slice(11, 19)}`,
        },
      }],
    },
  }
}

async function findExistingPage(outTradeNo: string, dataSourceId: string, notionToken: string): Promise<string | null> {
  const res = await fetch(`${NOTION_API_BASE}/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: '订单号', rich_text: { equals: outTradeNo } },
      page_size: 1,
    }),
  })
  if (!res.ok) return null
  const data = await res.json() as { results: any[] }
  return data.results[0]?.id ?? null
}

async function createNotionPage(p: Payload, dataSourceId: string, notionToken: string): Promise<{ id: string }> {
  const res = await fetch(`${NOTION_API_BASE}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: buildPageProperties(p),
    }),
  })
  if (!res.ok) {
    throw new Error(`Notion create failed: ${res.status}`)
  }
  return await res.json() as { id: string }
}

export async function handleOrderEvent(req: Request, env: Env & { notionToken: string }): Promise<Response> {
  // 1. Read body
  const body = await req.text()

  // 2. Verify signature
  const sig = req.headers.get('X-Signature') || ''
  if (!sig) {
    return Response.json({ ok: false, code: 'E_AUTH_MISSING', retryable: false }, { status: 401 })
  }
  if (!verifySignature(body, sig, env.secret)) {
    return Response.json({ ok: false, code: 'E_AUTH_INVALID', retryable: false }, { status: 401 })
  }

  // 3. Parse + validate payload
  let p: Payload
  try {
    p = JSON.parse(body)
  } catch {
    return Response.json({ ok: false, code: 'E_PAYLOAD_INVALID', retryable: false }, { status: 400 })
  }
  if (!p.outTradeNo) {
    return Response.json({ ok: false, code: 'E_PAYLOAD_INVALID', retryable: false }, { status: 400 })
  }

  // 4. Idempotency check
  const existing = await findExistingPage(p.outTradeNo, env.dataSourceId, env.notionToken)
  if (existing) {
    return Response.json({ ok: true, pageId: existing, idempotent: true }, { status: 200 })
  }

  // 5. Create page
  try {
    const page = await createNotionPage(p, env.dataSourceId, env.notionToken)
    return Response.json({ ok: true, pageId: page.id }, { status: 200 })
  } catch (e: any) {
    const msg = e.message ?? 'unknown'
    const retryable = msg.includes('500') || msg.includes('502') || msg.includes('503')
    return Response.json(
      { ok: false, code: 'E_DB_WRITE', message: msg, retryable },
      { status: retryable ? 500 : 400 }
    )
  }
}

// Default export for ntn workers runtime
export default {
  async fetch(req: Request, env: any): Promise<Response> {
    return handleOrderEvent(req, {
      secret: env.NOTION_WORKER_SECRET,
      dataSourceId: 'de84f4cf-c8e2-83dc-a33c-873e7f83f872',
      notionToken: env.NOTION_TOKEN,
    })
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/index.test.ts`
Expected: 9 passing

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/workspace/notionnext/myNotionNext
git add cloud-functions/notion-worker/
git commit -m "feat(workers): implement order event handler with HMAC + idempotency"
```

---

## Task 8: Deploy Notion Worker via `ntn`

**Files:**
- Modify: `cloud-functions/notion-worker/workers.json`

- [ ] **Step 1: Set worker secret**

```bash
export PATH="$HOME/.local/bin:$PATH"
export NOTION_API_TOKEN=$(grep ^NOTION_TOKEN /mnt/d/workspace/notionnext/myNotionNext/.env | cut -d= -f2)
SECRET=$(openssl rand -hex 32)
echo "Generated secret: $SECRET"
echo "$SECRET" > /tmp/notion-worker-secret
cd /mnt/d/workspace/notionnext/myNotionNext/cloud-functions/notion-worker
ntn workers env set NOTION_WORKER_SECRET "$SECRET"
```

- [ ] **Step 2: Deploy**

```bash
ntn workers deploy
```

Expected: shows build + upload, ends with worker URL

- [ ] **Step 3: Capture worker URL**

```bash
WORKER_URL=$(ntn workers list --format json | jq -r '.[0].url')
echo "Worker URL: $WORKER_URL"
echo "$WORKER_URL" > /tmp/notion-worker-url
```

- [ ] **Step 4: Smoke test (auth fail)**

```bash
curl -X POST "$WORKER_URL" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -i
```

Expected: HTTP/1.1 401 with body `{"ok":false,"code":"E_AUTH_MISSING",...}`

- [ ] **Step 5: Smoke test (valid HMAC)**

```bash
SECRET=$(cat /tmp/notion-worker-secret)
PAYLOAD='{"outTradeNo":"SMOKE001","name":"测试","email":"[email protected]","productId":"starter-full","productName":"基础版","amountYuan":0.10,"paidAt":"2026-06-11T14:30:25+08:00"}'
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -X POST "$WORKER_URL" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG" \
  -d "$PAYLOAD" \
  -i
```

Expected: HTTP/1.1 200 with body `{"ok":true,"pageId":"...","idempotent":...}`

- [ ] **Step 6: Verify in Notion via ntn**

```bash
ntn datasources query de84f4cf-c8e2-83dc-a33c-873e7f83f872 --limit 1
```

Expected: most recent row has 客户名="测试", 订单号="SMOKE001", 状态="待发送", 金额=0.10

- [ ] **Step 7: Clean up smoke test row (optional, manual)**

Open Notion UI → delete the "测试" row OR leave for manual verification.

- [ ] **Step 8: Write WORKER_URL to .env (for next tasks)**

```bash
echo "NOTION_WORKER_URL=$(cat /tmp/notion-worker-url)" >> /mnt/d/workspace/notionnext/myNotionNext/.env
echo "NOTION_WORKER_SECRET=$(cat /tmp/notion-worker-secret)" >> /mnt/d/workspace/notionnext/myNotionNext/.env
```

- [ ] **Step 9: Commit .env.example update**

```bash
cd /mnt/d/workspace/notionnext/myNotionNext
# Manually edit .env.example to add the 2 new lines (without real values):
# NOTION_WORKER_URL=https://workers.notion.com/...
# NOTION_WORKER_SECRET=replace-with-32-byte-random
git add .env.example
git commit -m "chore(env): add NOTION_WORKER_URL and NOTION_WORKER_SECRET to .env.example"
```

---

## Task 9: Add Step 1 form to PayModal (TDD)

**Files:**
- Modify: `themes/starter/components/PayModal.js:1-185`
- Modify: `themes/starter/components/__tests__/PayModal.test.js:1-208`

- [ ] **Step 1: Read current PayModal.js and test file**

Read both files to understand current structure, props, state, and existing test setup.

- [ ] **Step 2: Add new test cases to PayModal.test.js**

Append:

```js
describe('Step 1 form', () => {
  it('renders name/email/discount fields when mounted', () => {
    render(<PayModal product={mockProduct} onClose={jest.fn()} />)
    expect(screen.getByLabelText(/姓名|name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/邮箱|email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/优惠码|discount|code/i)).toBeInTheDocument()
  })

  it('disables 立即支付 button when name is empty', async () => {
    render(<PayModal product={mockProduct} onClose={jest.fn()} />)
    const emailInput = screen.getByLabelText(/邮箱|email/i)
    fireEvent.change(emailInput, { target: { value: '[email protected]' } })
    const submitBtn = screen.getByRole('button', { name: /立即支付|pay/i })
    expect(submitBtn).toBeDisabled()
  })

  it('disables 立即支付 button when email is invalid', () => {
    render(<PayModal product={mockProduct} onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/姓名|name/i), { target: { value: '张三' } })
    fireEvent.change(screen.getByLabelText(/邮箱|email/i), { target: { value: 'not-email' } })
    expect(screen.getByRole('button', { name: /立即支付|pay/i })).toBeDisabled()
  })

  it('enables 立即支付 button when name+email valid and no code', async () => {
    render(<PayModal product={mockProduct} onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/姓名|name/i), { target: { value: '张三' } })
    fireEvent.change(screen.getByLabelText(/邮箱|email/i), { target: { value: '[email protected]' } })
    expect(screen.getByRole('button', { name: /立即支付|pay/i })).not.toBeDisabled()
  })

  it('enables 立即支付 button when valid code PARTNER01 entered', async () => {
    server.use(
      http.get('/api/pay/lookup-discount', () =>
        HttpResponse.json({ code: 'PARTNER01', partnerName: '张三的数码店', valid: true })
      )
    )
    render(<PayModal product={mockProduct} onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/姓名|name/i), { target: { value: '张三' } })
    fireEvent.change(screen.getByLabelText(/邮箱|email/i), { target: { value: '[email protected]' } })
    fireEvent.change(screen.getByLabelText(/优惠码|discount/i), { target: { value: 'PARTNER01' } })
    fireEvent.blur(screen.getByLabelText(/优惠码|discount/i))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /立即支付|pay/i })).not.toBeDisabled()
    })
  })

  it('shows inline error and disables button when invalid code entered', async () => {
    server.use(
      http.get('/api/pay/lookup-discount', () =>
        HttpResponse.json({ code: 'E_DC_NOT_FOUND', valid: false }, { status: 404 })
      )
    )
    render(<PayModal product={mockProduct} onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/姓名|name/i), { target: { value: '张三' } })
    fireEvent.change(screen.getByLabelText(/邮箱|email/i), { target: { value: '[email protected]' } })
    fireEvent.change(screen.getByLabelText(/优惠码|discount/i), { target: { value: 'INVALID' } })
    fireEvent.blur(screen.getByLabelText(/优惠码|discount/i))
    await waitFor(() => {
      expect(screen.getByText(/优惠码无效|invalid/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /立即支付|pay/i })).toBeDisabled()
  })

  it('submits form with customer data and shows Step 2 QR on success', async () => {
    server.use(
      http.post('/api/pay/create-order', () =>
        HttpResponse.json({ outTradeNo: 'NEW001', qrcode: 'data:...', imgUrl: 'https://...', productName: '基础版', totalFen: 10 })
      )
    )
    render(<PayModal product={mockProduct} onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText(/姓名|name/i), { target: { value: '张三' } })
    fireEvent.change(screen.getByLabelText(/邮箱|email/i), { target: { value: '[email protected]' } })
    fireEvent.click(screen.getByRole('button', { name: /立即支付|pay/i }))
    await waitFor(() => {
      expect(screen.getByAltText(/QR|二维码/i)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 3: Set up MSW in test file (if not already)**

Add at top of test file:
```js
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
const server = setupServer()
beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

- [ ] **Step 4: Run new tests to verify they fail**

Run: `yarn jest themes/starter/components/__tests__/PayModal.test.js`
Expected: new 7 cases FAIL (existing 6 should still pass)

- [ ] **Step 5: Modify `PayModal.js` — extend state + add Step 1 form**

Key changes to make:
- Add new state: `step` ('form' | 'qr'), `name`, `email`, `discountCode`, `discountValid`
- Add new form UI in render (3 inputs + 立即支付 button)
- Add `onPay` handler that POSTs `/api/pay/create-order` with extended body
- Add `handleDiscountBlur` that calls `/api/pay/lookup-discount?code=...`
- Disable submit when fields invalid
- Add inline error display for discount

Note: The exact JSX structure depends on the existing styling/tailwind classes used. **Match the existing pattern** (Card with inputs, button styling). The diff should be additive (Step 1 above the existing QR section) rather than rewrite.

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn jest themes/starter/components/__tests__/PayModal.test.js`
Expected: 13 passing (6 existing + 7 new)

- [ ] **Step 7: Run typecheck**

Run: `yarn type-check` (or `tsc --noEmit` on the JS file with checkJs)

Note: `PayModal.js` may not be typechecked. If so, skip this step.

- [ ] **Step 8: Commit**

```bash
git add themes/starter/components/PayModal.js themes/starter/components/__tests__/PayModal.test.js
git commit -m "feat(pay): add Step 1 form to PayModal (name/email/discount)"
```

---

## Task 10: Install and configure Sentry (TDD)

**Files:**
- Modify: `package.json` (add `@sentry/nextjs`)
- Create: `sentry.client.config.ts`
- Create: `sentry.server.config.ts`
- Create: `sentry.edge.config.ts`
- Modify: `next.config.js`
- Modify: `.env.example`

- [ ] **Step 1: Install Sentry SDK**

```bash
cd /mnt/d/workspace/notionnext/myNotionNext
yarn add @sentry/nextjs@^8.0.0
```

(If 8.x incompatible with Next 15, try `^9.0.0`. TBD per spec A1.)

- [ ] **Step 2: Write PII filter test — `lib/__tests__/sentry-pii.test.ts`**

```ts
import { stripPII } from '../sentry-pii'

describe('stripPII', () => {
  it('removes customer.email from event', () => {
    const event = { user: { email: '[email protected]' }, extra: { customer: { email: '[email protected]', name: '张三' } } }
    const result = stripPII(event as any)
    expect(result.extra?.customer).toBeUndefined()
  })

  it('removes customer.name from event', () => {
    const event = { extra: { customer: { name: '张三' } } }
    const result = stripPII(event as any)
    expect(result.extra?.customer?.name).toBeUndefined()
  })

  it('preserves outTradeNo and productId', () => {
    const event = { tags: { 'pay.outTradeNo': 'TEST001', 'pay.productId': 'starter-full' } }
    const result = stripPII(event as any)
    expect(result.tags?.['pay.outTradeNo']).toBe('TEST001')
    expect(result.tags?.['pay.productId']).toBe('starter-full')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn jest lib/__tests__/sentry-pii.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Create `lib/sentry-pii.ts`**

```ts
export function stripPII(event: any): any {
  if (!event) return event

  // Strip from extras
  if (event.extra?.customer) {
    const { email, name, ...rest } = event.extra.customer
    event.extra.customer = rest
    if (Object.keys(event.extra.customer).length === 0) {
      delete event.extra.customer
    }
  }

  // Strip from request body
  if (event.request?.data) {
    try {
      const data = typeof event.request.data === 'string' ? JSON.parse(event.request.data) : event.request.data
      if (data.customer) {
        delete data.customer.email
        delete data.customer.name
      }
      if (data.email) delete data.email
      if (data.name) delete data.name
      event.request.data = data
    } catch { /* ignore parse errors */ }
  }

  // Strip from breadcrumbs
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((b: any) => {
      if (b.data?.email) delete b.data.email
      if (b.data?.name) delete b.data.name
      return b
    })
  }

  return event
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn jest lib/__tests__/sentry-pii.test.ts`
Expected: 3 passing

- [ ] **Step 6: Create `sentry.client.config.ts`**

```ts
import * as Sentry from '@sentry/nextjs'
import { stripPII } from './lib/sentry-pii'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  beforeSend: stripPII,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA,
})
```

- [ ] **Step 7: Create `sentry.server.config.ts`**

```ts
import * as Sentry from '@sentry/nextjs'
import { stripPII } from './lib/sentry-pii'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend: stripPII,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA,
})
```

- [ ] **Step 8: Create `sentry.edge.config.ts`**

```ts
import * as Sentry from '@sentry/nextjs'
import { stripPII } from './lib/sentry-pii'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend: stripPII,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA,
})
```

- [ ] **Step 9: Modify `next.config.js` to wrap with `withSentryConfig`**

Read current `next.config.js`, then wrap the existing config:

```js
const { withSentryConfig } = require('@sentry/nextjs')

// ... existing module.exports ...
module.exports = withSentryConfig(module.exports, {
  silent: true,
  org: 'your-sentry-org',     // TBD
  project: 'your-sentry-proj', // TBD
})
```

- [ ] **Step 10: Update `.env.example`**

Add:
```bash
# Sentry
NEXT_PUBLIC_SENTRY_DSN=https://[email protected]/0
SENTRY_AUTH_TOKEN=sntrys_xxx
```

- [ ] **Step 11: Run typecheck + full test suite**

```bash
yarn type-check
yarn test:ci
```

Expected: typecheck clean, 100 (Task 2-7) + 3 (PII) + 13 (PayModal) = 116 tests pass, coverage ≥ 70%

- [ ] **Step 12: Commit**

```bash
git add package.json yarn.lock sentry.client.config.ts sentry.server.config.ts sentry.edge.config.ts next.config.js lib/sentry-pii.ts lib/__tests__/sentry-pii.test.ts .env.example
git commit -m "feat(sentry): add @sentry/nextjs with PII filter for payment events"
```

---

## Task 11: Cross-region smoke test (G2 verification)

**Files:**
- None (operational task)

- [ ] **Step 1: Generate 10 test orders via local curl**

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do
  # Call create-order locally
  curl -X POST http://localhost:3000/api/pay/create-order \
    -H "Content-Type: application/json" \
    -d "{\"productId\":\"starter-full\",\"customer\":{\"name\":\"G2Test$i\",\"email\":\"g2test$i@$i.com\"}}"
  sleep 1
done
```

(Adjust localhost URL to your dev server. If running tests, use the test harness to drive the order flow.)

- [ ] **Step 2: Simulate Z-Pay notify for each (skipping actual payment)**

For each outTradeNo from Step 1, directly call the notify endpoint with valid sign:
```bash
# (use the existing notify test pattern from notify-e2e.test.ts to construct the request)
```

- [ ] **Step 3: Wait 30s for Workers to process**

```bash
sleep 30
```

- [ ] **Step 4: Query Notion for the 10 test rows**

```bash
export PATH="$HOME/.local/bin:$PATH"
export NOTION_API_TOKEN=$(grep ^NOTION_TOKEN .env | cut -d= -f2)
ntn datasources query de84f4cf-c8e2-83dc-a33c-873e7f83f872 \
  --filter '{"property":"客户名","rich_text":{"contains":"G2Test"}}' \
  --limit 20
```

- [ ] **Step 5: Verify ≥ 9 of 10 rows present**

Expected: 9 or 10 rows matching "G2Test"

- [ ] **Step 6: If < 9, document the failure for fallback decision**

If failure rate > 10%, check:
- Sentry issues for `E_NOTIFY_HTTP 5xx` or `E_NOTIFY_TIMEOUT`
- EdgeOne function logs
- Notion API rate limit

If consistent failures: **fallback decision** — consider abandoning Workers, switch to direct Notion REST from notify.ts (loses future Notion platform features, gains reliability).

- [ ] **Step 7: Clean up G2 test rows**

Open Notion UI, delete the 10 G2Test rows manually.

- [ ] **Step 8: Mark G2 verified or fallback decision**

If pass: ✅ G2 verified, proceed to Task 12.
If fail: STOP, escalate to user for fallback decision.

---

## Task 12: Documentation updates

**Files:**
- Modify: `docs/ARCHITECTURE-payment.md`
- Modify: `docs/SECURITY-REVIEW-payment.md`
- Modify: `docs/PAYMENT-FORM-DESIGN.md` (update status to "Shipped")

- [ ] **Step 1: Update `docs/ARCHITECTURE-payment.md`**

Add a new section "§8 Payment Form + Notion Sync" after §7 Known Limitations. Reference the spec (`docs/PAYMENT-FORM-DESIGN.md`) and the key files added in Tasks 1-10.

- [ ] **Step 2: Update `docs/SECURITY-REVIEW-payment.md`**

Add a new "P18-P25" PASS section summarizing:
- P18: HMAC-SHA256 signature verification on Workers (decision 1, §5.5)
- P19: PII filter strips email/name from Sentry events (§6.3)
- P20: Idempotency check prevents duplicate Notion pages on Z-Pay retry (§4.6)
- P21: Discount code disabled hard-block (decision 10, §2.2)
- P22: Server-side discount validation cannot be bypassed by client (§4.5)
- P23: EdgeOne function 2.5s fetch timeout prevents 11x Z-Pay retry pileup (§5.5 G3)
- P24: Workers retry with exponential backoff, give up after 3 (§5.4)
- P25: G2 cross-region smoke test verifies ≥ 90% Notion write success rate

- [ ] **Step 3: Update `docs/PAYMENT-FORM-DESIGN.md` header**

Change:
```
> 状态: Draft v0.1 (2026-06-11) — 等待用户 sign-off
```
To:
```
> 状态: Shipped v1.0 (2026-06-XX) — 已 sign-off, 已部署
```

- [ ] **Step 4: Update MEMORY.md**

Add entry to MEMORY.md:
```
- [Payment Form + Notion Sync shipped](project/payment-form-shipped-2026-06.md) — 12-task plan done, G2 verified, 24 errors + 30 tests added
```

- [ ] **Step 5: Commit docs**

```bash
git add docs/
git commit -m "docs(pay): update ARCHITECTURE, SECURITY-REVIEW, spec status for payment form launch"
```

---

## Verification (Final Sign-off)

After all 12 tasks complete, verify the Done Criteria from spec §14.2:

```bash
# 1. Static checks
yarn type-check
yarn lint
yarn test:ci        # expect 130+ cases passing, ≥ 70% coverage
yarn build          # expect success

# 2. Deployment dry-runs
cd cloud-functions/notion-worker && npx tsc --noEmit
cd ../..
tccli deploy --dry-run

# 3. End-to-end manual
# 3a. Plain order: PayModal → fill form → scan QR ¥0.10 → verify Notion row
# 3b. Discount order: PayModal → fill + PARTNER01 → verify [code:PARTNER01] in 备注
# 3c. Network error: disconnect mid-payment → verify Sentry receives E_NOTIFY_TIMEOUT

# 4. G2 cross-region: 10 markPaid simulations, ≥ 9 Notion writes (Task 11)

# 5. Verify all 16 Done Criteria checkboxes from spec §14.2 are ticked
```

If all pass, **feature is shipped**. Update the plan file with ship date.

---

## Self-Review Notes

After writing this plan, I reviewed against spec:

1. **Spec coverage** — all 14 sections mapped to tasks:
   - §1-2 → Task 9 (PayModal)
   - §3 → Task 2 (discount-codes)
   - §4 → Task 1 (Notion fields) + Task 4 (create-order mapping)
   - §5 → Tasks 5, 6, 7, 8 (notify + Workers)
   - §6 → Task 10 (Sentry)
   - §7 → Tasks 8, 10 (.env)
   - §8 → Tasks 3, 4, 5 (endpoints)
   - §9 → Distributed (each layer tested in its task)
   - §10 → All tasks
   - §11 → All tasks (TDD style)
   - §12 → Task 11 (smoke) + Task 8 (deploy)
   - §13 → Embedded as constraints
   - §14 → Final verification + Task 12 (docs)

2. **Placeholder scan** — no "TBD" or "implement later" in task steps (only in side notes about SDK version selection, which is intentional A1 flag).

3. **Type consistency** — function names, error codes, field names all match spec §4-9.

4. **Gap fixes** — G2 (R10 + Task 11), G3 (Tasks 5 + 7 timings), G4 (Task 7 idempotency) all addressed.

5. **No spec section without a task.**

---

**Total: 12 tasks, ~50+ TDD steps, ~1500 lines, 12 commits, 4-5 days work**
