import test from 'node:test'
import assert from 'node:assert/strict'
import { chatTypeName, formatSourceLine, senderTail } from '../lib/identity.js'

test('会话类型翻成中文，未知类型原样保留', () => {
  assert.equal(chatTypeName('p2p'), '单聊')
  assert.equal(chatTypeName('group'), '群聊')
  assert.equal(chatTypeName('topic'), 'topic')
  assert.equal(chatTypeName(''), '未知')
  assert.equal(chatTypeName(undefined), '未知')
})

test('open_id 只留尾部 8 位，短 id 原样返回', () => {
  assert.equal(senderTail('ou_1234567890abcdef'), '90abcdef')
  assert.equal(senderTail('ou_1'), 'ou_1')
  assert.equal(senderTail(''), '')
  assert.equal(senderTail(undefined), '')
})

test('来源标记包含会话类型与 open_id 尾号', () => {
  const line = formatSourceLine({ chatType: 'group', openId: 'ou_1234567890abcdef' })
  assert.equal(line, '【飞书 · 群聊 · 90abcdef】')
})

test('有姓名时姓名在前、尾号在括号里', () => {
  const line = formatSourceLine({ chatType: 'p2p', openId: 'ou_1234567890abcdef', senderName: '张三' })
  assert.equal(line, '【飞书 · 单聊 · 张三(90abcdef)】')
})

test('没有元数据时返回空串，消息不会多出空标题行', () => {
  assert.equal(formatSourceLine(undefined), '')
  assert.equal(formatSourceLine(null), '')
  assert.equal(formatSourceLine({}), '【飞书 · 未知】')
})

test('没有 open_id 时不渲染空的括号', () => {
  assert.equal(formatSourceLine({ chatType: 'p2p', openId: '' }), '【飞书 · 单聊】')
  assert.equal(formatSourceLine({ chatType: 'p2p', openId: '', senderName: '李四' }), '【飞书 · 单聊】')
})
