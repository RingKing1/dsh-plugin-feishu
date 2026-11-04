import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuBridge } from '../lib/bridge.js'

/**
 * 子agent 唤醒轮的认领与收尾（docs/需求-子agent异步回传.md 的 A1–A4）。
 *
 * 只测路由：onClaimed / onFrame / onIdle / onError 四个方法，用原型调用 + 假成员，
 * 不起长连接、不发任何请求。newCard 被替换成登记动作，重点看「建没建卡、标题对不对、帧进哪张卡」。
 */
const KEY = 'oc_1'

function makeCard(calls, label) {
  return {
    label,
    started: false,
    frames: [],
    finished: [],
    start() {
      this.started = true
      calls.push(['start', label])
    },
    onFrame(frame) {
      this.frames.push(frame)
    },
    finish(result) {
      this.finished.push(result)
      return Promise.resolve(true)
    },
  }
}

function fakeBridge(options) {
  const settings = options || {}
  const calls = []
  const bridge = Object.create(FeishuBridge.prototype)
  bridge.expectTurn = new Map()
  bridge.cards = new Map()
  bridge.liveCards = new Set()
  bridge.turns = new Map([[KEY, { key: KEY, chatId: KEY, title: '飞书: 起个子agent' }]])
  bridge.awaitingReactions = new Map()
  bridge.reactions = { settle: () => Promise.resolve() }
  bridge.log = { debug() {}, info() {}, warn() {}, error() {} }
  bridge.trace = () => {}
  bridge.newCard = (key, title) => {
    const card = makeCard(calls, title)
    calls.push(['newCard', key, title])
    bridge.cards.set(key, card)
    bridge.liveCards.add(card)
    return card
  }
  return { bridge, calls }
}

