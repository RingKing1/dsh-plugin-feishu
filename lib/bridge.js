import * as larkModule from '@larksuiteoapi/node-sdk'
import { AgentPool } from './agents.js'
import { executeCommand, parseCommand } from './commands.js'
import { autoSyncSlashCommands } from './slash-commands.js'
import { FeishuApi } from './feishu-api.js'
import { conversationKey, normalizeEvent } from './inbound.js'
import { SerialQueue } from './queue.js'
import { QuestionHub } from './questions.js'
import { ApprovalHub } from './approvals.js'
import { ReplyCard } from './reply-card.js'
import { SessionStore } from './session-store.js'
import { createUserMessage } from './user-message.js'

// 同时兼容 CJS 默认导出与 ESM 命名导出两种形态
const lark = larkModule.default || larkModule

/** 去重窗口：飞书会重投事件，按 message_id 挡住重复处理 */
const SEEN_LIMIT = 1000
/** 不支持的消息类型提示的静默窗口（毫秒），避免用户连发图片时被刷屏 */
const UNSUPPORTED_HINT_INTERVAL_MS = 60000
/** 飞书用户名缓存时长：姓名几乎不变，但通讯录接口有频率限制，不能每条消息都查 */
const NAME_CACHE_MS = 10 * 60 * 1000

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
    /** @type {Map<string, { chatId: string, chatType: string, openId: string, threadId: string, title: string, at: number, senderName?: string, sessionId?: string }>} 最近一条消息的会话信息 */
    this.turns = new Map()
    /** @type {Set<string>} 本插件投递过、尚在等待结果的会话 */
    this.expectTurn = new Set()
    /** 飞书侧的人机问答：把 dsh 的提问发成卡片，等按钮点击或文字作答 */
    this.questions = new QuestionHub({ api: this.api, log: this.log, config: this.config })
    /** 飞书侧的审批：把 dsh 的 approval/request 发成卡片，等按钮点击或文字答复 */
    this.approvals = new ApprovalHub({ api: this.api, log: this.log, config: this.config })
    /** @type {Map<string, { name: string, at: number }>} open_id -> 姓名缓存（仅在开启姓名解析时使用） */
    this.names = new Map()
    /** @type {Set<string>} 已处理过的 message_id */
    this.seen = new Set()
    /** @type {Map<string, number>} 上次「不支持的消息类型」提示时间 */
    this.hinted = new Map()

    this.wsClient = undefined
    this.botOpenId = ''
    this.stopped = false
    /** 长连接状态：connecting | online | reconnecting | error | stopped */
    this.connection = 'connecting'
    /** @type {string|undefined} 最近一次错误 */
    this.connectionError = undefined
    /** @type {((state: { state: string, error?: string, since: number }) => void)|undefined} */
    this.onConnectionChange = settings.onConnectionChange
  }

  /** 更新长连接状态并通知外面（插件用它给界面推状态灯） */
  setConnection(state, error) {
    if (state === this.connection && error === this.connectionError) return
    this.connection = state
    this.connectionError = error
    if (typeof this.onConnectionChange === 'function') {
      try {
        this.onConnectionChange({ state, error, since: Date.now() })
      } catch (notifyError) {
        this.log.warn('上报长连接状态失败', { error: String(notifyError) })
      }
    }
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

    // 把支持的指令注册到飞书输入框的「/」面板；失败只记日志，不影响长连接
    autoSyncSlashCommands(this.api, { log: this.log, key: this.config.appId })

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error })
    dispatcher.register({
      'im.message.receive_v1': (data) => {
        this.onEvent(data)
        // 立即返回：飞书要求 3 秒内响应，实际处理在队列里异步进行
        return undefined
      },
      // 选择题的按钮点击：返回值就是飞书侧看到的 toast（要点击后立刻有反馈）
      'card.action.trigger': (data) => this.onCardAction(data),
    })

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain,
      loggerLevel: lark.LoggerLevel.error,
      // 状态回调都往插件里报，界面据此亮「已连接」绿灯；凭据错了会在 onError 里体现
      onReady: () => {
        this.setConnection('online')
        this.log.info('飞书长连接已就绪')
      },
      onReconnecting: () => {
        this.setConnection('reconnecting')
        this.log.warn('飞书长连接断开，正在重连')
      },
      onReconnected: () => {
        this.setConnection('online')
        this.log.info('飞书长连接已恢复')
      },
      onError: (error) => {
        this.setConnection('error', error instanceof Error ? error.message : String(error))
        this.log.error('飞书长连接错误', { error: String(error) })
      },
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
    this.setConnection('stopped')
    // 先结算等待中的提问，再断连接：否则挂着的 Promise 永远等不到答案
    this.questions.cancelAll('飞书桥接已停止')
    this.approvals.cancelAll('飞书桥接已停止')
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

    const turn = {
      key,
      chatId: message.chatId,
      chatType: message.chatType,
      openId: message.senderOpenId,
      threadId: message.threadId,
      title: this.titleOf(message),
      at: Date.now(),
    }
    this.turns.set(key, turn)

    const command = parseCommand(message.text)
    if (command) {
      // 命令优先：/stop 不能被当成上一个问题的答案吞掉；等待中的提问一并取消
      this.questions.cancel(key, '收到命令，这次提问已取消')
      this.approvals.cancel(key, '收到命令，这次审批已取消')
      const result = await executeCommand(this, message, key, command)
      if (result && result.reply) await this.api.sendText(message.chatId, result.reply)
      return
    }

    // 有等待中的审批：文本可能是「允许/拒绝」，也可能是随口一句话。
    // 命中就收口；没命中只提示一句、不投递 —— 正在等审批时把普通消息投进去，
    // 只会变成新一轮对话，审批照样卡着，看起来就是「没反应」。
    if (this.approvals.pendingFor(key)) {
      const gate = this.approvals.answerByText(key, message.text)
      if (gate === 'settled' || gate === 'hint') return
    }

    // 有等待中的提问：这条文本当成答案，不能再投递成新一轮消息，否则答案会变成新问题
    if (this.questions.pendingFor(key)) {
      const answered = this.questions.answerByText(key, message.text)
      if (answered) {
        this.log.info('飞书用户用文字回答了提问', { key })
        return
      }
    }

    // 姓名解析失败不影响投递：拿不到就是空串，前缀里只显示 open_id 尾号
    turn.senderName = await this.resolveSenderName(message.senderOpenId)

    const deliver = async (target) => {
      target.followup(createUserMessage(message.text, turn))
      const sessions = typeof this.ctx.get === 'function' ? this.ctx.get('sessions') : undefined
      if (sessions && typeof sessions.flush === 'function') {
        await sessions.flush(target.session)
      }
    }

    let agent = await this.agents.resolve(key)
    turn.sessionId = (agent.session && agent.session.id) || ''
    this.expectTurn.add(key)
    try {
      await deliver(agent)
      this.log.debug('消息已投递给 agent', { key, sessionId: agent.session && agent.session.id })
    } catch (error) {
      // 借用的网页会话可能刚好被关掉（agent 已 dispose）：解除绑定后重新解析再投一次。
      // 只重试一次，避免真失败时无限重试。
      let delivered = false
      if (this.agents.isBorrowed(key)) {
        this.agents.release(key)
        try {
          agent = await this.agents.resolve(key)
          turn.sessionId = (agent.session && agent.session.id) || ''
          await deliver(agent)
          delivered = true
          this.log.info('借用的网页会话已失效，已恢复后重投', { key, sessionId: turn.sessionId })
        } catch (retryError) {
          this.log.warn('借用的会话重投也失败', { key, error: String(retryError) })
        }
      }
      if (!delivered) {
        this.expectTurn.delete(key)
        this.log.error('投递消息给 agent 失败', { key, error: String(error) })
        await this.api.sendText(message.chatId, '消息投递失败：' + String(error)).catch(() => {})
      }
    }
  }

  /**
   * 卡片按钮回调：按 value 的判别键分流。
   * 审批卡片用 `dsha`，选择题卡片用 `dshq` —— 两类卡片可能同时在会话里。
   * 必须同步返回：飞书长连接把回调返回值直接当作本次点击的 toast 响应。
   */
  onCardAction(data) {
    const event = data && data.event ? data.event : data
    const action = event && event.action
    const value = action && action.value && typeof action.value === 'object' ? action.value : {}
    if (typeof value.dsha === 'string') return this.approvals.onCardAction(data)
    return this.questions.onCardAction(data)
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
    this.questions.cancel(key, '会话已重置，这次提问已取消')
    this.approvals.cancel(key, '会话已重置，这次审批已取消')
    const card = this.cards.get(key)
    this.cards.delete(key)
    if (card) card.dispose()
    this.expectTurn.delete(key)
    await this.agents.destroy(key)
  }

  async stopTurn(key) {
    this.questions.cancel(key, '收到 /stop，这次提问已取消')
    this.approvals.cancel(key, '收到 /stop，这次审批已取消')
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

  /**
   * 某个 agent 属于哪个飞书会话（工具守卫与提问守卫共用）。
   *
   * 只认本插件 live 池里的 agent：Web 直开的会话不在池里，
   * 因此飞书工具对它不可见、飞书提问回调也不会接管它的提问。
   *
   * @param {any} agent
   * @returns {object|undefined} turn + key + sessionId
   */
  turnOf(agent) {
    if (!agent) return undefined
    for (const [key, entry] of this.agents.live) {
      if (entry.agent !== agent) continue
      const turn = this.turns.get(key)
      if (!turn) return undefined
      const sessionId = entry.sessionId || (agent.session && agent.session.id) || ''
      return { ...turn, key, sessionId }
    }
    return undefined
  }

  /**
   * 解析发送人姓名（可选能力）：需要通讯录权限 contact:user.base:readonly。
   * 失败只记 debug 并缓存空值 —— 姓名是锦上添花，不能拖慢甚至打断消息投递。
   */
  async resolveSenderName(openId) {
    if (!this.config.resolveSenderName || !openId) return ''
    const cached = this.names.get(openId)
    const now = Date.now()
    if (cached && now - cached.at < NAME_CACHE_MS) return cached.name
    let name = ''
    try {
      name = await this.api.userName(openId)
    } catch (error) {
      this.log.debug('解析飞书用户名失败', { openId, error: String(error) })
    }
    this.names.set(openId, { name, at: now })
    return name
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
  const raw = (() => {
    if (!error) return '未知错误'
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error.message) return String(error.message)
    return String(error)
  })()
  // 把 dsh 内核的报错翻成人话：飞书用户看不到「AgentOptions」这种词也没用
  if (raw.includes('has no provider/model')) {
    return '这个飞书会话还没有可用的默认模型：先在 dsh 界面里选一次模型（会记为默认），再发一次消息'
  }
  if (raw.includes('model-unavailable') || raw.includes('provider-models-unavailable')) {
    return '默认模型当前不可用（可能是 API Key 没配或模型下线）：在 dsh 里换一个模型后再试'
  }
  return raw
}
