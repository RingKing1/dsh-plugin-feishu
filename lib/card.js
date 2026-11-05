/**
 * 飞书 CardKit（schema 2.0）卡片 JSON 构造 —— 纯函数，无 IO，便于单测。
 *
 * 两张元件：
 *   - progress：折叠面板里的执行过程清单（工具在干什么、成没成、花了多久）
 *   - content ：正文，靠 element_id 做流式局部更新
 * 顺序固定为 progress 在前、content 在后：过程放上面，答案放下面，符合阅读习惯。
 */

/** 正文元件 id：CardKit 只支持按 element_id 更新，改名必须同步改更新路径 */
export const CONTENT_ELEMENT_ID = 'content'
/** 执行过程正文元件 id */
export const PROGRESS_ELEMENT_ID = 'progress'
/** 执行过程折叠面板 id（改标题走它） */
export const PROGRESS_PANEL_ID = 'progress_panel'
/** 顶部存活状态行元件 id（运行态心跳写这里，正文不被覆盖） */
export const STATUS_ELEMENT_ID = 'status'

/** 状态样式：running/paused 是中间态，其余为终态 */
const STATUS_HEADER = {
  running: { template: 'blue', title: '回复中' },
  paused: { template: 'orange', title: '等你选择' },
  answered: { template: 'grey', title: '已选择' },
  done: { template: 'green', title: '回复' },
  failed: { template: 'red', title: '出错了' },
  stopped: { template: 'grey', title: '已停止' },
}

/** 中间态正文占位：没有内容时也要让用户看到卡片在干什么 */
const PLACEHOLDER = {
  running: '正在回复…',
  paused: '（已暂停，等你先在选择题卡片上作答）',
}

export const TRUNCATED_MARK = '\n\n…（内容过长，已截断）'

/**
 * 构造一张卡片。
 * @param {object} input
 * @param {'running'|'paused'|'answered'|'done'|'failed'|'stopped'} [input.status]
 * @param {string} [input.title] 卡片标题，默认取状态标题
 * @param {string} [input.body] 正文 markdown
 * @param {string} [input.note] 备注：显示在正文上方（失败原因、等待说明）
 * @param {boolean} [input.streaming] 是否开启流式模式（只有 running 才有效）
 * @param {string} [input.progress] 执行过程清单（markdown，已带引用前缀）
 * @param {boolean} [input.progressEnabled] 过程面板是否启用：true 时即使清单为空也建出元件
 * @param {string} [input.progressTitle] 折叠面板标题
 * @param {boolean} [input.progressExpanded] 面板是否默认展开
 * @param {string} [input.statusLine] 顶部存活状态行（⏳ 回复中 · 第 N 步 · 当前工具 · 已用 MM:SS）；
 *   传了才建出该元件 —— 建卡后 CardKit 只能更新已存在的 element_id，
 *   运行期心跳无处可写，卡片就会一动不动
 * @param {string} [input.key] 会话键：传了才在中间态卡片上放「停止」按钮
 */
export function buildCard(input) {
  const options = input || {}
  const status = STATUS_HEADER[options.status] ? options.status : 'running'
  const header = STATUS_HEADER[status]
  const streaming = Boolean(options.streaming) && status === 'running'

  const config = {
    wide_screen_mode: true,
    update_multi: true,
    streaming_mode: streaming,
  }
  if (streaming) {
    // 飞书按此频率把已写入的内容增量推给客户端
    config.streaming_config = {
      print_frequency_ms: { default: 50 },
      print_step: { default: 1 },
    }
  }

  const elements = []
  // 状态行最上面：它是「还在跑 / 跑到哪 / 跑了多久」的唯一稳定载体。
  // 不放进正文：正文在 final 模式下留着真实答案，不能被心跳盖掉。
  const statusLine = typeof options.statusLine === 'string' ? options.statusLine.trim() : ''
  if (statusLine) {
    elements.push({ tag: 'markdown', content: statusLine, element_id: STATUS_ELEMENT_ID })
  }
  const progress = typeof options.progress === 'string' ? options.progress.trim() : ''
  // 过程面板必须**建卡时就存在**：CardKit 只能更新已存在的 element_id，
  // 建卡时因为清单还空着就不放元件，之后每一次 PUT 都会 400「not find elementID」。
  // 所以 progressEnabled 为真时用单个空格占住位置（飞书不接受空 content）。
  if (progress || options.progressEnabled) {
    elements.push({
      tag: 'collapsible_panel',
      element_id: PROGRESS_PANEL_ID,
      expanded: Boolean(options.progressExpanded),
      header: {
        title: { tag: 'plain_text', content: options.progressTitle || '执行过程' },
        // 右上角箭头：默认收起，用户想看过程时自己点开
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      elements: [{ tag: 'markdown', content: progress || ' ', element_id: PROGRESS_ELEMENT_ID }],
    })
  }

  elements.push({ tag: 'markdown', content: composeBody(status, options), element_id: CONTENT_ELEMENT_ID })

  if (options.key && (status === 'running' || status === 'paused')) {
    elements.push({
      tag: 'button',
      type: 'danger',
      text: { tag: 'plain_text', content: '停止' },
      value: { dshstop: String(options.key) },
      behaviors: [{ type: 'callback', value: { dshstop: String(options.key) } }],
    })
  }

  return {
    schema: '2.0',
    config,
    header: {
      template: header.template,
      title: { tag: 'plain_text', content: options.title || header.title },
    },
    body: { elements },
  }
}

/**
 * 正文拼装规则（对齐 pi-feishu-bridge 的 card-builder）：
 *   - 中间态：note 在上，正文在下；正文为空时给占位，卡片不留白
 *   - 终态 done：正文
 *   - 终态 failed / stopped：note 在上，正文在下（可能一句正文都没有）
 */
function composeBody(status, options) {
  const note = typeof options.note === 'string' ? options.note.trim() : ''
  const body = typeof options.body === 'string' ? options.body : ''
  if (status === 'paused') {
    // 暂停态正文为空时只留一句提示：note 与占位符同时上屏会出现两遍「等你选择」
    const text = body.trim()
    if (note && text) return note + '\n\n' + text
    if (note) return note
    return text || PLACEHOLDER.paused
  }
  if (status === 'running') {
    const text = body.trim() ? body : PLACEHOLDER.running
    return note ? note + '\n\n' + text : text
  }
  if (status === 'done') {
    // 终态也可能带备注（例如「输出达到长度上限，已被截断」）：有正文时放上面
    if (note && body.trim()) return note + '\n\n' + body
    return body.trim() ? body : note || ' '
  }
  if (note && body.trim()) return note + '\n\n' + body
  return note || body || ' '
}

/**
 * 按上限截断正文。卡片正文没有硬性字数上限，但整卡 JSON 有大小限制，
 * 且超长消息在手机端体验很差，故统一截断并显式告知用户。
 */
export function clipText(text, maxChars) {
  const value = typeof text === 'string' ? text : ''
  const limit = Number.isFinite(maxChars) ? maxChars : 8000
  if (value.length <= limit) return value
  return value.slice(0, Math.max(0, limit - TRUNCATED_MARK.length)) + TRUNCATED_MARK
}
