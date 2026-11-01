import test from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT_ELEMENT_ID, TRUNCATED_MARK, buildCard, clipText } from '../lib/card.js'

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
  assert.equal(card.body.elements[0].content, ' ')
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
