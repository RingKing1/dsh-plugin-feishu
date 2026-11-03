/**
 * 执行过程清单（对齐 pi-feishu-bridge 的 progress-note.ts）。
 *
 * 纯逻辑、无 IO：dsh 的 tool/call 与 tool/result 会话事件进来，
 * 这里维护「第几步在干什么、成没成、花了多久」，再渲染成卡片里的折叠面板。
 *
 * 为什么要显示它：飞书侧看不到终端，一问一答中间可能跑十几条命令；
 * 只显示「回复中」的用户体验就是「卡住了」。清单让等待有进度感，
 * 也让「为什么会慢 / 哪一步失败了」在卡片上直接可读。
 */

/** 摘要上限：一行里塞不下整条命令，中间省略 */
const MAX_DETAIL_CHARS = 200
/** 清单最多显示多少行，超出折叠中间部分 */
const MAX_LINES = 50
/** 清单整体字节上限：卡片 JSON 有大小限制，超了整卡更新会被飞书拒绝 */
const MAX_BYTES = 8 * 1024

/** 参数摘要优先取这些字段：它们才是「这一步在干什么」的可读描述 */
const PRIORITY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt']

/** 中间省略号：与前后文保持一个字符的间距，单行更清楚 */
const ELLIPSIS = '…'
/** 条目上限：超出只留最近的（旁白 / 思考也会计入） */
const MAX_ENTRIES = 200
/** 思考正文的保留长度：detail 只显示 200 字，留点余量够截断用 */
const MAX_BUFFER_CHARS = 2000

/**
 * 把工具参数压成一行可读摘要。
 *
 * tool/call 的 arguments 是模型给的 JSON 字符串，解析失败时退回原文
 * （宁可显示原文，也不要显示 "[object Object]" 或空串）。
 *
 * @param {unknown} input
 * @returns {string}
 */
export function summarizeToolArgs(input) {
  let value = input
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return ''
    try {
      value = JSON.parse(text)
    } catch {
      return clipOneLine(text)
    }
  }
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return clipOneLine(String(value))

  for (const key of PRIORITY_KEYS) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return clipOneLine(candidate)
  }
  try {
    return clipOneLine(JSON.stringify(value))
  } catch {
    return ''
  }
}

/**
 * 工具调用摘要：先给特殊工具做「人话」摘要，其余走通用参数摘要。
 *
 * ask_user_question 的参数是一整棵问卷 JSON，通用摘要会把题干、选项、
 * id 全塞进折叠面板标题，既难看也泄噪音；这里只留题数与第一题题干。
 *
 * @param {string} name
 * @param {unknown} args
 * @returns {string}
 */
export function summarizeToolCall(name, args) {
  const toolName = String(name || '')
  if (toolName === 'ask_user_question' || toolName.endsWith('_ask_user_question') || toolName.endsWith('__ask_user_question')) {
    return summarizeAsk(args)
  }
  return summarizeToolArgs(args)
}

/** 问卷参数 -> 「等待回答（N 个问题）：第一题题干」 */
function summarizeAsk(input) {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return '等待回答'
    }
  }
  if (!value || typeof value !== 'object') return '等待回答'
  const questions = Array.isArray(value.questions) ? value.questions : []
  if (questions.length === 0) return '等待回答'
  const first = questions[0] && typeof questions[0] === 'object' ? questions[0] : {}
  const title = String(first.question || first.header || '').replace(/\s+/g, ' ').trim()
  const brief = title ? '：' + (title.length > 80 ? title.slice(0, 79) + ELLIPSIS : title) : ''
  return questions.length === 1 ? '等待回答' + brief : '等待回答（' + questions.length + ' 个问题）' + brief
}

/**
 * 单行化 + 中部省略：保留开头（命令 / 路径前缀）与结尾（文件名 / 参数尾巴）。
 * @param {string} text
 * @returns {string}
 */
export function clipOneLine(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= MAX_DETAIL_CHARS) return flat
  const head = Math.ceil((MAX_DETAIL_CHARS - ELLIPSIS.length) / 2)
  const tail = Math.floor((MAX_DETAIL_CHARS - ELLIPSIS.length) / 2)
  return flat.slice(0, head) + ELLIPSIS + flat.slice(flat.length - tail)
}

