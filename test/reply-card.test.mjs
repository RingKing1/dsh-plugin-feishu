import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplyCard } from '../lib/reply-card.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

/** 正文元件（过程面板启用时会排在它前面，不能再用 elements[0] 盲取） */
const contentOf = (card) => card.body.elements.find((element) => element.element_id === 'content').content

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
    async putProgress(cardId, markdown, sequence) {
      calls.push(['putProgress', cardId, markdown, sequence])
    },
    async putProgressPanel(cardId, title, sequence) {
      calls.push(['putProgressPanel', cardId, title, sequence])
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
  assert.equal(contentOf(update[2]), '最终答案')
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
  assert.equal(contentOf(update[2]), '执行失败：超时')
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
  const paused = await card.pauseForAsk('等你选择')
  assert.equal(paused, true)
  assert.equal(card.closed, true)

  const update = api.calls.find((call) => call[0] === 'updateCard')
  assert.equal(update[2].header.template, 'orange')
  assert.ok(contentOf(update[2]).includes('等你选择'))
  assert.equal(contentOf(update[2]), '等你选择\n\n说到一半', '备注与正文各出现一次，不能重复' )
  // 定格后停止按钮仍在：用户可以直接放弃这轮
  assert.ok(update[2].body.elements.some((element) => element.tag === 'button'))

  // 定格之后不再接受正文与过程推送
  const putCount = api.calls.filter((call) => call[0] === 'putCardContent').length
  card.append('后续内容')
  await card.flushNow()
  assert.equal(api.calls.filter((call) => call[0] === 'putCardContent').length, putCount)
})

test('markAnswered：把已关闭的暂停卡原地翻成灰色「已选择」', async () => {
  const api = makeApi()
  const card = makeCard(api, { key: 'oc_1' })
  await card.start()
  card.append('已经说到一半')
  await card.pauseForAsk('等你选择')
  const ok = await card.markAnswered()
  assert.equal(ok, true)

  const updates = api.calls.filter((call) => call[0] === 'updateCard')
  const final = updates[updates.length - 1][2]
  assert.equal(final.header.template, 'grey')
  assert.equal(final.header.title.content, '已选择')
  assert.equal(contentOf(final), '已经说到一半')
  assert.equal(final.body.elements.some((element) => element.tag === 'button'), false, '终态不再给停止按钮')
})

test('settlePaused：取消时把暂停卡翻成灰色「已停止」并带说明', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  await card.pauseForAsk('等你选择')
  assert.equal(await card.settlePaused('stopped', '提问已结束'), true)
  const updates = api.calls.filter((call) => call[0] === 'updateCard')
  const final = updates[updates.length - 1][2]
  assert.equal(final.header.template, 'grey')
  assert.equal(final.header.title.content, '已停止')
  assert.equal(contentOf(final), '提问已结束')
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

// ---- 帧状态机接线（正文只发最终回复）----

function startFrame(turn, step, attemptId, revision) {
  return { type: 'start', attemptId: attemptId || 'a' + turn + step, revision: revision || 0, turn, step }
}

function deltaFrame(attemptId, text) {
  return { type: 'chunk', attemptId, revision: 0, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } }
}

function endFrame(attemptId) {
  return { type: 'end', attemptId, revision: 0, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } }
}

test('onFrame 多步：finish 推送的正文只含最终回复，中间步进旁白', async () => {
  const api = makeApi()
  const card = makeCard(api)
  card.onFrame(startFrame(0, 0, 'att-1'))
  card.onFrame(deltaFrame('att-1', '我先看一下文件'))
  card.onFrame(endFrame('att-1'))
  card.onFrame(startFrame(0, 1, 'att-2'))
  card.onFrame(deltaFrame('att-2', '现在改代码'))
  card.onFrame(endFrame('att-2'))
  card.onFrame(startFrame(0, 2, 'att-3'))
  card.onFrame(deltaFrame('att-3', '改好了，结论是没问题'))
  card.onFrame(endFrame('att-3'))
  await card.finish({ status: 'done' })

  const contents = api.calls.filter((call) => call[0] === 'putCardContent').map((call) => call[2])
  const final = contents[contents.length - 1]
  assert.equal(final, '改好了，结论是没问题')
  // 中间步骤的旁白进过程面板，不再出现在正文里
  const progress = api.calls.filter((call) => call[0] === 'putProgress').map((call) => call[2])
  const panel = progress.join('\n')
  assert.ok(panel.includes('我先看一下文件'))
  assert.ok(panel.includes('现在改代码'))
  assert.equal(final.includes('我先看一下文件'), false)
})

test('同步重试：废弃 attempt 的文本被清掉，不污染最终正文', async () => {
  const api = makeApi()
  const card = makeCard(api)
  card.onFrame(startFrame(0, 0, 'att-1', 0))
  card.onFrame(deltaFrame('att-1', '这是要被丢弃的半截'))
  card.onFrame(startFrame(0, 0, 'att-2', 1))
  card.onFrame(deltaFrame('att-2', '真正的回答'))
  card.onFrame(endFrame('att-2'))
  await card.finish({ status: 'done' })

  const contents = api.calls.filter((call) => call[0] === 'putCardContent').map((call) => call[2])
  assert.equal(contents[contents.length - 1], '真正的回答')
})