const startFrame = (turn) => ({ type: 'start', attemptId: 'a1', revision: 0, turn, step: 0 })
// 真实帧形态：只有 start 帧带 turn / step，chunk 与 end 只带 attemptId（见 dsh 的 AssistantStreamAttempt）
const chunkFrame = () => ({ type: 'chunk', attemptId: 'a1', revision: 1, index: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } })
const endFrame = () => ({ type: 'end', attemptId: 'a1', revision: 2, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
const claimed = (turn, kind, senderSessionId) => ({
  message: { source: { kind, senderSessionId, form: 'notice' } },
  turn,
})

/** 跑完一轮飞书入站：入站认领 -> 首帧定型 -> idle（唤醒轮之前的常态） */
function runInboundTurn(bridge, turn) {
  bridge.armTurn(KEY)
  bridge.onFrame(KEY, startFrame(turn))
  const card = bridge.cards.get(KEY)
  bridge.onIdle(KEY)
  return card
}

test('A1 唤醒轮开卡：子agent 完成后主 agent 被唤醒，帧进新卡并在 idle 收尾', () => {
  const { bridge, calls } = fakeBridge()
  const inbound = runInboundTurn(bridge, 0)
  assert.deepEqual(inbound.finished, [{ status: 'done' }])
  // 上一轮已收尾：认领记录与卡片都清干净了
  assert.equal(bridge.expectTurn.size, 0)
  assert.equal(bridge.cards.size, 0)

  bridge.onClaimed(KEY, claimed(7, 'subagent-settled', 'abc123def456'))
  assert.ok(bridge.expectTurn.has(KEY), '唤醒轮必须被认领，否则回复发不出去')

  bridge.onFrame(KEY, startFrame(7))
  const wake = bridge.cards.get(KEY)
  assert.equal(wake.label, '子agent 回来了 · abc123')
  assert.equal(wake.started, true)
  assert.deepEqual(wake.frames, [startFrame(7)])
  // 新卡是靠 newCard 建的，不是复用上一轮那张
  assert.notEqual(wake, inbound)
  assert.deepEqual(calls.filter((c) => c[0] === 'newCard'), [
    ['newCard', KEY, '飞书: 起个子agent'],
    ['newCard', KEY, '子agent 回来了 · abc123'],
  ])

  bridge.onFrame(KEY, chunkFrame())
  assert.equal(wake.frames.length, 2)

  bridge.onIdle(KEY)
  assert.deepEqual(wake.finished, [{ status: 'done' }])
  assert.equal(bridge.expectTurn.size, 0)
  assert.equal(bridge.cards.size, 0)
  assert.equal(bridge.liveCards.size, 0)
})

test('A1b 唤醒轮只放行自己那个 turn：其它轮次的帧不能搭车出卡', () => {
  const { bridge, calls } = fakeBridge()
  bridge.onClaimed(KEY, claimed(7, 'agent-message', 'zzz999'))
  // 网页端在同一会话里开的另一轮（turn 9）：认出但必须丢掉
  bridge.onFrame(KEY, startFrame(9))
  bridge.onFrame(KEY, chunkFrame())
  assert.equal(bridge.cards.size, 0)
  assert.deepEqual(calls.filter((c) => c[0] === 'newCard'), [])

  bridge.onFrame(KEY, startFrame(7))
  assert.equal(bridge.cards.get(KEY).label, '子agent 回来了 · zzz999')
})

test('A2 不误伤 Web 端：source.kind=user 的轮次不认领、不出卡', () => {
  const { bridge, calls } = fakeBridge()
  bridge.onClaimed(KEY, claimed(3, 'user'))
  assert.equal(bridge.expectTurn.size, 0)
  bridge.onFrame(KEY, startFrame(3))
  bridge.onFrame(KEY, chunkFrame())
  assert.equal(bridge.cards.size, 0)
  assert.deepEqual(calls, [])

  // 未知 kind 同样 fall through，不认领
  bridge.onClaimed(KEY, claimed(4, 'some-future-kind'))
  assert.equal(bridge.expectTurn.size, 0)
})

test('A2b 没有飞书会话记录时不认领（不知道往哪个会话发）', () => {
  const { bridge } = fakeBridge()
  bridge.turns.clear()
  bridge.onClaimed(KEY, claimed(7, 'subagent-settled', 'abc123'))
  assert.equal(bridge.expectTurn.size, 0)
})

test('卡片标题优先用姓名，拿不到姓名才退回 open_id 尾号', () => {
  const of = FeishuBridge.prototype.titleOf
  const p2p = { chatType: 'p2p', senderOpenId: 'ou_796c4cf9a10578e787c004fa40dddce1' }
  assert.equal(of(p2p, '苏文广'), '飞书 · 苏文广')
  assert.equal(of(p2p, ''), '飞书 · dddce1')
  assert.equal(of({ chatType: 'group', chatId: 'oc_1' }, undefined), '飞书群聊 · oc_1')
})

test('A1c 回归：chunk/end 帧不带 turn（dsh 只给 start 帧带），正文必须照常进卡', () => {
  const { bridge } = fakeBridge()
  bridge.armTurn(KEY)
  bridge.onFrame(KEY, startFrame(1))
  const card = bridge.cards.get(KEY)

  bridge.onFrame(KEY, chunkFrame())
  bridge.onFrame(KEY, chunkFrame())
  bridge.onFrame(KEY, endFrame())

  assert.equal(card.frames.length, 4, 'start + 2 chunk + end 全都要转给卡片；0.7.0 曾全部按 turn=NaN 丢掉')
  assert.deepEqual(card.frames.slice(1).map((f) => f.type), ['chunk', 'chunk', 'end'])
})

test('A1d 别的 attempt 的尾帧不能写进当前卡', () => {
  const { bridge } = fakeBridge()
  bridge.armTurn(KEY)
  bridge.onFrame(KEY, startFrame(1))
  const card = bridge.cards.get(KEY)

  // 上一轮/被重试丢弃那次 attempt 的 chunk 与 end 混进来
  bridge.onFrame(KEY, { ...chunkFrame(), attemptId: 'a0' })
  bridge.onFrame(KEY, { ...endFrame(), attemptId: 'a0' })
  bridge.onFrame(KEY, endFrame())

  assert.deepEqual(card.frames.map((f) => f.attemptId), ['a1', 'a1'])
})

test('A3 情况 1 不回归：入站轮进行中收到子agent 消息，并入同一张卡', () => {
  const { bridge, calls } = fakeBridge()
  bridge.armTurn(KEY)
  bridge.onFrame(KEY, startFrame(0))
  const inbound = bridge.cards.get(KEY)
  assert.equal(calls.filter((c) => c[0] === 'newCard').length, 1)

  // 主 agent 还没结束，子agent 先完成：next-turn 被同一驱动接着跑
  bridge.onClaimed(KEY, claimed(1, 'subagent-settled', 'abc123'))
  bridge.onFrame(KEY, startFrame(1))
  bridge.onFrame(KEY, chunkFrame())

  assert.equal(bridge.cards.size, 1)
  assert.equal(bridge.cards.get(KEY), inbound)
  assert.equal(calls.filter((c) => c[0] === 'newCard').length, 1, 'R5：同一时刻最多一张活卡')
  assert.equal(inbound.frames.length, 3)
  assert.deepEqual(inbound.finished, [])
})

test('A4 错误路径：唤醒轮出错转失败态并清理登记，下一轮不受影响', () => {
  const { bridge } = fakeBridge()
  bridge.onClaimed(KEY, claimed(7, 'subagent-settled', 'abc123'))
  bridge.onFrame(KEY, startFrame(7))
  const wake = bridge.cards.get(KEY)

  bridge.onError(KEY, new Error('boom'))
  assert.equal(wake.finished.length, 1)
  assert.equal(wake.finished[0].status, 'failed')
  assert.match(wake.finished[0].note, /boom/)
  assert.equal(bridge.expectTurn.size, 0)
  assert.equal(bridge.cards.size, 0)

  // 清理干净后，下一轮照常能认领并出卡
  bridge.onClaimed(KEY, claimed(8, 'subagent-settled', 'def456'))
  bridge.onFrame(KEY, startFrame(8))
  assert.equal(bridge.cards.get(KEY).label, '子agent 回来了 · def456')
})

test('idle 早于 claimed 到达时也不残留：认领只在轮次开始时发生', () => {
  const { bridge } = fakeBridge()
  // inserted 阶段（还没 claimed）什么都不做：没有认领就不会有残留
  bridge.onIdle(KEY)
  assert.equal(bridge.expectTurn.size, 0)
})
