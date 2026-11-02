import { randomUUID } from 'node:crypto'
import {
  buildApprovalCard,
  parseApprovalAction,
  parseApprovalText,
  DECISION_ALLOW,
  DECISION_REJECT,
  DECISION_LABEL,
} from './approval-card.js'

/**
 * 飞书侧的审批：接 dsh 的 `approval/request` waterfall。
 *
 * 为什么不另造通道：dsh 的审批是「工具调用暂停，等 answerer 返回 outcome」，
 * 只有把结果作为返回值交回去，暂停中的工具调用才会继续；另发一条消息只是新一轮对话，
 * 工具调用照样卡在那里。
 *
 * 同一会话的审批串行排队：模型可能并行发起多个工具调用，逐个弹卡片会让人分不清
 * 哪张卡对应哪一次，所以后到的审批等前一个收口后再发卡片。
 */

/** 超时上下限：太短会把人还没看清就判了，太长等于挂住整轮对话 */
const MIN_TIMEOUT_MS = 10 * 1000
const MAX_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export class ApprovalHub {
  /**
   * @param {{ api: object, log: object, config: object }} deps
   */
  constructor({ api, log, config }) {
    this.api = api
    this.log = log
    this.config = config || {}
    /** key -> 正在等回复的那一个审批 */
    this.pending = new Map()
    /** key -> 该会话审批队列的队尾（保证同一会话的卡片一张一张发） */
    this.tails = new Map()
  }

  /** 总开关：关掉时不接管审批，交回给 dsh 原有的 answerer（网页端） */
  get enabled() {
    return this.config.approvalEnabled !== false
  }

  /** 等多久算超时 */
  get timeoutMs() {
    const value = Number(this.config.approvalTimeoutMs)
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)))
  }

  /** 超时后的默认决定：默认拒绝（fail closed），显式配置才允许 */
  get timeoutOutcome() {
    return this.config.approvalTimeoutAllow === true ? DECISION_ALLOW : DECISION_REJECT
  }

  /**
   * 这个工具是否免审批。
   * 只做名字精确匹配（大小写不敏感）：配置写错一个字母就不该悄悄放行别的工具。
   */
  isAutoAllowed(toolName) {
    const list = Array.isArray(this.config.approvalAllowTools) ? this.config.approvalAllowTools : []
    if (list.length === 0) return false
    const target = String(toolName || '').trim().toLowerCase()
    return target !== '' && list.some((item) => String(item).trim().toLowerCase() === target)
  }

  /**
   * 处理一次审批请求，返回 dsh 的闭集 outcome。
   * 永不抛错：answerer 抛错会被 dsh 归一成 unavailable，这里直接给出明确结果更好排障。
   *
   * @param {{ agent?: object, toolName?: string, callId?: string, reason?: string, signal?: AbortSignal }} req
   * @param {{ key: string, chatId: string, openId: string }} turn
   * @returns {Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>}
   */
  async request(req, turn) {
    if (!this.enabled) return 'unavailable'
    const key = String((turn && turn.key) || '')
    const toolName = String((req && req.toolName) || '')
    if (!key) return 'unavailable'

    if (this.isAutoAllowed(toolName)) {
      this.log.info('审批白名单命中，直接放行', { key, toolName })
      return DECISION_ALLOW
    }

    // 排队：前一个审批还没收口时，这一张先等着，避免同一会话里卡片叠在一起
    const previous = this.tails.get(key) || Promise.resolve()
    const run = previous.then(
      () => this.askNow(req, turn),
      () => this.askNow(req, turn),
    )
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return run
  }

  /**
   * 真正发一张审批卡并等结果。
   * @param {object} req
   * @param {{ key: string, chatId: string, openId: string }} turn
   */
  async askNow(req, turn) {
    const key = String(turn.key)
    if (req && req.signal && req.signal.aborted) return 'cancelled'

    const requestId = randomUUID()
    let resolveOnce
    const settled = new Promise((resolve) => {
      resolveOnce = resolve
    })
    const pending = {
      key,
      requestId,
      chatId: turn.chatId,
      asker: turn.openId || '',
      toolName: String((req && req.toolName) || ''),
      callId: (req && req.callId) || '',
      done: false,
      resolve: resolveOnce,
      timer: undefined,
      signal: (req && req.signal) || undefined,
      onAbort: undefined,
    }
    this.pending.set(key, pending)

    try {
      await this.api.sendInteractive(
        turn.chatId,
        buildApprovalCard({
          requestId,
          toolName: pending.toolName,
          reason: req && req.reason,
          callId: pending.callId,
          timeoutMs: this.timeoutMs,
          defaultOutcome: this.timeoutOutcome,
        }),
      )
    } catch (error) {
      // 卡片都发不出去，这个请求没法由人决定：按不可用收口（调用方会失败关闭）
      this.log.error('审批卡片发送失败', { key, toolName: pending.toolName, error: String(error) })
      this.settle(pending, 'unavailable')
      return 'unavailable'
    }

    if (pending.done) return settled

    if (pending.signal) {
      if (pending.signal.aborted) {
        this.settle(pending, 'cancelled')
        return 'cancelled'
      }
      pending.onAbort = () => {
        this.log.info('审批请求被 dsh 撤回（本轮已停止或超时）', { key, toolName: pending.toolName })
        this.settle(pending, 'cancelled')
      }
      pending.signal.addEventListener('abort', pending.onAbort, { once: true })
    }

    pending.timer = setTimeout(() => this.expire(pending), this.timeoutMs)
    if (typeof pending.timer.unref === 'function') pending.timer.unref()

    this.log.info('已把审批发到飞书，等待答复', {
      key,
      toolName: pending.toolName,
      timeoutMs: this.timeoutMs,
    })
    return settled
  }

  /** 某个会话当前是否有一条审批在等 */
  pendingFor(key) {
    return this.pending.get(String(key))
  }

  /** 按 requestId 反查：卡片回调只带 requestId */
  findByRequestId(requestId) {
    if (!requestId) return undefined
    for (const pending of this.pending.values()) {
      if (pending.requestId === requestId) return pending
    }
    return undefined
  }

  /**
   * 卡片按钮回调。必须是同步返回：飞书长连接把回调返回值直接当作 toast 响应，
   * 返回 Promise 的话飞书收到的是一个空对象，用户点了按钮什么反馈都没有。
   *
   * @param {any} raw
   * @returns {{ toast: { type: string, content: string } }}
   */
  onCardAction(raw) {
    const parsed = parseApprovalAction(raw)
    if (!parsed) return toast('这个按钮已失效')
    const pending = this.findByRequestId(parsed.requestId)
    if (!pending) return toast('这个审批已经处理过了')
    // 群里所有人都能看到卡片，但只有发起这一轮的人能决定
    if (pending.asker && parsed.operatorOpenId && parsed.operatorOpenId !== pending.asker) {
      return toast('只有发起这一轮的人可以审批')
    }

    this.settle(pending, parsed.decision)
    return {
      toast: {
        type: parsed.decision === DECISION_ALLOW ? 'success' : 'warning',
        content: (parsed.decision === DECISION_ALLOW ? '已允许一次：' : '已拒绝：') + pending.toolName,
      },
    }
  }

  /**
   * 用户直接回文字：命中明确说法就当决定，命不中只提示一句、不把消息投给 agent
   * （正在等审批时把一条普通消息投进去，只会变成新一轮对话，审批照样卡着）。
   *
   * @param {string} key
   * @param {string} text
   * @returns {'settled'|'hint'|undefined} undefined = 当前没有审批在等
   */
  answerByText(key, text) {
    const pending = this.pending.get(String(key))
    if (!pending) return undefined

    const decision = parseApprovalText(text)
    if (decision === undefined) {
      void this.api
        .sendText(pending.chatId, '还有一条审批在等你：点卡片上的按钮，或直接回复「允许」/「拒绝」')
        .catch(() => {})
      return 'hint'
    }

    this.settle(pending, decision)
    void this.api
      .sendText(pending.chatId, (decision === DECISION_ALLOW ? '已允许一次：' : '已拒绝：') + pending.toolName)
      .catch(() => {})
    this.log.info('飞书用户用文字答复了审批', { key, toolName: pending.toolName, decision })
    return 'settled'
  }

  /**
   * 取消某个会话的审批（会话重置 / 用户 /stop / 桥接停止）。
   * 取消是『撤回请求』，不是『拒绝』：dsh 会把工具调用直接终止。
   */
  cancel(key, reason) {
    const pending = this.pending.get(String(key))
    if (!pending) return false
    this.log.info('取消等待中的审批', { key, toolName: pending.toolName, reason: String(reason || '') })
    this.settle(pending, 'cancelled')
    return true
  }

  /** 取消全部待答审批（桥接停止 / 插件卸载） */
  cancelAll(reason) {
    for (const key of [...this.pending.keys()]) this.cancel(key, reason)
  }

  /** 超时：按配置的默认决定收口，并在会话里留一句说明 */
  expire(pending) {
    const outcome = this.timeoutOutcome
    this.log.warn('审批超时，按默认决定收口', { key: pending.key, toolName: pending.toolName, outcome })
    this.settle(pending, outcome)
    const minutes = Math.max(1, Math.round(this.timeoutMs / 60000))
    void this.api
      .sendText(
        pending.chatId,
        '审批超时（' + minutes + ' 分钟没有回复），已按「' + DECISION_LABEL[outcome] + '」处理：' + pending.toolName,
      )
      .catch(() => {})
  }

  /**
   * 收口一个审批：清定时器与中止监听、从表里摘掉、兑现 Promise。
   * 重复调用是安全的（先到先得），卡片与文字两条路径可能同时到达。
   */
  settle(pending, outcome) {
    if (!pending || pending.done) return false
    pending.done = true
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer)
      pending.timer = undefined
    }
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort)
      pending.onAbort = undefined
    }
    if (this.pending.get(pending.key) === pending) this.pending.delete(pending.key)
    pending.resolve(outcome)
    return true
  }
}

/** 卡片回调的 toast 响应 */
function toast(content) {
  return { toast: { type: 'info', content } }
}
