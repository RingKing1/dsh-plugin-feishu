import { buildCard, clipText } from './card.js'

/**
 * 一轮回复对应的一张流式卡片。
 *
 * 生命周期：start()（建卡 + 发消息） -> append()（累积文本，节流刷新）-> finish()（收尾）。
 * 任何一步失败都不会抛给调用方：卡片只是展示层，失败时退化为纯文本消息，
 * 绝不能让「卡片更新失败」把已经跑完的这一轮回复弄丢。
 */
export class ReplyCard {
  constructor(options) {
    const settings = options || {}
    this.api = settings.api
    this.chatId = settings.chatId
    this.title = settings.title
    this.intervalMs = settings.intervalMs || 700
    this.maxChars = settings.maxChars || 8000
    this.log = settings.log

    this.text = ''
    this.cardId = ''
    this.messageId = ''
    this.sequence = 0
    this.sent = ''
    this.timer = undefined
    this.starting = undefined
    this.closed = false
    this.failed = false
  }

  /** 卡片是否已经建好（失败时永远是 false，上层据此决定是否兜底发文本）。 */
  get ready() {
    return Boolean(this.cardId)
  }

  /** 创建卡片并发到会话里。并发调用共享同一个 Promise。 */
  start() {
    if (this.cardId || this.failed) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.doStart()
    return this.starting
  }

  async doStart() {
    try {
      const card = buildCard({ status: 'running', title: this.title, body: '', streaming: true })
      this.cardId = await this.api.createCard(card)
      this.messageId = await this.api.sendCard(this.chatId, this.cardId)
      this.log.debug('已创建流式卡片', { cardId: this.cardId, messageId: this.messageId })
      if (this.text) this.schedule()
    } catch (error) {
      this.failed = true
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

  /** 节流：首次变更后 schedule 一次，定时器触发时一次性推送当前全文。 */
  schedule() {
    if (this.timer || this.closed || !this.cardId) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.intervalMs)
    // 不吊住进程退出（插件卸载/测试结束时定时器不该阻止退出）
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  async flush() {
    if (!this.cardId || this.closed) return
    const text = clipText(this.text, this.maxChars)
    if (!text || text === this.sent) return
    try {
      await this.api.putCardContent(this.cardId, text, ++this.sequence)
      this.sent = text
    } catch (error) {
      // 单次刷新失败不致命：下一拍还会带着全文重试
      this.log.debug('流式刷新失败', { error: String(error) })
    }
  }

  /** 立即推送一次（一轮结束时调用，不必等下一个节流窗口）。 */
  async flushNow() {
    this.clearTimer()
    await this.flush()
  }

  /**
   * 收尾：推送最终正文、关闭流式、把 header 换成终态。
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
    const note = settings.note
    const text = clipText(this.text, this.maxChars)

    try {
      if (text && text !== this.sent) {
        await this.api.putCardContent(this.cardId, text, ++this.sequence)
        this.sent = text
      }
      await this.api.closeStreaming(this.cardId, ++this.sequence, (text || note || '回复').slice(0, 50))
    } catch (error) {
      this.log.warn('关闭流式失败', { cardId: this.cardId, error: String(error) })
    }

    const finalBody = note && !text ? note : text
    try {
      const card = buildCard({ status, title: this.title, body: finalBody, streaming: false })
      await this.api.updateCard(this.cardId, card, ++this.sequence)
    } catch (error) {
      this.log.warn('终态卡片更新失败', { cardId: this.cardId, error: String(error) })
      if (finalBody) {
        await this.api.sendText(this.chatId, finalBody).catch(() => {})
      }
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
