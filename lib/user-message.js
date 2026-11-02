import { randomUUID } from 'node:crypto'
import { formatSourceLine } from './identity.js'

/**
 * 深冻结：已发布的消息不允许被下游改写。
 * 与 dsh 内部 createUserMessage 的语义一致（结构化克隆 + 冻结）。
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const entry of Object.values(value)) deepFreeze(entry)
  return value
}

/**
 * 构造一条 user 角色的消息。
 *
 * 为什么不用 @deepseek-ai/dsh-llm 的 createUserMessage：
 * 第三方插件装进 profile 后，宿主的内部包不一定能被解析到；
 * 而该函数本身只是补上 id/role 并冻结，形如 { id, role, content, source }，
 * 这里复刻同一形状即可，避免给插件引入宿主内部依赖。
 *
 * 来源信息放在正文第一行（而不是丢进 source 自定义字段）：
 * 模型对「消息第一行」的读取是确定的，会话日志里也能直接看到；
 * 没有 meta 时正文保持原样，兼容旧调用与单测。
 *
 * @param {string} text 用户原文
 * @param {{ chatType?: string, openId?: string, chatId?: string, threadId?: string, senderName?: string }} [meta]
 */
export function createUserMessage(text, meta) {
  const body = String(text)
  const sourceLine = formatSourceLine(meta)
  const content = sourceLine ? sourceLine + '\n' + body : body
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: content }],
    // source 仍是 dsh 已声明的用户消息来源，Web UI 与会话日志都能正常渲染；
    // 飞书的 chat_id / open_id 由首行标记与插件状态承载，不塞进这里。
    source: { kind: 'user' },
  })
}
