export interface CodeArtsSettingsKey {
  tabLabel: string
  tabsLabel: string
  tabAccounts: string
  tabModels: string
  tabUsage: string
  cardTitle: string
  statusSignedIn: string
  statusSignedOut: string
  statusExpired: string
  descSignedIn: string
  descSignedOut: string
  /** 首次读取状态期间不能说「未登录」，用一个中立词。 */
  statusLoading: string
  /** 状态接口整个失败（服务没起 / 路由 404）时的标题栏文案。 */
  statusUnavailable: string
  descLoading: string
  /** {message} 是底层错误（HTTP 500 / Failed to fetch 之类）。 */
  loadFailed: string
  retry: string
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
  accountRemove: string
  /** 重新登录这个账号：新凭证写回原条目，不会多出一条。 */
  accountRelogin: string
  /** 该账号正在浏览器里授权。 */
  reloginPending: string
  /** 「重新登录」却登了另一个账号：已作为新账号添加，原账号未动。 */
  reloginOtherAccount: string
  addAccount: string
  pasteTokenAdd: string
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
  modelImages: string
  modelError: string
  testModel: string
  testingModel: string
  testOk: string
  testFailed: string
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
  usageRange: string
  usageStatTokens: string
  usageStatIn: string
  usageStatThinking: string
  usageTipInput: string
  usageTipOutput: string
  usageTipReasoning: string
  usageTipCached: string
  usageTipNoCache: string
  usageTipRequests: string
  usageTipHit: string
  usageStatHit: string
  usageStatRequests: string
  /** 今日失败率（失败 /（成功 + 失败））。 */
  usageStatFailures: string
  usageStatFailureCount: string
  /** 首字延迟（P95，毫秒）。 */
  usageStatLatency: string
  usageStatLatencyDetail: string
  usageStatLatencyEmpty: string
  /** 行内的上下文窗口 / 最大输出（`1M · 64K`）。 */
  modelSpec: string
  modelSpecTitle: string
  /** 账号暂停/置顶。 */
  accountPaused: string
  accountPinned: string
  /** 「启用」开关的标签：关掉即暂停，不参与轮转。 */
  accountEnabled: string
  accountPin: string
  accountUnpin: string
  accountToday: string
  /** 体检（doctor）区块。 */
  doctorTitle: string
  doctorHint: string
  doctorRun: string
  doctorRunning: string
  doctorFailed: string
  doctorCheckAccount: string
  doctorCheckRuntime: string
  doctorCheckAccounts: string
  doctorCheckModels: string
  doctorCheckUsage: string
  doctorCheckPiAi: string
  doctorHintNoAccount: string
  doctorHintAccountStale: string
  doctorHintAccountNoKey: string
  doctorHintAccountExpired: string
  doctorHintEmptyCatalog: string
  doctorHintUsageMissing: string
  doctorHintDshHome: string
  doctorHintPiAi: string
  doctorHintOther: string
  /**
   * 趋势两张图的标题与悬停提示（本月每日 / 今天逐小时）。
   * 键名里的 Week 是历史遗留：那张图铺的是 `TREND_DAYS` = 35 天（5 周），不是 7 天。
   */
  usageTrendWeek: string
  usageTrendHour: string
  usageTrendHint: string
  /** 逐小时是本次新增口径，启用前的小时不回填。 */
  usageTrendHourEmpty: string
  /** 热力图顶上的星期行（周一…周日，空格分隔，前端 split(' ') 成 7 列）。 */
  usageHeatWeekdays: string
  /** 热力图档位图例的两端：少 ▢▢▢▢▢ 多。 */
  usageHeatLess: string
  usageHeatMore: string
  usageRequests: string
  usageByAccount: string
  usageRequestCount: string
  usageTokens: string
  /** 带缓存命中输入的那一版（上游不给缓存字段时仍用 usageTokens）。 */
  usageCompact: string
  /** 缓存命中率（`命中 76%`）。 */
  usageCacheHit: string
  /** 接在输出数字后面的思考 token（`输出 697（思考 505）`）；没有思考量时不拼。 */
  usageAllTime: string
  usageByModel: string
  usageSlots: string
  usageStateOk: string
  usageStateCapped: string
  usageStateCooling: string
  usageStateDisabled: string
  usageNoQuota: string
  usageEmpty: string
  creditsUnit: string
  creditsUsed: string
  creditsUsedOfTotal: string
  creditsTotal: string
  creditsExpiringShort: string
  creditsUpdated: string
  creditsReset: string
  creditsDetailLink: string
  creditsTokensToday: string
  creditsTokensBalance: string
  creditsUnavailable: string
  creditsNeedSignIn: string
  creditsDock: string
  creditsDockTitle: string
  creditsDockPanelTitle: string
  creditsDockRefresh: string
  creditsDockRefreshing: string
  creditsDockNoTokens: string
  creditsDockEmpty: string
  creditsDockExpiring: string
  creditsDockUpdated: string
  dockProvider: string
  dockModel: string
  dockNoModel: string
  tabDisplay: string
  displayTitle: string
  displayHint: string
  displayCreditsToggle: string
  displayQueueToggle: string
  displayNotWritable: string
  displayFailed: string
  displaySidebarTitle: string
  displaySidebarHint: string
  displaySidebarToggle: string
  queueDock: string
  queueDockTitle: string
  claimButton: string
  claimButtonDone: string
  claimPending: string
  claimAll: string
  claimHint: string
  claimDone: string
  claimAlready: string
  claimUnavailable: string
  claimFailed: string
  panelBack: string
  panelDesc: string
  [key: string]: string
}

