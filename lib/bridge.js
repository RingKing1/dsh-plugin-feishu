import * as larkModule from '@larksuiteoapi/node-sdk'
import { AgentPool } from './agents.js'
import { executeCommand, parseCommand } from './commands.js'
import { FeishuApi } from './feishu-api.js'
import { conversationKey, normalizeEvent } from './inbound.js'
import { SerialQueue } from './queue.js'
import { ReplyCard } from './reply-card.js'
import { SessionStore } from './session-store.js'
import { createUserMessage } from './user-message.js'

// 同时兼容 CJS 默认导出与 ESM 命名导出两种形态
const lark = larkModule.default || larkModule

/** 去重窗口：飞书会重投事件，按 message_id 挡住重复处理 */
const SEEN_LIMIT = 1000
/** 不支持的消息类型提示的静默窗口（毫秒），避免用户连发图片时被刷屏 */
const UNSUPPORTED_HINT_INTERVAL_MS = 60000

/**
 * 飞书 <-> dsh 的桥。
 *
 * 数据流：
 *   飞书 WS 事件 -> normalizeEvent -> 每会话串行队列 -> agent.followup
 *   agent 流式事件 -> ReplyCard -> CardKit 局部更新 -> 飞书卡片
 *
 * 设计要点：
 * 1. 事件回调必须立刻返回（飞书 3 秒内要 ack），实际处理全部丢进队列异步执行。
 * 2. 同一会话串行：连发多条消息不会让两条消息同时驱动同一轮次。
 * 3. 只有本插件投递的轮次才推卡片（expectTurn），避免 web 端在同一会话里
 *    手动对话时凭空多出一张飞书卡片。
 */
export class FeishuBridge {
  constructor(options) {
    const settings = options || {}
    this.ctx = settings.ctx
    this.config = settings.config
    this.log = settings.log

    this.api = new FeishuApi({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain,
      log: this.log,
    })
    this.store = new SessionStore(this.config.statePath, this.log)
    this.queue = new SerialQueue()
    this.agents = new AgentPool({
      ctx: this.ctx,
      config: this.config,
      store: this.store,
      log: this.log,
      onFrame: (key, frame) => this.onFrame(key, frame),
      onIdle: (key) => this.onIdle(key),
      onError: (key, error) => this.onError(key, error),
    })

    /** @type {Map<string, ReplyCard>} 当前这一轮的卡片 */
    this.cards = new Map()
    /** @type {Map<string, { chatId: string, title: string }>} 最近一条消息的会话信息 */
    this.turns = new Map()
    /** @type {Set<string>} 本插件投递过、尚在等待结果的会话 */
    this.expectTurn = new Set()
    /** @type {Set<string>} 已处理过的 message_id */
    this.seen = new Set()
    /** @type {Map<string, number>} 上次「不支持的消息类型」提示时间 */
    this.hinted = new Map()

    this.wsClient = undefined
    this.botOpenId = ''
    this.stopped = false
  }

