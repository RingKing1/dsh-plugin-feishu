import test from 'node:test'
import assert from 'node:assert/strict'
import { DONE_EMOJI, FAILED_EMOJI, ReactionManager } from '../lib/reaction.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

function makeApi() {
  const calls = []
  let counter = 0
  return {
    calls,
    async addReaction(messageId, emoji) {
      counter += 1
      calls.push(['add', messageId, emoji])
      return 're_' + counter
    },
    async deleteReaction(messageId, reactionId) {
      calls.push(['delete', messageId, reactionId])
    },
  }
}

test('收到消息时挂「收到」表情并记住 reactionId', async () => {
  const api = makeApi()
  const manager = new ReactionManager({ api, log: silentLog })
  await manager.markPending('om_1')
  assert.equal(api.calls[0][0], 'add')
  assert.equal(api.calls[0][2], 'Get')
  assert.equal(manager.pending.get('om_1'), 're_1')
})

test('同一条消息不会重复挂「收到」', async () => {
  const api = makeApi()
  const manager = new ReactionManager({ api, log: silentLog })
  await manager.markPending('om_1')
  await manager.markPending('om_1')
  assert.equal(api.calls.filter((call) => call[0] === 'add').length, 1)
})

test('完成后撤掉「收到」换上 DONE', async () => {
  const api = makeApi()
  const manager = new ReactionManager({ api, log: silentLog })
  await manager.markPending('om_1')
  await manager.settle('om_1', 'done')
  assert.deepEqual(api.calls.slice(1), [
    ['delete', 'om_1', 're_1'],
    ['add', 'om_1', DONE_EMOJI],
  ])
  assert.equal(manager.pending.has('om_1'), false)
})

test('失败后换上 CRY', async () => {
  const api = makeApi()
  const manager = new ReactionManager({ api, log: silentLog })
  await manager.markPending('om_1')
  await manager.settle('om_1', 'failed')
  assert.equal(api.calls[api.calls.length - 1][2], FAILED_EMOJI)
})

test('ignored 只撤不补，免得让用户以为任务跑了', async () => {
  const api = makeApi()
  const manager = new ReactionManager({ api, log: silentLog })
  await manager.markPending('om_1')
  await manager.settle('om_1', 'ignored')
  assert.deepEqual(api.calls.slice(1), [['delete', 'om_1', 're_1']])
})

test('接口失败只记录，不把异常抛给调用方', async () => {
  const api = {
    async addReaction() {
      throw new Error('boom')
    },
    async deleteReaction() {
      throw new Error('boom')
    },
  }
  const manager = new ReactionManager({ api, log: silentLog })
  await manager.markPending('om_1')
  assert.equal(manager.pending.size, 0)
  // 没有记录时 settle 不应发任何请求，也不该抛错
  await manager.settle('om_1', 'done')
})

test('clear 撤掉所有在册表情', async () => {
  const api = makeApi()
  const manager = new ReactionManager({ api, log: silentLog })
  await manager.markPending('om_1')
  await manager.markPending('om_2')
  await manager.clear()
  assert.equal(manager.pending.size, 0)
  assert.equal(api.calls.filter((call) => call[0] === 'delete').length, 2)
})

test('在册数量超上限时丢最旧的记录', async () => {
  const api = makeApi()
  const manager = new ReactionManager({ api, log: silentLog, limit: 2 })
  await manager.markPending('om_1')
  await manager.markPending('om_2')
  await manager.markPending('om_3')
  assert.equal(manager.pending.size, 2)
  assert.equal(manager.pending.has('om_1'), false)
  assert.equal(manager.pending.has('om_3'), true)
})
