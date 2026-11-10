import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApprovalCard, parseApprovalAction, APPROVAL_CARD_STATUS } from '../lib/approval-card.js'

test('buildApprovalCard：pending 有工具名、原因和两个按钮', () => {
  const card = buildApprovalCard({
    requestId: 'req-1',
    toolName: 'bash',
    reason: '要在工作区外执行 rm -rf build',
  })
  assert.equal(card.header.template, 'orange')
  const actions = card.elements.find((element) => element.tag === 'action')
  assert.ok(actions, '应有一个按钮组')
  assert.equal(actions.actions.length, 2)
  const values = actions.actions.map((action) => action.value)
  assert.deepEqual(values[0], { dsha: 'req-1', choice: 'allow' })
  assert.deepEqual(values[1], { dsha: 'req-1', choice: 'deny' })
  // 默认按钮必须是「拒绝」：手机误触的概率高于误判
  assert.equal(actions.actions[0].type, 'primary')
  assert.equal(actions.actions[1].type, 'danger')
})

test('buildApprovalCard：终态不再给按钮', () => {
  for (const status of ['approved', 'rejected', 'timeout', 'canceled']) {
    const card = buildApprovalCard({ requestId: 'req-1', toolName: 'bash', status })
    assert.equal(card.header.template, APPROVAL_CARD_STATUS[status].template)
    assert.equal(
      card.elements.some((element) => element.tag === 'action'),
      false,
      status + ' 不应再有按钮',
    )
  }
})

test('buildApprovalCard：超长工具名与原因被截断', () => {
  const card = buildApprovalCard({ requestId: 'r', toolName: 'x'.repeat(200), reason: 'y'.repeat(2000) })
  const tool = card.elements[0].text.content
  assert.ok(tool.length <= 90, '工具名应被截断')
  const reason = card.elements[1].text.content
  assert.ok(reason.length <= 610, '原因应被截断')
})

test('parseApprovalAction：解析允许 / 拒绝', () => {
  const allow = parseApprovalAction({
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { dsha: 'req-1', choice: 'allow' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
    },
  })
  assert.deepEqual(allow, {
    requestId: 'req-1',
    choice: 'allow',
    operatorOpenId: 'ou_1',
    chatId: 'oc_1',
    messageId: 'om_1',
  })

  const deny = parseApprovalAction({ action: { value: { dsha: 'req-2', choice: 'deny' } } })
  assert.equal(deny.choice, 'deny')
})

test('parseApprovalAction：不是授权卡片时返回 undefined', () => {
  assert.equal(parseApprovalAction(undefined), undefined)
  assert.equal(parseApprovalAction({}), undefined)
  // 选择题卡片的 value 用 dshq，不能被当成授权
  assert.equal(parseApprovalAction({ action: { value: { dshq: 'q-1', pick: ['A'] } } }), undefined)
  // 有 dsha 但 choice 不合法
  assert.equal(parseApprovalAction({ action: { value: { dsha: 'r', choice: 'maybe' } } }), undefined)
})