export const zh: CodeArtsSettingsKey = {
  tabLabel: 'CodeArts',
  tabsLabel: 'CodeArts 设置',
  tabAccounts: '账号 · {n}',
  tabModels: '模型 · {n}/{total}',
  tabUsage: '用量',
  cardTitle: 'DSH CodeArts Connect',
  statusSignedIn: '已登录',
  statusSignedOut: '未登录',
  statusExpired: '凭证已过期',
  descSignedIn: '凭证已就绪，勾选的模型会出现在模型选择器里。',
  descSignedOut: '用华为云账号登录，或手动粘贴一个 CodeArts cloud_dragon_token。',
  statusLoading: '加载中…',
  statusUnavailable: '状态读取失败',
  descLoading: '正在读取账号、模型与用量…',
  loadFailed: '读不到插件状态（{message}）',
  retry: '重试',
  storedMeta: '{label} · 存于 {time}',
  storedMetaNoLabel: '存于 {time}',
  refresh: '刷新',
  clearToken: '清除全部凭据',
  tokenLabel: 'cloud_dragon_token',
  tokenPlaceholder: '粘贴从 CodeArts 网页/桌面端拿到的 token……',
  labelLabel: '备注（可选）',
  labelPlaceholder: '例如账号昵称，便于区分',
  saveToken: '保存 token',
  expiredHint: '凭证已过期，请重新登录以继续使用；已勾选的模型设置会保留。',
  accountsTitle: '账号',
  accountRemove: '删除',
  accountRelogin: '重新登录',
  reloginPending: '登录中…',
  reloginOtherAccount: '你登录的是另一个账号，已作为新账号添加；原账号保持不变。',
  addAccount: '添加账号',
  pasteTokenAdd: '粘贴 Token 添加',
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
  modelImages: '识图',
  modelError: '异常',
  testModel: '测试',
  testingModel: '测试中…',
  testOk: '通过',
  testFailed: '失败',
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
  usageRange: '今日 {today} 条 · 近 30 天 {last30} 条',
  usageStatTokens: '今日 token',
  usageStatIn: '输入 {n}',
  usageStatThinking: '思考 {n}',
  usageTipInput: '输入',
  usageTipOutput: '输出',
  usageTipReasoning: '思考',
  usageTipCached: '缓存命中',
  usageTipNoCache: '上游未下发',
  usageTipRequests: '请求',
  usageTipHit: '命中率',
  usageStatHit: '缓存命中',
  usageStatRequests: '今日请求',
  usageStatFailures: '今日失败率',
  usageStatFailureCount: '失败 {n} 次',
  usageStatLatency: '首字 P95',
  usageStatLatencyDetail: 'P50 {p50} ms · {n} 次',
  usageStatLatencyEmpty: '还没有成功请求',
  modelSpec: '{context} 上下文 · {output} 输出',
  modelSpecTitle: '上游返回的上下文窗口 {context} token，最大输出 {output} token',
  accountPaused: '已暂停',
  accountPinned: '已置顶',
  accountEnabled: '启用',
  accountPin: '置顶',
  accountUnpin: '取消置顶',
  accountToday: '今日 {n} 次 · 失败 {failed}',
  doctorTitle: '体检',
  doctorHint: '只查本机状态（版本、凭证、目录、账本、pi-ai 兼容），不联网、不改任何东西。',
  doctorRun: '开始体检',
  doctorRunning: '检查中…',
  doctorFailed: '体检失败：{message}',
  doctorCheckAccount: '账号',
  doctorCheckRuntime: '运行环境',
  doctorCheckAccounts: '账号数量',
  doctorCheckModels: '模型目录',
  doctorCheckUsage: '用量账本',
  doctorCheckPiAi: 'pi-ai 兼容',
  doctorHintNoAccount: '还没有账号：先添加一个，或用 token 手动接入。',
  doctorHintAccountStale: '有账号需要重新登录。',
  doctorHintAccountNoKey: '有账号缺少签名私钥，无法自动续期。',
  doctorHintAccountExpired: '有账号凭证已过期：重新登录即可续上。',
  doctorHintEmptyCatalog: '模型目录为空：点「重拉目录」或检查上游连通性。',
  doctorHintUsageMissing: '用量账本没有接上：重启宿主后再看。',
  doctorHintDshHome: '没有设置 DSH_HOME：凭证和账本会写到默认位置。',
  doctorHintPiAi: '宿主口的 pi-ai 版本与插件预期不一致，可能影响流式解析。',
  doctorHintOther: '未知提示：{id}',
  usageRequests: '{n} 次请求',
  usageTrendWeek: '本月 · 每日 token',
  usageTrendHour: '今天 · 逐小时 token',
  usageTrendHint: '悬停格子看那一格明细',
  usageTrendHourEmpty: '今天还没有逐小时数据（启用前的小时不回填）',
  usageHeatWeekdays: '一 二 三 四 五 六 日',
  usageHeatLess: '少',
  usageHeatMore: '多',
  usageByAccount: '今日按账号',
  usageRequestCount: '{n} 条',
  usageTokens: '输入 {prompt} · 输出 {completion}',
  usageCompact: '入 {prompt} · 出 {completion}',
  usageCacheHit: '命中 {pct}%',
  usageAllTime: '累计（{days} 天）',
  usageByModel: '今日按模型',
  usageSlots: '会话槽位',
  usageStateOk: '可用',
  usageStateCapped: '撞上限，优先避开',
  usageStateCooling: '冷却中',
  usageStateDisabled: '已停用',
  usageNoQuota: '这里是本机经插件发出的请求统计（不等于账号总额度）；官方用量明细见',
  usageEmpty: '还没有记录：发一条消息就会开始累计。',
  creditsUnit: '积分',
  creditsUsed: '已用 {used}',
  creditsUsedOfTotal: '已用 {used} / {total}',
  creditsTotal: '总额度 {total}',
  creditsExpiringShort: '即将到期 {expiring}',
  creditsUpdated: '{time} 更新',
  creditsReset: '额度重置 {date}',
  creditsDetailLink: '查看积分明细 →',
  creditsTokensToday: '今日 token {used} / {limit}',
  creditsTokensBalance: '余额 {balance}',
  creditsUnavailable: '积分不可用：{message}',
  creditsNeedSignIn: '这个账号需要重新登录',
  creditsDock: '积分 {remain}',
  creditsDockTitle: 'CodeArts 剩余积分 {remain} / {total}',
  creditsDockPanelTitle: 'CodeArts 积分',
  creditsDockRefresh: '刷新积分',
  creditsDockRefreshing: '刷新中…',
  creditsDockNoTokens: '今天还没有经插件发出的请求',
  creditsDockEmpty: '暂时没有积分数据',
  creditsDockExpiring: '{account}：{expiring} 积分将在本周期结束时作废',
  creditsDockUpdated: '最近刷新 {time}',
  dockProvider: 'Provider {provider}',
  dockModel: 'Model {model}',
  dockNoModel: '未选择模型',
  tabDisplay: '显示',
  displayTitle: '输入框两侧显示',
  displayHint: '这两项只管输入框下方那一行的积分与排队两段；中间那段「Provider CodeArts · Model 模型 · 倍率」一直显示，不受开关影响。底部那条每 60 秒读一次设置，所以关掉最多要等一分钟才见效。',
  displayCreditsToggle: '在输入框工具行显示剩余积分（点开可看各账号明细）',
  displayQueueToggle: '显示上游排队位置',
  displayNotWritable: '这个宿主没给插件开配置存储，开关只能看不能改。',
  displayFailed: '保存失败：{message}',
  displaySidebarTitle: '侧边栏图标',
  displaySidebarHint: '勾上以后，DSH 左侧那一列图标里会多一个 CodeArts，点它直接在中间列打开当前这一页，不必每次都绕进设置。默认不勾：这列图标是全宿主共用的，每个插件都来占一格很快就挤满了。改完立刻生效，没有保存步骤。',
  displaySidebarToggle: '在侧边栏图标列显示 CodeArts',
  queueDock: '排队第 {position} 位',
  queueDockTitle: '上游排队：{model} · 第 {position} 位 / 共 {length} 条',
  claimButton: '签到领积分',
  claimButtonDone: '今日已领',
  claimPending: '领取中…',
  claimAll: '全部账号领取',
  claimHint: '每天领一次 1000 积分，走官方福利中心接口（与客户端里那个「每日签到」同一件事）。',
  claimDone: '已领取 {amount} 积分',
  claimAlready: '今日已领，明天再来',
  claimUnavailable: '这个账号当前没有可领的签到活动',
  claimFailed: '领取失败：{message}',
  panelBack: '返回对话',
  panelDesc: '账号、模型开关与用量都在这一页里管，和设置 → 插件里那张卡片是同一份状态。',
}

