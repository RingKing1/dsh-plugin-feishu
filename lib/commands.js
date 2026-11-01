/**
 * 斜杠命令解析与执行（/help /new /stop /status /cwd /whoami）。
 * 命令只在插件内部处理，不会进入 agent，避免污染会话上下文。
 */

/** @returns {{ name: string, args: string } | undefined} */
export function parseCommand(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('/')) return undefined
  const parts = trimmed.split(/\s+/)
  const head = parts[0].slice(1)
  if (!head) return undefined
  return { name: head.toLowerCase(), args: parts.slice(1).join(' ').trim() }
}

export const HELP_TEXT = [
  '我可以把消息转发给 DeepSeek Harness 会话，并把回复流式写回这张卡片。',
  '',
  '/new            开启新会话（当前会话的上下文不再续接）',
  '/stop           中断当前这一轮',
  '/status        查看会话 ID、工作目录、模型与运行状态',
  '/cwd <目录>     设置本会话的工作目录（下一次 /new 或新建会话时生效）',
  '/whoami        查看你的 open_id / chat_id（配置白名单时用得上）',
  '/help           查看本说明',
  '',
  '直接发消息就是提问；群聊里需要 @ 我。',
].join('\n')

/**
 * @param {object} host 桥接对象（bridge 实现这些方法）
 * @param {object} message 归一化后的飞书消息
 * @param {string} key 会话键
 * @param {{ name: string, args: string }} command
 * @returns {Promise<{ reply?: string } | undefined>}
 */
export async function executeCommand(host, message, key, command) {
  switch (command.name) {
    case 'help':
    case '?':
      return { reply: HELP_TEXT }

    case 'new':
      await host.newSession(key)
      return { reply: '已开启新会话。下一条消息会在新的上下文里执行。' }

    case 'stop': {
      const stopped = await host.stopTurn(key)
      return { reply: stopped ? '已请求中断当前这一轮。' : '当前没有正在运行的轮次。' }
    }

    case 'status': {
      const status = host.describeStatus(key)
      return {
        reply: [
          '会话：' + (status.sessionId || '（还没有，下一条消息会新建）'),
          '工作目录：' + status.cwd,
          '状态：' + status.status,
          '模型：' + status.model,
        ].join('\n'),
      }
    }

    case 'cwd': {
      const changed = await host.setWorkdir(key, command.args)
      return { reply: changed }
    }

    case 'whoami':
      return {
        reply: [
          'open_id：' + (message.senderOpenId || '（未知）'),
          'chat_id：' + message.chatId,
          'chat_type：' + message.chatType,
        ].join('\n'),
      }

    default:
      return { reply: '未知命令：/' + command.name + '\n\n' + HELP_TEXT }
  }
}
