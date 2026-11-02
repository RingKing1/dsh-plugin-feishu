/**
 * 飞书工具：只有「由本插件驱动的会话」才看得见。
 *
 * 三个前提，缺一个都不要把工具挂上去：
 * 1. 用 `register(definition, { when })` 按模型步求值 —— false 时工具对这一步不可见
 *    （不进工具描述、不进 PTC 绑定、不可执行），Web 直开的会话不会看到它；
 * 2. 执行时再核一次来源 —— when 只保证「会话是飞书的」，不保证「这一轮是飞书发起的」；
 * 3. 工具只做「读身份、发消息」，不在这里改会话内容，避免和回复卡片打架。
 */

/** @type {((definition: object) => object)|undefined} */
let defineTool
try {
  // 宿主 package 在 profile 里可解析；解析不到就退化成「不注册工具」，不影响桥接本身
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch (error) {
  defineTool = undefined
}

const NOT_FEISHU = '当前会话不是由飞书驱动的，这个工具不可用'

/**
 * 构造两个工具定义（纯构造函数，便于单测直接检查 schema）。
 * defineTool 允许注入：单测不依赖宿主包的解析结果，避免「解析不到 -> 零工具」把测试也带绿。
 *
 * @param {{ registry: { ownerOf: (agent: any) => any }, defineTool?: Function }} options
 * @returns {object[]}
 */
export function buildFeishuTools(options) {
  const registry = options && options.registry
  const define = (options && options.defineTool) || defineTool
  if (typeof define !== 'function' || !registry) return []
  return [identityTool(registry, define), sendTool(registry, define)]
}

/** 宿主包是否可用（诊断用：插件页/日志里能看出工具面为什么没挂上） */
export function hasDefineTool() {
  return typeof defineTool === 'function'
}

/**
 * 把飞书工具注册到宿主。
 * @param {{ ctx: any, registry: object, log: object, defineTool?: Function }} options
 * @returns {number} 实际注册的工具数量
 */
export function registerFeishuTools(options) {
  const { ctx, registry, log } = options || {}
  const define = (options && options.defineTool) || defineTool
  if (typeof define !== 'function') {
    log?.warn?.('宿主未提供 @deepseek-ai/dsh-tools，飞书工具未注册')
    return 0
  }
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    log?.warn?.('宿主未提供 tools 服务，飞书工具未注册')
    return 0
  }

  const definitions = buildFeishuTools({ registry, log, defineTool: define })
  const when = (context) => registry.owns(context && context.agent)
  let registered = 0
  for (const definition of definitions) {
    // 单个工具注册失败不能拖垮整个插件：桥接、身份、选择题都还在跑，工具面少一个就少一个
    try {
      ctx.tools.register(definition, { when })
      registered += 1
    } catch (error) {
      log?.warn?.('注册飞书工具失败', {
        tool: definition.name,
        error: String((error && error.message) || error),
      })
    }
  }
  log?.info?.('飞书工具已注册', { tools: registered })
  return registered
}

function identityTool(registry, define) {
  return define({
    name: 'feishu_identity',
    description:
      '查询当前对话绑定的飞书身份：单聊还是群聊、对方 open_id、插件内的会话键与会话 ID。'
      + '只在本会话由飞书驱动时可用；提问人的姓名取决于插件配置是否开启姓名解析。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true, description: '是否查到身份' },
          reason: { type: 'string', description: '不可用的原因（ok=false 时）' },
          chatId: { type: 'string', description: '飞书会话（chat）ID' },
          chatType: { type: 'string', description: 'p2p 单聊 / group 群聊' },
          openId: { type: 'string', description: '最近一条消息的发送人 open_id' },
          senderName: { type: 'string', description: '发送人姓名；未开启解析时为空' },
          chatKey: { type: 'string', description: '插件内部的会话键（群话题会带 topic 后缀）' },
          sessionId: { type: 'string', description: 'dsh 会话 ID' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderIdentity(value) }],
    },
    async execute(args, exec) {
      const owner = registry.ownerOf(exec && exec.agent)
      if (!owner) return { ok: false, reason: 'not-feishu-session' }
      const turn = owner.turn || {}
      return {
        ok: true,
        chatId: String(turn.chatId || ''),
        chatType: String(turn.chatType || ''),
        openId: String(turn.openId || ''),
        senderName: String(turn.senderName || ''),
        chatKey: String(owner.key || ''),
        sessionId: String(turn.sessionId || ''),
      }
    },
  })
}

function sendTool(registry, define) {
  return define({
    name: 'feishu_send',
    description:
      '往当前飞书会话里单独发一条文本消息（不会另开回复卡片）。'
      + '适合把结论、链接、提醒单独推给对方；正常回答直接写在正文里即可，不需要调用它。',
    parameters: {
      text: { type: 'string', required: true, description: '要发送的纯文本（飞书 text 消息）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true, description: '是否发送成功' },
          messageId: { type: 'string', description: '发送成功后的 message_id' },
          reason: { type: 'string', description: '失败原因（ok=false 时）' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [
        { type: 'text', text: value.ok ? '已发送到飞书（message_id ' + value.messageId + '）' : '未发送：' + value.reason },
      ],
    },
    async execute(args, exec) {
      const owner = registry.ownerOf(exec && exec.agent)
      if (!owner) return { ok: false, reason: 'not-feishu-session' }
      const text = String((args && args.text) || '').trim()
      if (!text) return { ok: false, reason: '文本为空' }
      const chatId = String((owner.turn && owner.turn.chatId) || '')
      if (!chatId) return { ok: false, reason: '找不到这个会话对应的飞书 chat' }
      try {
        const messageId = await owner.bridge.api.sendText(chatId, text)
        return { ok: true, messageId: String(messageId || '') }
      } catch (error) {
        return { ok: false, reason: describeError(error) }
      }
    },
  })
}

function renderIdentity(value) {
  if (!value || value.ok !== true) return NOT_FEISHU
  const kind = value.chatType === 'group' ? '群聊' : '单聊'
  const who = value.senderName ? value.senderName + '（' + value.openId + '）' : value.openId
  return '飞书' + kind + '：' + who + '\n会话键 ' + value.chatKey + '，dsh 会话 ' + value.sessionId
}

function describeError(error) {
  if (!error) return '未知错误'
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error.message || error)
}
