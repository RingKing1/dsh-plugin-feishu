import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTextAnswer, QuestionHub } from '../lib/questions.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

function fakeApi(options) {
  const calls = { interactive: [], text: [], patch: [] }
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
    async patchCardMessage(messageId, card) {
      if (options && options.patchFails) throw new Error('patch 失败')
      calls.patch.push({ messageId, card })
      return true
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

test('点按钮作答：回调原地刷新成「已选择」并让 ask 解析出答案', async () => {
  const { hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  const pending = hub.pendingFor('oc_1')
  assert.ok(pending, 'ask 之后应立刻登记待答问题')

  const ack = hub.onCardAction({
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { dshq: pending.requestId, qid: 'q1', pick: ['方案 B'] } },
      context: { open_chat_id: 'oc_1' },
    },
  })
  assert.equal(ack.toast, undefined, '答完不再回 toast，靠卡片原地刷新反馈')
  assert.equal(ack.card.type, 'raw')
  assert.equal(ack.card.data.header.title.content, '已选择')
  assert.equal(ack.card.data.header.template, 'green')
  assert.match(JSON.stringify(ack.card.data), /已选择：方案 B/)

  const result = await pendingResult
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.answers, [{ id: 'q1', selected: ['方案 B'] }])
  assert.equal(hub.pendingFor('oc_1'), undefined, '答完必须清掉待答状态')
})

test('表单自由输入：空输入只提示，填了内容按 custom 结算', async () => {
  const { hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  const pending = hub.pendingFor('oc_1')
  const empty = hub.onCardAction({
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { dshq: pending.requestId, qid: 'q1', input: 'dsh_input_0' }, form_value: { dsh_input_0: '   ' } },
    },
  })
  assert.match(empty.toast.content, /请先输入内容/)
  assert.ok(hub.pendingFor('oc_1'), '空输入不能结算')

  const ack = hub.onCardAction({
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { dshq: pending.requestId, qid: 'q1', input: 'dsh_input_0' }, form_value: { dsh_input_0: '都不合适，用方案 C' } },
    },
  })
  assert.equal(ack.card.data.header.title.content, '已选择')
  assert.match(JSON.stringify(ack.card.data), /你的输入：都不合适，用方案 C/)
  const result = await pendingResult
  assert.deepEqual(result.value.answers, [{ id: 'q1', selected: [], custom: '都不合适，用方案 C' }])
})

test('多题部分作答：返回「请选择」卡，题数与剩余表单都在', async () => {
  const { hub } = makeHub()
  const questions = [
    { id: 'q1', question: '第一个？', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: '第二个？' },
  ]
  const pendingResult = settled(hub.ask({ questions }, turn))
  const pending = hub.pendingFor('oc_1')
  const ack = hub.onCardAction({
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { dshq: pending.requestId, qid: 'q1', pick: ['A'] } },
    },
  })
  assert.equal(ack.card.data.header.title.content, '请选择')
  assert.match(JSON.stringify(ack.card.data), /等待选择（1\/2）/)
  assert.match(JSON.stringify(ack.card.data), /dsh_input_1/, '未答的第二题仍要有输入框')
  assert.ok(hub.pendingFor('oc_1'))
  hub.cancel('oc_1', '测试结束')
  await pendingResult
})

test('迟到点击：问题已结算时明确告知已结束', async () => {
  const { hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  const pending = hub.pendingFor('oc_1')
  const event = {
    operator: { open_id: 'ou_1' },
    action: { value: { dshq: pending.requestId, qid: 'q1', pick: ['方案 A'] } },
  }
  hub.onCardAction({ event })
  await pendingResult
  const late = hub.onCardAction({ event })
  assert.equal(late.toast.type, 'info')
  assert.match(late.toast.content, /已经结束/)
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

test('多个问题：逐条作答、卡片逐题刷新，全部答完才结算且不发回执文本', async () => {
  const { api, hub } = makeHub()
  const questions = [
    { id: 'q1', question: '第一个？', options: [{ label: 'A' }] },
    { id: 'q2', question: '第二个？' },
  ]
  const pendingResult = settled(hub.ask({ questions }, turn))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(hub.answerByText('oc_1', 'A'), true)
  assert.equal(hub.pendingFor('oc_1') !== undefined, true, '还有一题没答，不能结算')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(api.calls.text.length, 0, '答题过程不再发「还有 N 个问题」文本，卡片会刷新')
  assert.equal(api.calls.patch.length, 1, '答完第一题应原地刷新卡片')
  assert.equal(api.calls.patch[0].card.header.title.content, '请选择')
  assert.match(JSON.stringify(api.calls.patch[0].card), /等待选择（1\/2）/)

  assert.equal(hub.answerByText('oc_1', '随便'), true)
  const result = await pendingResult
  assert.deepEqual(result.value.answers, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [], custom: '随便' },
  ])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(api.calls.patch.length, 2)
  assert.equal(api.calls.patch[1].card.header.title.content, '已选择')
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

test('超时：卡片翻成「选择超时」，不再另发文本', async () => {
  const { api, hub } = makeHub()
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  await new Promise((resolve) => setImmediate(resolve))
  const pending = hub.pendingFor('oc_1')
  hub.timeout(pending)
  const result = await pendingResult
  assert.equal(result.ok, false)
  assert.match(result.error.message, /没有回答/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(api.calls.patch.length, 1)
  assert.equal(api.calls.patch[0].messageId, 'om_card')
  assert.equal(api.calls.patch[0].card.header.title.content, '选择超时')
  assert.equal(api.calls.patch[0].card.header.template, 'grey')
  assert.match(JSON.stringify(api.calls.patch[0].card), /等待超时/)
  assert.equal(api.calls.text.length, 0, '卡片刷新成功就不补文本')
  assert.equal(hub.pendingFor('oc_1'), undefined)
})

test('超时且卡片刷新失败：退回一条文本提示', async () => {
  const api = fakeApi({ patchFails: true })
  const hub = new QuestionHub({ api, log: silentLog, config: { askTimeoutMs: 60000 } })
  const pendingResult = settled(hub.ask({ questions: single }, turn))
  hub.timeout(hub.pendingFor('oc_1'))
  const result = await pendingResult
  assert.equal(result.ok, false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(api.calls.text.length, 1)
  assert.match(api.calls.text[0].text, /提问已取消/)
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
