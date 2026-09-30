/**
 * 补隔壁 2×2 缺的那一格：DSH 真实发的形状（tools + tool_stream + 大 system）。
 * 全部走生产函数 prepareChatBody，不手搓 body，免得测的是另一个东西。
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
const MODEL = 'deepseek-v4.1-flash'

const TOOLS = [{
  type: 'function',
  function: {
    name: 'read',
    description: '读取文件内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}]
// DSH 的 system prompt 实测 5925 字符，这里造一个同量级的
const BIG_SYS = '你是一个助手。' + '规则如下，请严格遵守并逐条执行。'.repeat(400)

async function once(label, rawBody) {
  const prepared = prepareChatBody(JSON.stringify(rawBody))
  const t0 = Date.now()
  const result = await chatStream(credential, prepared)
  if (!result.ok) { console.log(`${label}: ❌ HTTP ${result.status} ${result.message.slice(0, 150)}`); return }
  const reader = result.stream.getReader()
  const decoder = new TextDecoder()
  let buf = '', frames = 0, text = '', toolCall = false, err = ''
  const deadline = t0 + 40_000
  try {
    outer: while (Date.now() < deadline) {
      const remain = deadline - Date.now()
      const c = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ timeout: true }), remain))])
      if (c.timeout || c.done) break
      buf += decoder.decode(c.value, { stream: true })
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
          if (d?.tool_calls) toolCall = true
        } catch {}
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  const verdict = err ? `❌ ${err}` : frames === 0 ? '⏳ 0帧挂起' : text === '' && !toolCall ? `⚠ ${frames}帧但无正文` : '✅'
  console.log(`${label}: ${verdict}  ${frames}帧 ${dt}s toolCall=${toolCall} 正文=${JSON.stringify(text.slice(0, 40))}`)
}

const plain = { model: MODEL, messages: [{ role: 'user', content: '只回复两个字:收到' }], max_tokens: 8000 }

// 对照组：隔壁 A 已证明能过，这里用生产函数再走一遍，确认 prepareChatBody 本身没问题
await once('D0 无tools无system(生产路径)', plain)
await sleep(6000)

// 关键格：tools + tool_stream（DSH 每轮都发这个）
await once('D1 带tools + tool_stream  ', { ...plain, messages: [{ role: 'user', content: '请调用 read 工具查看 /tmp/a.txt' }], tools: TOOLS })
await sleep(6000)

// 大 system 单独是否是变量
await once('D2 大system 无tools      ', { ...plain, messages: [{ role: 'system', content: BIG_SYS }, { role: 'user', content: '只回复两个字:收到' }] })
await sleep(6000)

// 生产完整形状：大 system + tools
await once('D3 大system + tools      ', { ...plain, messages: [{ role: 'system', content: BIG_SYS }, { role: 'user', content: '请调用 read 工具查看 /tmp/a.txt' }], tools: TOOLS })
