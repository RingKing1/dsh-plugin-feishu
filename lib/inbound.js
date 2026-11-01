/**
 * 飞书事件 -> 插件内部消息模型（纯函数，无 IO）。
 * 只处理单聊/群聊文本消息；其余类型显式返回 unsupported，由上层给出提示。
 */

const TEXT_TYPE = 'text'

/**
 * 归一化一条 im.message.receive_v1 事件。
 * @param {any} raw WSClient 回调收到的原始事件
 * @param {{ botOpenId?: string, requireMentionInGroup?: boolean }} options
 * @returns {{ kind: 'message', messageId: string, chatId: string, chatType: string, threadId: string, senderOpenId: string, text: string, createdAt: number }
 *   | { kind: 'ignore', reason: string, chatId?: string, messageType?: string }}
 */
export function normalizeEvent(raw, options) {
  const settings = options || {}
  const event = raw && raw.event ? raw.event : raw
  const message = event && event.message
  const sender = event && event.sender

  if (!message || !message.message_id || !message.chat_id) {
    return { kind: 'ignore', reason: 'no-message' }
  }

  // 机器人自己发的消息（sender_type = app）必须忽略，否则会自问自答死循环
  if (sender && sender.sender_type && sender.sender_type !== 'user') {
    return { kind: 'ignore', reason: 'sender-' + sender.sender_type, chatId: message.chat_id }
  }

  const chatType = message.chat_type || 'p2p'
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const mentionedBot = Boolean(settings.botOpenId)
    && mentions.some((mention) => mention && mention.id && mention.id.open_id === settings.botOpenId)

  if (chatType === 'group' && settings.requireMentionInGroup && !mentionedBot) {
    return { kind: 'ignore', reason: 'no-mention', chatId: message.chat_id }
  }

  if (message.message_type !== TEXT_TYPE) {
    return {
      kind: 'ignore',
      reason: 'unsupported-' + String(message.message_type || 'unknown'),
      chatId: message.chat_id,
      messageType: message.message_type,
    }
  }

  const text = stripMentions(extractText(message), mentions)
  if (!text) return { kind: 'ignore', reason: 'empty-text', chatId: message.chat_id }

  return {
    kind: 'message',
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType,
    threadId: message.thread_id || message.root_id || '',
    senderOpenId: (sender && sender.sender_id && sender.sender_id.open_id) || '',
    text,
    createdAt: Number(message.create_time) || Date.now(),
  }
}

/** 文本消息的 content 是 JSON 字符串：{"text":"..."} */
export function extractText(message) {
  if (!message || message.message_type !== TEXT_TYPE) return ''
  try {
    const parsed = JSON.parse(message.content || '{}')
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

/**
 * 去掉 @ 占位符（@_user_1 之类），并压缩空白。
 * 群聊里 @ 机器人 的正文才是真正的指令。
 */
export function stripMentions(text, mentions) {
  let output = typeof text === 'string' ? text : ''
  for (const mention of mentions || []) {
    if (!mention || !mention.key) continue
    output = output.split(mention.key).join(' ')
  }
  return output.replace(/\s+/g, ' ').trim()
}

/** 会话键：同一 chat 的不同话题（thread）算不同会话。 */
export function conversationKey(message) {
  return message.threadId ? message.chatId + ':' + message.threadId : message.chatId
}
