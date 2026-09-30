/**
 * 端到端真流验证:模拟 DSH 实际会发的内容(system + tools + max_tokens=65536),
 * 走完整链路(shim 的 prepareChatBody → chatStream),直连真实上游。
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

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash'

// 模拟 pi-ai → shim 的原始入站请求(修复前的形状:pi-ai 的 OpenAI 专有字段全带)
const inbound = JSON.stringify({
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are a helpful coding assistant.' },
    { role: 'user', content: '只回复两个字:收到' },
  ],
  stream: true,
  stream_options: { include_usage: true },
  store: false,
  max_completion_tokens: 65536,
  tools: [{
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      strict: false,
    },
  }],
})

const prepared = prepareChatBody(inbound)
console.log('model:', prepared.model)
console.log('cleaned body:', prepared.body.slice(0, 400))

const result = await chatStream(credential, prepared)
if (!result.ok) {
  console.log('❌ HTTP 失败:', result.status, result.message.slice(0, 300))
  process.exit(1)
}
const reader = result.stream.getReader()
const decoder = new TextDecoder()
let text = ''
let full = ''
let frames = 0
const t0 = Date.now()
const deadline = t0 + 30_000
try {
  outer: while (Date.now() < deadline) {
    const remain = deadline - Date.now()
    const chunk = await Promise.race([
      reader.read(),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remain)),
    ])
    if (chunk.timeout) { console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] 读取超时`); break }
    if (chunk.done) { console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] 流结束`); break }
    text += decoder.decode(chunk.value, { stream: true })
    const lines = text.split('\n')
    text = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') { console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] [DONE]`); break outer }
      frames++
      try {
        const ev = JSON.parse(payload)
        if (ev.error) { console.log('❌ 流内错误:', JSON.stringify(ev.error).slice(0, 300)); process.exit(1) }
        const delta = ev.choices?.[0]?.delta?.content ?? ev.choices?.[0]?.delta?.reasoning_content
        if (delta) full += delta
        if (frames <= 3) console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] frame:`, JSON.stringify(ev).slice(0, 220))
      } catch {}
    }
  }
} finally {
  await reader.cancel().catch(() => {})
}
console.log(`共 ${frames} 帧;模型输出:`, JSON.stringify(full.slice(0, 200)))
console.log(full ? '✅ 端到端成功' : '⚠️ 无错误但无内容')
