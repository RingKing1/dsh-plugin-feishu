/**
 * 「网页端镜像」卡片：把非飞书发起的轮次渲染成一张只读卡（纯函数，无 IO）。
 *
 * 为什么是只读：这一轮的操作入口在电脑上，手机上只负责「看得见」。
 * 给按钮会造成两边抢操作（同一轮被两个入口同时停/答），所以刻意不给。
 */

export const MIRROR_CARD_STATUS = {
  running: { template: 'blue', title: '🖥 网页端 · 进行中' },
  done: { template: 'green', title: '✅ 网页端 · 完成' },
  failed: { template: 'red', title: '❌ 网页端 · 出错' },
  stopped: { template: 'grey', title: '⏹ 网页端 · 已中断' },
}

/** 正文上限：镜像只是「看一眼」，不搬运整篇 */
const MAX_TEXT = 1500
/** 工具清单最多列几条（从最近的往前取） */
const MAX_TOOLS = 8
/** 单个工具名/摘要的长度 */
const MAX_TOOL_LINE = 70

/**
 * @param {{
 *   title?: string,
 *   status?: 'running'|'done'|'failed'|'stopped',
 *   text?: string,
 *   tools?: Array<{ name: string, ok?: boolean, detail?: string }>,
 *   elapsedMs?: number,
 *   note?: string,
 * }} input
 */
export function buildMirrorCard(input) {
  const status = MIRROR_CARD_STATUS[input && input.status] ? input.status : 'running'
  const elements = []

  const title = String((input && input.title) || '').trim()
  if (title) elements.push({ tag: 'div', text: { tag: 'plain_text', content: '会话：' + title } })

  const text = String((input && input.text) || '').trim()
  if (text) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: clip(text, MAX_TEXT) } })
  } else if (status === 'running') {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '（模型还没输出文字，正在执行）' } })
  }

  const tools = Array.isArray(input && input.tools) ? input.tools : []
  if (tools.length > 0) {
    const recent = tools.slice(-MAX_TOOLS)
    const lines = recent.map((tool) => {
      const mark = tool.ok === true ? '✅' : tool.ok === false ? '⚠️' : '⏳'
      const detail = tool.detail ? ' · ' + clip(tool.detail, MAX_TOOL_LINE) : ''
      return mark + ' ' + clip(String(tool.name || '工具'), MAX_TOOL_LINE) + detail
    })
    const more = tools.length > recent.length ? '\n（更早 ' + (tools.length - recent.length) + ' 条省略）' : ''
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '执行过程：\n' + lines.join('\n') + more } })
  }

  const footer = footerText(status, Number((input && input.elapsedMs) || 0), tools)
  const note = String((input && input.note) || '').trim()
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: note ? note + '\n' + footer : footer }] })

  const header = MIRROR_CARD_STATUS[status]
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements,
  }
}

/** 从 AssistantMessage 的 content 里抽纯文字（镜像只用文字，工具另算） */
export function extractMessageText(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

function footerText(status, elapsedMs, tools) {
  const seconds = elapsedMs > 0 ? Math.round(elapsedMs / 1000) : 0
  const used = tools.length > 0 ? ' · ' + tools.length + ' 次工具调用' : ''
  if (status === 'done') return '✅ 完成' + (seconds ? ' · 用时 ' + formatDuration(seconds) : '') + used + ' · 只读镜像'
  if (status === 'failed') return '❌ 出错' + (seconds ? ' · 用时 ' + formatDuration(seconds) : '') + used
  if (status === 'stopped') return '⏹ 已中断' + used
  return '⏳ 进行中' + (seconds ? ' · 已用 ' + formatDuration(seconds) : '') + used + ' · 操作请在电脑上'
}

function formatDuration(seconds) {
  if (seconds < 60) return seconds + ' 秒'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes + ':' + String(rest).padStart(2, '0')
}

function clip(text, max) {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}
