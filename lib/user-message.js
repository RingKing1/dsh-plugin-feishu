import { randomUUID } from 'node:crypto'

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
 * source 用 { kind: 'user' }：这是 dsh 已声明的用户消息来源，
 * 会话日志与 Web UI 都能正常渲染；飞书的 chat_id / message_id 记录在插件自己的状态里。
 */
export function createUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  })
}
