/**
 * 独立探针：验证 CodeArts 聊天链路（含限时福利模型 + maas_type:benefit 头）。
 * 运行：node --experimental-strip-types scripts/probe-chat.ts "你的问题" [模型]
 *
 * 依赖 probe-login.ts 已落盘的 .codearts-auth.json。
 */
import { loadCredential, codeartsAuthPath } from '../src/auth.ts'
import { prepareChatBody, chatStream, claimBenefit } from '../src/upstream.ts'
import { isBenefitModel } from '../src/catalog.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

async function main(): Promise<void> {
  const question = process.argv[2] ?? '用一句话介绍你自己。'
  const path = codeartsAuthPath(join(homedir(), '.dsh'))
  const cred = await loadCredential(path)
  if (!cred || !cred.accessKeyId || !cred.secretAccessKey) {
    console.error('❌ 未找到完整凭证（请先跑 probe-login.ts）。')
    process.exit(1)
  }

  const resolved = {
    token: cred.token,
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secretAccessKey,
    securityToken: cred.token,
  }

  // 先领取限时福利（幂等），再测福利模型
  if (cred.accessKeyId && cred.secretAccessKey) {
    try {
      await claimBenefit(resolved)
      console.log('→ claimBenefit: OK（已领取/已存在）')
    } catch (e) {
      console.log('→ claimBenefit 失败（不阻断）:', (e as Error).message)
    }
  }

  const model = process.argv[3] ?? 'deepseek-v4-flash-0731'
  const prepared = prepareChatBody(
    JSON.stringify({
      model,
      messages: [{ role: 'user', content: question }],
      stream: true,
    }),
  )

  const benefit = isBenefitModel(prepared.model)
  console.log('→ 请求端点：', prepared.url)
  console.log('→ 模型：', prepared.model, '| 福利路由(maas_type:benefit):', benefit)

  // 诊断：直接 fetch 看原始响应（含福利头）
  const bodyBuf = Buffer.from(prepared.body)
  const url = new URL(prepared.url)
  const fetchReq = new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-auth-token': resolved.token,
      'X-Security-Token': resolved.securityToken,
      'x-snap-traceid': 'diag0000000000000000000000000000',
      'X-Language': 'zh-cn',
      'app-id': 'CodeAgent3.0',
      'is_confidential': 'false',
      ...(benefit ? { maas_type: 'benefit' } : {}),
    },
    body: bodyBuf,
  })
  const { signRequest } = await import('../src/signer.ts')
  signRequest(fetchReq, bodyBuf, {
    accessKeyId: resolved.accessKeyId,
    secretAccessKey: resolved.secretAccessKey,
    securityToken: resolved.securityToken,
  })
  console.log('→ 实际发送 maas_type:', fetchReq.headers.get('maas_type'))

  const diag = await fetch(fetchReq)
  console.log('→ HTTP 状态：', diag.status)
  console.log('→ Content-Type：', diag.headers.get('content-type'))
  const rawText = await diag.text()
  console.log('→ 原始响应前 800 字符：')
  console.log(rawText.slice(0, 800))

  if (!diag.ok) {
    console.error('❌ 上游拒绝请求')
    process.exit(1)
  }

  if (rawText.includes('data:') || (diag.headers.get('content-type') ?? '').includes('text/event-stream')) {
    console.log('--- 转换后的 OpenAI SSE（逐帧）---')
    const result = await chatStream(resolved, prepared)
    if (!result.ok) {
      console.error('❌ 转换失败：', result.kind, result.status, result.message)
      process.exit(1)
    }
    const reader = result.stream.getReader()
    const dec = new TextDecoder()
    let acc = ''
    let n = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const text = dec.decode(value, { stream: true })
      acc += text
      for (const frame of text.split('\n\n')) {
        const t = frame.trim()
        if (!t) continue
        console.log(t)
        if (++n > 80) break
      }
      if (n > 80) break
    }
    console.log('\n--- 文本累计长度：', acc.length, '---')
  }
}

void main().catch((err) => {
  console.error('探针异常：', err)
  process.exit(1)
})
