/**
 * 流式帧状态机：把 `agent/assistant-stream` 的帧翻成「对卡片该做什么」。
 *
 * 为什么需要它：dsh 的一个 turn 里有多个 step（每次工具调用后模型都要再说话），
 * 每个 step 都是一次独立的 attempt、都会正常吐可见文本。桥接早期把所有
 * text-delta 无条件拼进同一段正文，于是「我先读一下这个文件」「现在跑测试」
 * 这些中间旁白会一路混进最终回复；重试（abandoned attempt）的文本也无法回收。
 *
 * 这里按 attemptId / revision / turn / step 给每段文本定归属，产出的动作：
 *   reset     清空正文（切步 / 重试 / attempt 被废弃）
 *   append    追加增量文本
 *   replace   用权威全文整段替换（block-end、attempt 结束、回收废弃文本）
 *   narration 上一步的整段文本 —— 不是答案，交给执行过程面板
 *   reasoning 思考增量（默认丢弃，开启后进过程面板）
 *   step      进入下一步（卡片用来标「第 N 步」）
 *
 * bodyMode：
 *   final（默认）正文只留当前步；切步时上一步文本降级成旁白
 *   live         旧行为，整个 turn 的文本继续往同一段正文里累积（仍会回收废弃 attempt）
 *
 * 纯逻辑、无 IO：不碰卡片、不碰网络，便于单测。
 */

/** 只有 text 块进正文，reasoning 与工具块都不进 */
const TEXT = 'text'

/**
 * 一次流式回复的帧状态机。一张回复卡对应一个实例。
 */
export class ReplyStream {
  /**
   * @param {{bodyMode?: 'final'|'live', showReasoning?: boolean}} [options]
   */
  constructor(options) {
    const settings = options || {}
    this.bodyMode = settings.bodyMode === 'live' ? 'live' : 'final'
    this.showReasoning = settings.showReasoning === true
    this.reset()
  }

  /** 清空全部状态（新一轮、或卡片被复用重新开始时调用） */
  reset() {
    this.turn = -1
    this.step = -1
    this.attemptId = ''
    this.revision = -1
    /** @type {Map<number, {type: string, text: string}>} 当前 attempt 的块，键是块序号 */
    this.blocks = new Map()
    /** live 模式的累积正文（final 模式不用） */
    this.liveBuffer = ''
    /** live 模式进入当前 attempt 时的正文长度：废弃 attempt 从这个位置截断 */
    this.attemptFromLength = 0
    /** 最后一个产出过非空文本的步骤全文：末步为空（被中断 / 只有工具）时兜底 */
    this.lastText = ''
    /** 上一次 attempt 的结局：'' 还没结束 / 'committed' 已提交 / 'abandoned' 已废弃 */
    this.lastOutcome = ''
    /**
     * 已提交 attempt 的全文。切到下一步时只有它配当「旁白」——
     * 废弃 attempt 的文本是废稿，既不能混进正文，也不能进过程面板。
     */
    this.committedText = ''
    /** 最近一次 finish 的原因：stop / tool-calls / max-tokens / aborted / error */
    this.finishReason = ''
    /** 最近一次 usage，卡片收尾可以带 token 数 */
    this.usage = undefined
  }

  /** 当前可见正文（final：当前步；live：累计全文） */
  text() {
    if (this.bodyMode === 'live') return this.liveBuffer
    return buildText(this.blocks)
  }

  /** 整轮回复的最终正文：当前步优先，空了回落到最后一个有文本的步骤 */
  finalText() {
    return this.text() || this.lastText
  }

  /** @param {object} frame @returns {Array<object>} 动作列表（可能为空） */
  accept(frame) {
    if (!frame || typeof frame.type !== 'string') return []
    if (frame.type === 'start') return this.onStart(frame)
    if (frame.type === 'chunk') return this.onChunk(frame)
    if (frame.type === 'end') return this.onEnd(frame)
    return []
  }

  /**
   * 新 attempt：新 step 要把上一步文本挪成旁白，同 step 重试要丢掉废弃文本。
   * @param {{attemptId?: string, revision?: number, turn?: number, step?: number}} frame
   */
  onStart(frame) {
    const actions = []
    const turn = Number(frame.turn)
    const step = Number(frame.step)
    const newStep = turn !== this.turn || step !== this.step
    const retry = !newStep && Number(frame.revision) > this.revision

    if (newStep) {
      if (this.bodyMode === 'live') {
        // 旧行为：正文继续累积，不重置也不产生旁白
        this.blocks = new Map()
      } else {
        // 只有「已经提交」的上一步文本才是旁白；废弃 attempt 留下的废稿直接丢
        const previous = this.lastOutcome === 'committed' ? this.committedText : ''
        if (previous) {
          this.lastText = previous
          // 上一步的文本不是答案，是旁白：挪进执行过程，别丢也别混进正文
          actions.push({ kind: 'narration', step: this.step, text: previous })
        }
        actions.push({ kind: 'reset' })
        this.blocks = new Map()
      }
      this.committedText = ''
      this.lastOutcome = ''
      this.turn = turn
      this.step = step
      actions.push({ kind: 'step', turn, step })
    } else if (retry) {
      // 同一 step 重试：上一次 attempt 已被 dsh 判定废弃，正文必须回到它之前的状态，
      // 废稿也不能记成旁白
      this.committedText = ''
      this.lastOutcome = ''
      actions.push(...this.discardAttempt())
    }
    this.attemptId = String(frame.attemptId || '')
    this.revision = Number(frame.revision) || 0
    this.attemptFromLength = this.liveBuffer.length
    return actions
  }

