export interface CodeArtsSettingsKey {
  tabLabel: string
  cardTitle: string
  statusSignedIn: string
  statusSignedOut: string
  statusExpired: string
  descSignedIn: string
  descSignedOut: string
  storedMeta: string
  storedMetaNoLabel: string
  refresh: string
  clearToken: string
  tokenLabel: string
  tokenPlaceholder: string
  labelLabel: string
  labelPlaceholder: string
  saveToken: string
  expiredHint: string
  accountsTitle: string
  accountsShow: string
  accountsHide: string
  accountRemove: string
  addAccount: string
  accountsRotateHint: string
  accountNeedsSignIn: string
  accountNoKey: string
  accountStored: string
  accountExpires: string
  accountExpired: string
  modelsTitle: string
  optionalModelsHint: string
  optionalModelsAllHint: string
  selectedCount: string
  selectAll: string
  benefit: string
  benefitBlocked: string
  benefitBlockedHint: string
  refreshModels: string
  refreshing: string
  refreshed: string
  refreshStale: string
  refreshFailed: string
  saveModels: string
  saving: string
  saved: string
  signIn: string
  signingIn: string
  openManually: string
  manualToken: string
  loginFailed: string
  modelsLoading: string
  usageTitle: string
  usageToday: string
  usageRequests: string
  usageTokens: string
  usageAllTime: string
  usageByModel: string
  usageSlots: string
  usageStateOk: string
  usageStateCapped: string
  usageStateCooling: string
  usageStateDisabled: string
  usageNoQuota: string
  usageEmpty: string
  creditsTitle: string
  creditsRemaining: string
  creditsUsed: string
  creditsExpiring: string
  creditsReset: string
  creditsTokensToday: string
  creditsTokensBalance: string
  creditsUnavailable: string
  creditsDock: string
  creditsDockTitle: string
  claimButton: string
  claimButtonDone: string
  claimPending: string
  claimHint: string
  claimDone: string
  claimAlready: string
  claimUnavailable: string
  claimFailed: string
  [key: string]: string
}

export const zh: CodeArtsSettingsKey = {
  tabLabel: 'CodeArts',
  cardTitle: 'DSH CodeArts Connect',
  statusSignedIn: '已登录',
  statusSignedOut: '未登录',
  statusExpired: '凭证已过期',
  descSignedIn: '凭证已就绪，勾选的模型会出现在模型选择器里。',
  descSignedOut: '用华为云账号登录，或手动粘贴一个 CodeArts cloud_dragon_token。',
  storedMeta: '{label} · 存于 {time}',
  storedMetaNoLabel: '存于 {time}',
  refresh: '刷新',
  clearToken: '清除凭证',
  tokenLabel: 'cloud_dragon_token',
  tokenPlaceholder: '粘贴从 CodeArts 网页/桌面端拿到的 token……',
  labelLabel: '备注（可选）',
  labelPlaceholder: '例如账号昵称，便于区分',
  saveToken: '保存 token',
  expiredHint: '凭证已过期，请重新登录以继续使用；已勾选的模型设置会保留。',
  accountsTitle: '账号',
  accountsShow: '显示账号',
  accountsHide: '隐藏账号',
  accountRemove: '删除',
  addAccount: '添加账号',
  accountsRotateHint: '已存多个账号：请求会自动轮转，某个账号忙时改用下一个，不用干等。',
  accountNeedsSignIn: '需重新登录',
  accountNoKey: '无 AK/SK',
  accountStored: '获取于 {time}',
  accountExpires: '{time} 过期',
  accountExpired: '已于 {time} 过期',
  modelsTitle: '可选模型',
  optionalModelsHint: '仅勾选的模型会出现在模型选择器里。',
  optionalModelsAllHint: '所有模型默认都出现在选择器里；取消勾选不想用的即可。',
  selectedCount: '已选 {n} / {total}',
  selectAll: '全选',
  benefit: '福利',
  benefitBlocked: '福利今日不可用',
  benefitBlockedHint: '{n} 个福利模型今天被上游判定没有权益（活动领完或渠道未开），发出去会直接报 benefit not found。',
  refreshModels: '刷新模型列表',
  refreshing: '刷新中…',
  refreshed: '已刷新：{n} 个模型，其中 {benefit} 个走福利路由',
  refreshStale: '上游没回应，仍是旧名单（{n} 个模型）',
  refreshFailed: '刷新失败：{message}',
  saveModels: '保存模型选择',
  saving: '保存中…',
  saved: '已保存',
  signIn: '使用华为云账号登录',
  signingIn: '登录中…（请在浏览器完成授权）',
  openManually: '若未自动打开，请手动访问：',
  manualToken: '手动粘贴 token（降级）',
  loginFailed: '登录失败，请重试',
  modelsLoading: '模型勾选区加载中…（若长期不出现，请确认已登录且 DSH 已完全重启）',
  usageTitle: '本机用量',
  usageToday: '今日',
  usageRequests: '{n} 次请求',
  usageTokens: '输入 {prompt} · 输出 {completion}',
  usageAllTime: '累计（{days} 天）',
  usageByModel: '今日按模型',
  usageSlots: '会话槽位',
  usageStateOk: '可用',
  usageStateCapped: '撞上限，优先避开',
  usageStateCooling: '冷却中',
  usageStateDisabled: '已停用',
  usageNoQuota: '这里是本机经插件发出的请求统计（不等于账号总额度）；官方用量明细见',
  usageEmpty: '还没有记录：发一条消息就会开始累计。',
  creditsTitle: '积分',
  creditsRemaining: '剩余 {remain} / {total}',
  creditsUsed: '已用 {used}',
  creditsExpiring: '其中 {expiring} 将在 {date} 重置时作废',
  creditsReset: '额度重置 {date}',
  creditsTokensToday: '今日 token {used} / {limit}',
  creditsTokensBalance: '余额 {balance}',
  creditsUnavailable: '积分不可用：{message}',
  creditsDock: '积分 {remain}',
  creditsDockTitle: 'CodeArts 剩余积分 {remain} / {total}',
  claimButton: '签到领积分',
  claimButtonDone: '今日已领',
  claimPending: '领取中…',
  claimHint: '每天领一次 1000 积分，走官方福利中心接口（与客户端里那个「每日签到」同一件事）。',
  claimDone: '已领取 {amount} 积分',
  claimAlready: '今日已领，明天再来',
  claimUnavailable: '这个账号当前没有可领的签到活动',
  claimFailed: '领取失败：{message}',
}

