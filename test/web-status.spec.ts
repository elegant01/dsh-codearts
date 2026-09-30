import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodeArtsAccountStore, credentialFromOAuth } from '../src/auth.ts'
import {
  CODEARTS_ACCOUNTS_PATH,
  CODEARTS_STATUS_PATH,
  registerCodeArtsStatusRoute,
} from '../src/web-status.ts'

/**
 * 路由层的测试：直接驱动注册进去的 handler，不经过 socket —— handler 只用到
 * method / url / headers 和 writeHead / end，用最小替身就够，比开真端口快得多。
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** 捕获 registerCodeArtsStatusRoute 注册的每个路由。 */
function mountRoutes(deps: Parameters<typeof registerCodeArtsStatusRoute>[1]): Map<string, Handler> {
  const routes = new Map<string, Handler>()
  const ctx = {
    effect: (fn: () => () => void) => fn(),
    webServer: {
      register: ({ path, handler }: { path: string; handler: Handler }) => {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }
  registerCodeArtsStatusRoute(ctx as never, deps)
  return routes
}

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers: { host: '127.0.0.1:3080', ...headers } } as unknown as IncomingMessage
}

function mockRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> | undefined } {
  let status = 0
  let payload = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: string) => { payload = chunk ?? '' },
  } as unknown as ServerResponse
  return {
    res,
    status: () => status,
    body: () => (payload === '' ? undefined : JSON.parse(payload) as Record<string, unknown>),
  }
}

async function call(
  handler: Handler,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const { res, status, body } = mockRes()
  await handler(mockReq(method, url, headers), res)
  return { status: status(), body: body() }
}

const LOOPBACK = 'http://127.0.0.1:3080'

let dir: string
let store: CodeArtsAccountStore
let routes: Map<string, Handler>

function credential(userId: string) {
  return credentialFromOAuth({
    securityToken: `sts-${userId}`,
    accessKeyId: 'AKID',
    secretAccessKey: 'SK',
    refreshToken: 'r',
    clientId: 'c',
    dpopPrivateKey: { kty: 'EC', crv: 'P-256' },
    expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    userId,
    userName: userId,
  } as never)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-codearts-routes-'))
  store = new CodeArtsAccountStore(join(dir, '.codearts-accounts.json'))
  routes = mountRoutes({ store, models: () => [] })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('DELETE /api/codearts/accounts', () => {
  it('removes the named account and answers with the fresh status document', async () => {
    await store.upsert(credential('uid-a'))
    await store.upsert(credential('uid-b'))

    const res = await call(routes.get(CODEARTS_ACCOUNTS_PATH)!, 'DELETE', `${CODEARTS_ACCOUNTS_PATH}?id=uid-a`)

    expect(res.status).toBe(200)
    expect(await store.ids()).toEqual(['uid-b'])
    expect((res.body?.accounts as { id: string }[]).map(a => a.id)).toEqual(['uid-b'])
  })

  it('rejects a request with no id', async () => {
    const res = await call(routes.get(CODEARTS_ACCOUNTS_PATH)!, 'DELETE', CODEARTS_ACCOUNTS_PATH)
    expect(res.status).toBe(400)
  })

  it('rejects a non-DELETE method', async () => {
    const res = await call(routes.get(CODEARTS_ACCOUNTS_PATH)!, 'GET', CODEARTS_ACCOUNTS_PATH)
    expect(res.status).toBe(405)
  })

  // 改状态的路由：只校验 Host 不够，DNS-rebinding 页面也能把 Host 写成 127.0.0.1。
  it('rejects a cross-origin request', async () => {
    await store.upsert(credential('uid-a'))
    const res = await call(
      routes.get(CODEARTS_ACCOUNTS_PATH)!,
      'DELETE',
      `${CODEARTS_ACCOUNTS_PATH}?id=uid-a`,
      { origin: 'http://evil.example' },
    )
    expect(res.status).toBe(403)
    expect(await store.ids()).toEqual(['uid-a'])
  })

  it('rejects a non-loopback Host', async () => {
    const res = await call(
      routes.get(CODEARTS_ACCOUNTS_PATH)!,
      'DELETE',
      `${CODEARTS_ACCOUNTS_PATH}?id=uid-a`,
      { host: 'evil.example' },
    )
    expect(res.status).toBe(403)
  })

  it('requires a loopback Origin for the status route too', async () => {
    const res = await call(routes.get(CODEARTS_ACCOUNTS_PATH)!, 'DELETE', `${CODEARTS_ACCOUNTS_PATH}?id=x`, { origin: LOOPBACK })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/codearts/status', () => {
  it('reports signed-out with no accounts', async () => {
    const res = await call(routes.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    expect(res.status).toBe(200)
    expect(res.body?.status).toBe('signed-out')
    expect(res.body?.accounts).toEqual([])
  })

  it('lists stored accounts', async () => {
    await store.upsert(credential('uid-a'))
    const res = await call(routes.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    expect(res.body?.status).toBe('signed-in')
    expect((res.body?.accounts as { id: string }[]).map(a => a.id)).toEqual(['uid-a'])
  })

  // 一个账号过期不该让整张卡片显示「未登录」——别的账号还能用。
  it('stays signed-in while any account is still usable', async () => {
    await store.upsert(credential('uid-a'))
    await store.upsert({
      token: 'pasted',
      storedAt: Date.now(),
      expiration: '2000-01-01T00:00:00Z',
    })
    const res = await call(routes.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    expect(res.body?.status).toBe('signed-in')
  })

  it('reports expired when every account is stale', async () => {
    await store.upsert({ token: 'pasted', storedAt: Date.now(), expiration: '2000-01-01T00:00:00Z' })
    const res = await call(routes.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    expect(res.body?.status).toBe('expired')
  })
})
