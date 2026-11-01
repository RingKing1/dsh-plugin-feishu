import { setTimeout as delay } from 'node:timers/promises'

/** 飞书开放平台返回的业务错误（HTTP 200 也可能是错误，看 body.code）。 */
export class FeishuApiError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'FeishuApiError'
    const info = detail || {}
    this.code = info.code
    this.status = info.status
    this.path = info.path
  }
}

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
/** 触发该错误码说明 token 失效，清缓存重取一次即可 */
const TOKEN_INVALID_CODE = 99991663
const MAX_ATTEMPTS = 3

/**
 * 飞书 REST API 的最小封装：只包含本插件用到的能力。
 * 全部走 fetch，不依赖 SDK 的 Client，便于单测注入 fetchImpl。
 */
export class FeishuApi {
  constructor(options) {
    const settings = options || {}
    this.appId = settings.appId
    this.appSecret = settings.appSecret
    this.domain = settings.domain || 'https://open.feishu.cn'
    this.log = settings.log
    this.fetch = settings.fetchImpl || globalThis.fetch
    this.tokenValue = ''
    this.tokenExpiresAt = 0
  }

  /** 获取（并缓存）tenant_access_token；提前 60 秒过期，避免边界上用到失效 token。 */
  async token(force) {
    if (!force && this.tokenValue && Date.now() < this.tokenExpiresAt) return this.tokenValue
    const payload = await this.request('POST', TOKEN_PATH, {
      app_id: this.appId,
      app_secret: this.appSecret,
    })
    if (!payload.tenant_access_token) {
      throw new FeishuApiError('获取 tenant_access_token 失败：响应缺少 tenant_access_token', { code: payload.code })
    }
    this.tokenValue = payload.tenant_access_token
    const expireSeconds = Number(payload.expire) || 7200
    this.tokenExpiresAt = Date.now() + Math.max(60, expireSeconds - 60) * 1000
    return this.tokenValue
  }

  /** 机器人自身信息，主要为了拿 open_id 判断群里是否 @ 了自己。 */
  async botInfo() {
    const payload = await this.request('GET', '/open-apis/bot/v3/info')
    return payload.bot || {}
  }

  /** 创建一张 CardKit 卡片实体，返回 card_id。 */
  async createCard(card) {
    const payload = await this.request('POST', '/open-apis/cardkit/v1/cards', {
      type: 'card_json',
      data: JSON.stringify(card),
    })
    const cardId = payload.data && payload.data.card_id
    if (!cardId) throw new FeishuApiError('创建卡片失败：响应缺少 card_id', { code: payload.code })
    return cardId
  }

  /** 把卡片实体作为一条消息发到会话里，返回 message_id。 */
  async sendCard(chatId, cardId) {
    const payload = await this.request('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    })
    return (payload.data && payload.data.message_id) || ''
  }

  /** 流式更新正文元件（element_id = content）。sequence 必须单调递增。 */
  async putCardContent(cardId, content, sequence) {
    const path = '/open-apis/cardkit/v1/cards/' + cardId + '/elements/content/content'
    await this.request('PUT', path, {
      content,
      sequence,
      uuid: 'c_' + cardId + '_' + sequence,
    })
  }

  /** 关闭流式模式并写入摘要（卡片列表里显示的一行）。 */
  async closeStreaming(cardId, sequence, summary) {
    const path = '/open-apis/cardkit/v1/cards/' + cardId + '/settings'
    await this.request('PATCH', path, {
      settings: JSON.stringify({
        config: {
          streaming_mode: false,
          summary: { content: summary },
        },
      }),
      sequence,
      uuid: 's_' + cardId + '_' + sequence,
    })
  }

  /** 全量更新整张卡片（终态：改 header 颜色 + 正文 + 备注）。 */
  async updateCard(cardId, card, sequence) {
    const path = '/open-apis/cardkit/v1/cards/' + cardId
    await this.request('PUT', path, {
      card: { type: 'card_json', data: JSON.stringify(card) },
      sequence,
      uuid: 'u_' + cardId + '_' + sequence,
    })
  }

  /** 发送纯文本消息（命令回复、错误提示、卡片不可用时的兜底）。 */
  async sendText(chatId, text) {
    const payload = await this.request('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    })
    return (payload.data && payload.data.message_id) || ''
  }

  /**
   * 统一请求入口：自动带 token、JSON 解析、错误归一化、5xx/网络错误重试。
   * 注意：飞书业务错误（code != 0）不重试 —— 重试也不会变好，只浪费配额。
   */
  async request(method, path, body, attempt) {
    const round = attempt || 0
    const headers = { 'Content-Type': 'application/json; charset=utf-8' }
    if (path !== TOKEN_PATH) {
      headers.Authorization = 'Bearer ' + (await this.token())
    }

    let response
    try {
      response = await this.fetch(this.domain + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      if (round + 1 < MAX_ATTEMPTS) {
        await delay(300 * (round + 1))
        return this.request(method, path, body, round + 1)
      }
      throw new FeishuApiError('网络请求失败：' + describeError(error), { path })
    }

    const text = await response.text()
    let payload = {}
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { raw: text.slice(0, 200) }
    }

    if (response.status >= 500 && round + 1 < MAX_ATTEMPTS) {
      await delay(300 * (round + 1))
      return this.request(method, path, body, round + 1)
    }

    if (payload.code === TOKEN_INVALID_CODE && round + 1 < MAX_ATTEMPTS) {
      this.log.debug('tenant_access_token 失效，清缓存重试', { path })
      this.tokenValue = ''
      this.tokenExpiresAt = 0
      return this.request(method, path, body, round + 1)
    }

    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
      throw new FeishuApiError(payload.msg || 'HTTP ' + response.status, {
        code: payload.code,
        status: response.status,
        path,
      })
    }

    return payload
  }
}

function describeError(error) {
  if (!error) return 'unknown'
  if (error.message) return error.message
  return String(error)
}
