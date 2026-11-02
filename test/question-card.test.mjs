import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQuestionCard, parseCardAction, QUESTION_CARD_TITLE } from '../lib/question-card.js'

const questions = [
  {
    id: 'q1',
    question: '用哪个方案？',
    detail: 'A 快但糙，B 慢但稳',
    options: [{ label: '方案 A' }, { label: '方案 B' }],
  },
]

test('卡片包含题干、备注与按选项生成的按钮', () => {
  const card = buildQuestionCard({ questions, requestId: 'r1' })
  assert.equal(card.config.wide_screen_mode, true)
  assert.equal(card.header.title.content, QUESTION_CARD_TITLE)

  const action = card.elements.find((element) => element.tag === 'action')
  assert.ok(action, '缺少按钮行')
  assert.equal(action.actions.length, 2)
  assert.deepEqual(action.actions[0].value, { dshq: 'r1', qid: 'q1', pick: ['方案 A'] })
  // 第一项是推荐项，用主按钮
  assert.equal(action.actions[0].type, 'primary')
  assert.equal(action.actions[1].type, 'default')
})

test('题干用 plain_text，避免 markdown 吃掉符号', () => {
  const card = buildQuestionCard({ questions: [{ id: 'q', question: '选 *这个* 还是 _那个_' }], requestId: 'r' })
  assert.equal(card.elements[0].text.tag, 'plain_text')
  assert.equal(card.elements[0].text.content, '1. 选 *这个* 还是 _那个_')
})

test('题目没有选项时仍然带一行文字作答提示', () => {
  const card = buildQuestionCard({ questions: [{ id: 'q', question: '叫什么名字？' }], requestId: 'r' })
  assert.equal(card.elements.some((element) => element.tag === 'action'), false)
  assert.equal(card.elements[card.elements.length - 1].tag, 'note')
})

test('多选题给出可多选的文字提示', () => {
  const card = buildQuestionCard({ questions: [{ id: 'q', question: '选哪些？', options: [{ label: 'x' }], multiSelect: true }], requestId: 'r' })
  const notes = card.elements.filter((element) => element.tag === 'note').map((element) => element.elements[0].content)
  assert.ok(notes.some((text) => text.includes('可多选')))
})

test('选项超过 6 个时只渲染 6 个按钮，其余提示用文字', () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ label: '选项' + (index + 1) }))
  const card = buildQuestionCard({ questions: [{ id: 'q', question: '选一个', options: many }], requestId: 'r' })
  const action = card.elements.find((element) => element.tag === 'action')
  assert.equal(action.actions.length, 6)
  const notes = card.elements.filter((element) => element.tag === 'note').map((element) => element.elements[0].content)
  assert.ok(notes.some((text) => text.includes('选项7')))
})

test('解析按钮回调：取到 requestId / qid / pick / 操作人 / 会话', () => {
  const parsed = parseCardAction({
    event: {
      operator: { open_id: 'ou_user' },
      action: { value: { dshq: 'r1', qid: 'q1', pick: ['方案 B'] }, tag: 'button' },
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
    },
  })
  assert.equal(parsed.requestId, 'r1')
  assert.equal(parsed.questionId, 'q1')
  assert.deepEqual(parsed.picks, ['方案 B'])
  assert.equal(parsed.operatorOpenId, 'ou_user')
  assert.equal(parsed.chatId, 'oc_1')
  assert.equal(parsed.messageId, 'om_1')
})

test('不是本插件的按钮（没有 dshq）返回 undefined', () => {
  assert.equal(parseCardAction({ event: { action: { value: { foo: 'bar' } } } }), undefined)
  assert.equal(parseCardAction({ event: { action: { value: 'x' } } }), undefined)
  assert.equal(parseCardAction({ event: {} }), undefined)
  assert.equal(parseCardAction(undefined), undefined)
})

test('pick 是字符串时归一化成数组', () => {
  const parsed = parseCardAction({ event: { action: { value: { dshq: 'r', qid: 'q', pick: 'A' } } } })
  assert.deepEqual(parsed.picks, ['A'])
})