/**
 * 耗时的人类说法：不到 1 秒给毫秒，之上给一位小数的秒，超过 1 分钟给分秒。
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '0ms'
  if (value < 1000) return Math.round(value) + 'ms'
  if (value < 60000) return (Math.round(value / 100) / 10).toFixed(1) + 's'
  const minutes = Math.floor(value / 60000)
  const seconds = Math.round((value % 60000) / 1000)
  return minutes + 'm' + seconds + 's'
}

/**
 * 一行清单：状态图标 + 工具名（粗体）+ 参数（行内代码，空则省略）+ 耗时。
 * 参数里的反引号替换成单引号，避免破坏行的 markdown 结构。
 *
 * 旁白（模型在两步之间说的话）与思考（reasoning）不是工具调用，单独成行：
 * 它们没有「成没成」「花了多久」可言，硬套工具格式只会误导。
 *
 * @param {{kind?: string, toolName: string, detail: string, startedAt: number, endedAt?: number, ok?: boolean, aborted?: boolean, text?: string}} entry
 * @param {number} [now]
 * @returns {string}
 */
export function formatProgressLine(entry, now) {
  const timestamp = Number(now) || Date.now()
  if (entry.kind === 'note') return String(entry.text || '')
  if (entry.kind === 'narration' || entry.kind === 'reasoning') {
    const icon = entry.kind === 'narration' ? '💬' : '🧠'
    const label = entry.kind === 'narration' ? '旁白' : '思考'
    const detail = entry.detail ? ' \u0060' + String(entry.detail).replace(/\u0060/g, "'") + '\u0060' : ''
    return icon + ' **' + label + '**' + detail
  }
  const mark = entry.aborted ? '⛔' : entry.endedAt ? (entry.ok === false ? '❌' : '✅') : '⏳'
  const name = '**' + String(entry.toolName || '工具') + '**'
  const detail = entry.detail ? ' \u0060' + String(entry.detail).replace(/\u0060/g, "'") + '\u0060' : ''
  const elapsed = entry.endedAt
    ? ' · ' + formatElapsed(entry.endedAt - entry.startedAt)
    : ' · 已 ' + formatElapsed(timestamp - entry.startedAt)
  return mark + ' ' + name + detail + elapsed
}

/**
 * 进度跟踪器：一次回复对应一个实例。
 *
 * mode:
 *   - off    : 不产出任何内容（面板不出现）
 *   - steps  : 完整清单（默认，对齐桥接的 steps）
 *   - action : 只显示「当前正在执行的一步」，历史折叠成标题里的计数
 */
export class ProgressTracker {
  /**
   * @param {{mode?: 'off'|'steps'|'action', maxLines?: number, now?: () => number}} [options]
   */
  constructor(options) {
    const settings = options || {}
    this.mode = settings.mode === 'off' || settings.mode === 'action' ? settings.mode : 'steps'
    this.maxLines = Number(settings.maxLines) > 0 ? Number(settings.maxLines) : MAX_LINES
    this.now = typeof settings.now === 'function' ? settings.now : () => Date.now()
    /** @type {Array<object>} 按发生顺序排列 */
    this.entries = []
    /** 当前处在第几步（0 基，未知为 -1）：只用来在标题里标「第 N 步」 */
    this.step = -1
  }

  get enabled() {
    return this.mode !== 'off'
  }

  /** 条目数：卡片层用来判断「有没有变化」 */
  get lineCount() {
    return this.entries.length
  }

  /**
   * 记录一次工具调用（session 事件 tool/call）。
   * @param {{callId?: string, name?: string, arguments?: unknown}} data
   * @returns {boolean} 是否有变化
   */
  trackCall(data) {
    if (!this.enabled || !data) return false
    const callId = String(data.callId || '')
    // 会话恢复 / 事件重放可能再发一次同一个 callId：只补一次，不重复计数
    if (callId && this.entries.some((entry) => entry.toolCallId === callId)) return false
    this.entries.push({
      toolCallId: callId,
      toolName: String(data.name || '工具'),
      detail: summarizeToolCall(data.name, data.arguments),
      startedAt: this.now(),
      endedAt: undefined,
      ok: undefined,
      aborted: false,
    })
    this.trimEntries()
    return true
  }

