import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '../lib/user-message.js'

test('不带元数据时正文保持原样', () => {
  const message = createUserMessage('你好')
  assert.equal(message.role, 'user')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, '你好')
  assert.deepEqual(message.source, { kind: 'user' })
})

test('带元数据时首行是来源标记，正文在第二行', () => {
  const message = createUserMessage('帮我看下这个报错', {
    chatType: 'group',
    openId: 'ou_1234567890abcdef',
    chatId: 'oc_1',
  })
  const lines = message.content[0].text.split('\n')
  assert.equal(lines[0], '【飞书 · 群聊 · 90abcdef】')
  assert.equal(lines[1], '帮我看下这个报错')
  assert.equal(lines.length, 2)
})

test('姓名进前缀，消息仍然深冻结', () => {
  const message = createUserMessage('嗯', { chatType: 'p2p', openId: 'ou_1234567890abcdef', senderName: '张三' })
  assert.ok(message.content[0].text.startsWith('【飞书 · 单聊 · 张三(90abcdef)】'))
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content[0]))
})

test('每条消息的 id 唯一', () => {
  const first = createUserMessage('a', { chatType: 'p2p', openId: 'ou_1' })
  const second = createUserMessage('a', { chatType: 'p2p', openId: 'ou_1' })
  assert.notEqual(first.id, second.id)
})

test('非字符串正文会被转成字符串', () => {
  const message = createUserMessage(42)
  assert.equal(message.content[0].text, '42')
})
