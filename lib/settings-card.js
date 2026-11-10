/**
 * 设置卡片：模型 / 推理强度 / 权限模式（纯函数，无 IO，便于单测）。
 *
 * 三张卡片共用一套交互约定：
 *   - 按钮 value 用不同的前缀区分（dshm 模型 / dshe 推理强度 / dshp 权限），
 *     与选择题（dshq）、授权（dsha）互不干扰；
 *   - 点完由回调同步返回一张新卡，飞书原地刷新，不另发消息；
 *   - 每张卡底部都写清楚「当前值」，避免点完不知道生效没有。
 */

/** 一行最多几个按钮：再多飞书会折行，手机端很难点 */
const MAX_BUTTONS_PER_ROW = 4
/** 按钮文字上限（飞书 plain_text 有长度限制） */
const MAX_LABEL = 18
/** 卡片里最多列多少个模型：模型多的部署不至于把一张卡刷成几十个按钮 */
const MAX_MODELS = 24

export const MODEL_CARD_STATUS = {
  pending: { template: 'blue', title: '选择模型' },
  done: { template: 'green', title: '✅ 已切换模型' },
  failed: { template: 'red', title: '❌ 切换失败' },
}

export const EFFORT_CARD_STATUS = {
  pending: { template: 'blue', title: '选择推理强度' },
  done: { template: 'green', title: '✅ 已切换推理强度' },
  failed: { template: 'red', title: '❌ 切换失败' },
}

export const PERMISSION_CARD_STATUS = {
  pending: { template: 'orange', title: '选择权限模式' },
  done: { template: 'green', title: '✅ 已切换权限模式' },
  failed: { template: 'red', title: '❌ 切换失败' },
}

/**
 * 模型卡片。
 *
 * @param {{
 *   providers: Array<{ id: string, name: string, models: Array<{ id: string, name: string, reasoning?: boolean }> }>,
 *   current?: { provider: string, model: string, reasoningEffort?: string },
 *   status?: 'pending'|'done'|'failed',
 *   note?: string,
 * }} input
 */
export function buildModelCard(input) {
  const providers = Array.isArray(input && input.providers) ? input.providers : []
  const status = MODEL_CARD_STATUS[input && input.status] ? input.status : 'pending'
  const current = (input && input.current) || {}
  const elements = []

  elements.push({
    tag: 'div',
    text: {
      tag: 'plain_text',
      content: '当前：' + describeSelection(current),
    },
  })

  let shown = 0
  for (const provider of providers) {
    const models = Array.isArray(provider.models) ? provider.models : []
    if (models.length === 0) continue
    const visible = models.slice(0, Math.max(0, MAX_MODELS - shown))
    if (visible.length === 0) break
    shown += visible.length

    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '【' + (provider.name || provider.id) + '】' } })
    for (const row of chunk(visible, MAX_BUTTONS_PER_ROW)) {
      elements.push({
        tag: 'action',
        actions: row.map((model) => {
          const active = current.provider === provider.id && current.model === model.id
          return {
            tag: 'button',
            text: { tag: 'plain_text', content: truncate((active ? '✓ ' : '') + (model.name || model.id)) },
            type: active ? 'primary' : 'default',
            value: { dshm: provider.id + '|' + model.id },
          }
        }),
      })
    }
  }

  if (shown === 0) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '没有读到可用模型（llm 服务未就绪或没有配置 provider）。' } })
  }

  const noteText = typeof (input && input.note) === 'string' ? input.note.trim() : ''
  elements.push(note(noteText || '点模型名切换；有推理强度的模型会接着让你选强度。'))

  const header = MODEL_CARD_STATUS[status]
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements,
  }
}

/**
 * 推理强度卡片。
 *
 * @param {{
 *   provider: string,
 *   model: string,
 *   modelName?: string,
 *   efforts: Array<{ id: string, name?: string, description?: string }>,
 *   current?: string,
 *   status?: 'pending'|'done'|'failed',
 *   note?: string,
 * }} input
 */