  /** @param {{attemptId?: string, chunk?: object}} frame */
  onChunk(frame) {
    // 陈旧帧：事件重放或重试后迟到的 chunk，归属已经不对了
    if (frame.attemptId && this.attemptId && String(frame.attemptId) !== this.attemptId) return []
    const chunk = frame.chunk
    if (!chunk || typeof chunk.type !== 'string') return []
    const index = Number(chunk.index) || 0

    if (chunk.type === 'block-start') {
      const type = chunk.blockType === 'text' || chunk.blockType === 'reasoning' ? chunk.blockType : 'other'
      // 同一 attempt 里第二个 text 块要空一行，否则两段会粘成一段
      const needsBreak = type === TEXT && textBlockCount(this.blocks) > 0
      this.blocks.set(index, { type, text: '' })
      if (!needsBreak) return []
      this.liveBuffer += '\n\n'
      return [{ kind: 'append', text: '\n\n' }]
    }

    if (chunk.type === 'text-delta') {
      const text = String(chunk.text || '')
      const block = this.blocks.get(index) || { type: TEXT, text: '' }
      block.type = TEXT
      block.text += text
      this.blocks.set(index, block)
      if (!text) return []
      this.liveBuffer += text
      return [{ kind: 'append', text }]
    }

    if (chunk.type === 'reasoning-delta') {
      const text = String(chunk.text || '')
      const block = this.blocks.get(index) || { type: 'reasoning', text: '' }
      block.type = 'reasoning'
      block.text += text
      this.blocks.set(index, block)
      if (!this.showReasoning || !text) return []
      return [{ kind: 'reasoning', text, step: this.step }]
    }

    if (chunk.type === 'block-end') {
      const block = chunk.block
      if (!block || (block.type !== 'text' && block.type !== 'reasoning')) return []
      this.blocks.set(index, { type: block.type, text: String(block.text || '') })
      if (block.type !== 'text' || this.bodyMode === 'live') return []
      // 块结束时拿权威全文整段替换：流式拼接少字、重字都能纠回来
      return [{ kind: 'replace', text: this.text() }]
    }

    if (chunk.type === 'usage') {
      this.usage = chunk.usage
      return [{ kind: 'usage', usage: chunk.usage }]
    }

    if (chunk.type === 'finish') {
      this.finishReason = String((chunk.reason && chunk.reason.type) || '')
      return [{ kind: 'finish', reason: this.finishReason }]
    }

    return []
  }

  /** attempt 结束：committed 时正文以本地块集合为准，abandoned 时回退 */
  onEnd(frame) {
    const outcome = (frame && frame.outcome) || {}
    if (outcome.kind === 'abandoned') {
      this.lastOutcome = 'abandoned'
      this.committedText = ''
      return this.discardAttempt()
    }
    const text = this.text()
    this.committedText = text
    this.lastOutcome = 'committed'
    if (text) this.lastText = text
    return [{ kind: 'replace', text }, { kind: 'commit', step: this.step }]
  }

  /**
   * 丢弃当前 attempt 产出的文本（重试 / 被废弃）。
   * live 模式按进入 attempt 时的长度截断，final 模式直接清空块集合。
   * @returns {Array<object>}
   */
  discardAttempt() {
    if (this.bodyMode === 'live') {
      this.blocks = new Map()
      const next = this.liveBuffer.slice(0, this.attemptFromLength)
      if (next === this.liveBuffer) return []
      const hadContent = next.length > 0
      this.liveBuffer = next
      return [hadContent ? { kind: 'replace', text: next } : { kind: 'reset' }]
    }
    this.blocks = new Map()
    return [{ kind: 'reset' }]
  }
}

/**
 * 拼正文：按块序号排序，只取非空 text 块，块之间空一行。
 * @param {Map<number, {type: string, text: string}>} blocks
 * @returns {string}
 */
export function buildText(blocks) {
  if (!blocks || typeof blocks.entries !== 'function') return ''
  const parts = []
  for (const [, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (!block || block.type !== TEXT) continue
    const text = String(block.text || '').trim()
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

/** 已出现过的非空 text 块数量（0 说明还没有正文，不需要空行分隔） */
function textBlockCount(blocks) {
  let count = 0
  for (const block of blocks.values()) {
    if (block && block.type === TEXT && String(block.text || '').trim()) count += 1
  }
  return count
}
