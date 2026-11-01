import { AppRegistration, registerRoute } from './register-app.js'
import { Config } from './schema.js'
import { describeConfig, readField, resolveConfig } from './config.js'
import { createLog } from './log.js'
import { FeishuBridge } from './bridge.js'

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

  /** @type {FeishuBridge | undefined} */
  let bridge
  let appliedKey
  let timer

  /** 一次性读齐所有 volatile 字段：半个旧值半个新值会连错账号 */
  const readAll = () => ({
    appId: readField(raw.appId, ''),
    appSecret: readField(raw.appSecret, ''),
    domain: readField(raw.domain, ''),
    workdir: readField(raw.workdir, ''),
    allowedOpenIds: readField(raw.allowedOpenIds, []),
    requireMentionInGroup: readField(raw.requireMentionInGroup, true),
    streamIntervalMs: readField(raw.streamIntervalMs, 700),
    maxReplyChars: readField(raw.maxReplyChars, 8000),
    statePath: readField(raw.statePath, ''),
    debug: readField(raw.debug, false),
  })

  const stopBridge = () => {
    const current = bridge
    bridge = undefined
    if (!current) return
    void current.stop().catch((error) => log.warn('停止飞书桥接失败', { error: String(error) }))
  }

  const startBridge = () => {
    const values = readAll()
    appliedKey = JSON.stringify(values)
    const resolved = resolveConfig(values, process.env)

    if (!resolved.enabled) {
      // 没配凭证时保持休眠：--dump-config、单测、以及只想先装上插件的人都不该被打断
      log.warn('未配置飞书应用凭证，插件保持休眠（在插件页填好后会自动生效）', { missing: resolved.missing })
      return
    }

    const next = new FeishuBridge({ ctx, config: resolved, log })
    bridge = next
    log.info('飞书插件配置已生效', describeConfig(resolved))
    void next.start().catch((error) => log.error('飞书桥接启动失败', { error: String(error) }))
  }

  startBridge()

  // 扫码创建应用：浏览器半侧轮询 /api/feishu.register 拿二维码与凭证。
  // webServer 是软依赖 —— CLI / 无 Web 的 profile 里没有它，插件照常跑，只是没有扫码入口。
  const registration = new AppRegistration({
    log: { info: (message, detail) => log.info(message, detail), warn: (message, detail) => log.warn(message, detail) },
  })
  let stopRegisterRoute
  ctx.inject(['webServer'], (web) => {
    stopRegisterRoute = registerRoute(web.webServer, registration)
    return () => {
      stopRegisterRoute?.()
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
      stopBridge()
      startBridge()
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
    stopBridge()
  }
}
