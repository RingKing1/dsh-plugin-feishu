import test from 'node:test'
import assert from 'node:assert/strict'
import { HELP_TEXT, executeCommand, parseCommand } from '../lib/commands.js'

function makeHost() {
  const calls = []
  return {
    calls,
    async newSession(key) {
      calls.push(['newSession', key])
    },
    async stopTurn(key) {
      calls.push(['stopTurn', key])
      return true
    },
    describeStatus() {
      return { sessionId: 'session-1', cwd: '/tmp/demo', status: 'idle', model: 'deepseek/flash' }
    },
    async setWorkdir(key, arg) {
      calls.push(['setWorkdir', key, arg])
      return '已记录本会话的工作目录：' + arg
    },
  }
}

test('parseCommand 解析命令与参数', () => {
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: '' })
  assert.deepEqual(parseCommand('  /CWD  /a b '), { name: 'cwd', args: '/a b' })
  assert.equal(parseCommand('普通消息'), undefined)
  assert.equal(parseCommand('/'), undefined)
  assert.equal(parseCommand(''), undefined)
})

test('/help 返回说明', async () => {
  const result = await executeCommand(makeHost(), { chatId: 'oc_1' }, 'oc_1', { name: 'help', args: '' })
  assert.equal(result.reply, HELP_TEXT)
  assert.ok(HELP_TEXT.includes('/new'))
  assert.ok(HELP_TEXT.includes('/stop'))
})

test('/new 结束当前会话', async () => {
  const host = makeHost()
  const result = await executeCommand(host, { chatId: 'oc_1' }, 'oc_1', { name: 'new', args: '' })
  assert.deepEqual(host.calls, [['newSession', 'oc_1']])
  assert.ok(result.reply.includes('新会话'))
})

test('/stop 报告是否真的中断', async () => {
  const host = makeHost()
  host.stopTurn = async () => false
  const result = await executeCommand(host, { chatId: 'oc_1' }, 'oc_1', { name: 'stop', args: '' })
  assert.ok(result.reply.includes('没有正在运行'))
})

test('/status 汇总会话信息', async () => {
  const result = await executeCommand(makeHost(), { chatId: 'oc_1' }, 'oc_1', { name: 'status', args: '' })
  assert.ok(result.reply.includes('session-1'))
  assert.ok(result.reply.includes('/tmp/demo'))
  assert.ok(result.reply.includes('deepseek/flash'))
})

test('/cwd 转发参数给宿主', async () => {
  const host = makeHost()
  const result = await executeCommand(host, { chatId: 'oc_1' }, 'oc_1', { name: 'cwd', args: '/srv/app' })
  assert.deepEqual(host.calls, [['setWorkdir', 'oc_1', '/srv/app']])
  assert.ok(result.reply.includes('/srv/app'))
})

test('/whoami 回显身份信息', async () => {
  const message = { chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_1' }
  const result = await executeCommand(makeHost(), message, 'oc_1', { name: 'whoami', args: '' })
  assert.ok(result.reply.includes('ou_1'))
  assert.ok(result.reply.includes('oc_1'))
})

test('未知命令给出帮助', async () => {
  const result = await executeCommand(makeHost(), { chatId: 'oc_1' }, 'oc_1', { name: 'rm', args: '' })
  assert.ok(result.reply.startsWith('未知命令：/rm'))
  assert.ok(result.reply.includes(HELP_TEXT))
})