export const en: CodeArtsSettingsKey = {
  tabLabel: 'CodeArts',
  tabsLabel: 'CodeArts settings',
  tabAccounts: 'Accounts · {n}',
  tabModels: 'Models · {n}/{total}',
  tabUsage: 'Usage',
  cardTitle: 'DSH CodeArts Connect',
  statusSignedIn: 'Signed in',
  statusSignedOut: 'Not signed in',
  statusExpired: 'Credential expired',
  descSignedIn: 'Credential is ready. Checked models show up in the model picker.',
  descSignedOut: 'Sign in with your Huawei Cloud account, or paste a CodeArts cloud_dragon_token.',
  statusLoading: 'Loading…',
  statusUnavailable: 'Status unavailable',
  descLoading: 'Reading accounts, models and usage…',
  loadFailed: 'Could not read plugin status ({message})',
  retry: 'Retry',
  storedMeta: '{label} · stored {time}',
  storedMetaNoLabel: 'stored {time}',
  refresh: 'Refresh',
  clearToken: 'Clear all credentials',
  tokenLabel: 'cloud_dragon_token',
  tokenPlaceholder: 'Paste the token taken from the CodeArts web/desktop client……',
  labelLabel: 'Label (optional)',
  labelPlaceholder: 'e.g. account nickname',
  saveToken: 'Save token',
  expiredHint: 'Your credential has expired. Sign in again to continue; your model selection is kept.',
  accountsTitle: 'Accounts',
  accountRemove: 'Remove',
  accountRelogin: 'Sign in again',
  reloginPending: 'Signing in…',
  reloginOtherAccount: 'That was a different account, so it was added as a new one; the original stayed unchanged.',
  addAccount: 'Add account',
  pasteTokenAdd: 'Paste a token',
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
  modelImages: 'Images',
  modelError: 'Unavailable',
  testModel: 'Test',
  testingModel: 'Testing…',
  testOk: 'Passed',
  testFailed: 'Failed',
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
  usageRange: 'Today {today} · last 30 days {last30}',
  usageStatTokens: 'Today tokens',
  usageStatIn: 'in {n}',
  usageStatThinking: 'thinking {n}',
  usageTipInput: 'Input',
  usageTipOutput: 'Output',
  usageTipReasoning: 'Reasoning',
  usageTipCached: 'Cached',
  usageTipNoCache: 'not reported',
  usageTipRequests: 'Requests',
  usageTipHit: 'Hit rate',
  usageStatHit: 'Cache hit',
  usageStatRequests: 'Today requests',
  usageStatFailures: 'Failure rate today',
  usageStatFailureCount: '{n} failed',
  usageStatLatency: 'First token P95',
  usageStatLatencyDetail: 'P50 {p50} ms · {n} samples',
  usageStatLatencyEmpty: 'No successful request yet',
  modelSpec: '{context} ctx · {output} out',
  modelSpecTitle: 'Context window {context} tokens, max output {output} tokens reported upstream',
  accountPaused: 'Paused',
  accountPinned: 'Pinned',
  accountEnabled: 'Enabled',
  accountPin: 'Pin',
  accountUnpin: 'Unpin',
  accountToday: 'Today {n} · {failed} failed',
  doctorTitle: 'Health check',
  doctorHint: 'Local checks only (version, credentials, catalog, ledger, pi-ai compat). No network, changes nothing.',
  doctorRun: 'Run check',
  doctorRunning: 'Checking…',
  doctorFailed: 'Health check failed: {message}',
  doctorCheckAccount: 'Account',
  doctorCheckRuntime: 'Runtime',
  doctorCheckAccounts: 'Account count',
  doctorCheckModels: 'Model catalog',
  doctorCheckUsage: 'Usage ledger',
  doctorCheckPiAi: 'pi-ai compat',
  doctorHintNoAccount: 'No account yet: sign in or paste a token first.',
  doctorHintAccountStale: 'An account needs to sign in again.',
  doctorHintAccountNoKey: 'An account has no signing key and cannot refresh automatically.',
  doctorHintAccountExpired: 'An account credential has expired: sign in again to renew it.',
  doctorHintEmptyCatalog: 'Model catalog is empty: refresh it or check upstream connectivity.',
  doctorHintUsageMissing: 'Usage ledger is not wired: restart the host and retry.',
  doctorHintDshHome: 'DSH_HOME is not set: credentials and ledger fall back to the default location.',
  doctorHintPiAi: 'Host pi-ai version differs from what the plugin expects; streaming parsing may be affected.',
  doctorHintOther: 'Unknown hint: {id}',
  usageRequests: '{n} request(s)',
  usageTrendWeek: 'This month · tokens per day',
  usageTrendHour: 'Today · tokens by hour',
  usageTrendHint: 'Hover a cell for that day',
  usageTrendHourEmpty: 'No hourly data yet today (hours before this feature are not backfilled)',
  usageHeatWeekdays: 'Mo Tu We Th Fr Sa Su',
  usageHeatLess: 'Less',
  usageHeatMore: 'More',
  usageByAccount: 'Today by account',
  usageRequestCount: '{n} reqs',
  usageTokens: 'in {prompt} · out {completion}',
  usageCompact: 'in {prompt} · out {completion}',
  usageCacheHit: '{pct}% cached',
  usageAllTime: 'All time ({days} days)',
  usageByModel: 'Today by model',
  usageSlots: 'Session slots',
  usageStateOk: 'Ready',
  usageStateCapped: 'Cap hit, avoiding',
  usageStateCooling: 'Cooling down',
  usageStateDisabled: 'Disabled',
  usageNoQuota: 'Counts the requests this machine sent through the plugin (not the account balance). Official usage:',
  usageEmpty: 'Nothing recorded yet: send a message to start counting.',
  creditsUnit: 'credits',
  creditsUsed: '{used} used',
  creditsUsedOfTotal: '{used} of {total} used',
  creditsTotal: '{total} total',
  creditsExpiringShort: '{expiring} expiring',
  creditsUpdated: 'updated {time}',
  creditsReset: 'Quota resets {date}',
  creditsDetailLink: 'View credit details →',
  creditsTokensToday: 'Today {used} / {limit} tokens',
  creditsTokensBalance: '{balance} left',
  creditsUnavailable: 'Credits unavailable: {message}',
  creditsNeedSignIn: 'This account needs signing in again',
  creditsDock: 'Credits {remain}',
  creditsDockTitle: 'CodeArts credits left {remain} / {total}',
  creditsDockPanelTitle: 'CodeArts credits',
  creditsDockRefresh: 'Refresh credits',
  creditsDockRefreshing: 'Refreshing…',
  creditsDockNoTokens: 'No requests through the plugin today yet',
  creditsDockEmpty: 'No credit data yet',
  creditsDockExpiring: '{account}: {expiring} credits expire when this cycle ends',
  creditsDockUpdated: 'Last updated {time}',
  dockProvider: 'Provider {provider}',
  dockModel: 'Model {model}',
  dockNoModel: 'No model selected',
  tabDisplay: 'Display',
  displayTitle: 'Around the chat input box',
  displayHint: 'These two only control the credits and queue segments of that line under the input box; the middle “Provider CodeArts · Model … · rate” segments always show. The bar re-reads settings every 60 seconds, so hiding the rest can take up to a minute.',
  displayCreditsToggle: 'Show remaining credits in the composer tool row (click for per-account details)',
  displayQueueToggle: 'Show the upstream queue position',
  displayNotWritable: 'This host gives the plugin nowhere to persist settings, so the switches are read-only.',
  displayFailed: 'Failed to save: {message}',
  displaySidebarTitle: 'Sidebar icon',
  displaySidebarHint: 'Once checked, a CodeArts icon joins the icon column on the left of DSH and opens this very page in the middle column, so you do not have to go through Settings each time. Off by default: that column is shared by the whole host, and it fills up quickly if every plugin claims a slot. Takes effect immediately — there is nothing to save.',
  displaySidebarToggle: 'Show CodeArts in the sidebar icon column',
  queueDock: 'Queued #{position}',
  queueDockTitle: 'Upstream queue: {model} · position {position} of {length}',
  claimButton: 'Claim daily credits',
  claimButtonDone: 'Claimed today',
  claimPending: 'Claiming…',
  claimAll: 'Claim for all accounts',
  claimHint: 'Claim 1,000 credits once a day through CodeArts’ welfare centre — the same check-in the official client does.',
  claimDone: 'Claimed {amount} credits',
  claimAlready: 'Already claimed today — come back tomorrow',
  claimUnavailable: 'No check-in campaign available for this account',
  claimFailed: 'Claim failed: {message}',
  panelBack: 'Back to chat',
  panelDesc: 'Manage accounts, model switches and usage here — same state as the card under Settings → Plugins.',
}
