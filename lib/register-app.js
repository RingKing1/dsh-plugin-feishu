/**
 * 扫码创建飞书应用（OAuth 2.0 Device Authorization Grant / RFC 8628）。
 *
 * 飞书 Node SDK 从 1.61.1 起提供 `registerApp`：调用后返回一个验证链接，
 * 用户在飞书 / Lark 里扫码确认，SDK 轮询到结果并给出新应用的 App ID 与 App Secret。
 * 这里把它包成一个可查询状态的会话对象，供浏览器半侧轮询：
 *
 *   idle → starting → pending(有二维码 URL) → success(拿到凭证)
 *                                   ↘ expired / error / 取消
 *
 * 这些凭证只交给同源、已登录的浏览器（走 /api/feishu.register，和宿主同一个鉴权），
 * 由浏览器调用 configForms.mutate 写进 profile，插件随后照常热重建连接 —— 不在这里
 * 直接改配置文件，保持「配置的唯一写入方是 ConfigEditor」这条约束。
 */
import * as lark from '@larksuiteoapi/node-sdk'
import QRCode from 'qrcode'

/**
 * 创建应用时预填到确认页的增量配置（平台默认模板之上叠加）：
 * 机器人收发消息所需的最小集合。用户在确认页还能自己加减。
 */
export const APP_ADDONS = {
  scopes: {
    tenant: [
      'im:message:send_as_bot',
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      'cardkit:card:write',
      // 注册输入框「/」面板里的指令（lib/slash-commands.js）；缺这条权限同步会静默降级
      'application:app_slash_command:write',
    ],
  },
  events: {
    items: { tenant: ['im.message.receive_v1'] },
  },
}

/** 应用名称/描述预填；用户扫码后可以改 */
export const APP_PRESET = {
  name: '{user} 的 dsh',
  desc: 'DeepSeek Harness 飞书桥接：在飞书里直接和 dsh 对话',
}

/** 成功后凭证可被读取的时长：留出浏览器刷新/重试的余地，过期就不再返回 */
const CREDENTIAL_TTL_MS = 120_000

/**
 * 一次扫码创建会话。同一时刻只允许一个（用户连点两次不会开两个轮询）。
 */
export class AppRegistration {
  /**
   * @param {object} [options]
   * @param {(options: object) => Promise<{ client_id: string, client_secret: string }>} [options.registerApp]
   * @param {(url: string) => Promise<string>} [options.renderQr] 返回可直接放进 <img src> 的 data URL
   * @param {() => number} [options.now]
   * @param {{ info: Function, warn: Function }} [options.log]
   */
  constructor(options = {}) {
    this.registerApp = options.registerApp ?? lark.registerApp
    this.renderQr = options.renderQr ?? defaultRenderQr
    this.now = options.now ?? Date.now
    this.log = options.log ?? { info: () => {}, warn: () => {} }

    /** @type {'idle'|'starting'|'pending'|'success'|'error'|'expired'} */
    this.phase = 'idle'
    /** @type {string|undefined} 验证链接（可点开，也可渲染成二维码） */
    this.url = undefined
    /** @type {string|undefined} 二维码 data URL */
    this.qr = undefined
    /** @type {number|undefined} 链接过期时刻（毫秒） */
    this.expiresAt = undefined
    /** @type {{ code?: string, message?: string }|undefined} */
    this.failure = undefined
    /** @type {{ appId: string, appSecret: string, expiresAt: number }|undefined} */
    this.credentials = undefined
    this.controller = undefined
  }

  /** 供 HTTP 路由返回的只读快照 */
  snapshot() {
    this.expireIfNeeded()
    const credentials = this.credentials !== undefined && this.credentials.expiresAt > this.now()
      ? { appId: this.credentials.appId, appSecret: this.credentials.appSecret }
      : undefined
    return {
      state: this.phase,
      url: this.url,
      qr: this.qr,
      expireIn: this.expiresAt === undefined ? undefined : Math.max(0, Math.round((this.expiresAt - this.now()) / 1000)),
      expiresAt: this.expiresAt,
      error: this.failure,
      credentials,
    }
  }

