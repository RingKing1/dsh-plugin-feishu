import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMirrorCard, extractMessageText, MIRROR_CARD_STATUS } from '../lib/mirror-card.js'

test('buildMirrorCard：进行中状态 + 会话名 + 工具清单', () => {
  const card = buildMirrorCard({
    title: '修 CI',
    status: 'running',
    text: '正在跑测试',
    tools: [
      { name: 'bash', ok: true, detail: 'pnpm test' },
      { name: 'read', ok: undefined, detail: 'src/index.ts' },
    ],
    elapsedMs: 72_000,
  })
  assert.equal(card.header.template, MIRROR_CARD_STATUS.running.template)
  assert.equal(card.elements[0].text.content, '会话：修 CI')
  assert.equal(card.elements[1].text.content, '正在跑测试')
  const tools = card.elements[2].text.content
  assert.match(tools, /✅ bash · pnpm test/)
  assert.match(tools, /⏳ read · src\/index.ts/)
  const footer = card.elements.at(-1).elements[0].content
  assert.match(footer, /进行中/)
  assert.match(footer, /1:12/)
  assert.match(footer, /2 次工具调用/)
})

test('buildMirrorCard：终态不给「进行中」，也不含任何按钮', () => {
  for (const status of ['done', 'failed', 'stopped']) {
    const card = buildMirrorCard({ status, text: 'x' })
    assert.equal(card.header.template, MIRROR_CARD_STATUS[status].template)
    assert.equal(card.elements.some((element) => element.tag === 'action'), false)
    const footer = card.elements.at(-1).elements[0].content
    assert.doesNotMatch(footer, /操作请在电脑上/)
  }
})

test('buildMirrorCard：超长正文与工具清单都被截断', () => {
  const card = buildMirrorCard({
    status: 'running',
    text: 'x'.repeat(5000),
    tools: Array.from({ length: 15 }, (_, index) => ({ name: 'tool' + index, ok: true })),
  })
  const body = card.elements.find((element) => element.text && element.text.tag === 'lark_md')
  assert.ok(body.text.content.length <= 1501)
  const tools = card.elements.find((element) => String(element.text && element.text.content).startsWith('执行过程'))
  assert.match(tools.text.content, /tool14/)
  assert.match(tools.text.content, /更早 7 条省略/)
})

test('extractMessageText：只取 text 块，忽略 tool_use', () => {
  const message = {
    content: [
      { type: 'text', text: '第一段' },
      { type: 'tool_use', id: 't1', name: 'bash' },
      { type: 'text', text: '第二段' },
    ],
  }
  assert.equal(extractMessageText(message), '第一段第二段')
  assert.equal(extractMessageText(undefined), '')
  assert.equal(extractMessageText({ content: [] }), '')
})
