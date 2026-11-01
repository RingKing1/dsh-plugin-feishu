import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentPool } from '../lib/agents.js'

/** 造一个最小 ctx：agents 记录调用参数，agentDefaultModel 返回给定选择 */
function makePool(selection, options = {}) {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'sessionQuery' && (options.sessions !== undefined || options.observation !== undefined)) {
        return {
          async listSessions() { return options.sessions || [] },
          async observeSession() { return options.observation },
        }
      }
      if (name === 'agentPresets' && options.presets !== undefined) return options.presets
      if (name === 'workspaceRegistry' && options.workspaces !== undefined) {
        return { list: () => options.workspaces }
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
    config: { workdir: options.workdir ?? '/tmp', agentPreset: '', ...(options.config || {}) },
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
test('建会话后按 cwd 归入同路径工作区，已归过的不重复 attach', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'feishu-ws-'))
  const attached = []
  const workspace = {
    path: dir,
    sessionIds: [],
    async attachSession(id) {
      attached.push(id)
      this.sessionIds.push(id)
    },
  }
  const other = {
    path: join(dir, 'other'),
    sessionIds: [],
    async attachSession() {
      throw new Error('不该挂到别的工作区')
    },
  }
  const { pool } = makePool({ provider: 'p', model: 'm' }, {
    workdir: dir,
    workspaces: [other, workspace],
  })
  await pool.attachWorkspace('session-a', dir)
  await pool.attachWorkspace('session-a', dir)
  assert.deepEqual(attached, ['session-a'])

  // 没有同路径工作区时维持未分组，也不抛错
  await pool.attachWorkspace('session-b', join(dir, 'nowhere'))
})

test('归组失败只记日志，不打断消息收发', async () => {
  const { pool } = makePool({ provider: 'p', model: 'm' }, {
    workdir: '',
    workspaces: [{
      path: '/不存在的路径',
      sessionIds: [],
      async attachSession() { throw new Error('boom') },
    }],
  })
  await pool.attachWorkspace('session-x', '/tmp')
})
test('新建会话时按默认预设挂工具：meta 带 agentPreset，setup 会 mount', async () => {
  const mounted = []
  const presets = {
    async resolve(id) { return { id: id === undefined ? 'ptc' : id } },
    async mount(agentCtx, id) { mounted.push([agentCtx, id]) },
  }
  const { pool, calls } = makePool(undefined, { presets, workdir: '/tmp' })
  await pool.resolve('chat-preset')
  const create = calls.find(([kind]) => kind === 'create')
  assert.equal(create[1].meta.agentPreset, 'ptc')
  assert.equal(typeof create[1].setup, 'function')
  await create[1].setup({ scoped: true })
  assert.deepEqual(mounted, [[{ scoped: true }, 'ptc']])
})

test('配置里的 agentPreset 优先于默认预设', async () => {
  const presets = {
    calls: [],
    async resolve(id) { this.calls.push(id); return { id } },
    async mount() {},
  }
  const { pool, calls } = makePool(undefined, { presets, workdir: '/tmp', config: { agentPreset: 'standard' } })
  await pool.resolve('chat-preset-2')
  assert.deepEqual(presets.calls, ['standard'])
  assert.equal(calls.find(([kind]) => kind === 'create')[1].meta.agentPreset, 'standard')
})

test('恢复会话时沿用日志里记录的预设，并释放观测句柄', async () => {
  let disposed = false
  const mounted = []
  const presets = {
    async resolve(id) { return { id: id === undefined ? 'ptc' : id } },
    async mount(agentCtx, id) { mounted.push(id) },
  }
  const observation = {
    events: [
      { type: 'turn/start' },
      { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
    ],
    [Symbol.dispose]() { disposed = true },
  }
  const { pool, calls } = makePool(undefined, {
    presets,
    observation,
    workdir: '/tmp',
    saved: { sessionId: 'session-old', cwd: '/tmp' },
  })
  await pool.resolve('chat-preset-3')
  const resume = calls.find(([kind]) => kind === 'resume')
  assert.equal(typeof resume[1].setup, 'function')
  await resume[1].setup({})
  assert.deepEqual(mounted, ['minimal'])
  assert.equal(disposed, true)
})

test('没有 agentPresets 服务时照旧创建（不传 setup / 不写预设）', async () => {
  const { pool, calls } = makePool(undefined, { workdir: '/tmp' })
  await pool.resolve('chat-preset-4')
  const create = calls.find(([kind]) => kind === 'create')
  assert.equal(create[1].setup, undefined)
  assert.equal(create[1].meta.agentPreset, undefined)
})