test('正文清空时不推空串：占位文本顶上（飞书拒空 content）', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  card.setText('')
  await card.flushNow()
  const contents = api.calls.filter((call) => call[0] === 'putCardContent').map((call) => call[2])
  assert.equal(contents[contents.length - 1], '正在处理…')
  assert.equal(contents.includes(''), false)
})

test('执行中的占位直接报正在跑的工具，不是干巴巴一句「正在处理」', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  card.trackToolCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' })
  await card.flushNow()
  const contents = api.calls.filter((call) => call[0] === 'putCardContent').map((call) => call[2])
  assert.equal(contents[contents.length - 1], '⏳ 正在执行 bash ls -la…')

  // 工具跑完、模型还没开口：退回通用占位
  card.trackToolResult({ callId: 'c1', ok: true })
  card.setText('')
  await card.flushNow()
  const after = api.calls.filter((call) => call[0] === 'putCardContent').map((call) => call[2])
  assert.equal(after[after.length - 1], '正在处理…')
})

test('切步不清空正文：工具执行期间上一步的文字还在，新步开口才替换', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  const startFrame = (step, attemptId) => ({ type: 'start', attemptId, revision: 0, turn: 0, step })
  const chunkFrame = (attemptId, body) => ({ type: 'chunk', attemptId, revision: 0, index: 0, chunk: body })

  card.onFrame(startFrame(0, 'a0'))
  card.onFrame(chunkFrame('a0', { type: 'text-delta', index: 0, text: '第一步的旁白' }))
  card.onFrame({ type: 'end', attemptId: 'a0', revision: 0, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })

  // 进入第二步（工具要跑一阵）：正文不能被清成占位
  card.onFrame(startFrame(1, 'a1'))
  card.trackToolCall({ callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' })
  await card.flushNow()
  assert.equal(card.bodyText(), '第一步的旁白')

  // 第二步开口：整段换成第二步的内容，不接在旧文本后面
  card.onFrame(chunkFrame('a1', { type: 'text-delta', index: 0, text: '最终结论' }))
  assert.equal(card.bodyText(), '最终结论')
})

test('末步为空：finish 回落到上一步的文本，卡片不留白', async () => {
  const api = makeApi()
  const card = makeCard(api)
  card.onFrame(startFrame(0, 0, 'att-1'))
  card.onFrame(deltaFrame('att-1', '先说一句'))
  card.onFrame(endFrame('att-1'))
  card.onFrame(startFrame(0, 1, 'att-2'))
  card.onFrame({ type: 'end', attemptId: 'att-2', revision: 0, index: 0, outcome: { kind: 'abandoned' } })
  await card.finish({ status: 'done' })

  const contents = api.calls.filter((call) => call[0] === 'putCardContent').map((call) => call[2])
  assert.equal(contents[contents.length - 1], '先说一句')
})

test('max-tokens 截断：收尾备注里说明被截断', async () => {
  const api = makeApi()
  const card = makeCard(api)
  card.onFrame(startFrame(0, 0, 'att-1'))
  card.onFrame(deltaFrame('att-1', '说到一半'))
  card.onFrame({ type: 'chunk', attemptId: 'att-1', revision: 0, index: 1, time: 0, chunk: { type: 'finish', reason: { type: 'max-tokens' } } })
  card.onFrame(endFrame('att-1'))
  await card.finish({ status: 'done' })

  const updated = api.calls.filter((call) => call[0] === 'updateCard').map((call) => call[2])
  const note = JSON.stringify(updated[updated.length - 1])
  assert.ok(note.includes('长度上限'))
})

test('finish 会把折叠面板标题一起同步（关流后改不动了）', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  card.progress.trackCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
  card.progress.trackResult({ callId: 'c1', ok: true })
  card.progress.noteStep(1)
  await card.finish({ status: 'done' })
  const panel = api.calls.filter((call) => call[0] === 'putProgressPanel').at(-1)
  assert.ok(panel[2].startsWith('第 2 步 · 执行过程'))
  const update = api.calls.find((call) => call[0] === 'updateCard')
  assert.equal(update[2].body.elements.find((element) => element.element_id === 'progress_panel').header.title.content, panel[2])
})

test('建卡时就带上过程面板，第一次推送才落得上去', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  const created = api.calls.find((call) => call[0] === 'createCard')[1]
  const panel = created.body.elements.find((element) => element.element_id === 'progress_panel')
  assert.ok(panel, '建卡时没留面板元件，后面的 putProgress 会全部 400')
})

test('并发写入串行化：sequence 严格递增，不会出现倒序被飞书拒', async () => {
  const api = makeApi()
  const card = makeCard(api)
  await card.start()
  card.trackToolCall({ callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })
  card.setText('第一段')
  // 两拍并发：正文与过程各自入队
  await Promise.all([card.flush(), card.flushProgress()])
  const sequences = api.calls.filter((call) => typeof call[3] === 'number').map((call) => call[3])
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(sequences[index] > sequences[index - 1], 'sequence 必须严格递增：' + sequences.join(','))
  }
})
