import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTENT_ELEMENT_ID,
  PROGRESS_ELEMENT_ID,
  PROGRESS_PANEL_ID,
  TRUNCATED_MARK,
  buildCard,
  clipText,
} from '../lib/card.js'

test('running 卡片开启流式并指定正文元件 id', () => {
  const card = buildCard({ status: 'running', title: '提问 · 123456', body: '第一段', streaming: true })
  assert.equal(card.schema, '2.0')
  assert.equal(card.config.streaming_mode, true)
  assert.equal(card.config.update_multi, true)
  assert.ok(card.config.streaming_config.print_frequency_ms.default > 0)
  assert.equal(card.header.template, 'blue')
  assert.equal(card.header.title.content, '提问 · 123456')
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.equal(card.body.elements[0].element_id, CONTENT_ELEMENT_ID)
  assert.equal(card.body.elements[0].content, '第一段')
})

test('终态卡片不开启流式，标题回落到状态默认值', () => {
  const done = buildCard({ status: 'done', body: '完成', streaming: true })
  assert.equal(done.config.streaming_mode, false)
  assert.equal(done.config.streaming_config, undefined)
  assert.equal(done.header.template, 'green')
  assert.equal(done.header.title.content, '回复')

  assert.equal(buildCard({ status: 'failed' }).header.template, 'red')
  assert.equal(buildCard({ status: 'stopped' }).header.template, 'grey')
})

test('未知状态按 running 处理，空正文用占位符', () => {
  const card = buildCard({ status: 'whatever', body: '   ' })
  assert.equal(card.header.template, 'blue')
  // 中间态不能留白：留白会让用户以为卡片坏了
  assert.equal(card.body.elements[0].content, '正在回复…')
})

test('执行过程面板排在正文之前，并带自己的元件 id', () => {
  const card = buildCard({
    status: 'running',
    body: '答案',
    progress: '> ⏳ **bash** `ls`',
    progressTitle: '执行过程（正在执行 bash）',
  })
  assert.equal(card.body.elements.length, 2)
  const panel = card.body.elements[0]
  assert.equal(panel.tag, 'collapsible_panel')
  assert.equal(panel.element_id, PROGRESS_PANEL_ID)
  assert.equal(panel.expanded, false)
  assert.equal(panel.header.title.content, '执行过程（正在执行 bash）')
  assert.equal(panel.elements[0].element_id, PROGRESS_ELEMENT_ID)
  assert.equal(panel.elements[0].content, '> ⏳ **bash** `ls`')
  assert.equal(card.body.elements[1].element_id, CONTENT_ELEMENT_ID)
  assert.equal(card.body.elements[1].content, '答案')
})

test('中间态带 key 时出现停止按钮，终态不出现', () => {
  const running = buildCard({ status: 'running', key: 'oc_1' })
  const button = running.body.elements[running.body.elements.length - 1]
  assert.equal(button.tag, 'button')
  assert.equal(button.value.dshstop, 'oc_1')
  assert.equal(button.behaviors[0].value.dshstop, 'oc_1')

  const done = buildCard({ status: 'done', key: 'oc_1' })
  assert.equal(done.body.elements.some((element) => element.tag === 'button'), false)
})

test('paused 卡片橙色、备注在正文前、正文为空用等待占位', () => {
  const card = buildCard({ status: 'paused', note: '已暂停' })
  assert.equal(card.header.template, 'orange')
  assert.equal(card.header.title.content, '等你选择')
  assert.equal(card.config.streaming_mode, false)
  assert.equal(card.body.elements[0].content, '已暂停\n\n（已暂停，等你先在选择题卡片上作答）')
})

test('clipText 不超限时原样返回', () => {
  assert.equal(clipText('短文本', 100), '短文本')
  assert.equal(clipText('', 100), '')
  assert.equal(clipText(undefined, 100), '')
})

test('clipText 超限时截断并带省略标记', () => {
  const result = clipText('a'.repeat(200), 100)
  assert.equal(result.length, 100)
  assert.ok(result.endsWith(TRUNCATED_MARK))
})
