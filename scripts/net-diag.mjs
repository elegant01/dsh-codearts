/**
 * 复刻 chatStream 的原始抓包,并保留请求头做 diff。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { prepareChatBody } from '../src/upstream.ts'
import { signRequest } from '../src/signer.ts'

const credRaw = JSON.parse(readFileSync(join(homedir(), '.dsh', '.codearts-auth.json'), 'utf8'))
const credential = {
  token: credRaw.token,
  accessKeyId: credRaw.accessKeyId,
  secretAccessKey: credRaw.secretAccessKey,
  securityToken: credRaw.token,
}

const inbound = JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: '只回复一个字:好' }], max_tokens: 8192 })
const prepared = prepareChatBody(inbound)
const bodyBuf = Buffer.from(prepared.body)

const req = new Request(prepared.url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'x-auth-token': credential.token,
    'X-Security-Token': credential.securityToken,
    'x-snap-traceid': randomBytes(16).toString('hex'),
    'X-Language': 'zh-cn',
    'app-id': 'CodeAgent3.0',
    'is_confidential': 'false',
  },
  body: bodyBuf,
})
signRequest(req, bodyBuf, {
  accessKeyId: credential.accessKeyId,
  secretAccessKey: credential.secretAccessKey,
  securityToken: credential.securityToken,
})

console.log('=== 请求头(与 chatStream 完全一致) ===')
for (const [k, v] of req.headers.entries()) {
  console.log(`${k}: ${k.includes('auth') || k === 'x-security-token' ? v.slice(0, 40) + '...' : v}`)
}

const t0 = Date.now()
const dt = () => `t+${((Date.now() - t0) / 1000).toFixed(2)}s`
console.log(dt(), '发起请求')
const resp = await fetch(req)
console.log(dt(), 'HTTP', resp.status)
const reader = resp.body.getReader()
const decoder = new TextDecoder()
try {
  while (Date.now() - t0 < 45_000) {
    const remain = 45_000 - (Date.now() - t0)
    const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ timeout: true }), remain))])
    if (chunk.timeout) { console.log(dt(), '45s 无字节'); break }
    if (chunk.done) { console.log(dt(), 'body 结束'); break }
    console.log(dt(), '收到:', decoder.decode(chunk.value, { stream: true }).slice(0, 300))
  }
} finally {
  await reader.cancel().catch(() => {})
}
