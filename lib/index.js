import Schema from '@deepseek-ai/schemastery'
import { describeConfig, resolveConfig } from './config.js'
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

export const Config = Schema.object({
  appId: Schema.string().default(''),
  appSecret: Schema.string().default(''),
  domain: Schema.string().default('https://open.feishu.cn'),
  workdir: Schema.string().default(''),
  allowedOpenIds: Schema.array(Schema.string()).default([]),
  requireMentionInGroup: Schema.boolean().default(true),
  streamIntervalMs: Schema.number().default(700),
  maxReplyChars: Schema.number().default(8000),
  statePath: Schema.string().default(''),
  debug: Schema.boolean().default(false),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const raw = config || {}
  const log = createLog(ctx, Boolean(raw.debug))
  const resolved = resolveConfig(raw, process.env)

  if (!resolved.enabled) {
    // 没配凭证时保持休眠：--dump-config、单测、以及只想先装上插件的人都不该被打断
    log.warn('未配置飞书应用凭证，插件保持休眠（补齐后重启 dsh 生效）', { missing: resolved.missing })
    return
  }

  const bridge = new FeishuBridge({ ctx, config: resolved, log })
  log.info('飞书插件开始加载', describeConfig(resolved))

  void bridge.start().catch((error) => {
    log.error('飞书桥接启动失败', { error: String(error) })
  })

  // cordis 插件可以返回 disposer：插件被卸载/进程退出时断开长连接
  return () => {
    void bridge.stop()
  }
}
