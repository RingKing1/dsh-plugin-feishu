/**
 * 审批卡片：把 dsh 的 `approval/request` 渲染成飞书交互卡片（纯函数，无 IO，便于单测）。
 *
 * 与选择题卡片同一套 schema 1.0 形态：`action` + `button.value`，点击走
 * `card.action.trigger` 长连接回调。区别只在 value 的判别键：选择题用 `dshq`，
 * 审批用 `dsha` —— 两类卡片可能同时出现在一个会话里，靠判别键分流，互不干扰。
 */

/** 卡片标题：一眼能看出是 dsh 被卡住、在等人放行 */
export const APPROVAL_CARD_TITLE = '需要你审批'

/** dsh 的审批结果是闭集：这里只用两个可由人决定的；cancelled / unavailable 由插件自己处理 */
export const DECISION_ALLOW = 'allowed-once'
export const DECISION_REJECT = 'rejected'

/** 决定 -> 中文文案 */
export const DECISION_LABEL = {
  [DECISION_ALLOW]: '允许一次',
  [DECISION_REJECT]: '拒绝',
}

/** 审批理由最多展示这么多字：再长也不该把卡片撑满，细节去会话里看 */
const MAX_REASON_CHARS = 1200

/**
 * 构造审批卡片。
 * @param {{
 *   requestId: string,
 *   toolName: string,
 *   reason?: string,
 *   callId?: string,
 *   timeoutMs?: number,
 *   defaultOutcome?: string,
 * }} input
 * @returns {object} 可直接作为 interactive 消息 content 的卡片 JSON
 */
export function buildApprovalCard(input) {
  const requestId = String((input && input.requestId) || '')
  const toolName = String((input && input.toolName) || '未知工具')
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const callId = typeof input.callId === 'string' ? input.callId : ''
  const timeoutMs = Number(input && input.timeoutMs) > 0 ? Number(input.timeoutMs) : 0
  const defaultOutcome = input && input.defaultOutcome === DECISION_ALLOW ? DECISION_ALLOW : DECISION_REJECT

  const elements = [
    {
      tag: 'div',
      // 工具名与调用号用 plain_text：* _ 不会被当成 markdown
      text: { tag: 'plain_text', content: '工具：' + toolName + (callId ? '\n调用：' + callId : '') },
    },
  ]

  if (reason) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: clip(reason) } })
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: DECISION_LABEL[DECISION_ALLOW] },
        // 主按钮放「允许」：审批卡片的正常路径是放行，拒绝要专门点一下
        type: 'primary',
        value: { dsha: requestId, decide: DECISION_ALLOW },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: DECISION_LABEL[DECISION_REJECT] },
        type: 'danger',
        value: { dsha: requestId, decide: DECISION_REJECT },
      },
    ],
  })

  elements.push(note(timeoutHint(timeoutMs, defaultOutcome)))

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: APPROVAL_CARD_TITLE } },
    elements,
  }
}

/**
 * 把一条 card.action.trigger 事件归一化成审批决定。
 * 不是审批卡片（没有 `dsha`）、或 decide 不是闭集里的值，一律返回 undefined。
 *
 * @param {any} raw 长连接推来的原始事件
 * @returns {{ requestId: string, decision: string, operatorOpenId: string, chatId: string, messageId: string }|undefined}
 */
export function parseApprovalAction(raw) {
  const event = raw && raw.event ? raw.event : raw
  const action = event && event.action
  if (!action || typeof action !== 'object') return undefined

  const value = action.value && typeof action.value === 'object' ? action.value : {}
  const requestId = typeof value.dsha === 'string' ? value.dsha : ''
  const decision = typeof value.decide === 'string' ? value.decide : ''
  if (!requestId || (decision !== DECISION_ALLOW && decision !== DECISION_REJECT)) return undefined

  const operator = event.operator && typeof event.operator === 'object' ? event.operator : {}
  const context = event.context && typeof event.context === 'object' ? event.context : {}

  return {
    requestId,
    decision,
    operatorOpenId: String(operator.open_id || operator.openId || ''),
    chatId: String(context.open_chat_id || context.chatId || ''),
    messageId: String(context.open_message_id || context.messageId || ''),
  }
}

/** 允许类说法：从最正式到最口语 */
const ALLOW_WORDS = ['允许', '同意', '批准', '通过', '可以', '放行', 'allow', 'approve', 'ok', 'yes', 'y', '1']
/** 拒绝类说法 */
const REJECT_WORDS = ['拒绝', '不同意', '不行', '不可以', '驳回', '禁止', 'reject', 'deny', 'no', 'n', '2']

/**
 * 把用户回复的文字解析成审批决定。
 * 只认明确的同意/拒绝：审批是安全相关的，模糊的话不能猜（猜错就是放行了一次写操作）。
 *
 * @param {string} text
 * @returns {string|undefined} DECISION_ALLOW / DECISION_REJECT / undefined
 */
export function parseApprovalText(text) {
  const raw = String(text || '').trim().toLowerCase()
  if (!raw) return undefined
  if (ALLOW_WORDS.indexOf(raw) >= 0) return DECISION_ALLOW
  if (REJECT_WORDS.indexOf(raw) >= 0) return DECISION_REJECT
  return undefined
}

/** 超时提示：说清楚到点会怎样，避免用户以为卡住就是坏了 */
function timeoutHint(timeoutMs, defaultOutcome) {
  if (!(timeoutMs > 0)) return '点上面的按钮，或直接回复「允许」/「拒绝」'
  const minutes = Math.max(1, Math.round(timeoutMs / 60000))
  const tail = defaultOutcome === DECISION_ALLOW ? '自动允许' : '按拒绝处理'
  return '点上面的按钮，或直接回复「允许」/「拒绝」；' + minutes + ' 分钟内没有回复将' + tail
}

/** 卡片备注行 */
function note(content) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content }] }
}

/** 截断过长的审批理由 */
function clip(text) {
  if (text.length <= MAX_REASON_CHARS) return text
  return text.slice(0, MAX_REASON_CHARS) + '\n…（已截断）'
}