  /**
   * 记录一次工具结果（session 事件 tool/result）。
   * 找不到对应调用就不造条目：宁可少一行，也不要凭空出现「未知工具」。
   * @param {{callId?: string, ok?: boolean, message?: {callId?: string, isError?: boolean}}} data
   * @returns {boolean}
   */
  trackResult(data) {
    if (!this.enabled || !data) return false
    const callId = String(data.callId || (data.message && data.message.callId) || '')
    if (!callId) return false
    const entry = this.entries.find((item) => item.toolCallId === callId)
    if (!entry || entry.endedAt) return false
    entry.endedAt = this.now()
    entry.ok = typeof data.ok === 'boolean' ? data.ok : !(data.message && data.message.isError)
    return true
  }

  /**
   * 记下当前步骤号（agent 帧的 start 带来 turn/step）。
   * 只影响标题文案，不造条目：没有工具调用时不该凭空出现一行。
   * @param {number} step
   * @returns {boolean}
   */
  noteStep(step) {
    const value = Number(step)
    if (!Number.isFinite(value) || value < 0 || value === this.step) return false
    this.step = value
    return true
  }

  /**
   * 记录一段旁白：模型在两步之间说的「我先看一下 / 现在跑测试」。
   * 正文只留最终回复，这些话不能丢，就放在过程面板里 —— 它们解释了
   * 「为什么会有下一步」，是复盘时的关键线索。
   * @param {{text?: string, step?: number}} data
   * @returns {boolean}
   */
  trackNarration(data) {
    if (!this.enabled || !data) return false
    const detail = clipOneLine(data.text)
    if (!detail) return false
    const timestamp = this.now()
    this.entries.push({
      toolCallId: 'narration-' + this.entries.length,
      kind: 'narration',
      toolName: '旁白',
      detail,
      startedAt: timestamp,
      endedAt: timestamp,
      ok: true,
      aborted: false,
    })
    this.trimEntries()
    return true
  }

  /**
   * 记录思考增量：同一个 step 的多条 delta 合并成一行，否则面板会被逐字刷屏。
   * @param {{text?: string, step?: number}} data
   * @returns {boolean}
   */
  trackReasoning(data) {
    if (!this.enabled || !data || !data.text) return false
    const step = Number.isFinite(Number(data.step)) ? Number(data.step) : this.step
    const callId = 'reasoning-' + step
    let entry = this.entries.find((item) => item.kind === 'reasoning' && item.toolCallId === callId)
    if (!entry) {
      entry = {
        toolCallId: callId,
        kind: 'reasoning',
        toolName: '思考',
        detail: '',
        buffer: '',
        startedAt: this.now(),
        endedAt: undefined,
        ok: true,
        aborted: false,
      }
      this.entries.push(entry)
    }
    // buffer 只留最近的片段：detail 已按 200 字截断，buffer 再长也没人看得到
    entry.buffer = (String(entry.buffer || '') + String(data.text)).slice(-MAX_BUFFER_CHARS)
    entry.detail = clipOneLine(entry.buffer)
    entry.endedAt = this.now()
    this.trimEntries()
    return true
  }

  /** 条数上限：长会话里工具可能很多，超了只留最近的，避免内存与渲染失控 */
  trimEntries() {
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
  }

  /** 被用户中断：所有还在跑的步骤标成 ⛔，否则收尾后仍显示「进行中」 */
  abortAll() {
    const timestamp = this.now()
    for (const entry of this.entries) {
      if (entry.endedAt) continue
      entry.aborted = true
      entry.endedAt = timestamp
    }
  }

