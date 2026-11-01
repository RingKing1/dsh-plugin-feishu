import test from 'node:test'
import assert from 'node:assert/strict'
import { registerStatusRoute } from '../lib/status-route.js'

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body === undefined ? '' : body },
  }
}

test('状态端点返回每台机器人的 state/error，并禁止缓存', async () => {
  const statuses = new Map()
  statuses.set('cli_a', { appId: 'cli_a', name: '主号', state: 'online', since: 1 })
  statuses.set('cli_b', { appId: 'cli_b', name: '', state: 'error', error: 'invalid app secret', since: 2 })

  let route
  const webServer = { register: (value) => { route = value; return () => {} } }
  const dispose = registerStatusRoute(webServer, statuses)
  assert.equal(route.path, '/api/feishu.status')

  const response = fakeResponse()
  await route.handler({ method: 'GET' }, response)
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  const body = JSON.parse(response.body)
  assert.equal(body.bots.length, 2)
  assert.equal(body.bots[0].state, 'online')
  assert.equal(body.bots[1].error, 'invalid app secret')

  // HEAD 只要头，不要 body
  const head = fakeResponse()
  await route.handler({ method: 'HEAD' }, head)
  assert.equal(head.body, '')

  dispose()
})

test('没有机器人时返回空列表（界面据此不点灯）', async () => {
  let route
  const webServer = { register: (value) => { route = value; return () => {} } }
  registerStatusRoute(webServer, new Map())
  const response = fakeResponse()
  await route.handler({ method: 'GET' }, response)
  assert.deepEqual(JSON.parse(response.body), { bots: [] })
})
