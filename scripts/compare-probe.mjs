/**
 * 对照实验:区分"参数问题"与"上游排队/状态问题"。
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function once(label, model, extra) {
  const inbound = JSON.stringify({ model, messages: [{ role: 'user', content: '只回复一个字:好' }], ...extra })
  const prepared = prepareChatBody(inbound)
  const t0 = Date.now()
  const result = await chatStream(credential, prepared)
  if (!result.ok) {
    console.log(`${label}: HTTP ${result.status} ${result.message.slice(0, 150)}`)
    return
  }
  const reader = result.stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let frames = 0
  let first = ''
  let err = ''
  const deadline = t0 + 45_000
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
      if (payload === '[DONE]') break outer
      frames++
      if (!first) first = `t+${((Date.now() - t0) / 1000).toFixed(1)}s`
      try {
        const ev = JSON.parse(payload)
        if (ev.error && !err) err = JSON.stringify(ev.error).slice(0, 150)
      } catch {}
    }
  }
  await reader.cancel().catch(() => {})
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  if (err) console.log(`${label}: ❌ ${err}`)
  else if (frames === 0) console.log(`${label}: ⏳ 45s 内 0 帧(挂起)`)
  else console.log(`${label}: ✅ ${frames} 帧,首帧 ${first},总耗时 ${dt}s`)
}

console.log('--- 对照组 ---')
await once('1. GLM-5.2(商业) 最小请求', 'GLM-5.2', {})
await sleep(10_000)
await once('2. deepseek-v4.1-flash 最小请求', 'deepseek-v4.1-flash', {})
await sleep(10_000)
await once('3. deepseek-v4.1-flash max_tokens=8192', 'deepseek-v4.1-flash', { max_tokens: 8192 })
