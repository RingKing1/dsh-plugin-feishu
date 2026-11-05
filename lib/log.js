/**
 * 统一日志：所有行都带 feishu: 前缀，方便在 dsh 日志里检索。
 * 第二个参数是结构化细节，序列化后追加到同一行（失败时降级为 String）。
 *
 * 为什么要自己落盘（NFR-4）：
 * dsh 的日志只在内存 / 终端里，进程一崩就没了。而「卡片为什么停在回复中」
 * 这类事故恰恰是崩了之后才要复盘，所以事件发生的那一刻就必须落到文件里。
 * 约定：
 *   - info / warn / error 无条件落盘；debug 只在设置页打开时落盘（避免刷爆磁盘）
 *   - 每行自包含：时间 + 级别 + 来源 + 消息 + 结构化细节（含 appId / cardId / key）
 *   - 按天分文件 + 单文件超限滚动，最多留 3 个历史文件
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 默认落在 ~/.dsh/logs/，与 dsh 的其它状态文件同根 */
export const DEFAULT_LOG_DIR = join(homedir(), '.dsh', 'logs')
/** 单个日志文件上限：10MB，够放几十万行，又不至于把用户磁盘撑爆 */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024
/** 滚动保留的历史文件数：feishu-2026-11-05.log.1 / .2 / .3 */
const ROTATE_KEEP = 3

function render(detail) {
  if (detail === undefined) return ''
  try {
    return ' ' + JSON.stringify(detail)
  } catch {
    return ' ' + String(detail)
  }
}

/** 本地时间的 YYYY-MM-DD；按本地日期分文件，用户对着「今天」找日志才对得上 */
function dayKey(date) {
  const pad = (value) => (value < 10 ? '0' + value : String(value))
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/** 2026-11-05T09:40:00.123+08:00：带毫秒与时区，跨机器对齐时间线不用换算 */
function stamp(date) {
  const pad = (value, width) => String(value).padStart(width || 2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(offset) / 60)
  const minutes = Math.abs(offset) % 60
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds()) +
    '.' +
    pad(date.getMilliseconds(), 3) +
    sign +
    pad(hours) +
    ':' +
    pad(minutes)
  )
}

/**
 * 建一个文件日志接收器（懒创建：只有真的要写第一行时才建目录）。
 *
 * 用 appendFileSync 而不是排队的异步写：日志量小（QPS 个位数），
 * 但进程崩溃前最后一行必须是落盘的 —— 那行往往就是事故的唯一线索。
 */
function createSink(options) {
  const settings = options || {}
  const dir = resolve(String(settings.dir || DEFAULT_LOG_DIR).replace(/^~(?=$|\/)/, homedir()))
  const maxBytes = Number(settings.maxBytes) > 0 ? Number(settings.maxBytes) : DEFAULT_LOG_MAX_BYTES
  const now = typeof settings.now === 'function' ? settings.now : () => new Date()
  const sink = { dir, maxBytes, file: '', size: 0, day: '', disabled: false }

  const rotate = () => {
    if (!sink.file) return
    try {
      // 从最老的开始倒着挪：.2 -> .3，.1 -> .2，当前 -> .1
      for (let index = ROTATE_KEEP - 1; index >= 1; index -= 1) {
        const from = sink.file + '.' + index
        if (existsSync(from)) renameSync(from, sink.file + '.' + (index + 1))
      }
      if (existsSync(sink.file)) renameSync(sink.file, sink.file + '.1')
    } catch {
      // 滚不动就算了：清空计数继续往同一个文件追加，绝不能因为滚动失败把日志停了
    }
    sink.size = 0
  }

  const ensureFile = () => {
    const date = now()
    const day = dayKey(date)
    if (sink.file && sink.day === day) return sink.file
    mkdirSync(dir, { recursive: true })
    sink.day = day
    sink.file = join(dir, 'feishu-' + day + '.log')
    sink.size = existsSync(sink.file) ? statSync(sink.file).size : 0
    return sink.file
  }

  return {
    /** 写一行；返回是否真的落盘（调用方可据此决定要不要告警） */
    write(line) {
      if (sink.disabled) return false
      try {
        const file = ensureFile()
        appendFileSync(file, line + '\n')
        sink.size += Buffer.byteLength(line) + 1
        if (sink.maxBytes > 0 && sink.size >= sink.maxBytes) rotate()
        return true
      } catch (error) {
        // 只停用一次并打到控制台：磁盘满 / 只读时如果每行都重试，会把主流程拖死
        sink.disabled = true
        console.error('feishu: 日志落盘失败，已停用文件日志：' + String(error))
        return false
      }
    },
    get file() {
      return sink.file
    },
    get dir() {
      return dir
    },
  }
}

/**
 * @param {{ logger?: Record<string, Function> }} ctx 宿主上下文
 * @param {boolean | (() => boolean)} debugEnabled 是否输出 debug 级别；传函数可随设置页开关即时变化
 * @param {{ dir?: string, maxBytes?: number, now?: () => Date, file?: boolean }} [options]
 *   文件日志选项；file=false 可关掉落盘（单测用）
 */
export function createLog(ctx, debugEnabled, options) {
  const settings = options || {}
  // 设置页改 debug 开关时不用重建 log 实例，取值时再判断
  const isDebug = () => (typeof debugEnabled === 'function' ? Boolean(debugEnabled()) : Boolean(debugEnabled))
  const sink = settings.file === false ? null : createSink(settings)

  const emit = (level, scope, message, detail) => {
    if (level === 'debug' && !isDebug()) return
    const tag = scope ? '[feishu:' + scope + '] ' : 'feishu: '
    const line = tag + message + render(detail)
    if (sink) sink.write(stamp((typeof settings.now === 'function' ? settings.now() : new Date())) + ' ' + level.toUpperCase().padEnd(5) + ' ' + line)
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') {
      logger[level](line)
      return
    }
    // 宿主没有该级别（或根本没有 logger）时退回控制台，绝不静默吞日志
    const fallback = level === 'debug' ? 'log' : level
    console[fallback](line)
  }

  const build = (scope) => ({
    debug(message, detail) {
      emit('debug', scope, message, detail)
    },
    info(message, detail) {
      emit('info', scope, message, detail)
    },
    warn(message, detail) {
      emit('warn', scope, message, detail)
    },
    error(message, detail) {
      emit('error', scope, message, detail)
    },
    /** 派生一个带来源标记的 logger：多机器人共用一个进程时，日志里必须能分清是谁 */
    scope(key) {
      return build(String(key || '').trim() || scope)
    },
    get file() {
      return sink ? sink.file : ''
    },
  })

  return build('')
}
