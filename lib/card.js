/**
 * 飞书 CardKit（schema 2.0）卡片 JSON 构造 —— 纯函数，无 IO，便于单测。
 * 流式输出靠 element_id = content 的 markdown 元件做局部更新。
 */

/** 正文元件 id：CardKit 只支持按 element_id 更新，改名必须同步改更新路径 */
export const CONTENT_ELEMENT_ID = 'content'

/** 终态样式：running 是流式中的中间态，其余为终态 */
const STATUS_HEADER = {
  running: { template: 'blue', title: '回复中' },
  done: { template: 'green', title: '回复' },
  failed: { template: 'red', title: '出错了' },
  stopped: { template: 'grey', title: '已停止' },
}

export const TRUNCATED_MARK = '\n\n…（内容过长，已截断）'

/**
 * 构造一张卡片。
 * @param {object} input
 * @param {'running'|'done'|'failed'|'stopped'} [input.status]
 * @param {string} [input.title] 卡片标题，默认取状态标题
 * @param {string} [input.body] 正文 markdown
 * @param {boolean} [input.streaming] 是否开启流式模式（只有 running 才有效）
 */
export function buildCard(input) {
  const options = input || {}
  const status = STATUS_HEADER[options.status] ? options.status : 'running'
  const header = STATUS_HEADER[status]
  const body = typeof options.body === 'string' && options.body.trim() ? options.body : ' '
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

  return {
    schema: '2.0',
    config,
    header: {
      template: header.template,
      title: { tag: 'plain_text', content: options.title || header.title },
    },
    body: {
      elements: [
        { tag: 'markdown', content: body, element_id: CONTENT_ELEMENT_ID },
      ],
    },
  }
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
