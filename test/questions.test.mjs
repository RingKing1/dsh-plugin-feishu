import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTextAnswer, QuestionHub } from '../lib/questions.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

function fakeApi() {
  const calls = { interactive: [], text: [] }
  return {
    calls,
    async sendInteractive(chatId, card) {
      calls.interactive.push({ chatId, card })
      return 'om_card'
    },
    async sendText(chatId, text) {
      calls.text.push({ chatId, text })
      return 'om_text'
    },
  }
}

function makeHub(overrides) {
  const api = fakeApi()
  const hub = new QuestionHub({
    api,
    log: silentLog,
    config: { askTimeoutMs: 60000, ...(overrides && overrides.config) },
  })
  return { api, hub }
}

const turn = { key: 'oc_1', chatId: 'oc_1', openId: 'ou_1' }
const single = [{ id: 'q1', question: '用哪个？', options: [{ label: '方案 A' }, { label: '方案 B' }] }]

/** 常驻 catch：避免「先创建、后断言」的 Promise 变成 unhandled rejection */
function settled(promise) {
  return promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
}

test('点按钮作答：返回 toast 并让 ask 解析出答案', async () => {
  const { hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  const pending = hub.pendingFor('oc_1')
  assert.ok(pending, 'ask 之后应立刻登记待答问题')

  const ack = await hub.onCardAction({
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { dshq: pending.requestId, qid: 'q1', pick: ['方案 B'] } },
      context: { open_chat_id: 'oc_1' },
    },
  })
  assert.equal(ack.toast.type, 'success')
  assert.equal(ack.toast.content, '已收到：方案 B')

  const result = await pendingResult
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.answers, [{ id: 'q1', selected: ['方案 B'] }])
  assert.equal(hub.pendingFor('oc_1'), undefined, '答完必须清掉待答状态')
})

test('同一个会话里已有提问时，第二个提问直接拒绝', async () => {
  const { hub } = makeHub()
  const first = settled(hub.ask({ questions: single }, turn))
  await assert.rejects(hub.ask({ questions: single }, turn), /上一个问题还没有回答/)
  hub.cancel('oc_1', '测试结束')
  assert.equal((await first).ok, false)
})

test('文字作答：数字选第 N 项，消费后不再当成新消息', async () => {
  const { hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  assert.equal(hub.answerByText('oc_1', '2'), true)
  const result = await pendingResult
  assert.deepEqual(result.value.answers, [{ id: 'q1', selected: ['方案 B'] }])
  assert.equal(hub.answerByText('oc_1', '再来一条'), false, '没有待答问题时不能再消费消息')
})

test('文字作答：没有选项的问题记成 custom', async () => {
  const { hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: [{ id: 'q1', question: '你叫什么？' }] }, turn))
  assert.equal(hub.answerByText('oc_1', '张三'), true)
  const result = await pendingResult
  assert.deepEqual(result.value.answers, [{ id: 'q1', selected: [], custom: '张三' }])
})

test('多个问题：逐条回答，全部答完才结算，并给一次回执', async () => {
  const { api, hub } = makeHub()
  const questions = [
    { id: 'q1', question: '第一个？', options: [{ label: 'A' }] },
    { id: 'q2', question: '第二个？' },
  ]
  const pendingResult = settled(hub.ask({ questions }, turn))
  assert.equal(hub.answerByText('oc_1', 'A'), true)
  assert.equal(hub.pendingFor('oc_1') !== undefined, true, '还有一题没答，不能结算')
  assert.equal(api.calls.text.length, 1, '应回执「还有 1 个问题待回答」')
  assert.match(api.calls.text[0].text, /还有 1 个问题/)

  assert.equal(hub.answerByText('oc_1', '随便'), true)
  const result = await pendingResult
  assert.deepEqual(result.value.answers, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [], custom: '随便' },
  ])
})

