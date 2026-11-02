import { randomUUID } from 'node:crypto'
import { buildQuestionCard, parseCardAction } from './question-card.js'

/**
 * 飞书侧的人机问答：接 dsh 的 `user-questions/request` waterfall。
 *
 * 为什么不另造一条问答通道：dsh 的提问是「工具调用暂停，等 answerer 返回」，
 * 只有把答案作为答案返回，暂停中的工具调用才会继续；另发一条普通消息只会变成新一轮对话。
 *
 * 一个会话同一时刻只允许一个问题在等：飞书是线性对话，两个问题叠在一起，
 * 用户分不清在回答哪一个，回调也对不上号。
 */

/** 超时上下限：太短会把正常思考打断，太长等于永久挂住 */
const MIN_TIMEOUT_MS = 10 * 1000
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 把用户的自由文本解析成答案。
 * 规则（从最确定到最宽松）：
 *   1. 纯数字 -> 第 N 个选项（飞书里最顺手的回答方式）
 *   2. 与某个选项标签完全一致 -> 选它
 *   3. 多选题 -> 按逗号/顿号/空格拆分后取能对上的项
 *   4. 包含关系（只输入了选项的一部分）-> 选第一个包含它的选项
 *   5. 都对不上 -> 作为自定义回答（custom），selected 为空
 *
 * @param {{ id: string, options?: Array<{label: string}>, multiSelect?: boolean }} question
 * @param {string} text
 * @returns {{ picks: string[], custom?: string }}
 */
export function parseTextAnswer(question, text) {
  const raw = String(text || '').trim()
  const options = Array.isArray(question && question.options) ? question.options : []
  const labels = options.map((option) => String(option.label))
  if (labels.length === 0) return { picks: [], custom: raw }

  const index = Number(raw)
  if (Number.isInteger(index) && index >= 1 && index <= labels.length) {
    return { picks: [labels[index - 1]] }
  }
  if (labels.indexOf(raw) >= 0) return { picks: [raw] }

  if (question && question.multiSelect) {
    const parts = raw.split(/[,，、\s]+/).map((part) => part.trim()).filter(Boolean)
    const matched = parts.filter((part) => labels.indexOf(part) >= 0)
    if (matched.length > 0) return { picks: matched }
  }

  const fuzzy = labels.find((label) => raw !== '' && (label.indexOf(raw) >= 0 || raw.indexOf(label) >= 0))
  if (fuzzy) return { picks: [fuzzy] }

  return { picks: [], custom: raw }
}

/**
 * 把一次点击/一段文本归一化成 dsh 的答案项。
 * 选项标签对不上的一律丢弃：模型只应看到它给出的选项，或被明确标成 custom 的自由输入。
 */
