/**
 * ⚠️ ONE-SHOT bootstrap endpoint — DELETE THIS FILE after first use!
 *
 * 为什么需要这个文件：
 *   - EdgeOne Blob Storage 控制台只读，没有上传入口
 *   - 控制台文档原话："通过 Blob SDK 首次调用即自动创建，无需手动配置"
 *   - 所以我们必须通过 SDK 写一次 PEM，之后 SDK 才能 get
 *
 * 路径映射：cloud-functions/api/_internal/populate-blob.ts → POST /api/_internal/populate-blob
 *
 * 用法（一次性）：
 *   1. 控制台 env 设 BLOB_BOOTSTRAP_TOKEN（任意 32+ 字符）
 *   2. 等 EdgeOne redeploy
 *   3. curl -X POST -H "X-Bootstrap-Token: ..." -d @/tmp/payload.json https://www.one2agi.com/api/_internal/populate-blob
 *   4. 验证主 API /api/pay/create-order 工作
 *   5. 删 env BLOB_BOOTSTRAP_TOKEN
 *   6. 删此文件 + push cleanup
 */

interface EventContext {
  request: Request
  env: Record<string, string>
  params: Record<string, string>
}

const EXPECTED_BUCKET = 'wxpay-secrets'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' }
  })
}

export async function onRequestPost(context: EventContext): Promise<Response> {
  try {
    // Token 鉴权：env BLOB_BOOTSTRAP_TOKEN 设了就要 header 匹配
    const expectedToken = context.env.BLOB_BOOTSTRAP_TOKEN
    if (expectedToken) {
      const providedToken = context.request.headers.get('X-Bootstrap-Token')
      if (providedToken !== expectedToken) {
        return jsonResponse(
          { error: 'Invalid or missing X-Bootstrap-Token header' },
          401
        )
      }
    }

    const body = (await context.request.json().catch(() => ({}))) as {
      key?: string
      content?: string
    }
    const { key, content } = body
    if (!key || typeof content !== 'string') {
      return jsonResponse(
        { error: 'Body must be JSON: {"key": string, "content": string}' },
        400
      )
    }
    if (content.length === 0) {
      return jsonResponse({ error: 'content is empty' }, 400)
    }
    if (content.length > 5_000_000) {
      return jsonResponse({ error: 'content too large (max 5 MB)' }, 400)
    }

    // 动态 import 避免 ESM 解析问题（虽然裸包名 import 应该可以，但保持动态一致）
    const { getStore } = await import('@edgeone/pages-blob')
    const store = getStore(EXPECTED_BUCKET)
    await store.set(key, content)

    return jsonResponse({
      ok: true,
      bucket: EXPECTED_BUCKET,
      key,
      contentLength: content.length,
      message: 'Bucket auto-created on first call (if not existed). Object written. **This is a one-shot endpoint — please delete the source file after use.**'
    })
  } catch (e: any) {
    console.error('[populate-blob]', e)
    return jsonResponse(
      { error: e?.message || 'Internal Server Error' },
      500
    )
  }
}