  /** 启动：载入会话映射 -> 查机器人信息 -> 建立飞书长连接。 */
  async start() {
    await this.store.load()

    try {
      const bot = await this.api.botInfo()
      this.botOpenId = bot.open_id || ''
      this.log.info('飞书机器人信息已获取', { app: bot.app_name || '', botOpenId: this.botOpenId })
    } catch (error) {
      // 群聊里判断「是否 @ 我」依赖 botOpenId；拿不到就降级，不阻断启动
      this.log.warn('获取机器人信息失败，群聊 @ 判定将失效', { error: String(error) })
    }

    if (this.stopped) return

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error })
    dispatcher.register({
      'im.message.receive_v1': (data) => {
        this.onEvent(data)
        // 立即返回：飞书要求 3 秒内响应，实际处理在队列里异步进行
        return undefined
      },
    })

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain,
      loggerLevel: lark.LoggerLevel.error,
    })
    this.wsClient.start({ eventDispatcher: dispatcher })
    this.log.info('飞书长连接已启动', {
      domain: this.config.domain,
      workdir: this.config.workdir,
      statePath: this.config.statePath,
      requireMentionInGroup: this.config.requireMentionInGroup,
      allowedOpenIds: this.config.allowedOpenIds.length,
    })
  }

  /** 停止：断开长连接、清定时器、中断在跑的轮次。 */
  async stop() {
    this.stopped = true
    for (const card of this.cards.values()) card.dispose()
    this.cards.clear()
    this.agents.disposeAll()
    try {
      if (this.wsClient && typeof this.wsClient.close === 'function') await this.wsClient.close()
    } catch (error) {
      this.log.warn('关闭飞书长连接失败', { error: String(error) })
    }
    await this.store.save()
    this.log.info('飞书桥接已停止')
  }

  /** 飞书事件入口：只做归一化、去重、入队，绝不在这里 await 业务逻辑。 */
  onEvent(raw) {
    try {
      const event = normalizeEvent(raw, {
        botOpenId: this.botOpenId,
        requireMentionInGroup: this.config.requireMentionInGroup,
      })

      if (event.kind === 'ignore') {
        this.log.debug('忽略飞书事件', { reason: event.reason })
        if (String(event.reason).startsWith('unsupported-')) {
          void this.hintUnsupported(event.chatId, event.messageType)
        }
        return
      }

      if (this.seen.has(event.messageId)) {
        this.log.debug('重复事件已忽略', { messageId: event.messageId })
        return
      }
      this.remember(event.messageId)

      const key = conversationKey(event)
      this.queue
        .run(key, () => this.process(event, key))
        .catch((error) => this.log.error('处理飞书消息失败', { key, error: String(error) }))
    } catch (error) {
      this.log.error('解析飞书事件失败', { error: String(error) })
    }
  }

  /** 处理一条消息：权限 -> 命令 -> 投递给 agent。 */
  async process(message, key) {
    if (!this.isAllowed(message)) {
      this.log.warn('拒绝未授权的飞书用户', { openId: message.senderOpenId, chatId: message.chatId })
      await this.api
        .sendText(message.chatId, '没有访问权限。你的 open_id：' + (message.senderOpenId || '未知'))
        .catch(() => {})
      return
    }

    this.turns.set(key, { chatId: message.chatId, title: this.titleOf(message) })

    const command = parseCommand(message.text)
    if (command) {
      const result = await executeCommand(this, message, key, command)
      if (result && result.reply) await this.api.sendText(message.chatId, result.reply)
      return
    }

    const agent = await this.agents.resolve(key)
    this.expectTurn.add(key)
    try {
      agent.followup(createUserMessage(message.text))
      const sessions = typeof this.ctx.get === 'function' ? this.ctx.get('sessions') : undefined
      if (sessions && typeof sessions.flush === 'function') {
        await sessions.flush(agent.session)
      }
      this.log.debug('消息已投递给 agent', { key, sessionId: agent.session && agent.session.id })
    } catch (error) {
      this.expectTurn.delete(key)
      this.log.error('投递消息给 agent 失败', { key, error: String(error) })
      await this.api.sendText(message.chatId, '消息投递失败：' + String(error)).catch(() => {})
    }
  }

  /** agent 流式帧：start 时建卡，text-delta 时累积，end 时立刻推一次。 */
  onFrame(key, frame) {
    if (!this.expectTurn.has(key) || !frame) return
    if (frame.type === 'start') {
      const card = this.cardFor(key)
      if (card) void card.start()
      return
    }
    if (frame.type === 'end') {
      const card = this.cards.get(key)
      if (card) void card.flushNow()
      return
    }
    const chunk = frame.chunk
    if (chunk && chunk.type === 'text-delta' && chunk.text) {
      const card = this.cardFor(key)
      if (card) card.append(chunk.text)
    }
  }

  /** 一轮结束：收尾卡片，标记本插件不再等待结果。 */
  onIdle(key) {
    if (!this.expectTurn.delete(key)) return
    const card = this.cards.get(key)
    this.cards.delete(key)
    if (!card) return
    void card.finish({ status: 'done' }).catch((error) => {
      this.log.warn('收尾卡片失败', { key, error: String(error) })
    })
  }

  /** 轮次出错：卡片转红，并把错误摘要发出去。 */
  onError(key, error) {
    const text = describeError(error)
    this.log.error('会话执行失败', { key, error: text })
    if (!this.expectTurn.delete(key)) return
    const card = this.cards.get(key)
    this.cards.delete(key)
    const turn = this.turns.get(key)
    if (card) {
      void card.finish({ status: 'failed', note: '执行失败：' + text })
      return
    }
    if (turn) void this.api.sendText(turn.chatId, '执行失败：' + text).catch(() => {})
  }

  /** 当前会话的卡片；没有就按最近一条消息建一个。 */
  cardFor(key) {
    const existing = this.cards.get(key)
    if (existing) return existing
    const turn = this.turns.get(key)
    if (!turn) return undefined
    const card = new ReplyCard({
      api: this.api,
      chatId: turn.chatId,
      title: turn.title,
      intervalMs: this.config.streamIntervalMs,
      maxChars: this.config.maxReplyChars,
      log: this.log,
    })
    this.cards.set(key, card)
    return card
  }

  // ---- 命令宿主接口（commands.js 调用）----

  async newSession(key) {
    const card = this.cards.get(key)
    this.cards.delete(key)
    if (card) card.dispose()
    this.expectTurn.delete(key)
    await this.agents.destroy(key)
  }

  async stopTurn(key) {
    const card = this.cards.get(key)
    this.cards.delete(key)
    this.expectTurn.delete(key)
    const stopped = this.agents.cancel(key, new Error('feishu: /stop'))
    if (card) void card.finish({ status: 'stopped' })
    return stopped
  }

  describeStatus(key) {
    return this.agents.describe(key)
  }

  async setWorkdir(key, arg) {
    const directory = String(arg || '').trim()
    if (!directory) {
      const status = this.agents.describe(key)
      return '用法：/cwd <目录>\n当前工作目录：' + status.cwd
    }
    const saved = this.store.get(key)
    await this.store.set(key, { sessionId: (saved && saved.sessionId) || '', cwd: directory })
    return '已记录本会话的工作目录：' + directory + '\n（对下一次 /new 或新建会话生效）'
  }

  // ---- 内部工具 ----

  isAllowed(message) {
    const list = this.config.allowedOpenIds
    if (list.length === 0) return true
    return list.indexOf(message.senderOpenId) >= 0
  }

  titleOf(message) {
    const name = message.chatType === 'group' ? '飞书群聊' : '飞书'
    return name + ' · ' + String(message.senderOpenId || message.chatId).slice(-6)
  }

  remember(messageId) {
    this.seen.add(messageId)
    if (this.seen.size <= SEEN_LIMIT) return
    const oldest = this.seen.values().next().value
    if (oldest !== undefined) this.seen.delete(oldest)
  }

  /** 对「不支持的消息类型」给一次温和提示（带静默窗口）。 */
  async hintUnsupported(chatId, messageType) {
    if (!chatId) return
    const now = Date.now()
    const last = this.hinted.get(chatId) || 0
    if (now - last < UNSUPPORTED_HINT_INTERVAL_MS) return
    this.hinted.set(chatId, now)
    await this.api
      .sendText(chatId, '暂时只支持文本消息，收到的是 ' + String(messageType || '未知类型') + '。')
      .catch(() => {})
  }
}

function describeError(error) {
  if (!error) return '未知错误'
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  return String(error)
}
