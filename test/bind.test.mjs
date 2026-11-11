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
  assert.deepEqual(list[0], { id: 'session-a', cwd: '/home/me/proj', createdAt: 1700000000000, live: true, title: '' })
  assert.equal(list[1].id, 'session-b')
  assert.equal(list[1].cwd, '')

  const empty = new AgentPool({ ctx: { get: () => undefined }, config: {}, store: {}, log: { warn() {}, debug() {} } })
  assert.deepEqual(await empty.listSessions(10), [])
})

test('/model /effort /permission 都返回卡片而不是文本', async () => {
  const calls = []
  const host = {
    async modelCard(key) {
      calls.push(['model', key])
      return { header: { title: { content: '选择模型' } } }
    },
    async effortCard(key, arg) {
      calls.push(['effort', key, arg])
      return { header: { title: { content: '选择推理强度' } } }
    },
    async permissionCard(key) {
      calls.push(['permission', key])
      return { header: { title: { content: '选择权限模式' } } }
    },
  }

  const model = await executeCommand(host, {}, 'oc_1', { name: 'model', args: '' })
  assert.equal(model.card.header.title.content, '选择模型')
  assert.equal(model.reply, undefined)

  const effort = await executeCommand(host, {}, 'oc_1', { name: 'effort', args: 'deepseek-account/flash' })
  assert.equal(effort.card.header.title.content, '选择推理强度')
  assert.deepEqual(calls[1], ['effort', 'oc_1', 'deepseek-account/flash'])

  // 别名
  const reasoning = await executeCommand(host, {}, 'oc_1', { name: 'reasoning', args: '' })
  assert.ok(reasoning.card)
  const mode = await executeCommand(host, {}, 'oc_1', { name: 'mode', args: '' })
  assert.equal(mode.card.header.title.content, '选择权限模式')
})

test('/status 有权限时多打一行', async () => {
  const host = {
    describeStatus: () => ({ sessionId: 'session-1', cwd: '/tmp', status: 'idle', model: 'p/m', permission: 'workspace-write' }),
  }
  const result = await executeCommand(host, {}, 'oc_1', { name: 'status', args: '' })
  assert.match(result.reply, /权限：workspace-write/)
})

test('listSessions：标题按 sessionQuery.readTitleSnapshots 回填，失败不影响列表', async () => {
  const records = [
    { header: { id: 'session-a', cwd: '/home/me/proj', createdAt: 1700000000000 }, live: false },
    { header: { id: 'session-b', cwd: '/home/me/proj', createdAt: 1699999998000 }, live: false },
  ]
  const ctx = {
    get: (name) => {
      if (name !== 'sessionQuery') return undefined
      return {
        listSessions: async () => records,
        readTitleSnapshots: async (ids) => [
          { sessionId: ids[0], status: 'fulfilled', value: { title: { title: '修 CI 流水线' } } },
          { sessionId: ids[1], status: 'rejected', reason: new Error('gone') },
        ],
      }
    },
  }
  const pool = new AgentPool({ ctx, config: {}, store: {}, log: { warn() {}, debug() {} } })
  const list = await pool.listSessions(10)
  assert.equal(list[0].title, '修 CI 流水线')
  assert.equal(list[1].title, '')
})

test('listSessions：没有 readTitleSnapshots 时标题为空串，不抛错', async () => {
  const records = [{ header: { id: 'session-a', cwd: '', createdAt: 1 }, live: true }]
  const ctx = { get: () => ({ listSessions: async () => records }) }
  const pool = new AgentPool({ ctx, config: {}, store: {}, log: { warn() {}, debug() {} } })
  const list = await pool.listSessions(5)
  assert.deepEqual(list[0].title, '')
})

test('listSessions(titledOnly)：只保留有标题的会话，且取够数量', async () => {
  const records = [
    { header: { id: 'a', cwd: '/p', createdAt: 5 }, live: false },
    { header: { id: 'b', cwd: '/p', createdAt: 4 }, live: false },
    { header: { id: 'c', cwd: '/p', createdAt: 3 }, live: false },
  ]
  const ctx = {
    get: () => ({
      listSessions: async () => records,
      readTitleSnapshots: async (ids) =>
        ids.map((id) => ({
          sessionId: id,
          status: 'fulfilled',
          value: id === 'b' ? {} : { title: { title: '标题-' + id } },
        })),
    }),
  }
  const pool = new AgentPool({ ctx, config: {}, store: {}, log: { warn() {}, debug() {} } })
  const all = await pool.listSessions(10)
  assert.equal(all.length, 3, '默认不过滤')
  const titled = await pool.listSessions(10, { titledOnly: true })
  assert.deepEqual(titled.map((item) => item.id), ['a', 'c'])
})
