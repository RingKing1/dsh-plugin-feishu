import { buildMirrorCard, extractMessageText } from './mirror-card.js'
import { readField } from './config.js'

/**
 * 「网页端镜像」：把**不是飞书发起**的轮次推成一张只读卡，让手机上也看得见进度与结果。
 *
 * 为什么能拿到全部会话：`session/event` 是宿主级事件流（bridge.start 里监听一次），
 * 每个会话的 turn/start、tool/call、assistant/message、turn/end 都在里面。
 * 插件原本只用它给「自己投递的轮次」画执行过程面板，这里复用同一份数据。
 *
 * 三条边界（都是刻意的）：
 *   1. 只读：不给停止 / 答题按钮 —— 操作入口在电脑上，两边抢会互相打断；
 *   2. 不抢卡：飞书投递的轮次由 ReplyCard 负责，这里靠 bridge 的认领记录跳过；
 *   3. 有界：一张卡最多列 8 个工具、正文 1500 字，镜像只负责「看见」。
 */

/** 卡片刷新节流：飞书编辑频率有限，1.5 秒一次足够看清进度 */
const FLUSH_INTERVAL_MS = 1500
/** 同时在镜像的会话上限：防止多会话并发时刷屏 */
const MAX_SESSIONS = 4

export class MirrorHub {
  constructor(options) {
    const settings = options || {}
    this.api = settings.api
    this.log = settings.log
    this.config = settings.config || {}
    /** @type {Map<string, object>} sessionId -> 本轮镜像状态 */
    this.turns = new Map()
    /** @type {Set<string>} 本轮显式跳过的会话（飞书投递的轮次） */
    this.skip = new Set()
  }

  get enabled() {
    return Boolean(readField(this.config.mirrorOtherTurns, false))
  }

  /**
   * @param {{ session: any, event: any, target: (session: any, event: any) => ({ chatId: string, owned: boolean, title?: string }|undefined) }} input
   */
  observe(input) {
    if (!this.enabled) return
    const session = input && input.session
    const event = input && input.event
    const type = event && event.type
    const sessionId = session && session.id
    if (!type || !sessionId) return

    const data = event.data || {}

    if (type === 'turn/start') {
      const target = typeof input.target === 'function' ? input.target(session, event) : undefined
      if (!target || target.owned) {
        // 飞书投递的轮次：有 ReplyCard，不重复画一张
        this.skip.add(sessionId)
        return
      }
      this.skip.delete(sessionId)
      if (this.turns.size >= MAX_SESSIONS && !this.turns.has(sessionId)) {
        this.log.debug('镜像会话数已达上限，跳过', { sessionId, limit: MAX_SESSIONS })
        this.skip.add(sessionId)
        return
      }
      this.turns.set(sessionId, {
        chatId: target.chatId,
        title: target.title || '',
        turn: data.turn,
        startedAt: Date.now(),
        tools: [],
        text: '',
        status: 'running',
        messageId: '',
        timer: undefined,
      })
      this.schedule(sessionId, 0)
      return
    }

    if (this.skip.has(sessionId)) {
      if (type === 'turn/end') this.skip.delete(sessionId)
      return
    }

    const state = this.turns.get(sessionId)
    if (!state) return

    if (type === 'tool/call') {
      state.tools.push({
        callId: String(data.callId || ''),
        name: String(data.name || '工具'),
        detail: summarizeArguments(data.arguments),
        ok: undefined,
      })
      this.schedule(sessionId)
      return
    }

    if (type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const callId = String(data.callId || data.toolCallId || message.callId || message.toolCallId || '')
      const tool = state.tools.find((item) => item.callId === callId)
      if (tool) {
        tool.ok = typeof data.ok === 'boolean' ? data.ok : !message.isError
        this.schedule(sessionId)
      }
      return
    }

    if (type === 'assistant/message') {
      const text = extractMessageText(data.message)
      if (text) state.text = text
      this.schedule(sessionId)
      return
    }

    if (type === 'turn/end') {
      state.status = statusOf(data.reason)
      state.elapsedMs = Date.now() - state.startedAt
      void this.flush(sessionId, true).finally(() => this.turns.delete(sessionId))
    }
  }

  /** 插件停止 / 定时重连时收尾：把还挂着的卡翻成「已中断」 */
  async cancelAll(reason) {
    const ids = [...this.turns.keys()]
    for (const sessionId of ids) {
      const state = this.turns.get(sessionId)
      if (!state) continue
      state.status = 'stopped'
      state.elapsedMs = Date.now() - state.startedAt
      state.note = reason || '镜像已停止'
      await this.flush(sessionId, true).catch(() => {})
      this.turns.delete(sessionId)
    }
    this.skip.clear()
  }

  // ---- 内部 ----

  schedule(sessionId, delay) {
    const state = this.turns.get(sessionId)
    if (!state || state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.flush(sessionId, false)
    }, delay === undefined ? FLUSH_INTERVAL_MS : delay)
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  async flush(sessionId, final) {
    const state = this.turns.get(sessionId)
    if (!state || !state.chatId) return
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    const card = buildMirrorCard({
      title: state.title,
      status: state.status,
      text: state.text,
      tools: state.tools.map((tool) => ({ name: tool.name, ok: tool.ok, detail: tool.detail })),
      elapsedMs: state.elapsedMs || Date.now() - state.startedAt,
      note: state.note,
    })
    try {
      if (!state.messageId) {
        state.messageId = await this.api.sendInteractive(state.chatId, card)
        this.log.info('镜像卡片已创建', { sessionId, chatId: state.chatId, messageId: state.messageId })
      } else if (typeof this.api.patchCardMessage === 'function') {
        await this.api.patchCardMessage(state.messageId, card)
        if (final) this.log.info('镜像卡片已收尾', { sessionId, status: state.status, tools: state.tools.length })
      }
    } catch (error) {
      this.log.warn('镜像卡片刷新失败', { sessionId, error: String(error && error.message ? error.message : error) })
    }
  }
}

/** turn/end 的原因映射成卡片状态 */
function statusOf(reason) {
  const kind = reason && reason.kind ? String(reason.kind) : ''
  if (kind === 'completed') return 'done'
  if (kind === 'aborted') return 'stopped'
  if (kind === 'blocked' || kind === 'failed' || kind === 'error') return 'failed'
  return 'done'
}

/** 工具参数摘要：命令优先，其余压成一行 JSON，够看就行 */
function summarizeArguments(args) {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string') return clip(args, 60)
  if (typeof args !== 'object') return clip(String(args), 60)
  const command = args.command || args.cmd
  if (typeof command === 'string') return clip(command, 60)
  const path = args.path || args.file_path || args.filePath
  if (typeof path === 'string') return clip(path, 60)
  try {
    return clip(JSON.stringify(args), 60)
  } catch (error) {
    return ''
  }
}

function clip(text, max) {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}
