import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentPool } from '../lib/agents.js'

/** 造一个最小 ctx：agents 记录调用参数，agentDefaultModel 返回给定选择 */
function makePool(selection, options = {}) {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'sessionQuery' && options.sessions !== undefined) {
        return { async listSessions() { return options.sessions } }
      }
      if (name === 'agentDefaultModel') {
        if (selection === 'throw') return { currentSelection() { throw new Error('boom') } }
        if (selection === undefined) return undefined
        return { currentSelection: () => selection }
      }
      return undefined
    },
    agents: {
      async create(input) {
        calls.push(['create', input])
        return { agent: { ctx: { on: () => () => {} } } }
      },
      async resume(input) {
        calls.push(['resume', input])
        return { agent: { ctx: { on: () => () => {} } } }
      },
    },
  }
  const store = {
    sessions: new Map(options.ownSessions || []),
    get: () => options.saved,
    set: async () => {},
  }
  const pool = new AgentPool({
    ctx,
    config: { workdir: options.workdir ?? '/tmp' },
    store,
    log: { info() {}, warn() {}, debug() {}, error() {} },
  })
  return { pool, calls }
}

test('新建会话带上 profile 的默认模型（否则 dsh 会报 has no provider/model）', async () => {
  const { pool, calls } = makePool({ provider: 'deepseek-official', model: 'deepseek-flash' })
  await pool.resolve('chat-1')
  const [, input] = calls[0]
  assert.equal(calls[0][0], 'create')
  assert.deepEqual(input.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('默认选择带 reasoningEffort 时一起传', async () => {
  const { pool, calls } = makePool({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  await pool.resolve('chat-1')
  assert.equal(calls[0][1].agentOptions.reasoningEffort, 'high')
})

test('恢复已有会话也带上默认模型（老会话可能没记录过选择）', async () => {
  const { pool, calls } = makePool({ provider: 'p', model: 'm' }, { saved: { sessionId: 'session-x', cwd: '/tmp' } })
  await pool.resolve('chat-1')
  assert.equal(calls[0][0], 'resume')
  assert.deepEqual(calls[0][1].agentOptions, { provider: 'p', model: 'm' })
})

test('没有默认模型服务 / 选择为空 / 读取抛错时不塞空值', () => {
  for (const selection of [undefined, { provider: '', model: '' }, 'throw']) {
    const { pool } = makePool(selection)
    assert.equal(pool.defaultAgentOptions(), undefined)
  }
})
test('工作目录：显式配置优先，其次用这个 chat 上次的目录', async () => {
  const explicit = makePool({ provider: 'p', model: 'm' }, {
    workdir: '/work/explicit',
    saved: { sessionId: 'session-x', cwd: '/work/saved' },
  })
  await explicit.pool.resolve('chat-1')
  await explicit.pool.resolve('chat-2')
  assert.equal(explicit.pool.config.workdir, '/work/explicit')

  const { pool } = makePool({ provider: 'p', model: 'm' }, { workdir: '', saved: { sessionId: 'session-x', cwd: '/work/saved' } })
  assert.equal(await pool.resolveCwd('/work/saved'), '/work/saved')
})

test('工作目录没配时跟最近一次 dsh 会话的工作区（而不是桌面壳的安装目录）', async () => {
  const { pool } = makePool({ provider: 'p', model: 'm' }, {
    workdir: '',
    sessions: [
      { header: { id: 'session-old', cwd: '/work/old', createdAt: 1 } },
      { header: { id: 'session-new', cwd: '/work/new', createdAt: 99 } },
    ],
  })
  assert.equal(await pool.resolveCwd(undefined), '/work/new')
})

test('推断工作区时排除飞书自己建的会话，避免自我强化', async () => {
  const { pool } = makePool({ provider: 'p', model: 'm' }, {
    workdir: '',
    ownSessions: [['chat-1', { sessionId: 'session-own', cwd: '/work/desktop-shell', updatedAt: 1 }]],
    sessions: [
      { header: { id: 'session-own', cwd: '/work/desktop-shell', createdAt: 100 } },
      { header: { id: 'session-human', cwd: '/work/project', createdAt: 50 } },
    ],
  })
  assert.equal(await pool.resolveCwd(undefined), '/work/project')
})

test('没有会话可参考时退回进程 cwd', async () => {
  const { pool } = makePool({ provider: 'p', model: 'm' }, { workdir: '' })
  assert.equal(await pool.resolveCwd(undefined), process.cwd())
})
test('老映射里记着进程 cwd 时按未设置处理，重新推断工作区', async () => {
  const { pool } = makePool({ provider: 'p', model: 'm' }, {
    workdir: '',
    sessions: [{ header: { id: 'session-human', cwd: '/work/project', createdAt: 10 } }],
  })
  assert.equal(await pool.resolveCwd(process.cwd()), '/work/project')
})
