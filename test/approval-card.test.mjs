import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildApprovalCard,
  parseApprovalAction,
  parseApprovalText,
  APPROVAL_CARD_TITLE,
  DECISION_ALLOW,
  DECISION_REJECT,
} from '../lib/approval-card.js'

test('审批卡片：标题、工具名与两个按钮都在', () => {
  const card = buildApprovalCard({
    requestId: 'req_1',
    toolName: 'bash',
    reason: '需要执行 rm -rf build',
    callId: 'call_9',
    timeoutMs: 300000,
    defaultOutcome: DECISION_REJECT,
  })
  assert.equal(card.header.title.content, APPROVAL_CARD_TITLE)
  const flat = JSON.stringify(card)
  assert.match(flat, /bash/)
  assert.match(flat, /rm -rf build/)
  assert.match(flat, /call_9/)
  const actions = card.elements.filter((element) => element.tag === 'action')
  assert.equal(actions.length, 1)
  assert.deepEqual(
    actions[0].actions.map((button) => button.value.decide),
    [DECISION_ALLOW, DECISION_REJECT],
  )
  assert.deepEqual(actions[0].actions[0].value, { dsha: 'req_1', decide: DECISION_ALLOW })
})

test('审批卡片：超时提示说清楚到点会怎样', () => {
  const reject = JSON.stringify(buildApprovalCard({ requestId: 'r', toolName: 'bash', timeoutMs: 300000, defaultOutcome: DECISION_REJECT }))
  assert.match(reject, /5 分钟内没有回复将按拒绝处理/)
  const allow = JSON.stringify(buildApprovalCard({ requestId: 'r', toolName: 'bash', timeoutMs: 60000, defaultOutcome: DECISION_ALLOW }))
  assert.match(allow, /1 分钟内没有回复将自动允许/)
})

test('审批卡片：过长的理由被截断', () => {
  const reason = 'x'.repeat(2000)
  const card = buildApprovalCard({ requestId: 'r', toolName: 'bash', reason, timeoutMs: 0 })
  const text = JSON.stringify(card)
  assert.match(text, /已截断/)
  assert.ok(text.length < 2000)
})

test('卡片回调：只有 dsha 与闭集里的决定才被认', () => {
  const parsed = parseApprovalAction({
    event: {
      action: { value: { dsha: 'req_1', decide: 'rejected' } },
      operator: { open_id: 'ou_1' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
    },
  })
  assert.deepEqual(parsed, {
    requestId: 'req_1',
    decision: DECISION_REJECT,
    operatorOpenId: 'ou_1',
    chatId: 'oc_1',
    messageId: 'om_1',
  })
  // 选择题卡片（dshq）不是审批卡片
  assert.equal(parseApprovalAction({ event: { action: { value: { dshq: 'q', pick: ['A'] } } } }), undefined)
  // 决定不在闭集里
  assert.equal(parseApprovalAction({ event: { action: { value: { dsha: 'req_1', decide: 'maybe' } } } }), undefined)
  // 空事件
  assert.equal(parseApprovalAction(undefined), undefined)
})

test('文字答复：只认明确的允许/拒绝', () => {
  for (const word of ['允许', '同意', '通过', ' OK ', 'yes', '1', 'approve']) {
    assert.equal(parseApprovalText(word), DECISION_ALLOW, word)
  }
  for (const word of ['拒绝', '不行', 'NO', '2', 'deny']) {
    assert.equal(parseApprovalText(word), DECISION_REJECT, word)
  }
  // 模糊的话不能猜：猜错就是放行了一次写操作
  for (const word of ['', '看起来可以', '等我想想', '可以吗']) {
    assert.equal(parseApprovalText(word), undefined, word)
  }
})
