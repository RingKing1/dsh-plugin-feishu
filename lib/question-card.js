/**
 * 选择题卡片：把 dsh 的提问渲染成飞书交互卡片（纯函数，无 IO，便于单测）。
 *
 * 为什么不走 CardKit 2.0：提问卡只需要「按钮 / 表单提交 -> card.action.trigger 回调」，
 * 1.0 的 action + button.value 与 form 容器是这条链路里最稳定的形态；
 * 回调返回值可以带一张新卡片，飞书会原地刷新，不需要另发消息。
 *
 * 状态（对齐 pi-feishu-bridge 的 ask.ts）：
 *   pending 请选择（蓝） -> done 已选择（绿）/ timeout 选择超时（灰）/ canceled 已结束（灰）
 * 答完一题就刷新同一张卡：已答项只显示答案，不再给按钮和输入框。
 */

/** 卡片的四种状态：标题、颜色与底部提示集中在这里，避免散落在渲染逻辑里 */
export const QUESTION_CARD_STATUS = {
  pending: { template: 'blue', title: '请选择' },
  done: { template: 'green', title: '已选择' },
  timeout: { template: 'grey', title: '选择超时' },
  canceled: { template: 'grey', title: '已结束' },
}

/** 兼容旧调用方：默认状态标题 */
export const QUESTION_CARD_TITLE = QUESTION_CARD_STATUS.pending.title

/**
 * 一行最多放几个按钮：再多飞书会折行，手机端很难点。
 * 超出的选项不渲染按钮，但仍会在选项清单里列出来，用户可以直接回复文字。
 */
const MAX_BUTTONS_PER_ROW = 6

/** 按钮文字上限：飞书 plain_text 有长度限制，超长会整卡被拒 */
const MAX_BUTTON_LABEL = 20

/** 自由输入上限：防止误粘贴超长文本把卡片撞坏 */
export const CUSTOM_ANSWER_MAX = 200

/**
 * 构造提问卡片。
 * @param {{
 *   questions: Array<{ id: string, header?: string, question: string, detail?: string, options?: Array<{label: string, description?: string}>, multiSelect?: boolean }>,
 *   requestId: string,
 *   answers?: Map<string, { selected?: string[], custom?: string }>|Record<string, { selected?: string[], custom?: string }>,
 *   status?: 'pending'|'done'|'timeout'|'canceled',
 * }} input
 * @returns {object} 可直接作为 interactive 消息 content 的卡片 JSON
 */
export function buildQuestionCard(input) {
  const questions = Array.isArray(input && input.questions) ? input.questions : []
  const requestId = String((input && input.requestId) || '')
  const status = QUESTION_CARD_STATUS[input && input.status] ? input.status : 'pending'
  const answers = toAnswerMap(input && input.answers)
  const elements = []

  questions.forEach((question, index) => {
    const answer = answers.get(String(question.id))
    const chosen = Array.isArray(answer && answer.selected) ? answer.selected.map((item) => String(item)) : []
    const custom = typeof (answer && answer.custom) === 'string' ? answer.custom.trim() : ''
    const answered = chosen.length > 0 || custom !== ''

    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: questionTitle(question, index) },
    })

    const detail = typeof question.detail === 'string' ? question.detail.trim() : ''
    if (detail) elements.push({ tag: 'div', text: { tag: 'lark_md', content: detail } })

    if (answered) {
      // 已答项只留答案，不再给按钮 / 输入框，避免重复提交和「还能不能改」的歧义
      if (chosen.length > 0) {
        elements.push({ tag: 'div', text: { tag: 'plain_text', content: '✅ 已选择：' + chosen.join('、') } })
      }
      if (custom) {
        elements.push({ tag: 'div', text: { tag: 'plain_text', content: '✏️ 你的输入：' + custom } })
      }
      return
    }

    // 未答项：选项清单（带说明）+ 按钮 + 自由输入表单
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 0) {
      elements.push({
        tag: 'div',
        text: { tag: 'plain_text', content: options.map(formatOption).join('\n') },
      })
    }

    const visible = options.slice(0, MAX_BUTTONS_PER_ROW)
    if (visible.length > 0) {
      elements.push({
        tag: 'action',
        actions: visible.map((option, optionIndex) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: truncateLabel(String(option.label)) },
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
      elements.push(note('这题可多选：在输入框里用逗号分隔多个选项，或直接回复文字。'))
    }

    // 自由输入：飞书要求 form 内每个交互组件都带 name，且必须有一个 form_submit 按钮。
    // 输入框的值会随 form_submit 回调出现在 action.form_value 里（key = name）。
    const inputName = 'dsh_input_' + index
    const formName = 'dsh_form_' + index
    elements.push({
      tag: 'form',
      name: formName,
      elements: [
        {
          tag: 'input',
          name: inputName,
          placeholder: {
            tag: 'plain_text',
            content: options.length > 0 ? '选项都不合适？在这里自己输入，再点「提交输入」' : '在这里输入你的回答，再点「提交输入」',
          },
        },
        {
          tag: 'button',
          name: 'dsh_submit_' + index,
          text: { tag: 'plain_text', content: '提交输入' },
          type: 'primary',
          action_type: 'form_submit',
          // input 记录输入框 name：回调里按它从 form_value 取值，不靠猜下标
          value: { dshq: requestId, qid: String(question.id), input: inputName },
        },
      ],
    })
  })

  const noteText = typeof (input && input.note) === 'string' ? input.note.trim() : ''
  const footer = footerText(status, answers, questions)
  elements.push(note(noteText ? noteText + '\n' + footer : footer))

  const header = QUESTION_CARD_STATUS[status]
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements,
  }
}