export function buildEffortCard(input) {
  const efforts = Array.isArray(input && input.efforts) ? input.efforts : []
  const status = EFFORT_CARD_STATUS[input && input.status] ? input.status : 'pending'
  const current = typeof (input && input.current) === 'string' ? input.current : ''
  const provider = String((input && input.provider) || '')
  const model = String((input && input.model) || '')

  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: '模型：' + (input && input.modelName ? input.modelName : model) + '　当前强度：' + (effortLabel(efforts, current) || '默认'),
      },
    },
  ]

  if (efforts.length > 0) {
    const rows = chunk(
      [{ id: '', name: '默认' }, ...efforts].slice(0, MAX_MODELS),
      MAX_BUTTONS_PER_ROW,
    )
    for (const row of rows) {
      elements.push({
        tag: 'action',
        actions: row.map((effort) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: truncate((current === effort.id ? '✓ ' : '') + (effort.name || effort.id || '默认')) },
          type: current === effort.id ? 'primary' : 'default',
          value: { dshe: provider + '|' + model + '|' + effort.id },
        })),
      })
    }
    const detail = efforts
      .filter((effort) => typeof effort.description === 'string' && effort.description.trim())
      .map((effort) => (effort.name || effort.id) + '：' + effort.description.trim())
      .join('\n')
    if (detail) elements.push({ tag: 'div', text: { tag: 'plain_text', content: detail } })
  } else {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '这个模型没有声明推理强度选项。' } })
  }

  const noteText = typeof (input && input.note) === 'string' ? input.note.trim() : ''
  elements.push(note(noteText || '「默认」= 交给模型自己的默认强度。'))

  const header = EFFORT_CARD_STATUS[status]
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements,
  }
}

/**
 * 权限模式卡片。
 *
 * @param {{
 *   options: Array<{ value: string, name: string, description?: string }>,
 *   current?: string,
 *   status?: 'pending'|'done'|'failed',
 *   note?: string,
 * }} input
 */
export function buildPermissionCard(input) {
  const options = Array.isArray(input && input.options) ? input.options : []
  const status = PERMISSION_CARD_STATUS[input && input.status] ? input.status : 'pending'
  const current = String((input && input.current) || '')

  const elements = [
    { tag: 'div', text: { tag: 'plain_text', content: '当前：' + (labelOf(options, current) || current || '未知') } },
  ]

  if (options.length > 0) {
    for (const row of chunk(options.slice(0, MAX_MODELS), 3)) {
      elements.push({
        tag: 'action',
        actions: row.map((option) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: truncate((current === option.value ? '✓ ' : '') + (option.name || option.value)) },
          type: current === option.value ? 'primary' : 'default',
          value: { dshp: option.value },
        })),
      })
    }
    const detail = options
      .filter((option) => typeof option.description === 'string' && option.description.trim())
      .map((option) => (option.name || option.value) + '：' + option.description.trim())
      .join('\n')
    if (detail) elements.push({ tag: 'div', text: { tag: 'plain_text', content: detail } })
  } else {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '没有读到权限预设（permissionPresets 服务未就绪）。' } })
  }

  const noteText = typeof (input && input.note) === 'string' ? input.note.trim() : ''
  elements.push(note(noteText || '只对当前这条飞书会话生效；网页端会话不受影响。'))

  const header = PERMISSION_CARD_STATUS[status]
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements,
  }
}

/**
 * 解析设置卡片的回调。三个前缀分别对应模型 / 强度 / 权限。
 *
 * @param {any} raw
 * @returns {{ kind: 'model', provider: string, model: string }
 *   | { kind: 'effort', provider: string, model: string, effort: string }
 *   | { kind: 'permission', preset: string }
 *   | undefined}
 */
export function parseSettingsAction(raw) {
  const event = raw && raw.event ? raw.event : raw
  const action = event && event.action
  if (!action || typeof action !== 'object') return undefined
  const value = action.value && typeof action.value === 'object' ? action.value : {}

  if (typeof value.dshm === 'string') {
    const [provider, model] = splitPair(value.dshm)
    if (provider && model) return { kind: 'model', provider, model }
    return undefined
  }
  if (typeof value.dshe === 'string') {
    const [provider, model, effort] = String(value.dshe).split('|')
    if (provider && model) return { kind: 'effort', provider, model, effort: effort || '' }
    return undefined
  }
  if (typeof value.dshp === 'string' && value.dshp !== '') {
    return { kind: 'permission', preset: value.dshp }
  }
  return undefined
}

/** 「provider/model · 强度」一行字，/status 与卡片共用 */
export function describeSelection(selection) {
  if (!selection || !selection.provider || !selection.model) return '（跟随 dsh 默认）'
  const effort = selection.reasoningEffort ? ' · 强度 ' + selection.reasoningEffort : ''
  return selection.provider + '/' + selection.model + effort
}

function effortLabel(efforts, id) {
  if (!id) return ''
  const found = efforts.find((effort) => effort.id === id)
  return found ? found.name || found.id : id
}

function labelOf(options, value) {
  const found = options.find((option) => option.value === value)
  return found ? found.name || found.value : ''
}

function splitPair(text) {
  const index = String(text).indexOf('|')
  if (index <= 0) return ['', '']
  return [String(text).slice(0, index), String(text).slice(index + 1)]
}

function chunk(items, size) {
  const rows = []
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size))
  return rows
}

function truncate(text) {
  const value = String(text || '')
  return value.length > MAX_LABEL ? value.slice(0, MAX_LABEL - 1) + '…' : value
}

function note(content) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content }] }
}
