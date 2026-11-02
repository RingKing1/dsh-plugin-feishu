import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplyCard } from '../lib/reply-card.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

function makeApi() {
  const calls = []
  return {
    calls,
    async createCard(card) {
      calls.push(['createCard', card])
      return 'card_1'
    },
    async sendCard(chatId, cardId) {
      calls.push(['sendCard', chatId, cardId])
      return 'msg_1'
    },
    async putCardContent(cardId, content, sequence) {
      calls.push(['putCardContent', cardId, content, sequence])
    },
    async closeStreaming(cardId, sequence, summary) {
      calls.push(['closeStreaming', cardId, sequence, summary])
    },
    async updateCard(cardId, card, sequence) {
      calls.push(['updateCard', cardId, card, sequence])
    },
    async sendText(chatId, text) {
      calls.push(['sendText', chatId, text])
    },
  }
}

function makeCard(api, overrides) {
  return new ReplyCard(
    Object.assign(
      { api, chatId: 'oc_1', title: '飞书 · 123456', intervalMs: 60000, maxChars: 8000, log: silentLog },
      overrides,
    ),
  )
}

test('start 建卡并发消息，ready 变 true', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  assert.equal(card.ready, true)
  assert.equal(api.calls[0][0], 'createCard')
  assert.equal(api.calls[1][0], 'sendCard')
  assert.equal(api.calls[1][1], 'oc_1')
  assert.equal(api.calls[1][2], 'card_1')
})

test('buildCard 用 running 状态开启流式', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  const built = api.calls[0][1]
  assert.equal(built.config.streaming_mode, true)
  assert.equal(built.header.template, 'blue')
})

test('append + flushNow 推送全文', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  card.append('第一段')
  card.append('，第二段')
  await card.flushNow()

  const put = api.calls.find((call) => call[0] === 'putCardContent')
  assert.ok(put)
  assert.equal(put[1], 'card_1')
  assert.equal(put[2], '第一段，第二段')
})

test('内容未变化时不重复推送', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  card.append('同样的内容')
  await card.flushNow()
  const firstCount = api.calls.filter((call) => call[0] === 'putCardContent').length
  await card.flushNow()
  const secondCount = api.calls.filter((call) => call[0] === 'putCardContent').length
  assert.equal(firstCount, 1)
  assert.equal(secondCount, 1)
})

test('finish 关流式并把 header 换成终态', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  card.append('最终答案')
  const ok = await card.finish({ status: 'done' })
  assert.equal(ok, true)

  const close = api.calls.find((call) => call[0] === 'closeStreaming')
  assert.ok(close)
  const update = api.calls.find((call) => call[0] === 'updateCard')
  assert.equal(update[2].header.template, 'green')
  assert.equal(update[2].body.elements[0].content, '最终答案')
})

test('建卡失败时不抛错，finish 返回 false 供上层兜底', async () => {
  const api = makeApi()
  api.createCard = async () => {
    throw new Error('boom')
  }
  const card = makeCard(api)
  await card.start()
  assert.equal(card.ready, false)
  card.append('内容')
  const ok = await card.finish({ status: 'done' })
  assert.equal(ok, false)
})

test('超长正文被截断后再推送', async () => {
  const api = makeApi()
  const card = makeCard(api, { maxChars: 500 })
  await card.start()
  card.append('a'.repeat(2000))
  await card.flushNow()
  const put = api.calls.find((call) => call[0] === 'putCardContent')
  assert.equal(put[2].length, 500)
})

test('finish 带 note 且无正文时用 note 作为终态正文', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  const ok = await card.finish({ status: 'failed', note: '执行失败：超时' })
  assert.equal(ok, true)
  const update = api.calls.find((call) => call[0] === 'updateCard')
  assert.equal(update[2].header.template, 'red')
  assert.equal(update[2].body.elements[0].content, '执行失败：超时')
})

test('dispose 后不再推送', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  card.dispose()
  card.append('之后的内容')
  await card.flushNow()
  assert.equal(api.calls.filter((call) => call[0] === 'putCardContent').length, 0)
})

test('工具调用会推送执行过程面板与标题', async () => {
  const api = makeApi()
  api.putProgress = async (cardId, content, sequence) => {
    api.calls.push(['putProgress', cardId, content, sequence])
  }
  api.putProgressPanel = async (cardId, title, sequence) => {
    api.calls.push(['putProgressPanel', cardId, title, sequence])
  }
  const card = makeCard(api)
  await card.start()
  card.trackToolCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
  await card.flushNow()

  const progress = api.calls.find((call) => call[0] === 'putProgress')
  assert.ok(progress)
  assert.ok(progress[2].startsWith('> '))
  assert.ok(progress[2].includes('bash'))
  const panel = api.calls.find((call) => call[0] === 'putProgressPanel')
  assert.ok(panel)
  assert.ok(panel[2].includes('正在执行 bash'))

  card.trackToolResult({ message: { callId: 'c1', isError: false } })
  await card.flushNow()
  const latest = api.calls.filter((call) => call[0] === 'putProgress').pop()
  assert.ok(latest[2].includes('✅'))
})

test('finish 时过程清单必须赶在关流式之前推送', async () => {
  const api = makeApi()
  api.putProgress = async (cardId, content, sequence) => {
    api.calls.push(['putProgress', cardId, content, sequence])
  }
  api.putProgressPanel = async (cardId, title, sequence) => {
    api.calls.push(['putProgressPanel', cardId, title, sequence])
  }
  const card = makeCard(api)
  await card.start()
  card.append('答案')
  card.trackToolCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
  await card.finish({ status: 'done' })

  const progressIndex = api.calls.findIndex((call) => call[0] === 'putProgress')
  const closeIndex = api.calls.findIndex((call) => call[0] === 'closeStreaming')
  assert.ok(progressIndex >= 0)
  assert.ok(progressIndex < closeIndex)
})

test('pauseForAsk 定格成橙色「等你选择」并关闭本卡', async () => {
  const api = makeApi()
  const card = makeCard(api, { key: 'oc_1' })
  await card.start()
  card.append('说到一半')
  const paused = await card.pauseForAsk('已暂停，等你先在选择题卡片上作答')
  assert.equal(paused, true)
  assert.equal(card.closed, true)

  const update = api.calls.find((call) => call[0] === 'updateCard')
  assert.equal(update[2].header.template, 'orange')
  assert.ok(update[2].body.elements[0].content.includes('已暂停'))
  // 定格后停止按钮仍在：用户可以直接放弃这轮
  assert.ok(update[2].body.elements.some((element) => element.tag === 'button'))

  // 定格之后不再接受正文与过程推送
  const putCount = api.calls.filter((call) => call[0] === 'putCardContent').length
  card.append('后续内容')
  await card.flushNow()
  assert.equal(api.calls.filter((call) => call[0] === 'putCardContent').length, putCount)
})

test('卡片还没建起来时 pauseForAsk 返回 false，由上层照常发问题卡', async () => {
  const api = makeApi()
  api.createCard = async () => {
    throw new Error('boom')
  }
  const card = makeCard(api)
  await card.start()
  assert.equal(await card.pauseForAsk('已暂停'), false)
  assert.equal(card.closed, true)
})