function normalizeAnswer(question, payload) {
  const options = Array.isArray(question.options) ? question.options : []
  const labels = options.map((option) => String(option.label))
  const picks = (payload.picks || []).map((item) => String(item)).filter((item) => labels.length === 0 || labels.indexOf(item) >= 0)
  const custom = typeof payload.custom === 'string' ? payload.custom.trim() : ''

  if (picks.length > 0) {
    return {
      id: question.id,
      selected: question.multiSelect ? picks : [picks[0]],
      ...(custom ? { custom } : {}),
    }
  }
  return { id: question.id, selected: [], ...(custom ? { custom } : {}) }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export class QuestionHub {
  constructor(options) {
    const settings = options || {}
    this.api = settings.api
    this.log = settings.log
    this.config = settings.config || {}
    /** @type {Map<string, object>} 会话键 -> 待回答的问题 */
    this.pending = new Map()
    this.timeoutMs = clamp(Number(this.config.askTimeoutMs) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  }

  /** 会话里正在等回答的问题；bridge 用它判断「这条文本是回答还是新消息」 */
  pendingFor(key) {
    return this.pending.get(key)
  }

  /**
   * 把提问发到飞书并等一个答案。
   * @param {{ questions: Array<object>, signal?: AbortSignal }} request
   * @param {{ key: string, chatId: string, openId?: string }} turn
   * @returns {Promise<{ answers: Array<{id: string, selected: string[], custom?: string}> }>}
   */
  async ask(request, turn) {
    const key = turn.key
    const questions = Array.isArray(request && request.questions) ? request.questions : []
    if (questions.length === 0) throw new Error('提问里没有任何问题')
    if (this.pending.has(key)) throw new Error('飞书里上一个问题还没有回答，请先回答它再继续')

    const pending = {
      requestId: randomUUID(),
      key,
      chatId: turn.chatId,
      asker: String(turn.openId || ''),
      questions,
      answers: new Map(),
      messageId: '',
      settled: false,
    }
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
    })
    this.pending.set(key, pending)

    this.watchAbort(pending, request && request.signal)
    pending.timer = setTimeout(() => this.timeout(pending), this.timeoutMs)
    // 不吊住进程退出：插件停掉时由 cancelAll 兜底
    if (typeof pending.timer.unref === 'function') pending.timer.unref()

    try {
      const card = buildQuestionCard({ questions, requestId: pending.requestId })
      pending.messageId = await this.api.sendInteractive(turn.chatId, card)
      this.log.info('提问已发到飞书', { key, count: questions.length, messageId: pending.messageId })
    } catch (error) {
      this.settleError(pending, new Error('把问题发到飞书失败：' + describeError(error)))
    }

    return pending.promise
  }

  /**
   * 用户直接回文字：当作「下一个还没答的问题」的答案。
   * @returns {boolean} 是否被当成答案消费掉了
   */
  answerByText(key, text) {
    const pending = this.pending.get(key)
    if (!pending) return false
    const question = pending.questions.find((item) => !pending.answers.has(item.id))
    if (!question) return false
    this.record(pending, question, parseTextAnswer(question, text))
    return true
  }

  /**
   * 卡片按钮回调。
   *
   * 必须是同步返回：飞书长连接把回调返回值直接当作 toast 响应，
   * 返回 Promise 的话飞书那边看到的是空对象，点击就没有任何反馈。
   *
   * @returns {{ toast: { type: string, content: string } }}
   */
  onCardAction(raw) {
    const parsed = parseCardAction(raw)
    if (!parsed) return toast('这个按钮已失效')
    const pending = this.findByRequestId(parsed.requestId)
    if (!pending) return toast('这个问题已经回答过了')
    if (pending.asker && parsed.operatorOpenId && parsed.operatorOpenId !== pending.asker) {
      // 群里任何人都能看到卡片，但只有发起这一轮的人能作答
      return toast('只有提问人本人可以回答这个问题')
    }
    const question = pending.questions.find((item) => item.id === parsed.questionId)
    if (!question) return toast('这个问题已失效')
    if (pending.answers.has(question.id)) return toast('你已经回答过这一题了')

    this.record(pending, question, { picks: parsed.picks })
    const label = parsed.picks[0] || '（已记录）'
    return { toast: { type: 'success', content: '已收到：' + label } }
  }

  /** 取消某个会话的提问（/stop、/new、插件停止时） */
  cancel(key, reason) {
    const pending = this.pending.get(key)
    if (!pending) return false
    this.settleError(pending, new Error(reason || '提问已取消'), '这次提问已取消。')
    return true
  }

  /** 取消所有提问：插件卸载/重连时不留悬空 Promise */
  cancelAll(reason) {
    for (const key of [...this.pending.keys()]) this.cancel(key, reason || '插件已停止')
  }

  // ---- 内部 ----

  findByRequestId(requestId) {
    for (const pending of this.pending.values()) {
      if (pending.requestId === requestId) return pending
    }
    return undefined
  }

  record(pending, question, payload) {
    if (pending.settled || pending.answers.has(question.id)) return
    pending.answers.set(question.id, normalizeAnswer(question, payload))
    const left = pending.questions.filter((item) => !pending.answers.has(item.id))
    if (left.length === 0) {
      this.settle(pending, { answers: pending.questions.map((item) => pending.answers.get(item.id)) })
      return
    }
    this.log.debug('还有问题没回答', { key: pending.key, left: left.length })
    // 多个问题时给一次回执，否则用户不知道刚才那句被算到第几题上
    if (pending.questions.length > 1) {
      void this.api
        .sendText(pending.chatId, '已记录，还有 ' + left.length + ' 个问题待回答：' + left.map((item) => item.question).join(' / '))
        .catch(() => {})
    }
  }

  watchAbort(pending, signal) {
    if (!signal || typeof signal.addEventListener !== 'function') return
    const onAbort = () => this.settleError(pending, new Error('提问已被取消（dsh 侧中止了这次等待）'), '这次提问已取消。')
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.stopWatching = () => signal.removeEventListener('abort', onAbort)
  }

  timeout(pending) {
    const minutes = Math.round(this.timeoutMs / 60000)
    this.settleError(
      pending,
      new Error('飞书里 ' + minutes + ' 分钟没有回答这个问题，提问已取消'),
      '⏰ 没有等到你的回答，这次提问已取消（需要的话让 dsh 重新问一次）。',
    )
  }

  settle(pending, answer) {
    if (pending.settled) return
    pending.settled = true
    this.pending.delete(pending.key)
    if (pending.timer) clearTimeout(pending.timer)
    if (typeof pending.stopWatching === 'function') pending.stopWatching()
    pending.resolve(answer)
  }

  settleError(pending, error, notice) {
    if (pending.settled) return
    pending.settled = true
    this.pending.delete(pending.key)
    if (pending.timer) clearTimeout(pending.timer)
    if (typeof pending.stopWatching === 'function') pending.stopWatching()
    if (notice) void this.api.sendText(pending.chatId, notice).catch(() => {})
    pending.reject(error)
  }
}

function toast(content) {
  return { toast: { type: 'info', content } }
}

function describeError(error) {
  if (!error) return '未知错误'
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error.message || error)
}
