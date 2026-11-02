/**
 * 飞书身份 -> 会话里可见的来源标记（纯函数，无 IO，便于单测）。
 *
 * 为什么把身份渲染成消息的第一行，而不是只塞进 source 元数据：
 * 1. 模型每次都会读消息正文，但对 source 里的自定义字段没有稳定保证；
 * 2. 会话日志（session.v4.jsonl.zstd）里能一眼重建「这条消息来自飞书、来自谁」。
 * 完整 open_id 不放进每一条消息（太长、噪音大），需要精确值时走 feishu_identity 工具。
 */

/**
 * 会话类型的中文说法。
 * 飞书只有 p2p / group 两种；未知值原样返回，避免把新类型误报成单聊。
 * @param {string} [chatType]
 * @returns {string}
 */
export function chatTypeName(chatType) {
  if (chatType === 'p2p') return '单聊'
  if (chatType === 'group') return '群聊'
  return String(chatType || '未知')
}

/**
 * open_id 形如 ou_ + 32 位，前缀里只留尾部 8 位用于人眼比对。
 * @param {string} [openId]
 * @returns {string}
 */
export function senderTail(openId) {
  const value = String(openId || '')
  return value.length > 8 ? value.slice(-8) : value
}

/**
 * 生成消息首行的来源标记，例如 `【飞书 · 群聊 · 张三(1a2b3c4d)】`。
 *
 * 没有元数据时返回空串（旧消息、单测里直接调 createUserMessage(text) 的场景），
 * 调用方据此保持消息原样，不会凭空多出一个空标题行。
 *
 * @param {{ chatType?: string, openId?: string, senderName?: string }|undefined} meta
 * @returns {string}
 */
export function formatSourceLine(meta) {
  if (!meta) return ''
  const tail = senderTail(meta.openId)
  const name = typeof meta.senderName === 'string' ? meta.senderName.trim() : ''
  const parts = ['飞书', chatTypeName(meta.chatType)]
  if (tail) parts.push(name ? name + '(' + tail + ')' : tail)
  return '【' + parts.join(' · ') + '】'
}
