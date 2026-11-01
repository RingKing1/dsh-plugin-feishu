import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationKey, extractText, normalizeEvent, stripMentions } from '../lib/inbound.js'

const BOT = 'ou_bot'

function textEvent(overrides) {
  const message = Object.assign(
    {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '你好' }),
      create_time: '1700000000000',
    },
    overrides && overrides.message,
  )
  const sender = Object.assign(
    { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    overrides && overrides.sender,
  )
  return { schema: '2.0', event: { message, sender } }
}

test('单聊文本消息被归一化成 message', () => {
  const result = normalizeEvent(textEvent(), { botOpenId: BOT, requireMentionInGroup: true })
  assert.equal(result.kind, 'message')
  assert.equal(result.messageId, 'om_1')
  assert.equal(result.chatId, 'oc_1')
  assert.equal(result.chatType, 'p2p')
  assert.equal(result.senderOpenId, 'ou_user')
  assert.equal(result.text, '你好')
  assert.equal(result.createdAt, 1700000000000)
})

test('缺 message 的事件被忽略', () => {
  assert.equal(normalizeEvent({}, {}).reason, 'no-message')
  assert.equal(normalizeEvent(undefined, {}).reason, 'no-message')
  assert.equal(normalizeEvent({ event: { message: { message_id: 'x' } } }, {}).reason, 'no-message')
})

test('机器人自己发的消息被忽略，避免自问自答', () => {
  const raw = textEvent({ sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } } })
  assert.equal(normalizeEvent(raw, { botOpenId: BOT }).reason, 'sender-app')
})

test('群聊未 @ 机器人时忽略', () => {
  const raw = textEvent({ message: { chat_type: 'group' } })
  assert.equal(normalizeEvent(raw, { botOpenId: BOT, requireMentionInGroup: true }).reason, 'no-mention')
})

test('群聊关闭 requireMentionInGroup 时不 @ 也处理', () => {
  const raw = textEvent({ message: { chat_type: 'group' } })
  const result = normalizeEvent(raw, { botOpenId: BOT, requireMentionInGroup: false })
  assert.equal(result.kind, 'message')
})

test('群聊 @ 机器人后取正文并去掉占位符', () => {
  const raw = textEvent({
    message: {
      chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 帮我看看构建日志' }),
      mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: '机器人' }],
    },
  })
  const result = normalizeEvent(raw, { botOpenId: BOT, requireMentionInGroup: true })
  assert.equal(result.kind, 'message')
  assert.equal(result.text, '帮我看看构建日志')
})

test('非文本消息返回 unsupported 并带上类型', () => {
  const raw = textEvent({ message: { message_type: 'image', content: '{}' } })
  const result = normalizeEvent(raw, {})
  assert.equal(result.reason, 'unsupported-image')
  assert.equal(result.messageType, 'image')
  assert.equal(result.chatId, 'oc_1')
})

test('空白正文被忽略', () => {
  const raw = textEvent({ message: { content: JSON.stringify({ text: '   ' }) } })
  assert.equal(normalizeEvent(raw, {}).reason, 'empty-text')
})

test('content 不是合法 JSON 时返回空文本', () => {
  assert.equal(extractText({ message_type: 'text', content: '{bad' }), '')
  assert.equal(extractText({ message_type: 'image', content: '{}' }), '')
})

test('stripMentions 去掉所有占位符并压缩空白', () => {
  const text = stripMentions('@_user_1  看下   @_user_2 这个', [
    { key: '@_user_1' },
    { key: '@_user_2' },
  ])
  assert.equal(text, '看下 这个')
})

test('会话键区分同一群的不用话题', () => {
  assert.equal(conversationKey({ chatId: 'oc_1', threadId: '' }), 'oc_1')
  assert.equal(conversationKey({ chatId: 'oc_1', threadId: 'omt_9' }), 'oc_1:omt_9')
})
