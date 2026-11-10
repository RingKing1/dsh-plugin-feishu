import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** 飞书中国站域名；国际版 Lark 用 https://open.larksuite.com */
export const DEFAULT_DOMAIN = 'https://open.feishu.cn'

/** 密钥也可以只放环境变量，避免写进配置文件与提交记录。 */
export const ENV_APP_ID = 'DSH_FEISHU_APP_ID'
export const ENV_APP_SECRET = 'DSH_FEISHU_APP_SECRET'

const DEFAULT_STREAM_INTERVAL_MS = 700
const DEFAULT_MAX_REPLY_CHARS = 8000
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_QUOTED_MESSAGE_MAX_CHARS = 8000

/** 执行过程清单的模式：认不出的值一律按 steps（宁可多显示，也不要静默关掉） */
function normalizeProgressMode(value) {
  const text = String(value || '').trim()
  return text === 'off' || text === 'action' ? text : 'steps'
}

/**
 * 正文模式：final = 只发最终回复（中间步降级成旁白进过程面板）；live = 全过程拼进正文。
 * 认不出的值一律按 final —— 默认就该是一张干净的答案卡。
 */
function normalizeReplyBodyMode(value) {
  return String(value || '').trim() === 'live' ? 'live' : 'final'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 读一个配置字段的当前值。
 *
 * 插件页可编辑的字段在运行时是 Volatile 引用（带 .get()），而单测与旧入口传的是普通值，
 * 两种形态都要支持；null / undefined 一律回落到调用方给的默认值。
 */
export function readField(value, fallback) {
  const current = value && typeof value.get === 'function' ? value.get() : value
  return current === undefined || current === null ? fallback : current
}

/**
 * 把 dsh 传入的原始配置归一化成运行期配置。
 * 所有字段都容错：配置缺项不允许抛出，插件必须能在 --dump-config / 无凭证环境里加载。
 */
export function resolveConfig(raw, env) {
  const source = raw || {}
  const environment = env || process.env
  const appId = String(source.appId || environment[ENV_APP_ID] || '').trim()
  const appSecret = String(source.appSecret || environment[ENV_APP_SECRET] || '').trim()

  const missing = []
  if (!appId) missing.push('appId（或环境变量 ' + ENV_APP_ID + '）')
  if (!appSecret) missing.push('appSecret（或环境变量 ' + ENV_APP_SECRET + '）')

  // 留空 = 自动：由 AgentPool 取「这个 chat 上次的目录 → 最近一次 dsh 会话的工作区」，
  // 不能在这里回落 process.cwd() —— dsh 宿主由桌面壳拉起，进程 cwd 往往是壳的安装目录，
  // 飞书会话就会莫名归到那个工作区分组里。
  const workdir = source.workdir ? resolve(String(source.workdir)) : ''
  const statePath = source.statePath
    ? resolve(String(source.statePath))
    : resolve(homedir(), '.dsh', 'feishu', 'state.json')

  return {
    enabled: missing.length === 0,
    missing,
    appId,
    appSecret,
    domain: String(source.domain || DEFAULT_DOMAIN).replace(/\/+$/, ''),
    workdir,
    // 留空 = 用 dsh 的默认 agent 预设（agentPresets.resolve(undefined)）
    agentPreset: String(source.agentPreset || '').trim(),
    // 留空 = 跟随 dsh 默认权限预设（workspace-write + ask）；danger-full-access = 关沙箱
    permissionPreset: String(source.permissionPreset || '').trim(),
    statePath,
    allowedOpenIds: Array.isArray(source.allowedOpenIds)
      ? source.allowedOpenIds.map((item) => String(item).trim()).filter(Boolean)
      : [],
    requireMentionInGroup: source.requireMentionInGroup !== false,
    // 姓名解析默认开启：解析失败（权限没开/查不到）只会在首行退化成 open_id 尾号，不报错
    // 关掉可省一次通讯录请求（结果按 open_id 缓存 10 分钟）
    resolveSenderName: source.resolveSenderName !== false,
    // 提问等多久算超时：太短会打断正常思考，太长等于永远挂住
    askTimeoutMs: clamp(Number(source.askTimeoutMs) || DEFAULT_ASK_TIMEOUT_MS, 10000, 86400000),
    // 工具授权：默认搬到飞书（true）；false = 保持旧行为，只在网页弹
    approvalInFeishu: source.approvalInFeishu !== false,
    // 授权等多久：超时后请求转回网页，不会把这一轮一直挂住
    approvalTimeoutMs: clamp(Number(source.approvalTimeoutMs) || DEFAULT_APPROVAL_TIMEOUT_MS, 10000, 86400000),
    // 飞书审批应用：定义号留空 = 未配置（工具会明确拒绝，不会发空请求）
    approvalCode: String(source.approvalCode || '').trim(),
    // 表单控件 id 留空 = 自动挑（多行文本优先）
    approvalWidgetId: String(source.approvalWidgetId || '').trim(),
    streamIntervalMs: clamp(Number(source.streamIntervalMs) || DEFAULT_STREAM_INTERVAL_MS, 200, 10000),
    maxReplyChars: clamp(Number(source.maxReplyChars) || DEFAULT_MAX_REPLY_CHARS, 500, 50000),
    // 表情回执：收到消息挂「收到」，跑完换完成 / 失败；显式留空 = 关闭
    reactEmoji: source.reactEmoji === undefined ? 'Get' : String(source.reactEmoji || '').trim(),
    // 执行过程清单：off 不显示 / steps 完整清单 / action 只显示当前一步
    progressMode: normalizeProgressMode(source.progressMode),
    // 正文模式：final 只发最终回复（默认）/ live 全过程拼进正文
    replyBodyMode: normalizeReplyBodyMode(source.replyBodyMode),
    // 思考（reasoning）默认丢弃：打开后进执行过程面板的「思考」条目
    showReasoning: source.showReasoning === true,
    // 引用回复：把被引用的那条消息展开进提示词，模型才知道「这个」指什么
    includeQuotedMessage: source.includeQuotedMessage !== false,
    quotedMessageMaxChars: clamp(Number(source.quotedMessageMaxChars) || DEFAULT_QUOTED_MESSAGE_MAX_CHARS, 100, 50000),
    debug: Boolean(source.debug),
    // 日志落盘：留空 = ~/.dsh/logs（由 lib/log.js 兜默认值），0 = 默认 10MB
    logDir: source.logDir ? resolve(String(source.logDir)) : '',
    logMaxBytes: clamp(Number(source.logMaxBytes) || 0, 0, 1024 * 1024 * 1024),
  }
}

/**
 * 把配置里的机器人定义归一化成「一台机器人一份运行期配置」的列表。
 *
 * 支持两种写法：
 *   1. bots 字典（新）：{ "cli_xxx": { name, appSecret } }，键就是 App ID；
 *   2. 顶层 appId/appSecret（旧）：等价于只有一台、没有名字的机器人。
 *
 * @param {object} raw dsh 传进来的原始配置
 * @param {Record<string, string|undefined>} [env]
 * @returns {Array<{ key: string, name: string, appId: string, appSecret: string }>}
 */
export function resolveBots(raw, env) {
  const source = raw || {}
  const environment = env || process.env
  const table = source.bots && typeof source.bots === 'object' && !Array.isArray(source.bots) ? source.bots : {}

  const specs = Object.entries(table)
    .map(([appId, value]) => ({
      key: String(appId).trim(),
      name: String(value && value.name ? value.name : '').trim(),
      appId: String(appId).trim(),
      appSecret: String(value && value.appSecret ? value.appSecret : '').trim(),
    }))
    .filter((bot) => bot.appId !== '' || bot.appSecret !== '')

  if (specs.length > 0) return specs

  const legacyId = String(source.appId || environment[ENV_APP_ID] || '').trim()
  const legacySecret = String(source.appSecret || environment[ENV_APP_SECRET] || '').trim()
  if (!legacyId && !legacySecret) return []
  return [{ key: legacyId || 'default', name: '', appId: legacyId, appSecret: legacySecret }]
}

/**
 * 多机器人时每个机器人一份会话映射文件：`state.json` → `state-<appId>.json`。
 * 不同应用下同名 chat 的 ID 不保证互不相干，混在一个文件里会串会话。
 *
 * @param {string} statePath
 * @param {string} appId
 * @returns {string}
 */
export function botStatePath(statePath, appId) {
  const safe = String(appId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'bot'
  return String(statePath).replace(/\.json$/i, '') + '-' + safe + '.json'
}

/** 打日志用：只回显 appId 前缀，绝不回显 appSecret。 */
export function describeConfig(config) {
  return {
    domain: config.domain,
    workdir: config.workdir || '(自动：最近一次会话的工作区)',
    statePath: config.statePath,
    allowedOpenIds: config.allowedOpenIds.length,
    requireMentionInGroup: config.requireMentionInGroup,
    resolveSenderName: config.resolveSenderName,
    askTimeoutMs: config.askTimeoutMs,
    approvalInFeishu: config.approvalInFeishu,
    approvalTimeoutMs: config.approvalTimeoutMs,
    approvalCode: config.approvalCode || '(未配置)',
    approvalWidgetId: config.approvalWidgetId || '(自动)',
    streamIntervalMs: config.streamIntervalMs,
    maxReplyChars: config.maxReplyChars,
    reactEmoji: config.reactEmoji || '(关闭)',
    progressMode: config.progressMode,
    replyBodyMode: config.replyBodyMode,
    showReasoning: config.showReasoning,
    includeQuotedMessage: config.includeQuotedMessage,
    quotedMessageMaxChars: config.quotedMessageMaxChars,
    appIdPrefix: config.appId.slice(0, 6),
  }
}