export const en: CodeArtsSettingsKey = {
  tabLabel: 'CodeArts',
  cardTitle: 'DSH CodeArts Connect',
  statusSignedIn: 'Signed in',
  statusSignedOut: 'Not signed in',
  statusExpired: 'Credential expired',
  descSignedIn: 'Credential is ready. Checked models show up in the model picker.',
  descSignedOut: 'Sign in with your Huawei Cloud account, or paste a CodeArts cloud_dragon_token.',
  storedMeta: '{label} · stored {time}',
  storedMetaNoLabel: 'stored {time}',
  refresh: 'Refresh',
  clearToken: 'Clear credential',
  tokenLabel: 'cloud_dragon_token',
  tokenPlaceholder: 'Paste the token taken from the CodeArts web/desktop client……',
  labelLabel: 'Label (optional)',
  labelPlaceholder: 'e.g. account nickname',
  saveToken: 'Save token',
  expiredHint: 'Your credential has expired. Sign in again to continue; your model selection is kept.',
  accountsTitle: 'Accounts',
  accountsShow: 'Show accounts',
  accountsHide: 'Hide accounts',
  accountRemove: 'Remove',
  addAccount: 'Add account',
  accountsRotateHint: 'Multiple accounts stored: requests rotate automatically, so a busy account hands over to the next one instead of making you wait.',
  accountNeedsSignIn: 'Needs sign-in',
  accountNoKey: 'No AK/SK',
  accountStored: 'stored {time}',
  accountExpires: 'expires {time}',
  accountExpired: 'expired {time}',
  modelsTitle: 'Models',
  optionalModelsHint: 'Only checked models appear in the model picker.',
  optionalModelsAllHint: 'All models show in the picker by default; uncheck the ones you don’t want.',
  selectedCount: '{n} of {total} selected',
  selectAll: 'Select all',
  benefit: 'Benefit',
  benefitBlocked: 'Benefit unavailable today',
  benefitBlockedHint: '{n} benefit model(s) were told they have no entitlement today (campaign exhausted or channel not opened); sending to them fails with benefit not found.',
  refreshModels: 'Refresh models',
  refreshing: 'Refreshing…',
  refreshed: 'Refreshed: {n} models, {benefit} on the benefit route',
  refreshStale: 'Upstream did not answer; still showing the old {n} models',
  refreshFailed: 'Refresh failed: {message}',
  saveModels: 'Save selection',
  saving: 'Saving…',
  saved: 'Saved',
  signIn: 'Sign in with Huawei Cloud',
  signingIn: 'Signing in… (finish authorization in your browser)',
  openManually: 'If it did not open automatically, visit:',
  manualToken: 'Paste token manually (fallback)',
  loginFailed: 'Sign-in failed, please retry',
  modelsLoading: 'Loading model selection… (if it never appears, make sure you are signed in and DSH was fully restarted)',
  usageTitle: 'Local usage',
  usageToday: 'Today',
  usageRequests: '{n} request(s)',
  usageTokens: 'in {prompt} · out {completion}',
  usageAllTime: 'All time ({days} days)',
  usageByModel: 'Today by model',
  usageSlots: 'Session slots',
  usageStateOk: 'Ready',
  usageStateCapped: 'Cap hit, avoiding',
  usageStateCooling: 'Cooling down',
  usageStateDisabled: 'Disabled',
  usageNoQuota: 'Counts the requests this machine sent through the plugin (not the account balance). Official usage:',
  usageEmpty: 'Nothing recorded yet: send a message to start counting.',
  creditsTitle: 'Credits',
  creditsRemaining: '{remain} of {total} left',
  creditsUsed: '{used} used',
  creditsExpiring: '{expiring} of them expire at the next reset on {date}',
  creditsReset: 'Quota resets {date}',
  creditsTokensToday: 'Today {used} / {limit} tokens',
  creditsTokensBalance: '{balance} left',
  creditsUnavailable: 'Credits unavailable: {message}',
  creditsDock: 'Credits {remain}',
  creditsDockTitle: 'CodeArts credits left {remain} / {total}',
  claimButton: 'Claim daily credits',
  claimButtonDone: 'Claimed today',
  claimPending: 'Claiming…',
  claimHint: 'Claim 1,000 credits once a day through CodeArts’ welfare centre — the same check-in the official client does.',
  claimDone: 'Claimed {amount} credits',
  claimAlready: 'Already claimed today — come back tomorrow',
  claimUnavailable: 'No check-in campaign available for this account',
  claimFailed: 'Claim failed: {message}',
}
