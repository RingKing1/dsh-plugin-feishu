import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentPool } from '../lib/agents.js'

/** 造一个最小 ctx：agents 记录调用参数，agentDefaultModel 返回给定选择 */
function makePool(selection, options = {}) {
  const calls = []
  const ctx = {
    get(name) {
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
    get: () => options.saved,
    set: async () => {},
  }
  const pool = new AgentPool({
    ctx,
    config: { workdir: '/tmp' },
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
