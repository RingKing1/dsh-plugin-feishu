/**
 * 飞书事件 -> 插件内部消息模型（纯函数，无 IO）。
 * 处理单聊/群聊的纯文本（text）与富文本（post）消息；其余类型显式返回 unsupported，由上层给出提示。
 */

const TEXT_TYPE = 'text'
const POST_TYPE = 'post'
const SUPPORTED_TYPES = new Set([TEXT_TYPE, POST_TYPE])

/**
 * 归一化一条 im.message.receive_v1 事件。
 * @param {any} raw WSClient 回调收到的原始事件
 * @param {{ botOpenId?: string, requireMentionInGroup?: boolean }} options
 * @returns {{ kind: 'message', messageId: string, chatId: string, chatType: string, threadId: string, parentId: string, rootId: string, senderOpenId: string, text: string, createdAt: number }
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

  const messageType = String(message.message_type || 'unknown')
  if (!SUPPORTED_TYPES.has(messageType)) {
    return {
      kind: 'ignore',
      reason: 'unsupported-' + messageType,
      chatId: message.chat_id,
      messageType,
    }
  }

  const text = stripMentions(extractText(message), mentions)
  if (!text) {
    // 富文本里可能只放了图片/附件：解析不到文字也要给一次提示，别让用户以为消息丢了
    if (messageType === POST_TYPE) {
      return {
        kind: 'ignore',
        reason: 'unsupported-post-empty',
        chatId: message.chat_id,
        messageType,
      }
    }
    return { kind: 'ignore', reason: 'empty-text', chatId: message.chat_id }
  }

  return {
    kind: 'message',
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType,
    threadId: message.thread_id || message.root_id || '',
    // 引用回复：parent_id 是被引用那条，root_id 是话题根；上层据此决定要不要展开引用
    parentId: message.parent_id || '',
    rootId: message.root_id || '',
    senderOpenId: (sender && sender.sender_id && sender.sender_id.open_id) || '',
    text,
    createdAt: Number(message.create_time) || Date.now(),
  }
}

/**
 * 取出消息正文。
 * - text：content 是 JSON 字符串 {"text":"..."}
 * - post（富文本）：content 是 {title, content:[[{tag,text}...]...]}，逐段拼文字
 * 其它类型一律返回空字符串（由 normalizeEvent 判 unsupported）。
 */
export function extractText(message) {
  if (!message) return ''
  const type = message.message_type
  if (type !== TEXT_TYPE && type !== POST_TYPE) return ''
  const parsed = parseContent(message.content)
  if (!parsed) return ''
  if (type === TEXT_TYPE) return typeof parsed.text === 'string' ? parsed.text : ''
  return flattenPost(parsed)
}

/**
 * 取出「被引用消息」的正文。
 *
 * 与事件里的 message 不同，im/v1/messages/{id} 返回的条目字段是 msg_type + body.content，
 * 两种形态都接住，避免上层为查引用写第二套解析。
 * @param {any} item
 * @returns {{ messageType: string, text: string }}
 */
export function extractItemText(item) {
  if (!item) return { messageType: '', text: '' }
  const messageType = String(item.msg_type || item.message_type || '')
  if (messageType !== TEXT_TYPE && messageType !== POST_TYPE) return { messageType, text: '' }
  const raw = item.body && item.body.content !== undefined ? item.body.content : item.content
  const parsed = parseContent(raw)
  if (!parsed) return { messageType, text: '' }
  if (messageType === TEXT_TYPE) {
    return { messageType, text: typeof parsed.text === 'string' ? parsed.text : '' }
  }
  return { messageType, text: flattenPost(parsed) }
}

/**
 * 富文本转纯文本：段落之间换行，段落内各片段直接拼接（片段是同一句话被切开的部分）。
 * 飞书的 at 节点只用于点名/唤醒，不进正文，与 text 消息去掉 @_user_N 占位符的行为保持一致。
 */
export function flattenPost(post) {
  if (!post || typeof post !== 'object') return ''
  // 有些版本把真正的正文套在 post 字段里（json.post），两处都认
  const container = post.post && typeof post.post === 'object' ? post.post : post
  const localized = pickLocalized(container)
  const title = typeof localized.title === 'string' ? localized.title.trim() : ''
  let body = paragraphsToText(localized.content)
  // content_v2 是飞书后来补的扁平结构，content 解析不出文字时兜底
  if (!body) body = paragraphsToText(localized.content_v2)
  if (title && body) return title + '\n' + body
  return title || body
}

/**
 * 富文本按语言分包：优先 zh_cn，其次 en_us，最后取第一个含 content 数组的包。
 * 直接读顶层 content 在部分事件里会拿到空数组。
 */
function pickLocalized(post) {
  if (Array.isArray(post.content)) return post
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    const pack = post[locale]
    if (pack && typeof pack === 'object' && (Array.isArray(pack.content) || Array.isArray(pack.content_v2))) return pack
  }
  for (const value of Object.values(post)) {
    if (value && typeof value === 'object' && Array.isArray(value.content)) return value
  }
  return post
}

function parseContent(content) {
  if (typeof content !== 'string' || !content) return null
  try {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function paragraphsToText(paragraphs) {
  if (!Array.isArray(paragraphs)) return ''
  const lines = []
  for (const paragraph of paragraphs) {
    const runs = []
    collectText(paragraph, runs)
    // 只压掉段落内的横向空白，段落本身的换行留到最后统一拼接
    const line = runs.join('').replace(/[ \t\u3000]+/g, ' ').trim()
    if (!line) continue
    // 列表项（li）会在同一段落内塞入换行：按行拆开，避免条目之间出现空行
    for (const piece of line.split('\n')) {
      const trimmed = piece.trim()
      if (trimmed) lines.push(trimmed)
    }
  }
  return lines.join('\n')
}

/** 深度遍历富文本节点，把可读文字收进 out。 */
function collectText(node, out) {
  if (node === null || node === undefined) return
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return
  }
  if (typeof node !== 'object') return
  const tag = typeof node.tag === 'string' ? node.tag : ''
  if (tag === 'at') {
    out.push(' ')
    return
  }
  if (tag === 'img' || tag === 'media' || tag === 'emotion' || tag === 'hr') return
  // 有序 / 无序列表：每项单独一行，否则 1. 2. 会被压成一句话
  if (tag === 'li') {
    const inner = []
    collectText(node.content || node.elements, inner)
    const line = inner.join('').replace(/[ \t\u3000]+/g, ' ').trim()
    if (line) out.push('\n' + line + '\n')
    return
  }
  if (typeof node.text === 'string') {
    out.push(node.text)
    return
  }
  if (Array.isArray(node.content)) collectText(node.content, out)
  else if (Array.isArray(node.elements)) collectText(node.elements, out)
}

/**
 * 去掉 @ 占位符（@_user_1 之类）。
 *
 * 必须保留换行：用户按 1. / 2. 分行写的内容，飞书客户端可能存成富文本列表，
 * 如果这里把空白全压成一个空格，多行需求会变成一大段，模型读不出条目边界。
 * 只压掉每行内的横向空白与多余空行。
 */
export function stripMentions(text, mentions) {
  let output = typeof text === 'string' ? text : ''
  for (const mention of mentions || []) {
    if (!mention || !mention.key) continue
    output = output.split(mention.key).join(' ')
  }
  return output
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 会话键：同一 chat 的不同话题（thread）算不同会话。 */
export function conversationKey(message) {
  return message.threadId ? message.chatId + ':' + message.threadId : message.chatId
}