  /** 链接过期：还没扫就作废，并把轮询停掉 */
  expireIfNeeded() {
    if (this.phase === 'pending' && this.expiresAt !== undefined && this.expiresAt <= this.now()) {
      this.cancel()
      this.phase = 'expired'
      this.failure = { code: 'expired_token', message: '二维码已过期，请重新生成' }
    }
  }

  /** 开始一次新的扫码会话；已在进行中时直接返回当前快照 */
  async start() {
    if (this.phase === 'starting' || this.phase === 'pending') return this.snapshot()
    this.reset()

    const controller = new AbortController()
    this.controller = controller
    this.phase = 'starting'

    this.task = Promise.resolve()
      .then(() => this.registerApp({
        addons: APP_ADDONS,
        appPreset: APP_PRESET,
        createOnly: true,
        signal: controller.signal,
        onQRCodeReady: (info) => {
          if (controller.signal.aborted) return
          this.phase = 'pending'
          this.url = info.url
          this.expiresAt = this.now() + Math.max(0, Number(info.expireIn) || 0) * 1000
          this.log.info('扫码创建应用：二维码已就绪', { expireIn: info.expireIn })
          void this.renderQr(info.url)
            .then((dataUrl) => { if (!controller.signal.aborted) this.qr = dataUrl })
            .catch((error) => this.log.warn('二维码渲染失败，只提供链接', { error: String(error) }))
        },
        onStatusChange: (info) => {
          if (info && info.status === 'slow_down') this.log.info('扫码轮询被要求降速')
        },
      }))
      .then((result) => {
        if (controller.signal.aborted) return
        this.phase = 'success'
        this.url = undefined
        this.qr = undefined
        this.expiresAt = undefined
        this.credentials = {
          appId: String(result.client_id ?? ''),
          appSecret: String(result.client_secret ?? ''),
          expiresAt: this.now() + CREDENTIAL_TTL_MS,
        }
        this.log.info('扫码创建应用：已拿到凭证', { appId: this.credentials.appId })
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        const code = error && typeof error.code === 'string' ? error.code : undefined
        this.phase = code === 'expired_token' ? 'expired' : 'error'
        this.failure = {
          code,
          message: (error && (error.description || error.message)) ? String(error.description || error.message) : String(error),
        }
        this.url = undefined
        this.qr = undefined
        this.log.warn('扫码创建应用失败', this.failure)
      })

    // starting 阶段先返回，二维码就绪后由浏览器轮询拿到
    return this.snapshot()
  }

  /** 用户取消 / 插件卸载：停轮询，回到 idle */
  cancel() {
    const controller = this.controller
    this.controller = undefined
    if (controller !== undefined && !controller.signal.aborted) controller.abort()
    this.phase = this.phase === 'success' ? 'success' : 'idle'
    this.url = undefined
    this.qr = undefined
    this.expiresAt = undefined
  }

  /** 清空全部状态（新会话开始前调用） */
  reset() {
    this.cancel()
    this.phase = 'idle'
    this.failure = undefined
    this.credentials = undefined
  }
}

/**
 * 在宿主 webServer 上挂 /api/feishu.register：
 *   GET    → 当前快照（轮询用）
 *   POST   → 开始一次扫码创建
 *   DELETE → 取消
 *
 * 路径以 /api 开头，走的是宿主统一的登录鉴权：只有同源、已登录的浏览器能拿到凭证。
 *
 * @param {object} webServer 宿主 webServer 服务（register(route) → disposer）
 * @param {AppRegistration} registration
 * @param {string} [path]
 * @returns {() => void} 注销路由
 */
export function registerRoute(webServer, registration, path = '/api/feishu.register') {
  const reply = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  return webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      try {
        if (req.method === 'POST') {
          await registration.start()
          reply(res, 200, registration.snapshot())
          return
        }
        if (req.method === 'DELETE') {
          registration.cancel()
          reply(res, 200, registration.snapshot())
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          reply(res, 200, registration.snapshot())
          return
        }
        reply(res, 405, { error: 'method not allowed' })
      } catch (error) {
        reply(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    },
  })
}

/** 把验证链接渲染成 SVG data URL：浏览器侧直接 <img src>，不依赖外网二维码服务 */
export function defaultRenderQr(url) {
  return QRCode.toString(url, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' })
    .then((svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))
}
