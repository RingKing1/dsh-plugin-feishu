/**
 * 统一日志：所有行都带 feishu: 前缀，方便在 dsh 日志里检索。
 * 第二个参数是结构化细节，序列化后追加到同一行（失败时降级为 String）。
 */

function render(detail) {
  if (detail === undefined) return ''
  try {
    return ' ' + JSON.stringify(detail)
  } catch {
    return ' ' + String(detail)
  }
}

/**
 * @param {{ logger?: Record<string, Function> }} ctx 宿主上下文
 * @param {boolean} debugEnabled 是否输出 debug 级别
 */
export function createLog(ctx, debugEnabled) {
  const write = (level, message, detail) => {
    const line = 'feishu: ' + message + render(detail)
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') {
      logger[level](line)
      return
    }
    // 宿主没有该级别（或根本没有 logger）时退回控制台，绝不静默吞日志
    const fallback = level === 'debug' ? 'log' : level
    console[fallback](line)
  }

  return {
    debug(message, detail) {
      if (debugEnabled) write('debug', message, detail)
    },
    info(message, detail) {
      write('info', message, detail)
    },
    warn(message, detail) {
      write('warn', message, detail)
    },
    error(message, detail) {
      write('error', message, detail)
    },
  }
}
