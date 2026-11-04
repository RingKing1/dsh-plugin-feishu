import { buildCard, clipText } from './card.js'
import { ProgressTracker, trimProgressToBytes } from './progress.js'
import { ReplyStream } from './reply-stream.js'

/** 进度清单的字节上限：卡片整块更新，超限会被飞书拒绝 */
const PROGRESS_BYTES_LIMIT = 8 * 1024

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
    this.timer = undefined
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
      const card = buildCard({
        status: 'running',
        title: this.title,
        body: '',
        streaming: true,
        key: this.key,
        progress: snapshot.markdown,
        progressEnabled: this.progress.enabled,
        progressTitle: snapshot.title,
      })
      this.cardId = await this.api.createCard(card)
      this.messageId = await this.api.sendCard(this.chatId, this.cardId)
      this.trace('card-start', { key: this.key, cardId: this.cardId, title: this.title })
      this.log.debug('已创建流式卡片', { cardId: this.cardId, messageId: this.messageId })
      if (this.text) this.schedule()
    } catch (error) {
      this.failed = true
      this.trace('card-start-failed', { key: this.key, error: String(error) })
      this.log.warn('创建卡片失败，本轮改用纯文本回复', { error: String(error) })
    } finally {
      this.starting = undefined
    }
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
    if (this.timer || this.closed || !this.cardId) return
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

  /** @returns {Promise<void>} */
  flush() {
    return this.enqueue(() => this.doFlush())
  }

  async doFlush() {
    if (!this.cardId || this.closed) return
    // 空正文不能直接推：飞书会拒掉空 content。占位等下一个 delta 盖掉
    const text = clipText(this.bodyText(), this.maxChars) || this.placeholder()
    if (text && text !== this.sent) {
      try {
        await this.api.putCardContent(this.cardId, text, ++this.sequence)
        this.sent = text
        this.trace('flush-ok', { key: this.key, len: text.length })
      } catch (error) {
        // 单次刷新失败不致命：下一拍还会带着全文重试
        this.trace('flush-failed', { key: this.key, len: text.length, error: String(error) })
        this.log.debug('流式刷新失败', { error: String(error) })
      }
    }
    // 直接调内部实现：再进一次队列会等自己，形成死锁
    await this.doFlushProgress()
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
      try {
        await this.api.putProgress(this.cardId, markdown, ++this.sequence)
        this.sentProgress = markdown
      } catch (error) {
        this.log.debug('推送执行过程失败', { error: String(error) })
      }
    }
    if (snapshot.title && snapshot.title !== this.sentProgressTitle) {
      try {
        await this.api.putProgressPanel(this.cardId, snapshot.title, ++this.sequence)
        this.sentProgressTitle = snapshot.title
      } catch (error) {
        this.log.debug('更新执行过程标题失败', { error: String(error) })
      }
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

    try {
      if (text && text !== this.sent) {
        await this.api.putCardContent(this.cardId, text, ++this.sequence)
        this.sent = text
      }
      // 过程清单必须赶在关流式之前推完：关流后卡片不再接受元件级更新
      if (progress && progress !== this.sentProgress) {
        await this.api.putProgress(this.cardId, progress, ++this.sequence)
        this.sentProgress = progress
      }
      // 面板标题（「第 N 步 · 执行过程」）也要在关流前同步一次：
      // 节流窗口里可能来不及推，收尾后就再也改不动了
      if (snapshot.title && snapshot.title !== this.sentProgressTitle) {
        await this.api.putProgressPanel(this.cardId, snapshot.title, ++this.sequence)
        this.sentProgressTitle = snapshot.title
      }
      await this.api.closeStreaming(this.cardId, ++this.sequence, (text || note || '回复').slice(0, 50))
    } catch (error) {
      this.trace('finish-stream-close-failed', { key: this.key, error: String(error) })
      this.log.warn('关闭流式失败', { cardId: this.cardId, error: String(error) })
    }

    try {
      const card = buildCard({
        status,
        title: this.title,
        body: text,
        note,
        progress,
        progressEnabled: this.progress.enabled,
        progressTitle: snapshot.title,
        progressExpanded: status !== 'done',
      })
      await this.api.updateCard(this.cardId, card, ++this.sequence)
    } catch (error) {
      this.trace('finish-update-failed', { key: this.key, error: String(error) })
      this.log.warn('终态卡片更新失败', { cardId: this.cardId, error: String(error) })
      const fallback = note && !text ? note : text
      if (fallback) await this.api.sendText(this.chatId, fallback).catch(() => {})
    }
    return true
  }

  /** 只清定时器，不发请求（插件卸载时用，避免退出卡住）。 */
  dispose() {
    this.closed = true
    this.clearTimer()
  }

  clearTimer() {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