/**
 * 把一条 card.action.trigger 事件归一化成插件内部可用的结构。
 * 回调是外部输入：字段缺失、类型不对都返回 undefined，由调用方回一句「按钮已失效」。
 *
 * @param {any} raw 长连接推来的原始事件
 * @returns {{ requestId: string, questionId: string, picks: string[], customText: string, fromForm: boolean, inputName: string, operatorOpenId: string, chatId: string, messageId: string }|undefined}
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
  const formValue = action.form_value || action.formValue
  const inputName = typeof value.input === 'string' ? value.input : ''
  const rawCustom = inputName && formValue && typeof formValue === 'object' ? formValue[inputName] : undefined
  const customText = typeof rawCustom === 'string' ? rawCustom.trim().slice(0, CUSTOM_ANSWER_MAX) : ''

  return {
    requestId,
    questionId: typeof value.qid === 'string' ? value.qid : '',
    picks,
    customText,
    fromForm: Boolean(inputName),
    inputName,
    operatorOpenId: String(operator.open_id || operator.openId || ''),
    chatId: String(context.open_chat_id || context.chatId || ''),
    messageId: String(context.open_message_id || context.messageId || ''),
  }
}

/** 题干：题号 + 可选的小标题；用 plain_text，选项里常带 * _ 之类字符 */
function questionTitle(question, index) {
  const header = typeof question.header === 'string' && question.header.trim() ? '【' + question.header.trim() + '】' : ''
  return index + 1 + '. ' + header + String(question.question || '')
}

/** 选项清单：A. 标签 —— 说明 */
function formatOption(option, index) {
  const label = String(option.label || '')
  const description = typeof option.description === 'string' && option.description.trim() ? ' — ' + option.description.trim() : ''
  return String.fromCharCode(65 + index) + '. ' + label + description
}

/** 按钮文字超长时截断：按钮只是快捷入口，完整标签在 value 里 */
function truncateLabel(label) {
  const text = label.trim()
  return text.length > MAX_BUTTON_LABEL ? text.slice(0, MAX_BUTTON_LABEL - 1) + '…' : text
}

/** 底部状态：明确告诉用户还差几题 / 已经结束 */
function footerText(status, answers, questions) {
  const total = questions.length
  const answered = questions.filter((question) => {
    const answer = answers.get(String(question.id))
    return Boolean(answer && ((Array.isArray(answer.selected) && answer.selected.length > 0) || (typeof answer.custom === 'string' && answer.custom.trim())))
  }).length
  if (status === 'done') return '✅ 已全部作答（' + answered + '/' + total + '）'
  if (status === 'timeout') return '⌛ 等待超时，已作答 ' + answered + '/' + total
  if (status === 'canceled') return '⚠️ 提问已结束，已作答 ' + answered + '/' + total
  return '等待选择（' + answered + '/' + total + '）· 也可以直接回复文字作答'
}

/** 答案容器归一化：既接受 Map，也接受普通对象（测试 / 外部调用更方便） */
function toAnswerMap(input) {
  const map = new Map()
  if (input instanceof Map) {
    for (const [key, value] of input.entries()) map.set(String(key), value || {})
    return map
  }
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) map.set(String(key), value || {})
  }
  return map
}

/** 备注行：卡片底部的说明文字 */
function note(content) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content }] }
}
