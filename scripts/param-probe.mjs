/**
 * 参数二分探针:用真实凭证直连华为 /api/v2/chat/completions,
 * 逐项测试哪个参数触发流内 "The request param is invalid"。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prepareChatBody, chatStream, claimBenefit } from '../src/upstream.ts'

const credRaw = JSON.parse(readFileSync(join(homedir(), '.dsh', '.codearts-auth.json'), 'utf8'))
const credential = {
  token: credRaw.token,
  accessKeyId: credRaw.accessKeyId,
  secretAccessKey: credRaw.secretAccessKey,
  securityToken: credRaw.token,
}

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash'
const base = { model: MODEL, messages: [{ role: 'user', content: '只回复一个字:好' }] }

// 各实验:确认 deepseek-v4-flash-0731 的上限
const VARIANTS = {
  'max_tokens=393216(catalog现值)': { max_tokens: 393216 },
  'max_tokens=65536': { max_tokens: 65536 },
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function probeOnce(name, extra) {
  const body = JSON.stringify({ ...base, ...extra })
  const prepared = prepareChatBody(body)
  const result = await chatStream(credential, prepared)
  if (!result.ok) {
    return { kind: 'http', status: result.status, text: result.message.slice(0, 200) }
  }
  const reader = result.stream.getReader()
  const decoder = new TextDecoder()
  let first = ''
  const deadline = Date.now() + 25_000
  try {
    while (Date.now() < deadline && first.length < 800) {
      const remain = deadline - Date.now()
      const chunk = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remain)),
      ])
      if (chunk.timeout || chunk.done) break
      first += decoder.decode(chunk.value, { stream: true })
      if (first.includes('[DONE]')) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { kind: 'stream', text: first }
}

async function probe(name, extra) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await probeOnce(name, extra)
    if (r.kind === 'http' && r.text.includes('TM.00001041')) {
      process.stdout.write(`${name}: 并发限制,等待 45s 后重试(${attempt}/4)...\n`)
      await sleep(45_000)
      continue
    }
    if (r.kind === 'http') {
      console.log(`${name}: HTTP 失败 status=${r.status} msg=${r.text}`)
      return
    }
    const hasError = r.text.includes('InferHub') || (r.text.includes('error_code') && !r.text.includes('"error_code":"0"'))
    const preview = r.text.replace(/\s+/g, ' ').slice(0, 220)
    console.log(`${name}: ${hasError ? '❌ 拒绝' : '✅ 接受'} | ${preview}`)
    return
  }
  console.log(`${name}: 多次重试仍被并发限制`)
}

console.log(`model = ${MODEL}`)
console.log('先领取福利(幂等)...')
try { await claimBenefit(credential); console.log('claimBenefit 完成') } catch (e) { console.log('claimBenefit 失败(继续):', String(e).slice(0, 150)) }
console.log('')

for (const [name, extra] of Object.entries(VARIANTS)) {
  await probe(name, extra)
}
