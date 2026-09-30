import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 可手动兑现的 promise，用来驱动假登录会话。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const { startLoginMock } = vi.hoisted(() => ({ startLoginMock: vi.fn() }))

vi.mock('../src/oauth.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/oauth.ts')>()
  return { ...actual, startLogin: startLoginMock }
})

import { CodeArtsAccountStore, credentialFromOAuth } from '../src/auth.ts'
import {
  CODEARTS_ACCOUNTS_PATH,
  CODEARTS_LOGIN_PATH,
  CODEARTS_LOGIN_STATUS_PATH,
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
  startLoginMock.mockReset()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 一次假登录：startLogin 返回一个由测试手动控制的会话。 */
function fakeLogin(url = 'https://codearts.huaweicloud.com/portal/authorize?fake=1') {
  const outcome = deferred<Parameters<typeof credentialFromOAuth>[0]>()
  startLoginMock.mockResolvedValue({
    url,
    port: 49000,
    promise: outcome.promise,
    close: () => {},
  })
  return outcome
}

const POST = 'POST'
const GET = 'GET'

describe('login flow', () => {
  const poll = (url: string): Promise<{ status: number; body: Record<string, unknown> | undefined }> =>
    call(routes.get(CODEARTS_LOGIN_STATUS_PATH)!, GET, `${CODEARTS_LOGIN_STATUS_PATH}?url=${encodeURIComponent(url)}`)

  it('reports pending while the login is in flight', async () => {
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    const res = await poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')
    expect(res.body?.status).toBe('pending')
    expect(startLoginMock).toHaveBeenCalledTimes(1)
  })

  // 回归守卫：这是用户实际撞到的 bug。旧实现里，登录完成只会把「done」交给
  // 当时正好在等的那一个轮询；它兑现后所有叠着的回调还会把会话从表里删掉，
  // 于是下一次轮询只拿到 'idle'，客户端不处理 idle，按钮永远停在「登录中」。
  // 现在终态被服务端记住，**第一个**迟到的轮询必须拿到 done。
  it('delivers done to a poll that arrives after the login completed', async () => {
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    outcome.resolve({
      securityToken: 'sts', accessKeyId: '', secretAccessKey: '', refreshToken: 'r',
      clientId: 'c', dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      expiration: new Date(Date.now() + 3600_000).toISOString(), userId: 'uid-new', userName: 'tester',
    } as never)

    // 终态在落库（异步文件写）完成后才记录；idle 不会消费 recent，所以持续轮询
    // 直到拿到 done —— 旧实现里迟到的轮询永远只能拿到 idle，这里会超时报错。
    await vi.waitFor(async () => {
      expect((await poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')).body?.status).toBe('done')
    })
    expect(await store.ids()).toEqual(['uid-new'])
  })

  it('persists the account exactly once no matter how many polls race the settle', async () => {
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    // 兑现前先叠几个轮询（真实场景：卡片每 1.5s 一次，登录瞬间往往叠着好几个）
    const p1 = poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')
    const p2 = poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')
    outcome.resolve({
      securityToken: 'sts', accessKeyId: '', secretAccessKey: '', refreshToken: 'r',
      clientId: 'c', dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      expiration: new Date(Date.now() + 3600_000).toISOString(), userId: 'uid-new', userName: 'tester',
    } as never)
    await Promise.all([p1, p2])
    // 落库是异步文件写，等它真正完成再断言。
    await vi.waitFor(async () => {
      expect(await store.ids()).toEqual(['uid-new'])
    })
  })

  it('reports error when the login fails', async () => {
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    outcome.reject(new Error('exchange failed'))
    await new Promise(r => setImmediate(r))
    expect((await poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')).body?.status).toBe('error')
  })

  it('reports idle for a session that never existed', async () => {
    expect((await poll('https://nope.example/')).body?.status).toBe('idle')
  })
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
