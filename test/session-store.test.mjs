import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../lib/session-store.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

async function makePath() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-store-'))
  return join(dir, 'nested', 'state.json')
}

test('写入后能被新实例读回', async () => {
  const path = await makePath()
  const first = new SessionStore(path, silentLog)
  await first.load()
  await first.set('oc_1', { sessionId: 'session-1', cwd: '/tmp' })

  const second = new SessionStore(path, silentLog)
  await second.load()
  const value = second.get('oc_1')
  assert.equal(value.sessionId, 'session-1')
  assert.equal(value.cwd, '/tmp')
  assert.ok(value.updatedAt > 0)

  const raw = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(raw.version, 1)
})

test('文件不存在时按空映射启动', async () => {
  const path = await makePath()
  const store = new SessionStore(path, silentLog)
  await store.load()
  assert.equal(store.get('nope'), undefined)
})

test('损坏文件被改名备份，按空映射启动', async () => {
  const path = await makePath()
  const store = new SessionStore(path, silentLog)
  await store.set('oc_1', { sessionId: 'session-1' })
  await writeFile(path, 'not-json', 'utf8')

  const broken = new SessionStore(path, silentLog)
  await broken.load()
  assert.equal(broken.get('oc_1'), undefined)

  const { readdir } = await import('node:fs/promises')
  const files = await readdir(join(path, '..'))
  assert.ok(files.some((name) => name.includes('.corrupt-')))
})

test('delete 会同步落盘', async () => {
  const path = await makePath()
  const store = new SessionStore(path, silentLog)
  await store.set('oc_1', { sessionId: 'session-1' })
  await store.delete('oc_1')

  const reloaded = new SessionStore(path, silentLog)
  await reloaded.load()
  assert.equal(reloaded.get('oc_1'), undefined)
})
