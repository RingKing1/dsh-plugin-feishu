import { setTimeout as delay } from 'node:timers/promises'
import * as larkModule from '@larksuiteoapi/node-sdk'
import { AgentPool } from './agents.js'
import { executeCommand, parseCommand } from './commands.js'
import { autoSyncSlashCommands } from './slash-commands.js'
import { FeishuApi } from './feishu-api.js'
import { conversationKey, extractItemText, normalizeEvent } from './inbound.js'
import { SerialQueue } from './queue.js'
import { QuestionHub } from './questions.js'
import { ToolApprovalHub } from './tool-approvals.js'
import { FeishuApprovalClient } from './approval.js'
import { SessionSettings } from './session-settings.js'
import { MirrorHub, boundKeyOf } from './mirror.js'
import { readField } from './config.js'
import { buildEffortCard, buildModelCard, buildPermissionCard, describeSelection, parseSettingsAction } from './settings-card.js'
import { ReplyCard } from './reply-card.js'
import { CardRegistry, cardRegistryPath, sweepStaleCards } from './card-registry.js'
import { ReactionManager } from './reaction.js'
import { SessionStore } from './session-store.js'
import { createTrace } from './trace.js'
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
/** 卡片心跳超过这么久没写成功，就认定「假活」，强制翻成已中断 */
const CARD_STALE_MS = 3 * 60 * 1000
/** 巡检间隔：不用太勤，只在心跳已经不正常时才动手 */
const CARD_WATCHDOG_INTERVAL_MS = 60 * 1000
/** 服务重启后清扫残留卡片时给用户的解释 */
const SWEEP_NOTE = '服务重启中，本轮回复已中断'
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
    /** 关键链路追踪：debug 关闭时是空函数（见 lib/trace.js） */
    this.trace = createTrace({ config: this.config })

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
    /** dsh 的工具授权：把 approval/request 发成「允许一次 / 拒绝」卡片 */
    this.toolApprovals = new ToolApprovalHub({ api: this.api, log: this.log, config: this.config })
    /** 模型 / 推理强度 / 权限模式：读写宿主已有服务，自己不存状态 */
    this.settings = new SessionSettings({ ctx: this.ctx, log: this.log })
    /** 网页端镜像：非飞书发起的轮次推一张只读卡（默认关） */
    this.mirror = new MirrorHub({ api: this.api, log: this.log, config: this.config })
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
    /** 在跑卡片的持久化在册表：进程崩了也能在下次启动时把假活的卡翻成已中断 */
    this.registry = new CardRegistry(cardRegistryPath(this.config.statePath, this.config.appId), this.log)
    /** 巡检定时器：专门抓「心跳还在、但接口一直失败」的假活卡片 */
    this.cardWatchdog = undefined
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
    // 上次进程留下的「回复中」卡片：先清扫再连飞书，用户一进来就看到真相（NFR-2③）
    await this.registry.load()
    await sweepStaleCards(this.registry, this.api, this.log, SWEEP_NOTE)

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
        // 镜像只关心「不是飞书投递」的轮次；target() 负责判断本轮归谁
        this.mirror.observe({
          session,
          event,
          target: (current, currentEvent) => this.mirrorTarget(current, currentEvent),
        })
      })
    }
    this.startCardWatchdog()
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
    this.stopCardWatchdog()
    this.setConnection('stopped')
    // 先结算等待中的提问与授权，再断连接：否则挂着的 Promise 永远等不到答案
    this.questions.cancelAll('飞书桥接已停止')
    this.toolApprovals.cancelAll('飞书桥接已停止')
    await this.mirror.cancelAll('飞书桥接已停止')
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
      if (result && result.card) await this.api.sendInteractive(message.chatId, result.card)
      else if (result && result.reply) await this.api.sendText(message.chatId, result.reply)
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
    // 卡片标题也跟着换成姓名（`飞书 · 苏文广`）：只显示 open_id 尾号时用户分不清是谁在问
    if (turn.senderName) turn.title = this.titleOf(message, turn.senderName)
    // 引用回复：把被引用的那条展开，模型才知道「这个」指什么；失败就按原消息投递
    const promptText = await this.withQuotedMessage(message)

    const deliver = async (target) => {
      // identityHeader=false 时不写「【飞书 · 单聊 · xxx】」首行（模型仍可调 feishu_identity 查身份）
      target.followup(createUserMessage(promptText, turn, { identity: this.config.identityHeader !== false }))
      const sessions = typeof this.ctx.get === 'function' ? this.ctx.get('sessions') : undefined
      if (sessions && typeof sessions.flush === 'function') {
        await sessions.flush(target.session)
      }
    }

    let agent = await this.agents.resolve(key)
    turn.sessionId = (agent.session && agent.session.id) || ''
    this.trace('deliver', { key, messageId: message.messageId, sessionId: turn.sessionId, textLen: turn.text ? turn.text.length : 0 })
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
    // 模型 / 强度 / 权限三张设置卡（dshm / dshe / dshp）先拦，与问答、授权互不干扰
    const setting = parseSettingsAction(data)
    if (setting) {
      const result = this.onSettingsAction(setting, data)
      if (result) return result
    }
    // 授权卡片（value.dsha）与选择题卡片（value.dshq）用不同的键，互不干扰
    const approval = this.toolApprovals.onCardAction(data)
    if (approval) return approval
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
    this.trace('arm', { key, turn: Number.isFinite(number) ? number : null, title: title || null, wildcard: entry.wildcard, turns: [...entry.turns] })
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
    this.trace('claimed', {
      key,
      kind: kind || null,
      turn: Number.isFinite(Number(payload.turn)) ? Number(payload.turn) : null,
      sender: (source && source.senderSessionId) || null,
      hasTurnRecord: Boolean(this.turns.get(key)),
    })
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
   * - `start`：帧自带 `turn` / `step`，用它做归属判断；同时记下这次 attempt 的 id；
   * - `chunk` / `end`：**不带 turn**（dsh 的 `AssistantStreamAttempt` 只在 start 帧写 turn），
   *   只能按「这一轮已经开过卡、且 attemptId 对得上」放行 —— 曾经按 turn 号过滤，
   *   结果 `Number(undefined) = NaN` 把所有 delta 都丢了，卡片只剩占位符（0.7.0 的回归）。
   */
  onFrame(key, frame) {
    const entry = this.expectTurn.get(key)
    if (!entry || !frame) return
    if (frame.type !== 'start') {
      const card = this.cards.get(key)
      if (!card) {
        this.trace('frame-drop', { key, type: frame.type, reason: 'no-card' })
        return
      }
      // 上一轮 / 被丢弃那次 attempt 的尾帧不能写进当前卡
      if (entry.attemptId && frame.attemptId && String(frame.attemptId) !== entry.attemptId) {
        this.trace('frame-drop', { key, type: frame.type, reason: 'attempt' })
        return
      }
      card.onFrame(frame)
      return
    }
    const turn = Number(frame.turn)
    // 唤醒轮按 turn 号放行：同一会话里别的轮次不能搭车出卡
    if (!entry.wildcard && !entry.turns.has(turn)) {
      this.trace('frame-drop', { key, type: frame.type, turn: Number.isFinite(turn) ? turn : null, turns: [...entry.turns] })
      return
    }
    this.trace('frame-start', { key, turn: Number.isFinite(turn) ? turn : null, step: frame.step, wildcard: entry.wildcard, hasCard: this.cards.has(key) })
    // 入站认领在这一刻定型：之后只认这一轮（提问后的「接上条」卡仍属同一轮）
    if (entry.wildcard && Number.isFinite(turn)) {
      entry.wildcard = false
      entry.turns.add(turn)
    }
    entry.attemptId = frame.attemptId ? String(frame.attemptId) : undefined
    const card = this.cardFor(key, entry.title)
    if (!card) return
    // 交付即建卡：start 帧再兜一次底（提问后新建的「接上条」卡就靠这个起来）
    entry.title = undefined
    void card.start()
    card.onFrame(frame)
  }

  /** 一轮结束：收尾卡片，标记本插件不再等待结果。 */
  onIdle(key) {
    this.trace('idle', { key, armed: this.expectTurn.has(key), hasCard: this.cards.has(key) })
    if (!this.expectTurn.delete(key)) return
    this.settleReactions(key, 'done')
    const card = this.cards.get(key)
    this.cards.delete(key)
    if (!card) return
    this.liveCards.delete(card)
    this.trace('finish-done', { key, cardId: card.cardId, textLen: card.bodyText ? card.bodyText().length : -1 })
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
    this.trace('new-card', { key, title: title || turn.title })
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
      trace: this.trace,
      // 在册登记 / 注销：进程崩溃后靠它把卡翻成「已中断」
      onCardCreated: (cardId) => {
        void this.registry.add({ cardId, key, chatId: turn.chatId, title: card.title, since: Date.now() })
      },
      onCardClosed: (cardId) => {
        void this.registry.remove(cardId)
      },
    })
    this.cards.set(key, card)
    this.liveCards.add(card)
    return card
  }

  // ---- 命令宿主接口（commands.js 调用）----

  async newSession(key) {
    this.questions.cancel(key, '会话已重置，这次提问已取消')
    this.toolApprovals.cancel(key, '会话已重置，这次授权已取消')
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
    this.toolApprovals.cancel(key, '收到 /stop，这次授权已取消')
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
    const status = this.agents.describe(key)
    const agent = this.agentOf(key)
    // 模型以宿主真实生效的选择为准（agent.model 在 dsh 0.2 上没有暴露，别拿它猜）
    const selection = this.settings.currentSelection(agent)
    const permission = agent ? this.settings.currentPermission(agent) : ''
    return {
      ...status,
      model: selection ? describeSelection(selection) : status.model,
      ...(permission ? { permission } : {}),
    }
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
   * 把 dsh 的工具授权接到飞书（index.js 的 approval/request 回调）。
   *
   * 与提问不同，这里不动回复卡：授权发生时工具调用正暂停，回复卡本来就没有新帧；
   * 另发一张授权卡，回复卡继续挂着「执行中」，决定之后同一张卡接着写。
   * 返回 undefined 表示「这次不接管」，调用方要 next() 把请求交回网页。
   */
  async askApproval(request, turn) {
    return this.toolApprovals.ask(request, turn)
  }

  /**
   * 把当前飞书会话绑定到一条已存在的 dsh 会话（/bind、/resume）。
   *
   * 不直接 resume：只改映射并摘掉现有监听，下一条消息由 agents.resolve 统一处理
   * （活着的会话直接借用、落盘的恢复、都不行才新建），与正常路径只有一处逻辑。
   */
  async bindSession(key, arg) {
    const target = String(arg || '').trim()
    if (!target) return this.listSessionsForBind()

    const entry = this.agents.get(key)
    if (entry && entry.agent && entry.agent.status === 'running') {
      return '这一轮还在跑，先 /stop 再切换会话。'
    }

    // 序号必须和 /bind 列表完全一致（列表已过滤掉未命名的空会话），
    // 按 id / 标题找时才搜全量，否则「知道 id 却绑不上」。
    const numeric = /^\d+$/.test(target)
    const records = numeric
      ? await this.agents.listSessions(10, { titledOnly: true })
      : await this.agents.listSessions(50)
    if (records.length === 0) {
      return numeric
        ? '没有可绑定的命名会话。要给未命名的会话绑定，用 /bind <会话id>；要开新会话用 /new。'
        : '没有找到任何 dsh 会话（当前宿主还读不到会话索引）。'
    }

    let picked
    if (numeric) {
      const index = Number(target)
      if (index < 1 || index > records.length) return '序号超出范围：可用 1–' + records.length + '。'
      picked = records[index - 1]
    } else {
      const exact = records.find((item) => item.id === target)
      const prefixed = exact ? [exact] : records.filter((item) => item.id.startsWith(target))
      if (prefixed.length === 1) picked = prefixed[0]
      else if (prefixed.length > 1) return '有多条会话匹配「' + target + '」，请用更长的 id 或序号。'
      else {
        // 退一步按标题找：列表里显示的是标题，用户自然会照着标题说
        const byTitle = records.filter((item) => item.title && item.title.includes(target))
        if (byTitle.length === 1) picked = byTitle[0]
        else if (byTitle.length > 1) return '有 ' + byTitle.length + ' 条会话的标题都包含「' + target + '」，请用序号或更精确的标题。'
      }
    }
    if (!picked) return '没有找到会话「' + target + '」。发 /bind 看可用列表。'

    this.questions.cancel(key, '已切换会话，这次提问已取消')
    this.toolApprovals.cancel(key, '已切换会话，这次授权已取消')
    this.agents.release(key)
    await this.store.set(key, { sessionId: picked.id, cwd: picked.cwd || '' })
    // 立刻解析一次：绑定是否成功当场就能看出来（活着的借用 / 落盘的恢复）
    try {
      await this.agents.resolve(key)
    } catch (error) {
      this.log.warn('绑定后解析会话失败', { key, sessionId: picked.id, error: String(error) })
      return '已记录绑定：' + picked.id + '\n但恢复失败（会话可能已删除），下一条消息会新建会话。'
    }
    const status = this.agents.describe(key)
    return [
      '已绑定到会话：' + (picked.title ? '「' + picked.title + '」' : '') + ' ' + picked.id,
      '工作目录：' + (status.cwd || picked.cwd || '（未知）'),
      '下一条消息会接着这条会话继续。',
    ].join('\n')
  }

  /** /bind 无参数：列最近 10 条**有标题**的会话（未命名的空会话不显示） */
  async listSessionsForBind() {
    const records = await this.agents.listSessions(10, { titledOnly: true })
    if (records.length === 0) {
      return '没有可列出的命名会话。\n新开一个用 /new；要绑定未命名的会话，用 /bind <会话id>。'
    }
    const lines = records.map((item, index) => {
      const when = formatWhen(item.createdAt)
      const place = item.cwd ? item.cwd.split('/').filter(Boolean).slice(-1)[0] : '（无目录）'
      const title = item.title ? '「' + clipText(item.title, 22) + '」' : '（未命名）'
      return index + 1 + '. ' + title + ' · ' + shortId(item.id) + ' · ' + place + ' · ' + when + (item.live ? ' · 运行中' : '')
    })
    return [
      '最近的会话（新→旧）：',
      ...lines,
      '',
      '（未命名的空会话已隐藏）',
      '用法：/bind <序号|会话id|标题片段>，例如 /bind 2 或 /bind 修CI',
    ].join('\n')
  }

  // ---- 会话设置：模型 / 推理强度 / 权限模式 ----

  /** 这条会话的 agent；没建过就返回 undefined（设置动作不在这里偷偷建会话） */
  agentOf(key) {
    const entry = this.agents.get(key)
    return entry ? entry.agent : undefined
  }

  /** /model：列 provider 与模型，当前模型打勾 */
  async modelCard(key) {
    const catalog = await this.settings.modelCatalog()
    const agent = this.agentOf(key)
    return buildModelCard({
      providers: catalog.map((group) => ({
        id: group.id,
        name: group.name,
        models: group.models.map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: Boolean(model.reasoning),
        })),
      })),
      current: this.settings.currentSelection(agent),
    })
  }

  /**
   * /effort：选推理强度。参数可写 `provider/model` 指定模型，省略就用当前模型。
   * 模型没声明推理强度时，卡片会明确说出来，而不是给一排点不动的按钮。
   */
  async effortCard(key, arg) {
    const agent = this.agentOf(key)
    const current = this.settings.currentSelection(agent) || {}
    let provider = current.provider
    let model = current.model
    const wanted = String(arg || '').trim()
    if (wanted.includes('/') || wanted.includes('|')) {
      const parts = wanted.split(/[/|]/)
      provider = parts[0]
      model = parts.slice(1).join('/')
    }
    if (!provider || !model) {
      return buildEffortCard({ provider: '', model: '', efforts: [], note: '还没有选定模型：先用 /model 选一个。' })
    }
    const found = await this.settings.findModel(provider, model)
    const efforts = found && found.model.reasoning ? found.model.reasoning.efforts : []
    return buildEffortCard({
      provider,
      model,
      modelName: found ? found.model.name : model,
      efforts,
      current: current.reasoningEffort || '',
      note: efforts.length === 0 ? '这个模型没有声明推理强度；换个模型再试。' : '',
    })
  }

  /** /permission：列权限预设，当前值打勾 */
  async permissionCard(key) {
    const agent = this.agentOf(key)
    const options = this.settings.permissionOptions()
    const current = agent ? this.settings.currentPermission(agent) : ''
    return buildPermissionCard({ options, current })
  }

  /**
   * 设置卡片的按钮回调（同步）：飞书要求回调同步返回，所以这里只做同步动作。
   * 没有 agent 就回一句 toast —— 建会话要走异步的 resolve，不能塞进回调。
   */
  onSettingsAction(parsed, raw) {
    const chatId = chatIdOf(raw)
    const key = this.keyOfChat(chatId)
    if (!key) return { toast: { type: 'info', content: '这条会话已失效，请重新发 /model' } }
    const agent = this.agentOf(key)
    if (!agent) return { toast: { type: 'info', content: '这条会话还没开始，先随便发一条消息再设置' } }

    if (parsed.kind === 'model') {
      const found = this.settings.cachedModel(parsed.provider, parsed.model)
      const efforts = found && found.reasoning ? found.reasoning.efforts : []
      const current = this.settings.currentSelection(agent) || {}
      if (efforts.length > 0) {
        // 有推理强度：原地换成第二步卡片，让用户一次选完
        return {
          card: {
            type: 'raw',
            data: buildEffortCard({
              provider: parsed.provider,
              model: parsed.model,
              modelName: found.name,
              efforts,
              current: current.provider === parsed.provider && current.model === parsed.model ? current.reasoningEffort || '' : '',
            }),
          },
        }
      }
      try {
        this.settings.applyModel(agent, { provider: parsed.provider, model: parsed.model })
        this.log.info('已切换模型', { key, provider: parsed.provider, model: parsed.model })
      } catch (error) {
        return { toast: { type: 'info', content: '切换失败：' + String(error && error.message ? error.message : error) } }
      }
      return { card: { type: 'raw', data: this.modelCardFromCache(agent) } }
    }

    if (parsed.kind === 'effort') {
      try {
        this.settings.applyModel(agent, {
          provider: parsed.provider,
          model: parsed.model,
          reasoningEffort: parsed.effort || undefined,
        })
        this.log.info('已切换推理强度', { key, provider: parsed.provider, model: parsed.model, effort: parsed.effort })
      } catch (error) {
        return { toast: { type: 'info', content: '切换失败：' + String(error && error.message ? error.message : error) } }
      }
      const found = this.settings.cachedModel(parsed.provider, parsed.model)
      return {
        card: {
          type: 'raw',
          data: buildEffortCard({
            provider: parsed.provider,
            model: parsed.model,
            modelName: found ? found.name : parsed.model,
            efforts: found && found.reasoning ? found.reasoning.efforts : [],
            current: parsed.effort || '',
            status: 'done',
          }),
        },
      }
    }

    if (parsed.kind === 'permission') {
      try {
        this.settings.applyPermission(agent, parsed.preset)
        this.log.info('已切换权限模式', { key, preset: parsed.preset })
      } catch (error) {
        return { toast: { type: 'info', content: '切换失败：' + String(error && error.message ? error.message : error) } }
      }
      return {
        card: {
          type: 'raw',
          data: buildPermissionCard({
            options: this.settings.permissionOptions(),
            current: this.settings.currentPermission(agent),
            status: 'done',
            note: '已生效：下一轮工具调用按新权限执行（' + parsed.preset + '）。',
          }),
        },
      }
    }

    return { toast: { type: 'info', content: '这个按钮没有可执行的动作' } }
  }

  /** 用缓存里的模型目录重建「已完成」卡片（回调同步路径用，不能 await） */
  modelCardFromCache(agent) {
    const catalog = this.settings.cachedCatalog()
    return buildModelCard({
      providers: catalog.map((group) => ({
        id: group.id,
        name: group.name,
        models: group.models.map((model) => ({ id: model.id, name: model.name, reasoning: Boolean(model.reasoning) })),
      })),
      current: this.settings.currentSelection(agent),
      status: 'done',
    })
  }

  /** 卡片回调只带 chat_id：按最近的 turn 反查会话键 */
  keyOfChat(chatId) {
    const wanted = String(chatId || '')
    if (!wanted) return undefined
    let found
    let at = 0
    for (const [key, turn] of this.turns.entries()) {
      if (!turn || turn.chatId !== wanted) continue
      if (!found || (turn.at || 0) >= at) {
        found = key
        at = turn.at || 0
      }
    }
    return found
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
  /**
   * 镜像的投递目标：这张只读卡发到哪个飞书会话，以及「本轮是不是飞书自己发起的」。
   *
   * 飞书投递的轮次在 armTurn 里登记过（wildcard 或具体 turn 号），这里据此跳过，
   * 避免同一轮出现两张卡（ReplyCard + 镜像卡）。
   */
  mirrorTarget(session, event) {
    if (!readField(this.config.mirrorOtherTurns, false)) return undefined
    const sessionId = session && session.id
    if (!sessionId) return undefined
    const turn = Number(event && event.data && event.data.turn)
    // 先看活着的 agent，再回落到持久化映射 —— 宿主刚重启时 agents.live 是空的，
    // 只认前者会让「重启后立刻在网页端干活」永远不推卡。
    const key = this.keyOfSession(sessionId) || boundKeyOf(this.store && this.store.sessions, sessionId)
    if (key) {
      const claim = this.expectTurn.get(key)
      const owned = Boolean(claim) && (claim.wildcard || (Number.isFinite(turn) && claim.turns.has(turn)))
      return { chatId: key.split(':')[0], owned, title: this.sessionTitleOf(session) }
    }
    // 没有绑定飞书会话：只有 scope=all 才镜像，发到「镜像发往」或最近有消息的会话
    if (String(readField(this.config.mirrorScope, 'bound')) !== 'all') {
      this.log.debug('镜像跳过：会话未绑定飞书（scope=bound）', { sessionId })
      return undefined
    }
    const chatId = String(readField(this.config.mirrorChatId, '') || this.lastChatId() || '')
    if (!chatId) return undefined
    return { chatId, owned: false, title: this.sessionTitleOf(session) }
  }

  /** 会话标题（侧栏里那个名字）；拿不到就空串，卡片少一行而已 */
  sessionTitleOf(session) {
    try {
      const service = typeof this.ctx.get === 'function' ? this.ctx.get('sessionTitle') : undefined
      const snapshot = service && typeof service.get === 'function' ? service.get(session) : undefined
      if (snapshot && snapshot.title) return String(snapshot.title)
    } catch (error) {
      this.log.debug('读取会话标题失败（忽略）', { error: String(error) })
    }
    return ''
  }

  /** 最近一次与机器人对话的 chat_id：scope=all 且没配 mirrorChatId 时的兜底 */
  lastChatId() {
    let chatId = ''
    let at = 0
    for (const turn of this.turns.values()) {
      if (!turn || !turn.chatId) continue
      if ((turn.at || 0) >= at) {
        chatId = turn.chatId
        at = turn.at || 0
      }
    }
    return chatId
  }

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
  /** 巡检：把长时间写不进去的卡片强制翻成「已中断」，不让它假装还在跑 */
  startCardWatchdog() {
    if (this.cardWatchdog || this.stopped) return
    this.cardWatchdog = setInterval(() => {
      void this.scanStaleCards()
    }, CARD_WATCHDOG_INTERVAL_MS)
    if (typeof this.cardWatchdog.unref === 'function') this.cardWatchdog.unref()
  }

  stopCardWatchdog() {
    if (!this.cardWatchdog) return
    clearInterval(this.cardWatchdog)
    this.cardWatchdog = undefined
  }

  async scanStaleCards() {
    if (this.stopped) return
    const stale = [...this.liveCards].filter((card) => card.isStale(CARD_STALE_MS))
    for (const card of stale) {
      this.log.warn('卡片长时间没有更新，强制中断', {
        cardId: card.cardId,
        key: card.key,
        idleMs: Date.now() - card.lastSyncAt,
      })
      this.liveCards.delete(card)
      if (card.key) {
        this.cards.delete(card.key)
        this.expectTurn.delete(card.key)
      }
      await card.forceInterrupt('卡片长时间没有更新').catch((error) => {
        this.log.warn('强制中断卡片失败', { cardId: card.cardId, error: String(error) })
      })
    }
  }

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

  titleOf(message, senderName) {
    const base = message.chatType === 'group' ? '飞书群聊' : '飞书'
    const name = String(senderName || '').trim()
    if (name) return base + ' · ' + name
    return base + ' · ' + String(message.senderOpenId || message.chatId).slice(-6)
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

/** 会话列表里显示的时间：只保留「今天 / 昨天 / M-D」这种够用的粒度 */
function formatWhen(timestamp) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return '（时间未知）'
  const then = new Date(value)
  const now = new Date()
  const sameDay = then.toDateString() === now.toDateString()
  if (sameDay) {
    return String(then.getHours()).padStart(2, '0') + ':' + String(then.getMinutes()).padStart(2, '0')
  }
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  if (then.toDateString() === yesterday.toDateString()) return '昨天'
  return then.getMonth() + 1 + '-' + then.getDate()
}

/** 会话 id 太长，列表里只显示末 6 位，需要完整 id 时让用户发 /bind 后从回复里复制 */
function shortId(sessionId) {
  const text = String(sessionId || '')
  return text.length > 12 ? '…' + text.slice(-6) : text
}

/** 列表里的标题太长会挤掉后面的信息，截断到可读长度 */
function clipText(text, max) {
  const value = String(text || '').trim()
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}

/** 卡片回调里只有 chat_id：取出来给 keyOfChat 反查会话键 */
function chatIdOf(raw) {
  const event = raw && raw.event ? raw.event : raw
  const context = event && event.context && typeof event.context === 'object' ? event.context : {}
  return String(context.open_chat_id || context.chatId || '')
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