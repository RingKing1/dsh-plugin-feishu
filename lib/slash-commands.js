/**
 * 飞书「斜杠指令」（应用命令面板）注册。
 *
 * 为什么需要它：插件本来就能识别 /new /stop 这类文本命令，但那些只是"消息解析"——
 * 用户在飞书输入框敲 `/` 时，飞书展示的是**应用已注册的指令列表**
 * （open-apis/application/v7/app_slash_commands），不会去猜插件认什么。
 * 不注册，面板里就是空的，用户只能凭记忆手打。
 *
 * 官方接口：`/open-apis/application/v7/app_slash_commands`（tenant_access_token）
 * 所需权限：`application:app_slash_command:write`（读列表用 read / write 均可）
 *
 * 设计要点（与 pi-feishu-bridge/src/feishu/slash-commands.ts 同一个口径）：
 * - 幂等：先拉列表，缺的 POST，描述有变化才 PATCH，其余跳过。
 * - 静默降级：权限缺失 / 应用未发布 / 平台报错只记日志，绝不抛出，
 *   以免拖垮长连接和收发消息主流程。
 * - 客户端有缓存（注册约 5 分钟 + 客户端缓存约 3 分钟），失败后不必反复重试。
 */

/** 单条指令：command 不含前导斜杠，必须匹配 ^[a-z][a-z0-9_-]{0,31}$ */
export const SLASH_COMMANDS = [
  { command: 'new', zh: '开启新会话（不续接当前上下文）', en: 'Start a new conversation' },
  { command: 'bind', zh: '绑定到一条已存在的 dsh 会话（后接序号或会话 id）', en: 'Bind to an existing dsh session' },
  { command: 'resume', zh: '同 /bind', en: 'Alias of /bind' },
  { command: 'stop', zh: '中断当前这一轮', en: 'Stop the current turn' },
  { command: 'status', zh: '查看会话 ID、工作目录、模型与运行状态', en: 'Show session status' },
  { command: 'cwd', zh: '设置本会话的工作目录（后接绝对路径）', en: 'Set the working directory (absolute path)' },
  { command: 'whoami', zh: '查看你的 open_id / chat_id', en: 'Show your open_id / chat_id' },
  { command: 'help', zh: '查看命令说明', en: 'Show command help' },
]

const API_PATH = '/open-apis/application/v7/app_slash_commands'
const PAGE_SIZE = 100
/** 翻页上限，防异常分页死循环 */
const MAX_PAGES = 10

/** 已同步过的 appId：同一进程内每台机器人只自动同步一次，热重连不重复调接口 */
const autoSynced = new Set()

/** 构造一条指令的描述（中英双语） */
function buildDescription(spec) {
  return {
    default_value: spec.zh,
    i18n: { zh_cn: spec.zh, en_us: spec.en },
  }
}

/** 远端描述与目标描述是否一致（一致就不 PATCH） */
function descriptionMatches(existing, target) {
  if (!existing) return false
  if ((existing.default_value || '') !== target.default_value) return false
  const i18n = existing.i18n || {}
  return (i18n.zh_cn || '') === target.i18n.zh_cn && (i18n.en_us || '') === target.i18n.en_us
}

/** 拉取应用已注册的全部指令：command -> { commandId, description } */
async function listExisting(api) {
  const found = new Map()
  let pageToken = ''
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ page_size: String(PAGE_SIZE) })
    if (pageToken !== '') query.set('page_token', pageToken)
    const payload = await api.request('GET', API_PATH + '?' + query.toString())
    const data = (payload && payload.data) || {}
    for (const item of data.items || []) {
      if (!item || !item.command) continue
      found.set(String(item.command), {
        commandId: String(item.command_id || ''),
        description: item.description,
      })
    }
    pageToken = data.page_token || ''
    if (!data.has_more || pageToken === '') break
  }
  return found
}

/**
 * 幂等同步指令到飞书平台。
 *
 * 永不抛出：失败写进 result 并记日志，由调用方决定要不要展示。
 *
 * @param {any} api 带 request(method, path, body) 的 API 封装（见 lib/feishu-api.js）
 * @param {{ log?: any, commands?: Array<{command: string, zh: string, en: string}> }} [options]
 * @returns {Promise<{ ok: boolean, created: string[], updated: string[], skipped: string[], reason?: string }>}
 */
export async function syncSlashCommands(api, options = {}) {
  const specs = options.commands || SLASH_COMMANDS
  const log = options.log
  const result = { ok: false, created: [], updated: [], skipped: [] }

  if (!api || typeof api.request !== 'function') {
    result.reason = '飞书 API 未就绪'
    return result
  }

  try {
    const existing = await listExisting(api)
    if (log) log.debug('飞书指令：远端已有列表', { total: existing.size, commands: Array.from(existing.keys()) })

    for (const spec of specs) {
      const target = buildDescription(spec)
      const current = existing.get(spec.command)

      if (!current) {
        await api.request('POST', API_PATH, { command: spec.command, description: target })
        result.created.push(spec.command)
        if (log) log.debug('飞书指令：已创建', { command: spec.command })
        continue
      }

      if (current.commandId === '' || descriptionMatches(current.description, target)) {
        result.skipped.push(spec.command)
        continue
      }

      await api.request('PATCH', API_PATH + '/' + current.commandId, { description: target })
      result.updated.push(spec.command)
      if (log) log.debug('飞书指令：已更新描述', { command: spec.command, commandId: current.commandId })
    }

    result.ok = true
    if (log) log.info('飞书指令已同步', { created: result.created.length, updated: result.updated.length, skipped: result.skipped.length })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result.reason = message
    // 典型原因：应用没开通 application:app_slash_command:write，或应用版本未发布
    if (log) {
      log.warn('飞书指令同步失败（不影响收发消息）', {
        error: message,
        hint: '在飞书开发者后台为该应用开通 application:app_slash_command:write 并发布版本',
      })
    }
    return result
  }
}

/**
 * 启动时后台同步一次：不阻塞长连接建立，失败只记日志。
 *
 * @param {any} api
 * @param {{ log?: any, key?: string, commands?: Array<object> }} [options] key 用来避免同一机器人重复同步
 */
export function autoSyncSlashCommands(api, options = {}) {
  const key = options.key
  if (key !== undefined && key !== '') {
    if (autoSynced.has(key)) return
    autoSynced.add(key)
  }
  void syncSlashCommands(api, options).catch(() => {
    // syncSlashCommands 内部已兜住异常，这里只是双保险
  })
}
