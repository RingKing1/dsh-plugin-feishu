import { buildCard, clipText } from './card.js'
import { ProgressTracker, formatDuration, trimProgressToBytes } from './progress.js'
import { ReplyStream } from './reply-stream.js'

/** 进度清单的字节上限：卡片整块更新，超限会被飞书拒绝 */
const PROGRESS_BYTES_LIMIT = 8 * 1024

/**
 * 运行态心跳间隔：15s。
 * 飞书那边「一动不动」就等于「卡死了」，所以哪怕没有任何事件，卡片也必须自己走字。
 */
const DEFAULT_HEARTBEAT_MS = 15 * 1000

/** 收尾重试：1 次失败不算失败，3 次之后才在当前进程里认输（交给巡检器兜底） */
const FINISH_ATTEMPTS = 3
/** 流式刷新重试：只多试一次，失败下一拍还会带全文重来 */
const FLUSH_ATTEMPTS = 2
/** 指数退避的基数 */
const RETRY_BASE_MS = 300
/** 状态行里工具描述的视觉上限，再长就挤掉「已用时长」 */
const STATUS_ACTIVITY_CHARS = 60

/**
 * 正文空态占位：飞书不接受空的 element 内容更新，清空正文时换成这句话，
 * 等下一步的第一个字到了再盖掉。
 */
const EMPTY_BODY_PLACEHOLDER = '正在处理…'

/**
 * 一轮回复对应的一张流式卡片。
 *
 * 生命周期：
 *   start()（建卡 + 发消息） -> append()/trackTool()（累积文本与过程，节流刷新）
 *   -> pauseForAsk()（居中定格，等用户选择）或 finish()（收尾）
 *
 * 任何一步失败都不会抛给调用方：卡片只是展示层，失败时退化为纯文本消息，
 * 绝不能让「卡片更新失败」把已经跑完的这一轮回复弄丢。
 */
export class ReplyCard {
  constructor(options) {
    const settings = options || {}
    this.api = settings.api
    this.chatId = settings.chatId
    this.key = settings.key
    this.title = settings.title
    this.intervalMs = settings.intervalMs || 700
    this.maxChars = settings.maxChars || 8000
    this.log = settings.log
    /** 关键链路追踪（debug 开启时落盘，见 lib/trace.js）；默认空函数 */
    this.trace = typeof settings.trace === 'function' ? settings.trace : () => {}
    /** 可注入的时钟：心跳与「已用时长」都靠它，单测里换成假时钟就不再依赖真实等待 */
    this.now = typeof settings.now === 'function' ? settings.now : () => Date.now()
    /** 本轮起始时间：状态行里的「已用 MM:SS」全部以它为准 */
    this.startedAt = this.now()
    /** 心跳间隔；0 = 关闭（单测用） */
    this.heartbeatMs = settings.heartbeatMs === undefined ? DEFAULT_HEARTBEAT_MS : Number(settings.heartbeatMs) || 0
    this.heartbeatTimer = undefined
    /** 收尾重试次数基数，WATCHDOG 与单测共用 */
    this.retryBaseMs = settings.retryBaseMs === undefined ? RETRY_BASE_MS : Number(settings.retryBaseMs) || 0
    /** 最近一次成功写入卡片的时间；超过阈值没刷新 = 卡片可能已经假活 */
    this.lastSyncAt = this.now()
    /** 当前这轮里累计失败的卡片操作数（收尾时若仍失败，写进卡片备注） */
    this.failures = 0
    /** 最近一次失败的操作与原因（/status、兜底提示都用它） */
    this.lastError = ''
    /** 上层钩子：卡片建好 / 关闭时登记与注销「在册卡片」，重启清扫靠它 */
    this.onCardCreated = settings.onCardCreated
    this.onCardClosed = settings.onCardClosed
    /** 执行过程清单：与正文同卡不同元件，各自去重推送 */
    this.progress = settings.progressTracker || new ProgressTracker({ mode: settings.progressMode })
    /**
     * 帧状态机：正文归属由它决定。
     * bodyMode=final（默认）只把当前步的文本放进正文，切步时上一步文本降级成旁白；
     * bodyMode=live 保留旧行为（全过程拼进正文）。
     */
    this.stream = new ReplyStream({ bodyMode: settings.bodyMode, showReasoning: settings.showReasoning })
    /** 上一次 noteStep 的步号：步号变化时顺手刷新一下过程面板标题 */
    this.lastStep = -1

    this.text = ''
    this.cardId = ''
    this.messageId = ''
    this.sequence = 0
    this.sent = ''
    this.sentProgress = ''
    this.sentProgressTitle = ''
    /** 状态行上一次推出去的内容（心跳据此去重） */
    this.sentStatus = ''
    this.timer = undefined
    /** 建卡完成前就到来的变更（工具调用 / 文本）：建好卡要立刻补一次刷新 */
    this.pendingFlush = false
    /** 卡片写入串行队列：sequence 必须严格递增，两拍并发会让飞书报 sequence compare failed */
    this.writes = Promise.resolve()
    this.starting = undefined
    this.closed = false
    this.failed = false
    this.paused = false
  }

