/**
 * 对照实验:tool_stream 注入 vs 不注入,上游行为差异。
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

async function once(label, bodyObj) {
  const prepared = { url: 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions', body: JSON.stringify(bodyObj), model: bodyObj.model }
  const t0 = Date.now()
  const result = await chatStream(credential, prepared)
  if (!result.ok) { console.log(`${label}: HTTP ${result.status} ${result.message.slice(0, 160)}`); return }
  const reader = result.stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let frames = 0
  let text = ''
  let hasToolCall = false
  let err = ''
  const deadline = t0 + 40_000
  try {
    outer: while (Date.now() < deadline) {
      const remain = deadline - Date.now()
      const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ timeout: true }), remain))])
      if (chunk.timeout || chunk.done) break
      buf += decoder.decode(chunk.value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        if (payload === '[DONE]') break outer
        frames++
        try {
          const ev = JSON.parse(payload)
          if (ev.error && !err) err = JSON.stringify(ev.error).slice(0, 140)
          const d = ev.choices?.[0]?.delta
          if (d?.content) text += d.content
          if (d?.tool_calls) hasToolCall = true
        } catch {}
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  if (err) console.log(`${label}: ❌ ${err}`)
  else if (frames === 0) console.log(`${label}: ⏳ 40s 0 帧(挂起)`)
  else console.log(`${label}: ✅ ${frames}帧 ${dt}s toolCall=${hasToolCall} 回复=${JSON.stringify(text.slice(0, 60))}`)
}

const base = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: '只回复两个字:收到' }], max_tokens: 8192, stream: true, stream_options: { include_usage: true } }

// 1. 带 tool_stream(现状)
await once('A 带 tool_stream + chat_id    ', { ...base, chat_id: 'a'.repeat(32), prompt_cache_key: 'a'.repeat(32), tool_stream: true })
await sleep(8000)
// 2. 不带 tool_stream(拟改)
await once('B 纯净(无 tool_stream/chat_id)', { ...base })
await sleep(8000)
// 3. 带 tools 但不带 tool_stream —— 关键:工具调用是否还正常
await once('C tools 但无 tool_stream     ', {
  ...base,
  messages: [{ role: 'user', content: '请调用 read 工具查看 /tmp/a.txt' }],
  tools: [{ type: 'function', function: { name: 'read', description: '读取文件内容', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
})
