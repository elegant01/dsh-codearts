/**
 * 抓完整流的所有帧,重点看最后一帧的 usage(决定 DSH 底部用量药丸能否显示)。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prepareChatBody, chatStream } from '../src/upstream.ts'

const credRaw = JSON.parse(readFileSync(join(homedir(), '.dsh', '.codearts-auth.json'), 'utf8'))
const credential = {
  token: credRaw.token,
  accessKeyId: credRaw.accessKeyId,
  secretAccessKey: credRaw.secretAccessKey,
  securityToken: credRaw.token,
}

const inbound = JSON.stringify({
  model: process.argv[2] ?? 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: '只回复两个字:收到' }],
  max_tokens: 8192,
})
const prepared = prepareChatBody(inbound)
const result = await chatStream(credential, prepared)
if (!result.ok) { console.log('HTTP 失败:', result.status, result.message.slice(0, 200)); process.exit(1) }
const reader = result.stream.getReader()
const decoder = new TextDecoder()
let buf = ''
const frames = []
const deadline = Date.now() + 60_000
try {
  outer: while (Date.now() < deadline) {
    const remain = deadline - Date.now()
    const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ timeout: true }), remain))])
    if (chunk.timeout || chunk.done) break
    buf += decoder.decode(chunk.value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') { console.log('[流以 [DONE] 结束]'); break outer }
      try { frames.push(JSON.parse(payload)) } catch {}
    }
  }
  // 流结束后把残留的最后一行也处理掉(真实 usage 帧常在这里)
  for (const line of buf.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try { frames.push(JSON.parse(payload)) } catch {}
  }
} finally {
  await reader.cancel().catch(() => {})
}
console.log(`共 ${frames.length} 帧`)
console.log('=== 首 2 帧 ===')
for (const f of frames.slice(0, 2)) console.log(JSON.stringify(f).slice(0, 300))
console.log('=== 非 0 usage 帧 ===')
let found = false
for (const f of frames) {
  const u = f.usage
  if (u && (u.prompt_tokens > 0 || u.completion_tokens > 0 || u.total_tokens > 0)) { console.log(JSON.stringify(f).slice(0, 500)); found = true }
}
if (!found) console.log('(无)')
console.log('=== 末 2 帧 ===')
for (const f of frames.slice(-2)) console.log(JSON.stringify(f).slice(0, 400))