  /** 卡片是否已经建好（失败时永远是 false，上层据此决定是否兜底发文本）。 */
  get ready() {
    return Boolean(this.cardId)
  }

  /**
   * 创建卡片并发到会话里。并发调用共享同一个 Promise。
   * 交付即建卡（startImmediately 的语义就是本方法）：用户发完消息马上看到「回复中」，
   * 不必等模型吐出第一段文字 —— 首字往往要几秒到几十秒。
   */
  start() {
    if (this.cardId || this.failed) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.doStart()
    return this.starting
  }

  async doStart() {
    try {
      const snapshot = this.progress.snapshot()
      const statusLine = this.statusLine()
      const card = buildCard({
        status: 'running',
        title: this.title,
        body: '',
        streaming: true,
        key: this.key,
        statusLine,
        progress: snapshot.markdown,
        progressEnabled: this.progress.enabled,
        progressTitle: snapshot.title,
      })
      this.cardId = await this.api.createCard(card)
      this.messageId = await this.api.sendCard(this.chatId, this.cardId)
      this.trace('card-start', { key: this.key, cardId: this.cardId, title: this.title })
      this.sentStatus = statusLine
      this.lastSyncAt = this.now()
      this.log.debug('已创建流式卡片', { cardId: this.cardId, messageId: this.messageId })
      if (typeof this.onCardCreated === 'function') {
        try {
          this.onCardCreated(this.cardId)
        } catch (error) {
          this.log.warn('登记在册卡片失败（不影响本轮）', { cardId: this.cardId, error: String(error) })
        }
      }
      // 建卡期间发生的工具调用 / 文本不能丢：那时 schedule() 因 cardId 为空直接返回了，
      // 这里补一次，否则「一张卡建好就再也不动」——12 分钟只显示「回复中」就是这么来的
      if (this.pendingFlush || this.text) this.schedule()
      this.startHeartbeat()
    } catch (error) {
      this.failed = true
      this.trace('card-start-failed', { key: this.key, error: String(error) })
      this.log.warn('创建卡片失败，本轮改用纯文本回复', { error: String(error) })
    } finally {
      this.starting = undefined
    }
  }

  /**
   * 顶部状态行文案：`⏳ 回复中 · 第 3 步 · bash pnpm build · 已用 12:11`。
   *
   * 为什么单开一个元件而不是写正文：final 模式下正文里是真正的答案，
   * 心跳不能把它盖掉；而用户最需要的东西（还在跑吗 / 跑到哪 / 跑了多久）
   * 必须每 15 秒自己动一次，不能只靠“有事件才刷新”。
   */
  statusLine(override) {
    if (typeof override === 'string') return override
    const elapsed = formatDuration(this.now() - this.startedAt)
    const step = this.progress.step >= 0 ? '第 ' + (this.progress.step + 1) + ' 步' : ''
    const running = this.progress.running
    let activity = ''
    if (running) {
      activity = (running.detail ? running.toolName + ' ' + running.detail : running.toolName).trim()
      if (activity.length > STATUS_ACTIVITY_CHARS) activity = activity.slice(0, STATUS_ACTIVITY_CHARS - 1) + '…'
    }
    return ['⏳ 回复中', step, activity, '已用 ' + elapsed].filter(Boolean).join(' · ')
  }

