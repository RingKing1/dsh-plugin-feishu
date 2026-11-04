import { setTimeout as delay } from 'node:timers/promises'
import * as larkModule from '@larksuiteoapi/node-sdk'
import { AgentPool } from './agents.js'
import { executeCommand, parseCommand } from './commands.js'
import { autoSyncSlashCommands } from './slash-commands.js'
import { FeishuApi } from './feishu-api.js'
import { conversationKey, extractItemText, normalizeEvent } from './inbound.js'
import { SerialQueue } from './queue.js'
import { QuestionHub } from './questions.js'
import { FeishuApprovalClient } from './approval.js'
import { ReplyCard } from './reply-card.js'
import { ReactionManager } from './reaction.js'
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
/** 内容去重窗口：同一条文字在窗口内重复进来只处理一次（飞书重投 / 用户手抖连发） */
const CONTENT_DEDUPE_TTL_MS = 5000
/** 引用消息展开的默认上限（字符） */
const DEFAULT_QUOTED_MESSAGE_MAX_CHARS = 8000
/** 插件停止时收尾卡片的最长等待：接口挂住也不能让插件卸载卡死 */
const LIVE_CARD_CLOSE_TIMEOUT_MS = 2500
/** 卡片停在「回复中」时给用户的解释（与 pi-feishu-bridge 同一口径） */
const INTERRUPTED_NOTE = '服务重启中，本轮回复已中断，请重发这条消息'
/** ptc 预设的子调用事件：真正干活的工具藏在 run_code 里，只有这两个事件能看到 */
const PTC_DISPATCH_START = 'tool/ptc-dispatch-start'
const PTC_DISPATCH_END = 'tool/ptc-dispatch'
/** 子agent 唤醒轮的卡片标题前缀（R3）；后面拼 ` · <子agent 会话 id 前 6 位>` */
const SUBAGENT_WAKE_TITLE = '子agent 回来了'

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
      onClaimed: (key, payload) => this.onClaimed(key, payload),
    })

    /** @type {Map<string, ReplyCard>} 当前这一轮的卡片 */
    this.cards = new Map()
    /** @type {Map<string, { chatId: string, chatType: string, openId: string, threadId: string, title: string, at: number, senderName?: string, sessionId?: string }>} 最近一条消息的会话信息 */
    this.turns = new Map()
    /**
     * 本插件认领、尚在等待结果的轮次：会话键 -> 认领记录。
     * @type {Map<string, { turns: Set<number>, wildcard: boolean, title?: string }>}
     */
    this.expectTurn = new Map()
    /** 飞书侧的人机问答：把 dsh 的提问发成卡片，等按钮点击或文字作答 */
    this.questions = new QuestionHub({ api: this.api, log: this.log, config: this.config })
    /** 飞书审批应用：模型通过工具建单 / 查单，这里只做 API 封装，不接管 dsh 的 approval/request */
    this.approval = new FeishuApprovalClient({ api: this.api, log: this.log, config: this.config })
    /** 飞书侧表情回执：收到挂「收到」，跑完换完成 / 失败（留空即关闭） */
    this.reactions = new ReactionManager({
      api: this.api,
      log: this.log,
      ackEmoji: this.config.reactEmoji,
    })
    /** @type {Set<import('./reply-card.js').ReplyCard>} 在册卡片：插件停止时统一收尾 */
    this.liveCards = new Set()
    /** @type {Map<string, string[]>} 会话键 -> 还在等结果的消息（用于结算表情） */
    this.awaitingReactions = new Map()
    /** @type {Map<string, { text: string, at: number }>} 会话键 -> 最近处理过的正文 */
    this.recentContent = new Map()
    /** @type {(() => void)|undefined} session/event 监听的注销函数 */
    this.offSessionEvent = undefined
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

    // 会话事件是本插件「执行过程清单」的唯一数据源：tool/call 记开始、tool/result 记结果。
    // 只监听不分发：事件里带的是全局会话，按 session.id 过滤出本项目投递的那些。
    if (typeof this.ctx.on === 'function') {
      this.offSessionEvent = this.ctx.on('session/event', (session, event) => {
        this.onSessionEvent(session, event)
      })
    }
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
    // 先把在册卡片翻成「已中断」再断连接：否则卡片会永久停在「回复中」
    await this.finishLiveCards()
    await this.reactions.clear()
    if (typeof this.offSessionEvent === 'function') {
      try {
        this.offSessionEvent()
      } catch (error) {
        this.log.debug('注销会话事件监听失败（忽略）', { error: String(error) })
      }
      this.offSessionEvent = undefined
    }
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
      // 内容去重：飞书偶发重投换了 message_id，或用户手抖连发同一句；
      // 5 秒内同会话同一段文字只处理一次，否则会连续跑两轮同样的活
      if (this.isDuplicateContent(key, event.text)) {
        this.log.debug('重复内容已忽略', { key })
        void this.reactions.settle(event.messageId, 'ignored')
        return
      }
      // 收到消息先挂一个表情：长任务里它比卡片更早给出「看到了」的反馈
      void this.reactions.markPending(event.messageId)
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
      void this.reactions.settle(message.messageId, 'ignored')
      return
    }

    const turn = {
      key,
      chatId: message.chatId,
      chatType: message.chatType,
      openId: message.senderOpenId,
      threadId: message.threadId,
      messageId: message.messageId,
      title: this.titleOf(message),
      at: Date.now(),
    }
    this.turns.set(key, turn)

    const command = parseCommand(message.text)
    if (command) {
      // 命令优先：/stop 不能被当成上一个问题的答案吞掉；等待中的提问一并取消
      this.questions.cancel(key, '收到命令，这次提问已取消')
      const result = await executeCommand(this, message, key, command)
      if (result && result.reply) await this.api.sendText(message.chatId, result.reply)
      void this.reactions.settle(message.messageId, 'done')
      return
    }

    // 有等待中的提问：这条文本当成答案，不能再投递成新一轮消息，否则答案会变成新问题
    if (this.questions.pendingFor(key)) {
      const answered = this.questions.answerByText(key, message.text)
      if (answered) {
        this.log.info('飞书用户用文字回答了提问', { key })
        void this.reactions.settle(message.messageId, 'done')
        return
      }
    }

    // 姓名解析失败不影响投递：拿不到就是空串，前缀里只显示 open_id 尾号
    turn.senderName = await this.resolveSenderName(message.senderOpenId)
    // 引用回复：把被引用的那条展开，模型才知道「这个」指什么；失败就按原消息投递
    const promptText = await this.withQuotedMessage(message)

    const deliver = async (target) => {
      target.followup(createUserMessage(promptText, turn))
      const sessions = typeof this.ctx.get === 'function' ? this.ctx.get('sessions') : undefined
      if (sessions && typeof sessions.flush === 'function') {
        await sessions.flush(target.session)
      }
    }

    let agent = await this.agents.resolve(key)
    turn.sessionId = (agent.session && agent.session.id) || ''
    // 入站投递先认领：这一刻还没有 turn 号，由首帧定型（见 armTurn）
    this.armTurn(key)
    // 交付即建卡：用户发完消息马上看到「回复中」，不必等模型吐出第一段文字
    const early = this.cardFor(key)
    if (early) void early.start()
    // 表情回执等这一轮真正结束再结算，别提前打勾
    this.expectReaction(key, message.messageId)
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
        this.settleReactions(key, 'failed')
        this.log.error('投递消息给 agent 失败', { key, error: String(error) })
        await this.api.sendText(message.chatId, '消息投递失败：' + String(error)).catch(() => {})
      }
    }
  }

  /**
   * 卡片按钮回调：目前只有选择题卡（`dshq`）与停止按钮（`dshstop`）。
   * 必须同步返回：飞书长连接把回调返回值直接当作本次点击的 toast 响应。
   */
  onCardAction(data) {
    const event = data && data.event ? data.event : data
    const action = event && event.action
    const value = action && action.value && typeof action.value === 'object' ? action.value : {}
    // 卡片上的「停止」按钮：先回 toast 再异步停，飞书要求回调同步返回
    if (typeof value.dshstop === 'string') {
      void this.stopTurn(value.dshstop).catch((error) => {
        this.log.warn('卡片停止按钮执行失败', { error: String(error) })
      })
      return { toast: { type: 'info', content: '已请求停止，稍等这一轮收尾' } }
    }
    return this.questions.onCardAction(data)
  }

  /**
   * 认领一轮：让这个会话的流式帧有资格推卡片（唯一的认领入口）。
   *
   * 记录形状 `{ turns, wildcard, title }`：
   * - `wildcard`：飞书入站投递时认领，此刻还没有 turn 号，由收到的首帧定型；
   * - `turns`：子agent 唤醒轮由 `agent/inbox/claimed` 直接带 turn 号认领，只放行这几个 turn 的帧
   *   —— 同一会话里别的入口（网页端）发起的轮次因此不会搭车出卡（R2）；
   * - `title`：唤醒轮建卡时用的标题，用完即清。
   * 粒度仍到会话：R5 要求同一时刻最多一张活卡，卡片继续复用 `cards.get(key)`。
   */
  armTurn(key, turn, title) {
    let entry = this.expectTurn.get(key)
    if (!entry) {
      entry = { turns: new Set(), wildcard: false }
      this.expectTurn.set(key, entry)
    }
    const number = Number(turn)
    if (Number.isFinite(number)) entry.turns.add(number)
    else entry.wildcard = true
    if (title) entry.title = title
    return entry
  }

  /**
   * `agent/inbox/claimed`：一轮真的开跑、这批消息被取进了这一步。
   *
   * 只认「子agent 回来了」这两种来源（白名单，见 docs/需求-子agent异步回传.md 5.2）：
   * - `subagent-settled`：子agent 跑完，把结论汇总给主 agent；
   * - `agent-message`：子agent 中途主动发消息。
   * 消息到来时主 agent 可能已经 idle 过（`onIdle` 早已删掉认领记录），唤醒轮的回复就无处可去。
   * 这里在**轮次真正开始**时重新认领，比 `inserted` 稳：inserted 之后消息还可能被 /stop 清掉，
   * 认领了却没有轮次会残留到下一轮（`claimed` 之后即使 step 被拒，轮次收尾时的 idle 也会清掉）。
   */
  onClaimed(key, payload) {
    const message = payload && payload.message
    const source = message && message.source
    const kind = source && source.kind
    if (kind !== 'subagent-settled' && kind !== 'agent-message') return
    const turn = Number(payload.turn)
    if (!Number.isFinite(turn)) return
    // 还得知道往哪儿发：没有入站记录（插件重启后用户还没发过消息）就没法建卡
    if (!this.turns.get(key)) {
      this.log.debug('收到子agent 回传，但缺少飞书会话记录，跳过', { key })
      return
    }
    const sender = String(source.senderSessionId || '').slice(0, 6)
    this.armTurn(key, turn, sender ? SUBAGENT_WAKE_TITLE + ' · ' + sender : SUBAGENT_WAKE_TITLE)
    // 有活卡时由 onFrame 的 start 帧顺带 start()，这里重复调也无害（幂等）
    this.log.info('子agent 回传，已认领唤醒轮', { key, turn, kind, sender })
  }

  /**
   * agent 流式帧：归属判断（哪一步、哪次 attempt）全在 ReplyStream 里做，
   * 这里只负责「认不认这一轮 / start 时保证有卡」并把帧转给卡片。
   */
  onFrame(key, frame) {
    const entry = this.expectTurn.get(key)
    if (!entry || !frame) return
    const turn = Number(frame.turn)
    // 唤醒轮按 turn 号放行：同一会话里别的轮次不能搭车出卡
    if (!entry.wildcard && !entry.turns.has(turn)) return
    // 入站认领在这一刻定型：之后只认这一轮（提问后的「接上条」卡仍属同一轮）
    if (entry.wildcard && Number.isFinite(turn)) {
      entry.wildcard = false
      entry.turns.add(turn)
    }
    const card = frame.type === 'start' ? this.cardFor(key, entry.title) : this.cards.get(key)
    if (!card) return
    // 交付即建卡：start 帧再兜一次底（提问后新建的「接上条」卡就靠这个起来）
    if (frame.type === 'start') {
      entry.title = undefined
      void card.start()
    }
    card.onFrame(frame)
  }

  /** 一轮结束：收尾卡片，标记本插件不再等待结果。 */
  onIdle(key) {
    if (!this.expectTurn.delete(key)) return
    this.settleReactions(key, 'done')
    const card = this.cards.get(key)
    this.cards.delete(key)
    if (!card) return
    this.liveCards.delete(card)
    void card.finish({ status: 'done' }).catch((error) => {
      this.log.warn('收尾卡片失败', { key, error: String(error) })
    })
  }

  /** 轮次出错：卡片转红，并把错误摘要发出去。 */
  onError(key, error) {
    const text = describeError(error)
    this.log.error('会话执行失败', { key, error: text })
    if (!this.expectTurn.delete(key)) return
    this.settleReactions(key, 'failed')
    const card = this.cards.get(key)
    this.cards.delete(key)
    if (card) this.liveCards.delete(card)
    const turn = this.turns.get(key)
    if (card) {
      void card.finish({ status: 'failed', note: '执行失败：' + text })
      return
    }
    if (turn) void this.api.sendText(turn.chatId, '执行失败：' + text).catch(() => {})
  }

  /** 当前会话的卡片；没有就按最近一条消息建一个（title 给唤醒轮用）。 */
  cardFor(key, title) {
    const existing = this.cards.get(key)
    if (existing) return existing
    const turn = this.turns.get(key)
    if (!turn) return undefined
    return this.newCard(key, title || turn.title)
  }

  /** 建一张新卡并登记到会话与在册表（resume 时标题带「接上条」）。 */
  newCard(key, title) {
    const turn = this.turns.get(key)
    if (!turn) return undefined
    const card = new ReplyCard({
      api: this.api,
      chatId: turn.chatId,
      key,
      title: title || turn.title,
      intervalMs: this.config.streamIntervalMs,
      maxChars: this.config.maxReplyChars,
      progressMode: this.config.progressMode,
      // 正文策略：final 只留最终回复（中间步降级成旁白进过程面板）
      bodyMode: this.config.replyBodyMode,
      showReasoning: this.config.showReasoning,
      log: this.log,
    })
    this.cards.set(key, card)
    this.liveCards.add(card)
    return card
  }

  // ---- 命令宿主接口（commands.js 调用）----

  async newSession(key) {
    this.questions.cancel(key, '会话已重置，这次提问已取消')
    const card = this.cards.get(key)
    this.cards.delete(key)
    if (card) {
      this.liveCards.delete(card)
      card.dispose()
    }
    this.settleReactions(key, 'ignored')
    this.expectTurn.delete(key)
    await this.agents.destroy(key)
  }

  async stopTurn(key) {
    this.questions.cancel(key, '收到 /stop，这次提问已取消')
    const card = this.cards.get(key)
    this.cards.delete(key)
    this.expectTurn.delete(key)
    this.settleReactions(key, 'ignored')
    const stopped = this.agents.cancel(key, new Error('feishu: /stop'))
    if (card) {
      this.liveCards.delete(card)
      // 中断时把还在跑的步骤标成 ⛔，否则收尾后仍显示「进行中」
      card.abortProgress()
      void card.finish({ status: 'stopped' })
    }
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

  /**
   * 把 dsh 的提问接到飞书（index.js 的 user-questions/request 回调）。
   *
   * 为什么要在提问前后动卡片：回复卡正在流式输出，问题卡是另一条消息，
   * 两张同时「活着」时用户不知道该操作哪张；而且 dsh 等回答期间不会再有新 delta，
   * 卡片会停在半句话上，看起来像卡死。所以提问前把卡定格成「等你选择」，
   * 回答完再开一张新卡承接后续回复 —— 绝不在旧卡上原地续写。
   */
  async askQuestions(request, turn) {
    const key = turn && turn.key
    const card = key ? this.cards.get(key) : undefined
    if (card) {
      this.cards.delete(key)
      this.liveCards.delete(card)
      await card.pauseForAsk('等你选择')
    }
    // 提问有始有终：答完把暂停卡翻成「已选择」，超时/取消翻成「已结束」，
    // 再另开一张「回复（接上条）」承接后续输出；不再沿用旧标题拼「（接上条）」。
    // 注意不能按 expectTurn 预判：超时/取消时它可能还在，只有 ask 正常 resolve 才算答完。
    let answered = false
    try {
      const result = await this.questions.ask(request, turn)
      answered = true
      return result
    } finally {
      if (card) {
        await (answered ? card.markAnswered() : card.settlePaused('stopped', '提问已结束'))
      }
      if (answered) {
        const next = this.newCard(key, '回复（接上条）')
        if (next) void next.start()
      }
    }
  }

  /**
   * 会话事件入口：工具调用与结果（含 ptc 子调用）。
   * 数据源是 dsh 的 session/event，按 session.id 过滤出本插件的会话。
   */
  onSessionEvent(session, event) {
    if (!event) return
    const type = event.type
    if (type !== 'tool/call' && type !== 'tool/result' && type !== PTC_DISPATCH_START && type !== PTC_DISPATCH_END) return
    const key = this.keyOfSession(session && session.id)
    if (!key) return
    const card = this.cards.get(key)
    if (!card) return
    const data = event.data || {}
    if (type === 'tool/call') card.trackToolCall(data)
    else if (type === 'tool/result') card.trackToolResult(data)
    // ptc 预设下真正干活的是 run_code 里的子调用：用 subCallId 当 callId 才能配上对，
    // 否则过程面板里只剩一条孤零零的 run_code，用户看不出到底跑了什么
    else if (type === PTC_DISPATCH_START) {
      card.trackToolCall({ callId: data.subCallId, name: data.name, arguments: data.arguments })
    } else {
      card.trackToolResult({ callId: data.subCallId, ok: !data.isError })
    }
  }

  /** session.id -> 飞书会话键（只在插件 live 池里找，网页端会话不参与） */
  keyOfSession(sessionId) {
    if (!sessionId) return undefined
    for (const [key, entry] of this.agents.live) {
      const id = entry.sessionId || (entry.agent && entry.agent.session && entry.agent.session.id) || ''
      if (id === sessionId) return key
    }
    return undefined
  }

  /**
   * 展开被引用的那条消息。
   *
   * 飞书「回复某条消息」时事件只带 parent_id，不带被引用内容；
   * 不展开的话模型看到的就是一句「这个改一下」，根本不知道「这个」是什么。
   * 查不到 / 没权限就按原消息投递：引用是增强信息，不能因为它失败而丢消息。
   */
  async withQuotedMessage(message) {
    if (this.config.includeQuotedMessage === false) return message.text
    const parentId = message.parentId || ''
    if (!parentId || parentId === message.messageId) return message.text
    try {
      const item = await this.api.getMessage(parentId)
      const quoted = extractItemText(item)
      const body = String(quoted.text || '').trim()
      if (!body) return message.text
      const limit = this.config.quotedMessageMaxChars || DEFAULT_QUOTED_MESSAGE_MAX_CHARS
      const clipped = body.length > limit ? body.slice(0, limit) + '\n…（引用过长，已截断）' : body
      return '[Quoted message]\ntype: ' + (quoted.messageType || 'unknown')
        + '\n---\n' + clipped + '\n---\n[User]\n' + message.text
    } catch (error) {
      this.log.debug('展开引用消息失败（按原消息投递）', { parentId, error: String(error) })
      return message.text
    }
  }

  /** 内容去重：5 秒内同会话同一段文字只处理一次。 */
  isDuplicateContent(key, text) {
    const now = Date.now()
    const previous = this.recentContent.get(key)
    this.recentContent.set(key, { text: String(text || ''), at: now })
    if (this.recentContent.size > 500) {
      const oldest = this.recentContent.keys().next().value
      if (oldest !== undefined) this.recentContent.delete(oldest)
    }
    if (!previous) return false
    return previous.text === String(text || '') && now - previous.at <= CONTENT_DEDUPE_TTL_MS
  }

  /** 记下「这条消息还在等结果」：一轮结束时统一结算表情。 */
  expectReaction(key, messageId) {
    if (!messageId) return
    const list = this.awaitingReactions.get(key) || []
    if (list.indexOf(messageId) < 0) list.push(messageId)
    // 异常路径可能留下没结算的残留，别让一个会话无限增长
    if (list.length > 10) list.splice(0, list.length - 10)
    this.awaitingReactions.set(key, list)
  }

  /** 结算某会话所有等待中消息的表情（done / failed / ignored）。 */
  settleReactions(key, outcome) {
    const list = this.awaitingReactions.get(key) || []
    if (list.length === 0) return
    this.awaitingReactions.delete(key)
    for (const messageId of list) void this.reactions.settle(messageId, outcome)
  }

  /**
   * 插件停止前把在册卡片统一收尾。
   * 不做这件事的话，重启后卡片会永久停在「回复中」，用户以为还在跑（2026-10-14 的真实事故）。
   * 单卡最多等 2.5 秒：接口挂住时不能让插件卸载流程卡死。
   */
  async finishLiveCards() {
    const cards = [...this.liveCards]
    this.liveCards.clear()
    await Promise.all(cards.map((card) => {
      const closing = card.finish({ status: 'stopped', note: INTERRUPTED_NOTE }).catch(() => false)
      return Promise.race([closing, delay(LIVE_CARD_CLOSE_TIMEOUT_MS)])
    }))
  }

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
      .sendText(chatId, unsupportedMessageHint(messageType))
      .catch(() => {})
  }
}

/**
 * 不支持的消息类型给用户的提示。
 * 富文本（post）现在是支持的，只有「富文本里没有文字」才会走到这里，说法要与之区分，
 * 否则用户看到「收到的是 post」会以为格式不认识。
 */
function unsupportedMessageHint(messageType) {
  if (messageType === 'post') {
    return '这条富文本里没有解析到文字（图片 / 附件暂时还不支持），请直接发文字。'
  }
  return '暂时只支持文本消息，收到的是 ' + String(messageType || '未知类型') + '。'
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