test('不是提问人本人点按钮：只回 toast，不结算', async () => {
  const { hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  const pending = hub.pendingFor('oc_1')
  const ack = await hub.onCardAction({
    event: {
      operator: { open_id: 'ou_别人' },
      action: { value: { dshq: pending.requestId, qid: 'q1', pick: ['方案 A'] } },
    },
  })
  assert.equal(ack.toast.type, 'info')
  assert.match(ack.toast.content, /只有提问人/)
  assert.ok(hub.pendingFor('oc_1'), '别人的点击不能把问题答掉')
  hub.cancel('oc_1', '测试结束')
  await pendingResult
})

test('过期/重复的卡片点击：只回 toast', async () => {
  const { hub } = makeHub()
  const ack = await hub.onCardAction({ event: { action: { value: { dshq: 'not-exist', qid: 'q1', pick: ['A'] } } } })
  assert.equal(ack.toast.type, 'info')
  assert.match(ack.toast.content, /已经回答过/)

  const noValue = await hub.onCardAction({ event: { action: { value: { foo: 1 } } } })
  assert.match(noValue.toast.content, /失效/)
})

test('超时：拒绝并给用户一条提示', async () => {
  const { api, hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  const pending = hub.pendingFor('oc_1')
  hub.timeout(pending)
  const result = await pendingResult
  assert.equal(result.ok, false)
  assert.match(result.error.message, /没有回答/)
  assert.equal(api.calls.text.length, 1)
  assert.match(api.calls.text[0].text, /提问已取消/)
  assert.equal(hub.pendingFor('oc_1'), undefined)
})

test('dsh 侧中止（AbortSignal）：拒绝并清理状态', async () => {
  const { hub } = makeHub()
  const controller = new AbortController()
  const pendingResult = settled(hub.ask({ questions: single, signal: controller.signal }, turn))
  controller.abort()
  const result = await pendingResult
  assert.equal(result.ok, false)
  assert.match(result.error.message, /取消/)
  assert.equal(hub.pendingFor('oc_1'), undefined)
})

test('cancel：/stop 与插件停止时不留悬空 Promise', async () => {
  const { hub } = makeHub()
  const first = settled(hub.ask({ questions: single }, turn))
  assert.equal(hub.cancel('oc_1', '收到 /stop'), true)
  assert.equal((await first).ok, false)
  assert.equal(hub.cancel('oc_1', '再来一次'), false, '没有待答问题时 cancel 返回 false')
})

test('cancelAll：插件停止时结算所有会话', async () => {
  const { hub } = makeHub()
  const a = settled(hub.ask({ questions: single }, { key: 'oc_a', chatId: 'oc_a' }))
  const b = settled(hub.ask({ questions: single }, { key: 'oc_b', chatId: 'oc_b' }))
  hub.cancelAll('飞书桥接已停止')
  assert.equal((await a).ok, false)
  assert.equal((await b).ok, false)
  assert.equal(hub.pending.size, 0)
})

test('发送卡片失败时，ask 直接拒绝而不是永久等待', async () => {
  const { hub } = makeHub()
  hub.api = {
    async sendInteractive() {
      throw new Error('网络断了')
    },
    async sendText() {
      return ''
    },
  }
  const result = await settled(hub.ask({ questions: single }, turn))
  assert.equal(result.ok, false)
  assert.match(result.error.message, /把问题发到飞书失败/)
  assert.equal(hub.pendingFor('oc_1'), undefined)
})

test('空提问直接拒绝', async () => {
  const { hub } = makeHub()
  await assert.rejects(hub.ask({ questions: [] }, turn), /没有任何问题/)
})

// ---- parseTextAnswer ----

test('parseTextAnswer：数字、标签、包含关系、多选、自由文本', () => {
  const question = { id: 'q', options: [{ label: '方案 A' }, { label: '方案 B' }] }
  assert.deepEqual(parseTextAnswer(question, '1'), { picks: ['方案 A'] })
  assert.deepEqual(parseTextAnswer(question, '方案 B'), { picks: ['方案 B'] })
  assert.deepEqual(parseTextAnswer(question, 'B'), { picks: ['方案 B'] })
  assert.deepEqual(parseTextAnswer(question, '都行'), { picks: [], custom: '都行' })
  // 数字越界不该被当成选项
  assert.deepEqual(parseTextAnswer(question, '3'), { picks: [], custom: '3' })

  const multi = { id: 'q', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] }
  assert.deepEqual(parseTextAnswer(multi, 'x、z'), { picks: ['x', 'z'] })

  // 没有选项：整段当自定义回答
  assert.deepEqual(parseTextAnswer({ id: 'q' }, '你好'), { picks: [], custom: '你好' })
})