  /** 心跳：无论有没有事件，卡片都要自己走字 */
  startHeartbeat() {
    if (this.heartbeatTimer || !this.heartbeatMs || this.closed || !this.cardId) return
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || this.paused || !this.cardId) return
      void this.flush()
    }, this.heartbeatMs)
    // 不吊住进程退出（插件卸载 / 测试结束时定时器不该阻止退出）
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  append(delta) {
    if (this.closed || !delta) return
    this.text += delta
    this.schedule()
  }

  /**
   * 整段替换正文。用于 block-end 与 attempt 结束时的权威校正，也用于重试 / 切步的清空。
   * @param {string} text
   */
  setText(text) {
    const next = typeof text === 'string' ? text : ''
    if (this.closed || next === this.text) return
    this.text = next
    this.schedule()
  }

  /** 最终正文：当前步优先，空了回落到最后一个有文本的步骤 */
  bodyText() {
    return this.text || this.stream.finalText()
  }

  /**
   * 正文还没内容时的占位。
   * 执行中必须让人看得出「在干活」：直接报当前正在跑的工具，
   * 而不是一句静态的「正在处理…」——长任务里那句占位会挂好几分钟。
   */
  placeholder() {
    const activity = this.progress.activity()
    return activity ? '⏳ 正在执行 ' + activity + '…' : EMPTY_BODY_PLACEHOLDER
  }

  /**
   * agent 流式帧的入口：状态机把帧翻成动作，这里只负责执行。
   * 所有写入都幂等（setText / append 去重，进度事件自带去重），重放帧不会刷屏。
   * @param {object} frame agent/assistant-stream 的 frame
   */
  onFrame(frame) {
    if (this.closed) return
    for (const action of this.stream.accept(frame)) this.applyAction(action)
  }

  /** @param {{kind: string, text?: string, step?: number, reason?: string}} action */
  applyAction(action) {
    if (!action || typeof action.kind !== 'string') return
    switch (action.kind) {
      case 'append':
        // 正文以状态机算出的全文为准：切步后第一个 delta 会把上一步的文字整段换掉，
        // 而不是接在它后面（final 模式下 blocks 已按 step 重置）
        this.setText(this.stream.text())
        return
      case 'replace':
        this.setText(action.text)
        return
      case 'reset':
        // 正文清空代表「上一步说完了，下一步还没开口」：推占位而不是空串
        this.setText('')
        return
      case 'narration':
        this.progress.trackNarration({ text: action.text, step: action.step })
        this.schedule()
        return
      case 'reasoning':
        this.progress.trackReasoning({ text: action.text, step: action.step })
        this.schedule()
        return
      case 'step':
        if (this.progress.noteStep(action.step)) this.schedule()
        this.lastStep = action.step
        return
      case 'commit':
        // attempt 已提交：立即推一次，不必等下一个节流窗口
        void this.flushNow()
        return
      default:
        // usage / finish 只是元信息，正文与过程都用不上
        return
    }
  }

  /** 记录一次工具调用（数据来自 session 的 tool/call 事件）。 */
  trackToolCall(data) {
    if (this.closed) return
    if (!this.progress.trackCall(data)) return
    this.schedule()
  }

  /** 记录一次工具结果（session 的 tool/result 事件）。 */
  trackToolResult(data) {
    if (this.closed) return
    if (!this.progress.trackResult(data)) return
    this.schedule()
  }

  /** 用户中断：把未结束的步骤标成 ⛔ 并立刻推一次。 */
  abortProgress() {
    this.progress.abortAll()
    void this.flushProgress()
  }

  /** 节流：首次变更后 schedule 一次，定时器触发时一次性推送当前全文与过程。 */
  schedule() {
    if (this.closed) return
    if (!this.cardId) {
      // 建卡还没回来：记一笔，doStart 成功时补排期。
      // 少了这一步，「建卡前到达的第一次工具调用」就永远推不出去
      this.pendingFlush = true
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.intervalMs)
    // 不吊住进程退出（插件卸载/测试结束时定时器不该阻止退出）
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * 所有卡片写入排进同一条队列。
   *
   * 飞书按 `sequence` 严格递增校验整卡更新，并发写入会让「后来的请求带更小的号」
   * 而被拒（`sequence number compare failed`）；排队后顺序与号段天然一致。
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T|undefined>}
   */
  enqueue(task) {
    const run = this.writes.then(task, task)
    // 队列本身不能因为某次失败断掉
    this.writes = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 带重试的卡片写入。
   *
   * 飞书那边一次超时就会把卡片永久停在旧状态，所以幂等写入一律重试；
   * 指数退避（300 / 600 / 1200ms）避开瞬时网络抖动，又不至于在真挂了的时候干等。
   *
   * 不论成败都不抛给调用方：卡片只是展示层，不能把已经跑完的回复弄丢。
   *
   * @param {string} op 操作名（日志里能一眼看出是哪一步失败）
   * @param {number} attempts 总尝试次数（含首次）
   * @param {() => Promise<unknown>} task
   * @param {'debug'|'warn'} [level] 全部失败后的日志级别
   * @returns {Promise<boolean>}
   */
  async attempt(op, attempts, task, level) {
    const total = Math.max(1, Number(attempts) || 1)
    let lastError
    for (let index = 0; index < total; index += 1) {
      try {
        await task()
        this.lastSyncAt = this.now()
        return true
      } catch (error) {
        lastError = error
        if (index < total - 1) await delayMs(this.retryBaseMs * 2 ** index)
      }
    }
    this.failures += 1
    this.lastError = op + '：' + String(lastError)
    const write = level === 'warn' ? this.log.warn.bind(this.log) : this.log.debug.bind(this.log)
    write(op + '失败（已重试 ' + (total - 1) + ' 次）', { cardId: this.cardId, error: String(lastError) })
    return false
  }

  /** @returns {Promise<void>} */
  flush() {
    return this.enqueue(() => this.doFlush())
  }

  async doFlush() {
    if (!this.cardId || this.closed) return
    this.pendingFlush = false
    // 状态行单独写：正文／过程都没变化时，心跳也要能把「已用时长」推上去
    await this.doFlushStatus()
    // 空正文不能直接推：飞书会拒掉空 content。占位等下一个 delta 盖掉
    const text = clipText(this.bodyText(), this.maxChars) || this.placeholder()
    if (text && text !== this.sent) {
      const ok = await this.attempt('刷新正文', FLUSH_ATTEMPTS, () => this.api.putCardContent(this.cardId, text, ++this.sequence))
      if (ok) {
        this.sent = text
        this.trace('flush-ok', { key: this.key, len: text.length })
      } else {
        // 单次刷新失败不致命：下一拍还会带着全文重试
        this.trace('flush-failed', { key: this.key, len: text.length, error: this.lastError })
      }
    }
    // 直接调内部实现：再进一次队列会等自己，形成死锁
    await this.doFlushProgress()
  }

  /** 推送顶部存活状态行（未建出该元件时静默跳过，兼容旧的 api 实现） */
  async doFlushStatus() {
    if (!this.cardId || this.closed) return
    if (typeof this.api.putCardStatus !== 'function') return
    const line = this.statusLine()
    if (!line || line === this.sentStatus) return
    const ok = await this.attempt('更新状态行', FLUSH_ATTEMPTS, () => this.api.putCardStatus(this.cardId, line, ++this.sequence))
    if (ok) this.sentStatus = line
  }

  /**
   * 推送执行过程：正文元件与折叠面板标题各自去重。
   * 工具事件很密（一条命令就有调用 + 结果两次），每个事件都推一次会把卡片接口打满，
   * 因此与正文共用同一个节流窗口。
   */
  /** @returns {Promise<void>} */
  flushProgress() {
    return this.enqueue(() => this.doFlushProgress())
  }

  async doFlushProgress() {
    if (!this.cardId || this.closed) return
    const snapshot = this.progress.snapshot()
    if (snapshot.markdown && snapshot.markdown !== this.sentProgress) {
      const markdown = trimProgressToBytes(snapshot.markdown, PROGRESS_BYTES_LIMIT)
      const ok = await this.attempt('推送执行过程', FLUSH_ATTEMPTS, () => this.api.putProgress(this.cardId, markdown, ++this.sequence))
      if (ok) this.sentProgress = markdown
    }
    if (snapshot.title && snapshot.title !== this.sentProgressTitle) {
      const ok = await this.attempt('更新执行过程标题', FLUSH_ATTEMPTS, () => this.api.putProgressPanel(this.cardId, snapshot.title, ++this.sequence))
      if (ok) this.sentProgressTitle = snapshot.title
    }
  }

  /** 立即推送一次（一轮结束时调用，不必等下一个节流窗口）。 */
  async flushNow() {
    this.clearTimer()
    await this.flush()
  }

  /**
   * 提问前把卡片定格成「等你选择」。
   *
   * 为什么要定格而不是放着不管：回复卡正在流式输出，选择题卡片是另一条消息，
   * 两者同时「活着」时用户不知道哪张才是当前该操作的；而且 dsh 在等待回答期间
   * 不会再有新 delta，卡片会停在半句话上，看上去像卡死。
   *
   * 收尾后本卡关闭，回答完由上层新建一张卡（标题带「接上条」），
   * 绝不在旧卡上原地续写 —— 那会让新回复出现在旧位置，把后发的问题卡顶下去。
   *
   * @param {string} [note]
   * @returns {Promise<boolean>} 是否有可定格的卡片
   */
  async pauseForAsk(note) {
    if (this.closed) return false
    if (!this.cardId) {
      // 卡片还没建起来（首字未到就提问）：没什么可定格的，上层照常发问题卡
      this.closed = true
      this.clearTimer()
      return false
    }
    this.clearTimer()
    this.paused = true
    this.stopHeartbeat()
    this.sentStatus = this.statusLine('⏸ 等你选择 · 已用 ' + formatDuration(this.now() - this.startedAt))
    await this.flush()
    const snapshot = this.progress.snapshot()
    const progress = snapshot.markdown ? trimProgressToBytes(snapshot.markdown, PROGRESS_BYTES_LIMIT) : ''
    try {
      await this.api.closeStreaming(this.cardId, ++this.sequence, (this.bodyText() || '等你选择').slice(0, 50))
    } catch (error) {
      this.log.debug('关闭流式失败（继续定格）', { cardId: this.cardId, error: String(error) })
    }
    try {
      const card = buildCard({
        status: 'paused',
        title: this.title,
        body: clipText(this.bodyText(), this.maxChars),
        note: note || '等你选择',
        progress,
        progressEnabled: this.progress.enabled,
        progressTitle: snapshot.title,
        progressExpanded: true,
        key: this.key,
      })
      await this.api.updateCard(this.cardId, card, ++this.sequence)
    } catch (error) {
      this.log.warn('定格卡片失败（不影响提问）', { cardId: this.cardId, error: String(error) })
    }
    this.closed = true
    return true
  }

  /**
   * 问答结束后的定格收尾：把「等你选择」那张卡原地翻成「已选择 / 已结束」。
   *
   * pauseForAsk 已经把卡片的流式关掉并置 closed=true；这里刻意不检查 closed，
   * 因为要更新的正是那张已关闭的暂停卡。状态卡只改 header 与备注，正文保持原样。
   *
   * @param {'answered'|'stopped'} [status]
   * @param {string} [note]
   * @returns {Promise<boolean>}
   */
  async settlePaused(status, note) {
    if (!this.paused || !this.cardId) return false
    const snapshot = this.progress.snapshot()
    const progress = snapshot.markdown ? trimProgressToBytes(snapshot.markdown, PROGRESS_BYTES_LIMIT) : ''
    const card = buildCard({
      status: status === 'stopped' ? 'stopped' : 'answered',
      body: clipText(this.bodyText(), this.maxChars),
      note,
      progress,
      progressEnabled: this.progress.enabled,
      progressTitle: snapshot.title,
      progressExpanded: true,
      key: this.key,
    })
    try {
      await this.api.updateCard(this.cardId, card, ++this.sequence)
      this.paused = false
      return true
    } catch (error) {
      this.log.warn('问答结束后更新暂停卡失败', { cardId: this.cardId, error: String(error) })
      this.paused = false
      return false
    }
  }

  /** 问题答完：暂停卡翻成「已选择」，随后上层另开「回复（接上条）」 */
  async markAnswered() {
    return this.settlePaused('answered')
  }

  /**
   * 收尾：推送最终正文与过程、关闭流式、把 header 换成终态。
   * @param {{ status?: 'done'|'failed'|'stopped', note?: string }} options
   * @returns {Promise<boolean>} 卡片是否可用（false 表示需要上层兜底发文本）
   */
  async finish(options) {
    if (this.closed) return this.ready
    this.closed = true
    this.clearTimer()
    await this.start()
    if (!this.cardId) return false

    const settings = options || {}
    const status = settings.status || 'done'
    // 被 max-tokens 截断是「这一轮本来还有话说」，不能静默收尾
    const truncation = status === 'done' && this.stream.finishReason === 'max-tokens' ? '本轮输出达到长度上限，已被截断' : ''
    const note = [settings.note, truncation].filter(Boolean).join('\n') || undefined
    const text = clipText(this.bodyText(), this.maxChars)
    this.trace('finish', { key: this.key, status, len: text.length, sentLen: this.sent.length, finishReason: this.stream.finishReason })
    const snapshot = this.progress.snapshot()
    const progress = snapshot.markdown ? trimProgressToBytes(snapshot.markdown, PROGRESS_BYTES_LIMIT) : ''

    // 终态状态行：收尾之后再也不会自动刷新，所以这里必须写死「跑了多久 / 几步」，
    // 用户事后翻消息时才不会只看到一条停在半路的卡
    const finalBadge = status === 'failed' ? '❌ 出错了' : status === 'stopped' ? '⏹ 已停止' : '✅ 完成'
    const steps = snapshot.markdown && this.progress.step >= 0 ? ' · 共 ' + (this.progress.step + 1) + ' 步' : ''
    const finalLine = finalBadge + ' · 用时 ' + formatDuration(this.now() - this.startedAt) + steps

    this.stopHeartbeat()

    // 收尾三次机会：飞书偶发超时是常态，一次失败就把卡片停在「回复中」才是真事故（NFR-2）
    if (text && text !== this.sent) {
      const ok = await this.attempt('收尾正文', FINISH_ATTEMPTS, () => this.api.putCardContent(this.cardId, text, ++this.sequence), 'warn')
      if (ok) this.sent = text
    }
    // 过程清单必须赶在关流式之前推完：关流后卡片不再接受元件级更新
    if (progress && progress !== this.sentProgress) {
      const ok = await this.attempt('收尾执行过程', FINISH_ATTEMPTS, () => this.api.putProgress(this.cardId, progress, ++this.sequence), 'warn')
      if (ok) this.sentProgress = progress
    }
    // 面板标题（「第 N 步 · 执行过程」）也要在关流前同步一次：
    // 节流窗口里可能来不及推，收尾后就再也改不动了
    if (snapshot.title && snapshot.title !== this.sentProgressTitle) {
      const ok = await this.attempt('收尾过程标题', FINISH_ATTEMPTS, () => this.api.putProgressPanel(this.cardId, snapshot.title, ++this.sequence), 'warn')
      if (ok) this.sentProgressTitle = snapshot.title
    }
    const closed = await this.attempt('关闭流式', FINISH_ATTEMPTS, () => this.api.closeStreaming(this.cardId, ++this.sequence, (text || note || '回复').slice(0, 50)), 'warn')
    if (!closed) this.trace('finish-stream-close-failed', { key: this.key, error: this.lastError })

    const card = buildCard({
      status,
      title: this.title,
      body: text,
      note,
      statusLine: finalLine,
      progress,
      progressEnabled: this.progress.enabled,
      progressTitle: snapshot.title,
      progressExpanded: status !== 'done',
    })
    const updated = await this.attempt('终态卡片更新', FINISH_ATTEMPTS, () => this.api.updateCard(this.cardId, card, ++this.sequence), 'warn')
    if (updated) {
      this.sentStatus = finalLine
      this.notifyClosed()
      return true
    }
    this.trace('finish-update-failed', { key: this.key, error: this.lastError })

    // 三次都炸了：卡片只能停在原地，这时必须把答案用纯文本再送一遍，
    // 并且明说卡片没更新成功 —— 静默降级等于让用户以为「这轮没回复」（NFR-3）
    const fallback = note && !text ? note : text
    if (fallback) {
      const degraded = '⚠️ 卡片状态更新失败，以下为最终结果：\n\n' + fallback
      await this.api.sendText(this.chatId, degraded).catch(() => {})
    }
    this.degraded = true
    this.lastError = this.lastError || '终态卡片更新失败'
    this.notifyClosed()
    return false
  }

  /**
   * 巡检器用：这张卡是不是「假活」——还有心跳、但已经很久没写入成功。
   * @param {number} thresholdMs
   */
  isStale(thresholdMs) {
    if (this.closed || !this.cardId) return false
    const limit = Number(thresholdMs) || 0
    return limit > 0 && this.now() - this.lastSyncAt > limit
  }

  /**
   * 兜底中断（进程崩溃 / 重启 / 网络长时间不可用）：把卡片强制翻成「已中断」，
   * 并写明原因。调用方拿不到原对象时（重启后）由巡检器用自己的 api 调这里。
   *
   * @param {string} [reason]
   * @returns {Promise<boolean>}
   */
  async forceInterrupt(reason) {
    if (!this.cardId) return false
    this.closed = true
    this.stopHeartbeat()
    this.clearTimer()
    const finalLine = '⛔ 已中断 · 用时 ' + formatDuration(this.now() - this.startedAt)
    const note = '⚠️ ' + (reason || '卡片长时间没有更新') + '，本轮已中断，请重发这条消息'
    const snapshot = this.progress.snapshot()
    const card = buildCard({
      status: 'stopped',
      title: this.title,
      body: clipText(this.bodyText(), this.maxChars),
      note,
      statusLine: finalLine,
      progress: snapshot.markdown ? trimProgressToBytes(snapshot.markdown, PROGRESS_BYTES_LIMIT) : '',
      progressEnabled: this.progress.enabled,
      progressTitle: snapshot.title,
      progressExpanded: true,
    })
    const ok = await this.attempt('兜底中断卡片', FINISH_ATTEMPTS, () => this.api.updateCard(this.cardId, card, ++this.sequence), 'warn')
    this.notifyClosed()
    return ok
  }

  /** 通知上层注销在册卡片（失败不影响收尾） */
  notifyClosed() {
    if (typeof this.onCardClosed !== 'function' || !this.cardId) return
    try {
      this.onCardClosed(this.cardId)
    } catch (error) {
      this.log.debug('注销在册卡片失败（不影响本轮）', { cardId: this.cardId, error: String(error) })
    }
  }

  /** 只清定时器，不发请求（插件卸载时用，避免退出卡住）。 */
  dispose() {
    this.closed = true
    this.stopHeartbeat()
    this.clearTimer()
  }

  clearTimer() {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** 退避等待；0 或非法值直接放行（单测把 retryBaseMs 设成 0 就不必真等） */
function delayMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms > 0 ? ms : 0))
}
