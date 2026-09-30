/**
 * 独立探针：验证 CodeArts OAuth 登录链路（桌面版 DSH 环境）。
 * 运行：node --experimental-strip-types scripts/probe-login.ts
 *
 * 它会：起本地回调 → 打印授权 URL → 你浏览器登录 → 自动换 token → 打印并落盘到 .codearts-auth.json
 * 不依赖 DSH 宿主，纯验证协议。
 */
import { startLogin, defaultLoginConfig } from '../src/oauth.ts'
import { saveCredential, credentialFromOAuth, codeartsAuthPath } from '../src/auth.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cfg = defaultLoginConfig()
const session = await startLogin(cfg)
console.log('\n=== 请在浏览器打开下面链接，用华为云账号登录 ===\n')
console.log('  ' + session.url + '\n')
console.log('（桌面版会自动跳回 127.0.0.1；登录成功后此脚本会自动继续）\n')

try {
  const token = await session.promise
  console.log('\n✅ 登录成功：')
  console.log('  user_id =', token.userId)
  console.log('  user_name =', token.userName)
  console.log('  expiration =', token.expiration)
  console.log('  access_key_id =', token.accessKeyId?.slice(0, 8) + '…')
  console.log('  has refresh_token =', Boolean(token.refreshToken))

  const path = codeartsAuthPath(join(homedir(), '.dsh'))
  await saveCredential(path, credentialFromOAuth(token))
  console.log('\n凭证已落盘：', path)
  console.log('接下来可运行：node --experimental-strip-types scripts/probe-chat.ts')
} catch (err) {
  console.error('\n❌ 登录失败：', err)
  process.exit(1)
}
