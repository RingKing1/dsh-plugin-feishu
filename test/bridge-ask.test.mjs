import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FeishuBridge } from '../lib/bridge.js'

/**
 * askQuestions 只依赖 cards / liveCards / questions / newCard 四个成员，
 * 用原型调用即可覆盖「答完」与「超时/取消」两条收尾路径，不必启动长连接。
 */
function fakeBridge(ask) {
  const calls = []
  const card = {
    pauseForAsk: async (note) => { calls.push(['pause', note]); return true },
    markAnswered: async () => { calls.push(['answered']); return true },
    settlePaused: async (status, note) => { calls.push(['settle', status, note]); return true },
  }
  const bridge = Object.create(FeishuBridge.prototype)
  bridge.cards = new Map([['oc_1', card]])
  bridge.liveCards = new Set([card])
  bridge.questions = { ask }
  bridge.newCard = (key, title) => {
    calls.push(['newCard', key, title])
    return { start: () => calls.push(['start']) }
  }
  return { bridge, calls }
}

const turn = { key: 'oc_1', chatId: 'oc_1' }
const request = { questions: [{ id: 'q1', question: '选哪个' }] }

test('答完：暂停卡翻「已选择」，再开「回复（接上条）」', async () => {
  const { bridge, calls } = fakeBridge(async () => ({ answers: [{ id: 'q1', selected: ['A'] }] }))
  const result = await bridge.askQuestions(request, turn)
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['A'] }])
  assert.deepEqual(calls, [
    ['pause', '等你选择'],
    ['answered'],
    ['newCard', 'oc_1', '回复（接上条）'],
    ['start'],
  ])
})

test('超时/取消：暂停卡翻「已结束」，不开新卡也不改标题', async () => {
  const { bridge, calls } = fakeBridge(async () => { throw new Error('飞书里 10 分钟没有回答') })
  await assert.rejects(() => bridge.askQuestions(request, turn), /10 分钟没有回答/)
  assert.deepEqual(calls, [
    ['pause', '等你选择'],
    ['settle', 'stopped', '提问已结束'],
  ])
})