  /** 当前正在执行的那一步（最后一条未结束的） */
  get running() {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]
      if (!entry.endedAt) return entry
    }
    return undefined
  }

  /**
   * 正在跑的那一步的简述（`bash · ls`），给正文占位用。
   * 没有进行中的步骤、或面板被关掉时返回 ''：这时正文占位退回通用文案。
   */
  activity() {
    if (!this.enabled) return ''
    const running = this.running
    if (!running) return ''
    return running.detail ? running.toolName + ' ' + running.detail : running.toolName
  }

  /** 折叠面板的标题：进行中显示「在干什么」，结束显示「完成了几步」 */
  title() {
    if (!this.enabled) return ''
    // 没有任何工具调用时不要推送面板标题：面板本身都还没出现，
    // 对不存在的元件做 PATCH 会被飞书拒绝（400），白白浪费一次请求
    if (this.entries.length === 0) return ''
    // 第几步是 per-turn 信息：多步任务里用户要知道「现在进行到哪了」
    const prefix = this.step >= 0 ? '第 ' + (this.step + 1) + ' 步 · ' : ''
    const running = this.running
    if (running) {
      const detail = running.detail ? ' · ' + running.detail : ''
      return prefix + '执行过程（正在执行 ' + running.toolName + detail + ' · 已 ' + formatElapsed(this.now() - running.startedAt) + '）'
    }
    const failed = this.entries.filter((entry) => entry.ok === false).length
    const aborted = this.entries.filter((entry) => entry.aborted).length
    if (aborted > 0 && failed === 0) return prefix + '执行过程（已中断 · 完成 ' + this.entries.length + ' 步）'
    if (failed > 0) return prefix + '执行过程（完成 ' + this.entries.length + ' 步 · ' + failed + ' 步失败）'
    return prefix + '执行过程（已完成 ' + this.entries.length + ' 步）'
  }

  /** 面板正文（markdown，不带引用前缀；加前缀由 formatProgressBlock 做） */
  render() {
    if (!this.enabled || this.entries.length === 0) return ''
    const timestamp = this.now()
    const lines = this.entries.map((entry) => formatProgressLine(entry, timestamp))
    if (this.mode === 'action') {
      const running = this.running
      const last = running || this.entries[this.entries.length - 1]
      return formatProgressLine(last, timestamp)
    }
    return collapseLines(lines, this.maxLines)
  }

  /** 渲染结果 + 标题的一次性快照（卡片层据此去重推送） */
  snapshot() {
    return { markdown: formatProgressBlock(this.render()), title: this.title() }
  }
}

/**
 * 行数超过上限时折叠中间：保留开头几步（知道从哪开始）与结尾几步（知道怎么结束），
 * 中间用一行省略说明。整段丢掉结尾会让用户看不到最后一步是成功还是失败。
 * @param {string[]} lines
 * @param {number} maxLines
 */
function collapseLines(lines, maxLines) {
  if (lines.length <= maxLines) return lines.join('\n')
  const head = Math.max(1, Math.ceil((maxLines - 1) / 2))
  const tail = Math.max(1, maxLines - head - 1)
  const hidden = lines.length - head - tail
  return [...lines.slice(0, head), '… 中间 ' + hidden + ' 步已省略 …', ...lines.slice(lines.length - tail)].join('\n')
}

/**
 * 给清单加引用前缀：飞书 markdown 里引用块与正文区分得开，
 * 用户一眼能看出这是过程、不是答案。
 * @param {string} markdown
 */
export function formatProgressBlock(markdown) {
  const text = String(markdown || '').trim()
  if (!text) return ''
  return text
    .split('\n')
    .map((line) => (line.startsWith('>') ? line : '> ' + line))
    .join('\n')
}

/**
 * 从开头裁到能装进 limit 字节：卡片更新是整块传的，超限会被飞书拒绝。
 * 从尾部保留（最近发生的更重要），裁掉的行数写进首行提示。
 * @param {string} markdown
 * @param {number} [limit]
 */
export function trimProgressToBytes(markdown, limit) {
  const max = Number(limit) > 0 ? Number(limit) : MAX_BYTES
  const text = String(markdown || '')
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  const lines = text.split('\n')
  const kept = []
  let size = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    const bytes = Buffer.byteLength(line + '\n', 'utf8')
    if (size + bytes > max && kept.length > 0) break
    kept.unshift(line)
    size += bytes
  }
  const dropped = lines.length - kept.length
  const header = dropped > 0 ? '> … 前面 ' + dropped + ' 行已省略 …' : ''
  return [header, ...kept].filter(Boolean).join('\n')
}
