/**
 * 关键链路追踪：把「认领 / 帧放行 / 卡片更新」的判定写成 JSONL 落到文件。
 *
 * 为什么要有：飞书的卡片出问题（卡片空白、回复没上去、唤醒轮不出卡）时，宿主日志
 * 只有 stdout，桌面壳只留最近 200 行在内存里，事后拿不到；把这几条判定落盘，
 * 才能回答「这一帧到底是被谁拦下的」。
 *
 * 只在 `debug: true` 时启用（默认关闭，不产生任何 IO）；文件超过 MAX_BYTES 就截断重来。
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 单个追踪文件的大小上限：够排查一次问题，又不会把磁盘写爆 */
const MAX_BYTES = 2 * 1024 * 1024

/** 追踪文件路径（`~/.dsh/feishu/trace.log`，与插件 state.json 同目录） */
export function tracePath() {
  return join(homedir(), '.dsh', 'feishu', 'trace.log')
}

/**
 * 建一个追踪器。关闭时返回空函数，调用点不用做分支。
 *
 * @param {object} options
 * @param {{debug?: boolean}} [options.config]
 * @param {string} [options.file] 覆盖落盘路径（测试用）
 * @returns {(event: string, fields?: object) => void}
 */
export function createTrace(options) {
  const settings = options || {}
  const enabled = Boolean(settings.config && settings.config.debug)
  const file = settings.file || tracePath()
  if (!enabled) return () => {}

  let ready = false
  return (event, fields) => {
    try {
      if (!ready) {
        mkdirSync(join(file, '..'), { recursive: true })
        ready = true
      }
      try {
        if (statSync(file).size > MAX_BYTES) truncateSync(file, 0)
      } catch {
        // 文件还不存在：第一次写就是创建
      }
      appendFileSync(file, JSON.stringify({ at: Date.now(), event, ...(fields || {}) }) + '\n')
    } catch {
      // 追踪失败绝不能影响收发消息
    }
  }
}
