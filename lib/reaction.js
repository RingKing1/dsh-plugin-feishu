/**
 * 消息表情回应（对齐 pi-feishu-bridge 的 transport.settleReaction）。
 *
 * 作用：用户发完消息后，机器人先给一个「看到了」的表情；跑完换成完成/失败的表情。
 * 长任务里这比卡片更早给出反馈 —— 卡片要等 agent 产出第一段文字，
 * 表情在消息落库那一刻就能挂上。
 *
 * 表情类型由飞书规定：实测 DONE / CRY / Get 可用；Sad / NO 会报 231001 invalid。
 * 因此这里只内置这三个，配置里允许覆盖「已收到」的那一个。
 */

/** 收到消息时挂的表情（飞书的 Get 是一个「收到」手势） */
export const DEFAULT_ACK_EMOJI = 'Get'
/** 正常结束 */
export const DONE_EMOJI = 'DONE'
/** 执行失败 */
export const FAILED_EMOJI = 'CRY'

/** 在册表情上限：超了忘掉最旧的一批（只丢记录，不去删已经删不掉的表情） */
const MAX_PENDING = 2000

export class ReactionManager {
  /**
   * @param {{api: any, log: any, ackEmoji?: string, limit?: number}} options
   */
  constructor(options) {
    const settings = options || {}
    this.api = settings.api
    this.log = settings.log
    this.ackEmoji = String(settings.ackEmoji || DEFAULT_ACK_EMOJI).trim() || DEFAULT_ACK_EMOJI
    this.limit = Number(settings.limit) > 0 ? Number(settings.limit) : MAX_PENDING
    /** @type {Map<string, string>} messageId -> reactionId（用于稍后撤销） */
    this.pending = new Map()
  }

  /**
   * 给一条新消息挂「收到」表情。
   * 失败只记 debug：表情是锦上添花，不能影响消息投递。
   * @param {string} messageId
   */
  async markPending(messageId) {
    const id = String(messageId || '')
    if (!id || this.pending.has(id)) return
    try {
      const reactionId = await this.api.addReaction(id, this.ackEmoji)
      if (!reactionId) return
      this.pending.set(id, reactionId)
      this.trim()
    } catch (error) {
      this.log.debug('挂收到表情失败（忽略）', { messageId: id, emoji: this.ackEmoji, error: String(error) })
    }
  }

  /**
   * 结算：撤掉「收到」，按结果换上完成 / 失败表情。
   * ignored（命令、未授权、重复消息等）不补表情 —— 那会让用户以为任务跑了。
   * @param {string} messageId
   * @param {'done'|'failed'|'ignored'} outcome
   */
  async settle(messageId, outcome) {
    const id = String(messageId || '')
    if (!id) return
    await this.remove(id)
    if (outcome !== 'done' && outcome !== 'failed') return
    try {
      await this.api.addReaction(id, outcome === 'done' ? DONE_EMOJI : FAILED_EMOJI)
    } catch (error) {
      this.log.debug('挂结果表情失败（忽略）', { messageId: id, outcome, error: String(error) })
    }
  }

  /**
   * 撤掉某条消息上的「收到」表情。
   * 先从表里删记录再发请求：即便请求失败也不该无限重试同一条。
   * @param {string} messageId
   */
  async remove(messageId) {
    const id = String(messageId || '')
    const reactionId = this.pending.get(id)
    if (!reactionId) return
    this.pending.delete(id)
    try {
      await this.api.deleteReaction(id, reactionId)
    } catch (error) {
      this.log.debug('撤销表情失败（忽略）', { messageId: id, error: String(error) })
    }
  }

  /** 插件停止时把还在册的表情清掉，别在用户消息上留一堆「收到」 */
  async clear() {
    for (const id of [...this.pending.keys()]) await this.remove(id)
  }

  trim() {
    while (this.pending.size > this.limit) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) return
      this.pending.delete(oldest)
    }
  }
}
