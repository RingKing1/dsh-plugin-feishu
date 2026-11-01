import test from 'node:test'
import assert from 'node:assert/strict'
import { AppRegistration, defaultRenderQr, registerRoute } from '../lib/register-app.js'

/** 造一个可控的 registerApp：先回调二维码，再按脚本成功/失败 */
function fakeRegisterApp(script) {
  const calls = []
  const fn = async (options) => {
    calls.push(options)
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device?user_code=ABCD', expireIn: 600 })
    return script(options)
  }
  fn.calls = calls
  return fn
}

const okScript = async () => ({ client_id: 'cli_created', client_secret: 'secret_created' })

test('扫码创建：二维码就绪后进入 pending，成功后给出凭证', async () => {
  const registerApp = fakeRegisterApp(okScript)
  const registration = new AppRegistration({ registerApp, renderQr: async () => 'data:image/svg+xml,qr' })

  const started = await registration.start()
  assert.equal(started.state, 'starting')

  await new Promise((resolve) => setTimeout(resolve, 20))
  const done = registration.snapshot()
  assert.equal(done.state, 'success')
  assert.equal(done.url, undefined)
  assert.equal(done.qr, undefined)
  assert.deepEqual(done.credentials, { appId: 'cli_created', appSecret: 'secret_created' })

  // 确认页预填的增量配置：收发消息 + 卡片更新，且只允许创建新应用
  const options = registerApp.calls[0]
  assert.equal(options.createOnly, true)
  assert.deepEqual(options.addons.events.items.tenant, ['im.message.receive_v1'])
  assert.ok(options.addons.scopes.tenant.includes('im:message:send_as_bot'))
  assert.ok(options.addons.scopes.tenant.includes('cardkit:card:write'))
})

test('pending 时能拿到二维码，链接过期后标记 expired 并停轮询', async () => {
  let clock = 1_000
  let aborted = false
  const registerApp = async (options) => {
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device?user_code=ABCD', expireIn: 30 })
    options.signal.addEventListener('abort', () => { aborted = true })
    return new Promise(() => {}) // 用户一直不确认
  }
  const registration = new AppRegistration({ registerApp, renderQr: async () => 'data:image/svg+xml,qr', now: () => clock })

  await registration.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const pending = registration.snapshot()
  assert.equal(pending.state, 'pending')
  assert.equal(pending.qr, 'data:image/svg+xml,qr')
  assert.equal(pending.expireIn, 30)

  clock += 31_000
  const expired = registration.snapshot()
  assert.equal(expired.state, 'expired')
  assert.equal(expired.error.code, 'expired_token')
  assert.equal(aborted, true)
})

test('用户拒绝 / 过期错误码分别落到 error 与 expired', async () => {
  const denied = new AppRegistration({
    registerApp: fakeRegisterApp(async () => { throw Object.assign(new Error('denied'), { code: 'access_denied', description: '用户拒绝' }) }),
    renderQr: async () => '',
  })
  await denied.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(denied.snapshot().state, 'error')
  assert.equal(denied.snapshot().error.message, '用户拒绝')

  const expired = new AppRegistration({
    registerApp: fakeRegisterApp(async () => { throw Object.assign(new Error('expired'), { code: 'expired_token' }) }),
    renderQr: async () => '',
  })
  await expired.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(expired.snapshot().state, 'expired')
})

test('取消后回到 idle，重复 start 不会开两个轮询', async () => {
  let started = 0
  const registration = new AppRegistration({
    registerApp: async (options) => {
      started += 1
      options.onQRCodeReady({ url: 'https://x', expireIn: 60 })
      return new Promise(() => {})
    },
    renderQr: async () => '',
  })
  await registration.start()
  await registration.start()
  assert.equal(started, 1)
  registration.cancel()
  assert.equal(registration.snapshot().state, 'idle')
})

test('HTTP 路由：POST 开始 / GET 快照 / DELETE 取消 / 其它方法 405', async () => {
  const registration = new AppRegistration({
    registerApp: fakeRegisterApp(okScript),
    renderQr: async () => 'data:image/svg+xml,qr',
  })
  let route
  const webServer = { register: (value) => { route = value; return () => {} } }
  const dispose = registerRoute(webServer, registration)
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/api/feishu.register')

  const call = async (method) => {
    const response = {
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { this.body = body },
    }
    await route.handler({ method }, response)
    return { status: response.status, body: response.body === '' ? undefined : JSON.parse(response.body) }
  }

  const posted = await call('POST')
  assert.equal(posted.status, 200)

  await new Promise((resolve) => setTimeout(resolve, 20))
  const got = await call('GET')
  assert.equal(got.body.state, 'success')
  assert.equal(got.body.credentials.appId, 'cli_created')

  // 取消只对「等进行中」的会话有意义：成功后 DELETE 不抹掉已拿到的凭证
  const deleted = await call('DELETE')
  assert.equal(deleted.body.state, 'success')

  const wrong = await call('PUT')
  assert.equal(wrong.status, 405)

  dispose()
})

test('二维码渲染成 SVG data URL（不依赖外网服务）', async () => {
  const dataUrl = await defaultRenderQr('https://accounts.feishu.cn/device?user_code=ABCD')
  assert.ok(dataUrl.startsWith('data:image/svg+xml'))
  assert.ok(decodeURIComponent(dataUrl).includes('<svg'))
})
