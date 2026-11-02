import { AppRegistration, registerRoute } from './register-app.js'
import { registerStatusRoute } from './status-route.js'
import { Config } from './schema.js'
import { botStatePath, describeConfig, readField, resolveBots, resolveConfig } from './config.js'
import { createLog } from './log.js'
import { FeishuBridge } from './bridge.js'
import { registerFeishuTools } from './tools.js'

/**
 * dsh-plugin-feishu 插件入口。
 *
 * 这是一个 DSH（DeepSeek Harness）插件：装进 profile 后由 dsh 的 cordis 加载，
 * 在 dsh 进程内直接驱动 Agent（不需要另起 daemon、不需要公网回调地址），
 * 通过飞书长连接（WebSocket）收发消息。
 */

export const name = 'dsh-plugin-feishu'

/** 需要宿主提供的服务：agents（AgentRegistry）。缺它就不 apply。 */
export const inject = ['agents']

export { Config }

/** 插件页保存后等这么久再重建，避免用户连续改几个字段时反复连断 */
const REBUILD_DELAY_MS = 300

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const raw = config || {}
  const log = createLog(ctx, () => Boolean(readField(raw.debug, false)))

  /** 每台机器人一条长连接：键 = App ID */
  const bridges = new Map()
  /**
   * 每台机器人的连接状态，界面上的绿灯与状态灯都读它：
   * missing（缺凭证）| connecting | online | reconnecting | error | stopped
   * @type {Map<string, { appId: string, name: string, state: string, error?: string, since: number }>}
   */
  const statuses = new Map()
  let appliedKey
  let timer

  /** 一次性读齐所有 volatile 字段：半个旧值半个新值会连错账号 */
  const readAll = () => ({
    bots: readField(raw.bots, {}),
    appId: readField(raw.appId, ''),
    appSecret: readField(raw.appSecret, ''),
    domain: readField(raw.domain, ''),
    workdir: readField(raw.workdir, ''),
    // agentPreset / permissionPreset 之前漏在这里：建会话时永远读到空值，
    // 插件页填了也当没填。漏读是沉默失败，补上并保持和其它字段同一份快照。
    agentPreset: readField(raw.agentPreset, ''),
    permissionPreset: readField(raw.permissionPreset, ''),
    allowedOpenIds: readField(raw.allowedOpenIds, []),
    requireMentionInGroup: readField(raw.requireMentionInGroup, true),
    // 新增字段同样要进快照：漏读 = 插件页填了也永远不生效（agentPreset 就栽过这一次）
    resolveSenderName: readField(raw.resolveSenderName, false),
    askTimeoutMs: readField(raw.askTimeoutMs, 600000),
    streamIntervalMs: readField(raw.streamIntervalMs, 700),
    maxReplyChars: readField(raw.maxReplyChars, 8000),
    statePath: readField(raw.statePath, ''),
    debug: readField(raw.debug, false),
  })

  /** 给一台机器人的日志加前缀，多机器人时能分清是哪台在说话 */
  const botLog = (label) => ({
    debug: (message, detail) => log.debug('[' + label + '] ' + message, detail),
    info: (message, detail) => log.info('[' + label + '] ' + message, detail),
    warn: (message, detail) => log.warn('[' + label + '] ' + message, detail),
    error: (message, detail) => log.error('[' + label + '] ' + message, detail),
  })

  const stopBridges = () => {
    const current = [...bridges.entries()]
    bridges.clear()
    statuses.clear()
    for (const [key, instance] of current) {
      void instance.stop().catch((error) => log.warn('停止飞书机器人失败', { bot: key, error: String(error) }))
    }
  }

  const startBridges = () => {
    const values = readAll()
    appliedKey = JSON.stringify(values)

    const specs = resolveBots(values, process.env)
    if (specs.length === 0) {
      // 没配凭证时保持休眠：--dump-config、单测、以及只想先装上插件的人都不该被打断
      log.warn('未配置飞书应用凭证，插件保持休眠（在插件页填好后会自动生效）')
      return
    }

    // 多台机器人时各自落一份会话映射，避免同一个 chat 在两台之间串会话
    const shared = resolveConfig(values, process.env)
    const multi = specs.length > 1

    for (const spec of specs) {
      const label = spec.name || spec.appId.slice(0, 10) || '未命名'
      const resolved = resolveConfig({
        ...values,
        appId: spec.appId,
        appSecret: spec.appSecret,
        statePath: multi ? botStatePath(shared.statePath, spec.appId) : values.statePath,
      }, process.env)
      const scoped = botLog(label)

      if (!resolved.enabled) {
        statuses.set(spec.key, {
          appId: spec.appId,
          name: label,
          state: 'missing',
          error: '缺少 ' + resolved.missing.join('、'),
          since: Date.now(),
        })
        scoped.warn('这台机器人缺少凭证，跳过', { missing: resolved.missing })
        continue
      }

      statuses.set(spec.key, { appId: spec.appId, name: label, state: 'connecting', since: Date.now() })
      const instance = new FeishuBridge({
        ctx,
        config: resolved,
        log: scoped,
        onConnectionChange: (info) => {
          const previous = statuses.get(spec.key)
          statuses.set(spec.key, {
            appId: spec.appId,
            name: label,
            state: info.state,
            error: info.error,
            since: info.since,
            ...(previous && previous.state === info.state ? { since: previous.since } : {}),
          })
        },
      })
      bridges.set(spec.key, instance)
      scoped.info('飞书机器人已启动', describeConfig(resolved))
      void instance.start().catch((error) => scoped.error('飞书机器人启动失败', { error: String(error) }))
    }
  }

  startBridges()

  /**
   * 工具与提问共用的账本：只认本插件 live 池里的 agent。
   * 用闭包读 bridges 的实时内容，而不是启动时的快照 —— 配置热重建会把 Map 清空重建。
   */
  const ownerOf = (agent) => {
    for (const bridge of bridges.values()) {
      const turn = bridge.turnOf(agent)
      if (turn) return { bridge, turn, key: turn.key }
    }
    return undefined
  }
  const registry = {
    ownerOf,
    owns: (agent) => ownerOf(agent) !== undefined,
  }

  /**
   * 把 dsh 的提问接到飞书：只接管本插件会话的提问，其余一律 next() 交回去。
   *
   * prepend 不能省：浏览器侧（api/remotes）也注册了同一个 waterfall 的转发器，
   * 排在它后面的话，飞书会话的提问会先被转发到 Web UI，飞书这边永远收不到卡片。
   */
  ctx.on(
    'user-questions/request',
    async (request, next) => {
      const owner = ownerOf(request && request.agent)
      if (!owner) return next()
      return owner.bridge.questions.ask(request, owner.turn)
    },
    { prepend: true },
  )

  // 飞书工具：按来源会话可见（tools 是软依赖，缺它只影响工具面，桥接照常跑）
  ctx.inject(['tools'], (scoped) => {
    registerFeishuTools({ ctx: scoped, registry, log })
  })

  // 扫码创建应用：浏览器半侧轮询 /api/feishu.register 拿二维码与凭证。
  // webServer 是软依赖 —— CLI / 无 Web 的 profile 里没有它，插件照常跑，只是没有扫码入口。
  const registration = new AppRegistration({
    log: { info: (message, detail) => log.info(message, detail), warn: (message, detail) => log.warn(message, detail) },
  })
  let stopRegisterRoute
  let stopStatusRoute
  ctx.inject(['webServer'], (web) => {
    stopRegisterRoute = registerRoute(web.webServer, registration)
    // 连接状态：浏览器侧据此给侧栏图标点绿灯、给每台机器人显示状态
    stopStatusRoute = registerStatusRoute(web.webServer, statuses)
    return () => {
      stopStatusRoute?.()
      stopRegisterRoute?.()
      stopStatusRoute = undefined
      stopRegisterRoute = undefined
      registration.cancel()
    }
  })

  // 插件页保存配置后热重建：先断开旧连接，再按新值启动
  const onVolatileUpdate = () => {
    if (JSON.stringify(readAll()) === appliedKey) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      log.info('检测到配置变更，正在重建飞书连接')
      stopBridges()
      startBridges()
    }, REBUILD_DELAY_MS)
    // 不吊住进程退出
    if (typeof timer.unref === 'function') timer.unref()
  }
  ctx.on('loader/volatile-update', onVolatileUpdate)

  // cordis 插件可以返回 disposer：插件被卸载/进程退出时断开长连接
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    stopRegisterRoute?.()
    registration.cancel()
    stopBridges()
  }
}
