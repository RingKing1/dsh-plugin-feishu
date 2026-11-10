import { randomUUID } from 'node:crypto'
import { buildApprovalCard, parseApprovalAction } from './approval-card.js'
import { readField } from './config.js'

/**
 * 把 dsh 的工具授权（`approval/request` waterfall）搬到飞书。
 *
 * 为什么可以直接接 waterfall：dsh 的授权是「工具调用暂停，等 answerer 返回一个
 * outcome」，只有把 outcome 作为返回值交回去，暂停中的工具调用才会继续；给
 * `'allowed-once'` / `'rejected'` 就是一次性的决定，不存在「永久放行」。
 *
 * 关键取舍：
 *   - 只接管本插件自己的会话（index.js 用 ownerOf 过滤），网页端会话照旧弹网页；
 *   - 任何异常路径（发卡失败、超时、已有请求在等）都返回 `undefined`，让调用方
 *     `next()` 把请求交回下一个 answerer —— 宁可多弹一次网页，也不能把请求吞掉；
 *   - 一个会话同时只等一个授权：两个卡片叠在一起，用户分不清在点哪一个。
 */

const MIN_TIMEOUT_MS = 10 * 1000
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** 已结束请求的快照保留时长：迟到点击要能回一句「已经结束了」，而不是「已失效」 */
const SETTLED_TTL_MS = 30 * 60 * 1000

export class ToolApprovalHub {
  constructor(options) {
    const settings = options || {}
    this.api = settings.api
    this.log = settings.log
    this.config = settings.config || {}
    /** @type {Map<string, object>} 会话键 -> 正在等的授权 */
    this.pending = new Map()
    /** @type {Map<string, object>} requestId -> 已结束快照 */
    this.settled = new Map()
    this.timeoutMs = clamp(
      Number(readField(this.config.approvalTimeoutMs, DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )
    this.enabled = Boolean(readField(this.config.approvalInFeishu, true))
  }

  /** 会话里正在等的授权；bridge 用它做 /status 与串行保护 */
  pendingFor(key) {
    return this.pending.get(key)
  }

  /**
   * 把一条授权请求发到飞书并等一个决定。
   *
   * @param {{ agent: any, toolName?: string, reason?: string, signal?: AbortSignal }} request
   * @param {{ key: string, chatId: string, openId?: string }} turn
   * @returns {Promise<'allowed-once'|'rejected'|'cancelled'|undefined>} undefined = 交给下一个 answerer
   */
  async ask(request, turn) {
    if (!this.enabled) return undefined
    const key = turn && turn.key
    const chatId = turn && turn.chatId
    if (!key || !chatId) return undefined
    if (this.pending.has(key)) {
      this.log.debug('已有授权在等，转交网页处理', { key })
      return undefined
    }

    const pending = {
      requestId: randomUUID(),
      key,
      chatId,
      asker: String((turn && turn.openId) || ''),
      toolName: String((request && request.toolName) || ''),
      reason: String((request && request.reason) || ''),
      status: 'pending',
      settled: false,
      messageId: '',
    }
    pending.promise = new Promise((resolve) => {
      pending.resolve = resolve
    })
    this.pending.set(key, pending)

    this.watchAbort(pending, request && request.signal)
    pending.timer = setTimeout(() => this.timeout(pending), this.timeoutMs)
    if (typeof pending.timer.unref === 'function') pending.timer.unref()

    try {
      pending.messageId = await this.api.sendInteractive(chatId, this.renderCard(pending))
      this.log.info('授权卡片已发到飞书', { key, toolName: pending.toolName, messageId: pending.messageId })
    } catch (error) {
      // 卡片发不出去就别让这一轮干等：立刻交回网页
      this.log.warn('发送授权卡片失败，转交网页处理', { key, error: describeError(error) })
      this.finish(pending, 'canceled')
      pending.resolve(undefined)
    }

    return pending.promise
  }

  /**
   * 卡片按钮回调。必须同步返回（飞书把返回值当作响应）。
   * 返回一张同 requestId 的终态卡，飞书会原地刷新。
   */
  onCardAction(raw) {
    const parsed = parseApprovalAction(raw)
    if (!parsed) return undefined
    const pending = this.findByRequestId(parsed.requestId)
    if (!pending) {
      return this.settled.has(parsed.requestId)
        ? toast('这次授权已经结束了')
        : toast('这个授权请求已经失效')
    }
    if (pending.asker && parsed.operatorOpenId && parsed.operatorOpenId !== pending.asker) {
      return toast('只有发起这一轮的人可以授权')
    }

    const allowed = parsed.choice === 'allow'
    const outcome = allowed ? 'allowed-once' : 'rejected'
    const status = allowed ? 'approved' : 'rejected'
    this.settle(pending, outcome, status)
    return { card: { type: 'raw', data: this.renderCard(pending) } }
  }

  /** 取消某个会话的授权（/stop、/new、插件停止时） */
  cancel(key, reason) {
    const pending = this.pending.get(key)
    if (!pending) return false
    this.settle(pending, 'cancelled', 'canceled', reason)
    return true
  }

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

  renderCard(pending) {
    return buildApprovalCard({
      requestId: pending.requestId,
      toolName: pending.toolName,
      reason: pending.reason,
      status: pending.status,
      note: pending.note,
    })
  }

  /** 刷新已发出去的卡片（终态）；失败只记日志，不影响授权结果 */
  async refreshCard(pending) {
    if (!pending.messageId || typeof this.api.patchCardMessage !== 'function') return false
    try {
      await this.api.patchCardMessage(pending.messageId, this.renderCard(pending))
      return true
    } catch (error) {
      this.log.warn('刷新授权卡片失败', { messageId: pending.messageId, error: describeError(error) })
      return false
    }
  }

  watchAbort(pending, signal) {
    if (!signal || typeof signal.addEventListener !== 'function') return
    const onAbort = () => {
      // 请求方已经不等了：回 cancelled，卡片也标成已取消
      this.settle(pending, 'cancelled', 'canceled', '这次授权已取消（dsh 侧中止了这次等待）。')
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.stopWatching = () => signal.removeEventListener('abort', onAbort)
  }

  timeout(pending) {
    // 超时不是「拒绝」：把决定权交回网页，避免手机不在身边时任务永远挂住
    this.settle(pending, undefined, 'timeout')
  }

  /** 写入最终状态并 resolve；所有结束路径都走这里，保证只结算一次 */
  settle(pending, outcome, status, note) {
    if (pending.settled) return
    pending.status = status
    if (note) pending.note = note
    this.finish(pending, status)
    void this.refreshCard(pending)
    pending.resolve(outcome)
  }

  finish(pending, status) {
    pending.settled = true
    this.pending.delete(pending.key)
    if (pending.timer) clearTimeout(pending.timer)
    if (typeof pending.stopWatching === 'function') pending.stopWatching()
    this.settled.set(pending.requestId, {
      requestId: pending.requestId,
      status,
      settledAt: Date.now(),
    })
    const timer = setTimeout(() => this.settled.delete(pending.requestId), SETTLED_TTL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
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
