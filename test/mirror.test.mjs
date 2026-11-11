import test from 'node:test'
import assert from 'node:assert/strict'
import { MirrorHub } from '../lib/mirror.js'

const silentLog = { info() {}, warn() {}, debug() {} }

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

const session = { id: 'session-web-1' }
const target = () => ({ chatId: 'oc_web', owned: false, title: '网页会话' })

function makeHub(overrides, api) {
  const instance = api || makeApi()
  const hub = new MirrorHub({
    api: instance,
    log: silentLog,
    config: { mirrorOtherTurns: true, mirrorScope: 'bound', ...(overrides || {}) },
  })
  return { hub, api: instance }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

test('关闭时完全不动作', async () => {
  const { hub, api } = makeHub({ mirrorOtherTurns: false })
  hub.observe({ session, event: { type: 'turn/start', data: { turn: 1 } }, target })
  hub.observe({ session, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, target })
  await tick()
  assert.equal(api.sent.length, 0)
  assert.equal(api.patched.length, 0)
})

test('飞书投递的轮次（owned）不镜像', async () => {
  const { hub, api } = makeHub()
  hub.observe({
    session,
    event: { type: 'turn/start', data: { turn: 1 } },
    target: () => ({ chatId: 'oc_1', owned: true, title: 'x' }),
  })
  hub.observe({ session, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, target })
  await tick()
  assert.equal(api.sent.length, 0)
})

test('没有目标（未绑定且 scope=bound）时跳过', async () => {
  const { hub, api } = makeHub()
  hub.observe({ session, event: { type: 'turn/start', data: { turn: 1 } }, target: () => undefined })
  await tick()
  assert.equal(api.sent.length, 0)
})

test('完整一轮：先建卡，再收尾成 done，只发一张卡', async () => {
  const { hub, api } = makeHub()
  hub.observe({ session, event: { type: 'turn/start', data: { turn: 3 } }, target })
  await tick()
  assert.equal(api.sent.length, 1, 'turn/start 就该建卡')
  assert.equal(api.sent[0].chatId, 'oc_web')
  assert.match(api.sent[0].card.header.title.content, /进行中/)

  hub.observe({ session, event: { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'ls' } } }, target })
  hub.observe({ session, event: { type: 'tool/result', data: { callId: 'c1', ok: true } }, target })
  hub.observe({
    session,
    event: { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '跑完了，没问题' }] } } },
    target,
  })
  hub.observe({ session, event: { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }, target })
  await tick()

  assert.equal(api.sent.length, 1, '不应再发第二张卡')
  assert.ok(api.patched.length >= 1)
  const last = api.patched.at(-1).card
  assert.equal(last.header.title.content, '✅ 网页端 · 完成')
  assert.ok(last.elements.some((element) => element.text && element.text.content === '跑完了，没问题'))
  assert.ok(last.elements.some((element) => String(element.text && element.text.content).includes('✅ bash · ls')))
  assert.equal(hub.turns.size, 0, '收尾后状态清空')
})

test('aborted 记成已中断，blocked 记成出错', async () => {
  for (const [kind, expected] of [['aborted', '⏹ 网页端 · 已中断'], ['blocked', '❌ 网页端 · 出错']]) {
    const { hub, api } = makeHub()
    hub.observe({ session, event: { type: 'turn/start', data: { turn: 1 } }, target })
    await tick()
    hub.observe({ session, event: { type: 'turn/end', data: { turn: 1, reason: { kind } } }, target })
    await tick()
    assert.equal(api.patched.at(-1).card.header.title.content, expected)
  }
})

test('cancelAll 把挂着的卡翻成已中断', async () => {
  const { hub, api } = makeHub()
  hub.observe({ session, event: { type: 'turn/start', data: { turn: 1 } }, target })
  await tick()
  await hub.cancelAll('插件已停止')
  assert.equal(api.patched.at(-1).card.header.title.content, '⏹ 网页端 · 已中断')
  assert.equal(hub.turns.size, 0)
})

test('并发会话上限：超过 MAX_SESSIONS 的第十个会话被跳过', async () => {
  const { hub, api } = makeHub()
  for (let index = 0; index < 6; index += 1) {
    hub.observe({
      session: { id: 'session-' + index },
      event: { type: 'turn/start', data: { turn: 1 } },
      target: () => ({ chatId: 'oc_' + index, owned: false }),
    })
  }
  await tick()
  assert.equal(api.sent.length, 4, '最多同时镜像 4 个会话')
})
