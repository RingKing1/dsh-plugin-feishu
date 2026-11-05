import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardRegistry, cardRegistryPath, sweepStaleCards } from '../lib/card-registry.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const tempFile = () => join(mkdtempSync(join(tmpdir(), 'feishu-cards-')), 'running-cards-cli_1.json')

test('add / remove 会落盘，load 能读回来（崩溃后靠它兜底）', async () => {
  const path = tempFile()
  const registry = new CardRegistry(path, silentLog)
  await registry.load()
  await registry.add({ cardId: 'card_1', key: 'k1', chatId: 'oc_1', title: '飞书 · 1', since: 1 })
  await registry.add({ cardId: 'card_2', key: 'k2', chatId: 'oc_2', title: '飞书 · 2', since: 2 })
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.length, 2)
  await registry.remove('card_1')

  const reloaded = new CardRegistry(path, silentLog)
  const items = await reloaded.load()
  assert.deepEqual(items.map((item) => item.cardId), ['card_2'])
})

test('文件不存在或内容坏掉都不阻断启动', async () => {
  const path = tempFile()
  const registry = new CardRegistry(path, silentLog)
  assert.deepEqual(await registry.load(), [])
  await registry.add({ cardId: 'card_1', key: 'k1' })
  const broken = new CardRegistry(path + '.broken', silentLog)
  assert.deepEqual(await broken.load(), [])
})

test('sweepStaleCards：逐张翻成已中断，单张失败不影响其它', async () => {
  const path = tempFile()
  const registry = new CardRegistry(path, silentLog)
  await registry.add({ cardId: 'card_ok', key: 'k1', title: '飞书 · 1' })
  await registry.add({ cardId: 'card_bad', key: 'k2', title: '飞书 · 2' })
  const updated = []
  const api = {
    async updateCard(cardId, card, sequence) {
      if (cardId === 'card_bad') throw new Error('message not found')
      updated.push([cardId, card, sequence])
    },
  }
  const count = await sweepStaleCards(registry, api, silentLog, '服务重启中')
  assert.equal(count, 1)
  assert.equal(updated[0][0], 'card_ok')
  assert.match(JSON.stringify(updated[0][1]), /服务重启中/)
  assert.match(JSON.stringify(updated[0][1]), /已中断/)
  // 成功的与失败的都从在册表移除：失败的重启再试也没意义，避免永远残留
  assert.deepEqual(registry.list(), [])
})

test('cardRegistryPath：与 statePath 同目录，按 appId 分开且文件名安全', () => {
  const path = cardRegistryPath('/tmp/state/state.json', 'cli_a/b')
  assert.equal(path, '/tmp/state/running-cards-cli_a_b.json')
})
