import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuBridge } from '../lib/bridge.js'

/**
 * 只测两个纯路由方法：onSessionEvent（ptc 子调用映射）与 onFrame（转给卡片）。
 * 用原型调用 + 假成员，不起长连接、不发任何请求。
 */
function fakeBridge(options) {
  const settings = options || {}
  const calls = []
  const card = {
    start: () => calls.push(['start']),
    onFrame: (frame) => calls.push(['frame', frame]),
    trackToolCall: (data) => calls.push(['call', data]),
    trackToolResult: (data) => calls.push(['result', data]),
  }
  const bridge = Object.create(FeishuBridge.prototype)
  bridge.expectTurn = new Map()
  bridge.cards = new Map(settings.noCard ? [] : [['oc_1', card]])
  bridge.agents = { live: new Map(settings.noAgent ? [] : [['oc_1', { sessionId: 'sess_1' }]]) }
  // 入站认领（wildcard）：此刻还没有 turn 号，由首帧定型
  if (settings.expectTurn !== false) bridge.armTurn('oc_1')
  return { bridge, calls }
}

const session = { id: 'sess_1' }

test('tool/call 与 tool/result 照旧进过程面板', () => {
  const { bridge, calls } = fakeBridge()
  bridge.onSessionEvent(session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  bridge.onSessionEvent(session, { type: 'tool/result', data: { callId: 'c1', ok: true } })
  assert.deepEqual(calls, [
    ['call', { callId: 'c1', name: 'bash', arguments: '{}' }],
    ['result', { callId: 'c1', ok: true }],
  ])
})

test('ptc 子调用：subCallId 当 callId，成对进过程面板', () => {
  const { bridge, calls } = fakeBridge()
  bridge.onSessionEvent(session, {
    type: 'tool/ptc-dispatch-start',
    data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub1', name: 'read', arguments: '{"path":"/tmp/a"}' },
  })
  bridge.onSessionEvent(session, {
    type: 'tool/ptc-dispatch',
    data: { rootCallId: 'root', subCallId: 'sub1', isError: false, content: 'ok' },
  })
  assert.deepEqual(calls, [
    ['call', { callId: 'sub1', name: 'read', arguments: '{"path":"/tmp/a"}' }],
    ['result', { callId: 'sub1', ok: true }],
  ])
})

test('ptc 失败：isError 映射成 ok=false', () => {
  const { bridge, calls } = fakeBridge()
  bridge.onSessionEvent(session, { type: 'tool/ptc-dispatch', data: { subCallId: 'sub1', isError: true } })
  assert.deepEqual(calls, [['result', { callId: 'sub1', ok: false }]])
})

test('无关事件、非本插件会话、没有卡片时都静默返回', () => {
  const { bridge, calls } = fakeBridge()
  bridge.onSessionEvent(session, { type: 'turn/start', data: {} })
  bridge.onSessionEvent({ id: 'other' }, { type: 'tool/call', data: { callId: 'c1' } })
  assert.deepEqual(calls, [])

  const empty = fakeBridge({ noCard: true })
  empty.bridge.onSessionEvent(session, { type: 'tool/call', data: { callId: 'c1' } })
  assert.deepEqual(empty.calls, [])
})

test('onFrame：start 帧保证有卡并调 start，其余帧只转给已有卡', () => {
  const { bridge, calls } = fakeBridge()
  const start = { type: 'start', attemptId: 'a1', revision: 0, turn: 0, step: 0 }
  bridge.onFrame('oc_1', start)
  assert.deepEqual(calls, [['start'], ['frame', start]])

  const chunk = { type: 'chunk', attemptId: 'a1', revision: 0, turn: 0, index: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } }
  bridge.onFrame('oc_1', chunk)
  assert.deepEqual(calls.slice(2), [['frame', chunk]])
})

test('onFrame：不在等待结果的会话、没有卡片时都不做事', () => {
  const idle = fakeBridge({ expectTurn: false })
  idle.bridge.onFrame('oc_1', { type: 'start', turn: 0, step: 0 })
  assert.deepEqual(idle.calls, [])

  const noCard = fakeBridge({ noCard: true })
  noCard.bridge.onFrame('oc_1', { type: 'chunk', turn: 0, chunk: { type: 'text-delta', text: 'x' } })
  assert.deepEqual(noCard.calls, [])
  // 没有卡片时 chunk 帧不建卡（避免流末尾凭空多一张空卡）
  assert.equal(noCard.bridge.cards.size, 0)
})
