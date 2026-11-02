import test from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalHub } from '../lib/approvals.js'
import { DECISION_ALLOW, DECISION_REJECT } from '../lib/approval-card.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

function fakeApi(options) {
  const calls = { interactive: [], text: [] }
  const failure = options && options.failSend
  return {
    calls,
    async sendInteractive(chatId, card) {
      if (failure) throw new Error('boom')
      calls.interactive.push({ chatId, card })
      return 'om_card_' + calls.interactive.length
    },
    async sendText(chatId, text) {
      calls.text.push({ chatId, text })
      return 'om_text'
    },
  }
}

function makeHub(config, apiOptions) {
  const api = fakeApi(apiOptions)
  const hub = new ApprovalHub({
    api,
    log: silentLog,
    config: { approvalEnabled: true, approvalTimeoutMs: 60000, approvalTimeoutAllow: false, approvalAllowTools: [], ...(config || {}) },
  })
  return { api, hub }
}

const turn = { key: 'oc_1', chatId: 'oc_1', openId: 'ou_1' }
const request = { toolName: 'bash', callId: 'call_1', reason: '需要执行构建' }

/** 让 await 链推进一轮 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 从已发出的卡片里取出 requestId 与按钮标签 */
function cardValue(api, index) {
  const card = api.calls.interactive[index || 0].card
  const actions = card.elements.filter((element) => element.tag === 'action')
  return actions[0].actions.map((button) => ({ label: button.text.content, value: button.value }))
}

test('点「允许一次」：审批按 allowed-once 收口并回 toast', async () => {
  const { api, hub } = makeHub()
  const pending = hub.request(request, turn)
  await flush()
  assert.equal(api.calls.interactive.length, 1)

  const buttons = cardValue(api)
  const result = hub.onCardAction({
    event: { action: { value: buttons[0].value }, operator: { open_id: 'ou_1' } },
  })
  assert.equal(result.toast.type, 'success')
  assert.match(result.toast.content, /允许/)
  assert.equal(await pending, DECISION_ALLOW)
  assert.equal(hub.pendingFor('oc_1'), undefined)
})

test('点「拒绝」：审批按 rejected 收口', async () => {
  const { api, hub } = makeHub()
  const pending = hub.request(request, turn)
  await flush()
  const buttons = cardValue(api)
  const result = hub.onCardAction({
    event: { action: { value: buttons[1].value }, operator: { open_id: 'ou_1' } },
  })
  assert.equal(result.toast.type, 'warning')
  assert.equal(await pending, DECISION_REJECT)
})

test('别人点按钮：只回一句提示，审批仍然挂着', async () => {
  const { api, hub } = makeHub()
  const pending = hub.request(request, turn)
  await flush()
  const buttons = cardValue(api)
  const result = hub.onCardAction({
    event: { action: { value: buttons[0].value }, operator: { open_id: 'ou_2' } },
  })
  assert.match(result.toast.content, /只有发起这一轮的人/)
  assert.ok(hub.pendingFor('oc_1'))
  hub.cancel('oc_1', '测试结束')
  assert.equal(await pending, 'cancelled')
})

test('文字回复「允许」：直接收口并回执', async () => {
  const { api, hub } = makeHub()
  const pending = hub.request(request, turn)
  await flush()
  assert.equal(hub.answerByText('oc_1', '允许'), 'settled')
  assert.equal(await pending, DECISION_ALLOW)
  assert.match(api.calls.text[0].text, /已允许一次：bash/)
})

test('文字不是明确答复：只提示，不猜也不收口', async () => {
  const { api, hub } = makeHub()
  const pending = hub.request(request, turn)
  await flush()
  assert.equal(hub.answerByText('oc_1', '这个命令看起来有点危险'), 'hint')
  assert.match(api.calls.text[0].text, /回复「允许」\/「拒绝」/)
  assert.ok(hub.pendingFor('oc_1'))
  hub.cancel('oc_1', '测试结束')
  assert.equal(await pending, 'cancelled')
})

test('超时：默认按拒绝收口并留一句说明', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { api, hub } = makeHub({ approvalTimeoutMs: 10000 })
  const pending = hub.request(request, turn)
  await flush()
  t.mock.timers.tick(10000)
  assert.equal(await pending, DECISION_REJECT)
  assert.match(api.calls.text[0].text, /审批超时/)
})

test('超时后自动允许：显式配置才生效', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { hub } = makeHub({ approvalTimeoutMs: 10000, approvalTimeoutAllow: true })
  const pending = hub.request(request, turn)
  await flush()
  t.mock.timers.tick(10000)
  assert.equal(await pending, DECISION_ALLOW)
})

test('dsh 撤回请求（signal abort）：按 cancelled 收口', async () => {
  const { hub } = makeHub()
  const controller = new AbortController()
  const pending = hub.request({ ...request, signal: controller.signal }, turn)
  await flush()
  controller.abort()
  assert.equal(await pending, 'cancelled')
  assert.equal(hub.pendingFor('oc_1'), undefined)
})

test('卡片发不出去：按 unavailable 收口（调用方失败关闭）', async () => {
  const { hub } = makeHub({}, { failSend: true })
  assert.equal(await hub.request(request, turn), 'unavailable')
})

test('免审批白名单：命中直接放行，不发卡片', async () => {
  const { api, hub } = makeHub({ approvalAllowTools: ['read', ' Grep '] })
  assert.equal(await hub.request({ toolName: 'read' }, turn), DECISION_ALLOW)
  assert.equal(await hub.request({ toolName: 'grep' }, turn), DECISION_ALLOW)
  // 只做精确匹配，写错一个字母不能悄悄放行
  assert.equal(api.calls.interactive.length, 0)
  const pending = hub.request({ toolName: 'grep2' }, turn)
  await flush()
  assert.equal(api.calls.interactive.length, 1)
  hub.cancel('oc_1', '测试结束')
  assert.equal(await pending, 'cancelled')
})

test('同一会话的审批排队：前一张没答就不发下一张', async () => {
  const { api, hub } = makeHub()
  const first = hub.request(request, turn)
  await flush()
  const second = hub.request({ toolName: 'write' }, turn)
  await flush()
  assert.equal(api.calls.interactive.length, 1)

  hub.answerByText('oc_1', '允许')
  assert.equal(await first, DECISION_ALLOW)
  await flush()
  assert.equal(api.calls.interactive.length, 2)
  hub.answerByText('oc_1', '拒绝')
  assert.equal(await second, DECISION_REJECT)
})

test('关掉飞书审批：不接管（返回 unavailable，交给原来的 answerer）', async () => {
  const { api, hub } = makeHub({ approvalEnabled: false })
  assert.equal(await hub.request(request, turn), 'unavailable')
  assert.equal(api.calls.interactive.length, 0)
})
