/**
 * 授权卡片：把 dsh 的 `approval/request` 渲染成飞书交互卡片（纯函数，无 IO，便于单测）。
 *
 * 与选择题卡片的区别：授权只有两个答案（允许一次 / 拒绝），没有自由输入，
 * 默认按钮是「拒绝」——手机误触的概率远高于误判，宁可多点一次。
 *
 * 状态：pending 需要授权（橙）-> approved 已允许（绿）/ rejected 已拒绝（红）
 *      / timeout 已超时（灰）/ canceled 已取消（灰）
 */

/** 四种终态集中在这里：标题、颜色、底部说明，避免散落在渲染逻辑里 */
export const APPROVAL_CARD_STATUS = {
  pending: { template: 'orange', title: '🔐 需要你的授权' },
  approved: { template: 'green', title: '✅ 已允许一次' },
  rejected: { template: 'red', title: '❌ 已拒绝' },
  timeout: { template: 'grey', title: '⏱ 已超时（转回网页）' },
  canceled: { template: 'grey', title: '已取消' },
}

/** 按钮文字上限：飞书 plain_text 有长度限制 */
const MAX_LABEL = 20

/** 工具名 / 原因在卡片里最多展示多少字符，避免一张卡被超长命令撑爆 */
const MAX_TOOL_NAME = 80
const MAX_REASON = 600

/**
 * 构造授权卡片。
 *
 * @param {{
 *   requestId: string,
 *   toolName?: string,
 *   reason?: string,
 *   status?: 'pending'|'approved'|'rejected'|'timeout'|'canceled',
 *   note?: string,
 *   allowLabel?: string,
 * }} input
 * @returns {object} 可直接作为 interactive 消息 content 的卡片 JSON
 */
export function buildApprovalCard(input) {
  const requestId = String((input && input.requestId) || '')
  const status = APPROVAL_CARD_STATUS[input && input.status] ? input.status : 'pending'
  const toolName = clip(String((input && input.toolName) || '（未知工具）'), MAX_TOOL_NAME)
  const reason = clip(String((input && input.reason) || '').trim(), MAX_REASON)
  const allowLabel = clip(String((input && input.allowLabel) || '允许一次'), MAX_LABEL)

  const elements = [
    {
      tag: 'div',
      text: { tag: 'plain_text', content: '工具：' + toolName },
    },
  ]

  if (reason) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: reason } })
  }

  if (status === 'pending') {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: allowLabel },
          type: 'primary',
          value: { dsha: requestId, choice: 'allow' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '拒绝' },
          type: 'danger',
          value: { dsha: requestId, choice: 'deny' },
        },
      ],
    })
  }

  const noteText = typeof (input && input.note) === 'string' ? input.note.trim() : ''
  elements.push(note(noteText ? noteText + '\n' + footerText(status, allowLabel) : footerText(status, allowLabel)))

  const header = APPROVAL_CARD_STATUS[status]
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements,
  }
}

/**
 * 把一条 card.action.trigger 事件归一化成授权选择。
 * 只认本插件发出的卡片（value.dsha），其它卡片返回 undefined 交给选择题处理。
 *
 * @param {any} raw 长连接推来的原始事件
 * @returns {{ requestId: string, choice: 'allow'|'deny', operatorOpenId: string, chatId: string, messageId: string }|undefined}
 */
export function parseApprovalAction(raw) {
  const event = raw && raw.event ? raw.event : raw
  const action = event && event.action
  if (!action || typeof action !== 'object') return undefined

  const value = action.value && typeof action.value === 'object' ? action.value : {}
  const requestId = typeof value.dsha === 'string' ? value.dsha : ''
  if (!requestId) return undefined

  const choice = value.choice === 'allow' ? 'allow' : value.choice === 'deny' ? 'deny' : ''
  if (!choice) return undefined

  const operator = event.operator && typeof event.operator === 'object' ? event.operator : {}
  const context = event.context && typeof event.context === 'object' ? event.context : {}

  return {
    requestId,
    choice,
    operatorOpenId: String(operator.open_id || operator.openId || ''),
    chatId: String(context.open_chat_id || context.chatId || ''),
    messageId: String(context.open_message_id || context.messageId || ''),
  }
}

/** 底部状态说明：告诉用户这一步之后会发生什么 */
function footerText(status, allowLabel) {
  if (status === 'approved') return '工具已放行，这一轮继续执行。'
  if (status === 'rejected') return '已拒绝，这一轮会带着拒绝结果继续或结束。'
  if (status === 'timeout') return '没有等到你的选择，请求已转回 DSH 网页。'
  if (status === 'canceled') return '这次授权已取消。'
  return '点「' + allowLabel + '」只放行这一次；不点就会一直等（超时后转回网页）。'
}

/** 备注行 */
function note(content) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content }] }
}

/** 超长文本截断，保留可读的开头 */
function clip(text, max) {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}
