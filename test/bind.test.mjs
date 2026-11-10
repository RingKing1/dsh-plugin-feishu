import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCommand, HELP_TEXT } from '../lib/commands.js'
import { AgentPool } from '../lib/agents.js'

function makeHost() {
  const calls = []
  return {
    calls,
    async bindSession(key, arg) {
      calls.push(['bindSession', key, arg])
      return '已绑定到会话：session-1'
    },
  }
}

test('/bind 与 /resume 都走 bindSession', async () => {
  const host = makeHost()
  const reply = await executeCommand(host, { chatId: 'oc_1' }, 'oc_1', { name: 'bind', args: '' })
  assert.equal(reply.reply, '已绑定到会话：session-1')
  assert.deepEqual(host.calls[0], ['bindSession', 'oc_1', ''])

  const resumed = await executeCommand(host, { chatId: 'oc_1' }, 'oc_1', { name: 'resume', args: '2' })
  assert.equal(resumed.reply, '已绑定到会话：session-1')
  assert.deepEqual(host.calls[1], ['bindSession', 'oc_1', '2'])
})

test('/help 里能看到 /bind 与 /resume', () => {
  assert.ok(HELP_TEXT.includes('/bind'))
  assert.ok(HELP_TEXT.includes('/resume'))
})

test('AgentPool.listSessions：映射字段、过滤子agent、缺服务时返回空', async () => {
  const records = [
    {
      header: { id: 'session-a', cwd: '/home/me/proj', createdAt: 1700000000000, delegationDepth: 0 },
      live: true,
    },
    {
      header: { id: 'session-child', cwd: '/home/me/proj', createdAt: 1699999999000, delegationDepth: 1 },
      live: false,
    },
    {
      header: { id: 'session-b', cwd: '', createdAt: 1699999998000 },
      live: false,
    },
  ]
  const ctx = { get: (name) => (name === 'sessionQuery' ? { listSessions: async () => records } : undefined) }
  const pool = new AgentPool({ ctx, config: {}, store: {}, log: { warn() {}, debug() {} } })

  const list = await pool.listSessions(10)
  assert.equal(list.length, 2, '子agent 会话不应出现')
  assert.deepEqual(list[0], { id: 'session-a', cwd: '/home/me/proj', createdAt: 1700000000000, live: true })
  assert.equal(list[1].id, 'session-b')
  assert.equal(list[1].cwd, '')

  const empty = new AgentPool({ ctx: { get: () => undefined }, config: {}, store: {}, log: { warn() {}, debug() {} } })
  assert.deepEqual(await empty.listSessions(10), [])
})
