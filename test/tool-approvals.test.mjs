import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolApprovalHub } from '../lib/tool-approvals.js'

function makeApi() {
  const sent = []
  const patched = []
  return {
    sent,
    patched,
    async sendInteractive(chatId, card) {
      sent.push({ chatId, card })
      return 'om_' + sent.length
    },
    async patchCardMessage(messageId, card) {
      patched.push({ messageId, card })
    },
  }
}

const silentLog = { info() {}, warn() {}, debug() {} }

function makeHub(overrides) {
  const api = makeApi()
  const hub = new ToolApprovalHub({
    api,
    log: silentLog,
    config: { approvalInFeishu: true, approvalTimeoutMs: 600000, ...(overrides || {}) },
  })
  return { hub, api }
}

const turn = { key: 'oc_1', chatId: 'oc_1', openId: 'ou_1' }
const request = { toolName: 'bash', reason: '要在工作区外执行' }

test('允许：点按钮后 resolve 成 allowed-once 并刷新卡片', async () => {
  const { hub, api } = makeHub()
  const promise = hub.ask(request, turn)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(api.sent.length, 1)
  const pending = hub.pendingFor('oc_1')
  assert.ok(pending, '应有等待中的授权')

  const result = hub.onCardAction({
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { dsha: pending.requestId, choice: 'allow' } },
    },
  })
  assert.equal(await promise, 'allowed-once')
  assert.equal(hub.pendingFor('oc_1'), undefined)
  // 回调本身要返回一张刷新后的卡（飞书同步取这个返回值）
  assert.equal(result.card.type, 'raw')
  assert.equal(api.patched.length, 1)
  assert.equal(api.patched[0].card.header.template, 'green')
})

test('拒绝：resolve 成 rejected', async () => {
  const { hub } = makeHub()
  const promise = hub.ask(request, turn)
  await new Promise((resolve) => setImmediate(resolve))
  const pending = hub.pendingFor('oc_1')
  hub.onCardAction({ action: { value: { dsha: pending.requestId, choice: 'deny' } } })
  assert.equal(await promise, 'rejected')
})

test('超时：resolve 成 undefined（交回网页），卡片标成超时', async () => {
  const { hub, api } = makeHub()
  const promise = hub.ask(request, turn)
  await new Promise((resolve) => setImmediate(resolve))
  hub.timeout(hub.pendingFor('oc_1'))
  assert.equal(await promise, undefined)
  assert.equal(api.patched.at(-1).card.header.template, 'grey')
})

test('中止信号：resolve 成 cancelled', async () => {
  const { hub } = makeHub()
  const controller = new AbortController()
  const promise = hub.ask({ ...request, signal: controller.signal }, turn)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  assert.equal(await promise, 'cancelled')
  assert.equal(hub.pendingFor('oc_1'), undefined)
})

test('关闭开关或已有授权在等：不接管，返回 undefined', async () => {
  const { hub: off, api: offApi } = makeHub({ approvalInFeishu: false })
  assert.equal(await off.ask(request, turn), undefined)
  assert.equal(offApi.sent.length, 0)

  const { hub } = makeHub()
  const first = hub.ask(request, turn)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await hub.ask(request, turn), undefined, '第二个请求应交给网页')
  hub.cancel('oc_1', 'done')
  assert.equal(await first, 'cancelled')
})

test('别人点按钮：不结算，只回 toast', async () => {
  const { hub } = makeHub()
  const promise = hub.ask(request, turn)
  await new Promise((resolve) => setImmediate(resolve))
  const pending = hub.pendingFor('oc_1')
  const result = hub.onCardAction({
    event: {
      operator: { open_id: 'ou_2' },
      action: { value: { dsha: pending.requestId, choice: 'allow' } },
    },
  })
  assert.ok(result.toast, '非提问人点击应只回 toast')
  assert.equal(hub.pendingFor('oc_1'), pending, '请求应还在等')
  hub.cancel('oc_1', 'cleanup')
  awaitingSettle(promise)
  assert.equal(await promise, 'cancelled')
})

test('取消：resolve 成 cancelled，重复点击只回 toast', async () => {
  const { hub } = makeHub()
  const promise = hub.ask(request, turn)
  await new Promise((resolve) => setImmediate(resolve))
  const pending = hub.pendingFor('oc_1')
  assert.equal(hub.cancel('oc_1', 'x'), true)
  assert.equal(await promise, 'cancelled')
  const late = hub.onCardAction({ action: { value: { dsha: pending.requestId, choice: 'allow' } } })
  assert.ok(late.toast)
})

function awaitingSettle(promise) {
  promise.catch(() => {})
}
