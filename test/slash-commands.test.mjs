import test from 'node:test'
import assert from 'node:assert/strict'
import { syncSlashCommands, autoSyncSlashCommands, SLASH_COMMANDS } from '../lib/slash-commands.js'

/** 造一个假 API：记录调用，按需返回已注册列表或抛错 */
function makeApi(remote, options = {}) {
  const calls = []
  return {
    calls,
    async request(method, path, body) {
      calls.push([method, path, body])
      if (options.error) throw options.error
      if (method === 'GET') {
        if (options.failList) throw new Error('permission denied: application:app_slash_command:write')
        return { data: { items: remote.items || [], has_more: remote.has_more, page_token: remote.page_token } }
      }
      return { data: {} }
    },
  }
}

test('远端为空时逐条创建，指令名与本地命令表一致', async () => {
  const api = makeApi({ items: [] })
  const result = await syncSlashCommands(api, { commands: SLASH_COMMANDS })
  assert.equal(result.ok, true)
  assert.equal(result.created.length, SLASH_COMMANDS.length)
  const posts = api.calls.filter(([method]) => method === 'POST')
  assert.deepEqual(posts.map(([, , body]) => body.command), SLASH_COMMANDS.map(spec => spec.command))
  assert.equal(posts[0][2].description.i18n.zh_cn.length > 0, true)
})

test('已存在且描述一致时只跳过，不重复 POST / PATCH', async () => {
  const items = SLASH_COMMANDS.map((spec, index) => ({
    command_id: 'id-' + index,
    command: spec.command,
    description: { default_value: spec.zh, i18n: { zh_cn: spec.zh, en_us: spec.en } },
  }))
  const api = makeApi({ items })
  const result = await syncSlashCommands(api)
  assert.equal(result.ok, true)
  assert.deepEqual(result.created, [])
  assert.deepEqual(result.updated, [])
  assert.equal(result.skipped.length, SLASH_COMMANDS.length)
  assert.equal(api.calls.filter(([method]) => method !== 'GET').length, 0)
})

test('描述变了才 PATCH，路径带 command_id', async () => {
  const items = [{ command_id: 'cmd-1', command: 'new', description: { default_value: '旧文案' } }]
  const api = makeApi({ items })
  const result = await syncSlashCommands(api, { commands: [{ command: 'new', zh: '新文案', en: 'new' }] })
  assert.deepEqual(result.updated, ['new'])
  const patch = api.calls.find(([method]) => method === 'PATCH')
  assert.equal(patch[1], '/open-apis/application/v7/app_slash_commands/cmd-1')
  assert.equal(patch[2].description.default_value, '新文案')
})

test('缺权限时静默失败：ok=false 且带可读原因，不抛出', async () => {
  const api = makeApi({ items: [] }, { failList: true })
  const result = await syncSlashCommands(api)
  assert.equal(result.ok, false)
  assert.match(result.reason, /application:app_slash_command:write/)
  assert.deepEqual(result.created, [])
})

test('API 未就绪时直接返回失败结果', async () => {
  const result = await syncSlashCommands(undefined)
  assert.equal(result.ok, false)
  assert.match(result.reason, /未就绪/)
})

test('分页：has_more + page_token 时继续翻页并合并结果', async () => {
  const api = {
    calls: [],
    async request(method, path) {
      this.calls.push([method, path])
      if (method !== 'GET') return { data: {} }
      if (!path.includes('page_token=')) {
        return { data: { items: [{ command_id: 'a', command: 'new', description: { default_value: SLASH_COMMANDS[0].zh, i18n: { zh_cn: SLASH_COMMANDS[0].zh, en_us: SLASH_COMMANDS[0].en } } }], has_more: true, page_token: 'p2' } }
      }
      return { data: { items: [{ command_id: 'b', command: 'stop', description: { default_value: SLASH_COMMANDS[1].zh, i18n: { zh_cn: SLASH_COMMANDS[1].zh, en_us: SLASH_COMMANDS[1].en } } }], has_more: false } }
    },
  }
  const result = await syncSlashCommands(api, { commands: SLASH_COMMANDS.slice(0, 2) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.skipped, ['new', 'stop'])
  assert.equal(api.calls.length, 2)
})

test('autoSyncSlashCommands 同一 key 只同步一次', async () => {
  const created = []
  const api = {
    async request(method, path, body) {
      if (method === 'GET') return { data: { items: [] } }
      created.push(body.command)
      return { data: {} }
    },
  }
  autoSyncSlashCommands(api, { key: 'cli_test_once', commands: [{ command: 'help', zh: '帮助', en: 'help' }] })
  autoSyncSlashCommands(api, { key: 'cli_test_once', commands: [{ command: 'help', zh: '帮助', en: 'help' }] })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(created, ['help'])
})
