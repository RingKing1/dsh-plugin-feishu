import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** 飞书中国站域名；国际版 Lark 用 https://open.larksuite.com */
export const DEFAULT_DOMAIN = 'https://open.feishu.cn'

/** 密钥也可以只放环境变量，避免写进配置文件与提交记录。 */
export const ENV_APP_ID = 'DSH_FEISHU_APP_ID'
export const ENV_APP_SECRET = 'DSH_FEISHU_APP_SECRET'

const DEFAULT_STREAM_INTERVAL_MS = 700
const DEFAULT_MAX_REPLY_CHARS = 8000

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

  const workdir = source.workdir ? resolve(String(source.workdir)) : process.cwd()
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
    statePath,
    allowedOpenIds: Array.isArray(source.allowedOpenIds)
      ? source.allowedOpenIds.map((item) => String(item).trim()).filter(Boolean)
      : [],
    requireMentionInGroup: source.requireMentionInGroup !== false,
    streamIntervalMs: clamp(Number(source.streamIntervalMs) || DEFAULT_STREAM_INTERVAL_MS, 200, 10000),
    maxReplyChars: clamp(Number(source.maxReplyChars) || DEFAULT_MAX_REPLY_CHARS, 500, 50000),
    debug: Boolean(source.debug),
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
    workdir: config.workdir,
    statePath: config.statePath,
    allowedOpenIds: config.allowedOpenIds.length,
    requireMentionInGroup: config.requireMentionInGroup,
    streamIntervalMs: config.streamIntervalMs,
    maxReplyChars: config.maxReplyChars,
    appIdPrefix: config.appId.slice(0, 6),
  }
}
