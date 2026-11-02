/**
 * 选择题卡片：把 dsh 的提问渲染成飞书交互卡片（纯函数，无 IO，便于单测）。
 *
 * 为什么用 schema 1.0 的 `action` + `button.value`，而不是流式回复卡那套 CardKit 2.0：
 * 提问卡只需要「按钮点击 -> card.action.trigger 回调」，1.0 的按钮 value 是这条链路里
 * 最稳定的形态；CardKit 2.0 的流式能力是给回复卡用的，这里用不上，混用反而多一层风险。
 */

/** 卡片标题：一眼能看出是 dsh 在等你拍板 */
export const QUESTION_CARD_TITLE = '需要你的确认'

/**
 * 一行最多放几个按钮：再多飞书会折行，手机端很难点。
 * 超出的选项不渲染按钮，提示用户用文字回答。
 */
const MAX_BUTTONS_PER_ROW = 6

/**
 * 构造提问卡片。
 * @param {{ questions: Array<{ id: string, question: string, detail?: string, options?: Array<{label: string, description?: string}>, multiSelect?: boolean }>, requestId: string }} input
 * @returns {object} 可直接作为 interactive 消息 content 的卡片 JSON
 */
export function buildQuestionCard(input) {
  const questions = Array.isArray(input && input.questions) ? input.questions : []
  const requestId = String((input && input.requestId) || '')
  const elements = []

  questions.forEach((question, index) => {
    const title = (index + 1) + '. ' + String(question.question || '')
    // 题干用 plain_text：选题里常带 * _ 之类字符，走 markdown 会被吃掉
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: title } })

    const detail = typeof question.detail === 'string' ? question.detail.trim() : ''
    if (detail) elements.push({ tag: 'div', text: { tag: 'lark_md', content: detail } })

    const options = Array.isArray(question.options) ? question.options : []
    const visible = options.slice(0, MAX_BUTTONS_PER_ROW)
    if (visible.length > 0) {
      elements.push({
        tag: 'action',
        actions: visible.map((option, optionIndex) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: String(option.label) },
          // 第一项是推荐项，按 dsh 的约定用主按钮突出
          type: optionIndex === 0 ? 'primary' : 'default',
          value: { dshq: requestId, qid: String(question.id), pick: [String(option.label)] },
        })),
      })
    }
    if (options.length > visible.length) {
      elements.push(note('其余选项请直接回复文字：' + options.slice(visible.length).map((option) => option.label).join(' / ')))
    }
    if (question.multiSelect) {
      elements.push(note('这题可多选：直接回复文字，用逗号分隔多个选项'))
    }
  })

  elements.push(note('也可以直接回复文字作答；多个问题时按顺序逐条回复。'))

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: QUESTION_CARD_TITLE } },
    elements,
  }
}

/**
 * 把一条 card.action.trigger 事件归一化成插件内部可用的结构。
 * 回调是外部输入：字段缺失、类型不对都返回 undefined，由调用方回一句「按钮已失效」。
 *
 * @param {any} raw 长连接推来的原始事件
 * @returns {{ requestId: string, questionId: string, picks: string[], operatorOpenId: string, chatId: string, messageId: string }|undefined}
 */
export function parseCardAction(raw) {
  const event = raw && raw.event ? raw.event : raw
  const action = event && event.action
  if (!action || typeof action !== 'object') return undefined

  const value = action.value && typeof action.value === 'object' ? action.value : {}
  const requestId = typeof value.dshq === 'string' ? value.dshq : ''
  if (!requestId) return undefined

  const rawPick = value.pick
  const picks = Array.isArray(rawPick)
    ? rawPick.map((item) => String(item))
    : typeof rawPick === 'string' && rawPick !== ''
      ? [rawPick]
      : []

  const operator = event.operator && typeof event.operator === 'object' ? event.operator : {}
  const context = event.context && typeof event.context === 'object' ? event.context : {}

  return {
    requestId,
    questionId: typeof value.qid === 'string' ? value.qid : '',
    picks,
    operatorOpenId: String(operator.open_id || operator.openId || ''),
    chatId: String(context.open_chat_id || context.chatId || ''),
    messageId: String(context.open_message_id || context.messageId || ''),
  }
}

/** 备注行：卡片底部的说明文字 */
function note(content) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content }] }
}
