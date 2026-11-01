import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DOMAIN, describeConfig, resolveConfig } from '../lib/config.js'

test('缺凭证时 enabled=false 并列出缺项', () => {
  const config = resolveConfig({}, {})
  assert.equal(config.enabled, false)
  assert.equal(config.missing.length, 2)
  assert.ok(config.missing[0].includes('appId'))
})

test('只缺 appSecret 时仍不可用', () => {
  const config = resolveConfig({ appId: 'cli_x' }, {})
  assert.equal(config.enabled, false)
  assert.equal(config.missing.length, 1)
  assert.ok(config.missing[0].includes('appSecret'))
})

test('支持环境变量注入凭证', () => {
  const config = resolveConfig({}, { DSH_FEISHU_APP_ID: 'cli_env', DSH_FEISHU_APP_SECRET: 'sec_env' })
  assert.equal(config.enabled, true)
  assert.equal(config.appId, 'cli_env')
  assert.equal(config.appSecret, 'sec_env')
})

test('配置里的凭证优先于环境变量', () => {
  const config = resolveConfig(
    { appId: 'cli_file', appSecret: 'sec_file' },
    { DSH_FEISHU_APP_ID: 'cli_env', DSH_FEISHU_APP_SECRET: 'sec_env' },
  )
  assert.equal(config.appId, 'cli_file')
  assert.equal(config.appSecret, 'sec_file')
})

test('默认值：域名、群聊必须 @、节流间隔、截断上限', () => {
  const config = resolveConfig({ appId: 'a', appSecret: 'b' }, {})
  assert.equal(config.domain, DEFAULT_DOMAIN)
  assert.equal(config.requireMentionInGroup, true)
  assert.equal(config.streamIntervalMs, 700)
  assert.equal(config.maxReplyChars, 8000)
  assert.deepEqual(config.allowedOpenIds, [])
  assert.ok(config.statePath.endsWith('state.json'))
  assert.ok(config.workdir.length > 0)
})

test('数值越界被夹到合法区间', () => {
  const low = resolveConfig({ appId: 'a', appSecret: 'b', streamIntervalMs: 1, maxReplyChars: 10 }, {})
  assert.equal(low.streamIntervalMs, 200)
  assert.equal(low.maxReplyChars, 500)

  const high = resolveConfig({ appId: 'a', appSecret: 'b', streamIntervalMs: 999999, maxReplyChars: 999999 }, {})
  assert.equal(high.streamIntervalMs, 10000)
  assert.equal(high.maxReplyChars, 50000)
})

test('域名去掉尾部斜杠，白名单去空、去空格', () => {
  const config = resolveConfig(
    {
      appId: 'a',
      appSecret: 'b',
      domain: 'https://open.larksuite.com/',
      allowedOpenIds: [' ou_1 ', '', 'ou_2'],
      requireMentionInGroup: false,
    },
    {},
  )
  assert.equal(config.domain, 'https://open.larksuite.com')
  assert.deepEqual(config.allowedOpenIds, ['ou_1', 'ou_2'])
  assert.equal(config.requireMentionInGroup, false)
})

test('describeConfig 不泄露 appSecret', () => {
  const config = resolveConfig({ appId: 'cli_123456789', appSecret: 'super-secret' }, {})
  const described = describeConfig(config)
  assert.equal(described.appIdPrefix, 'cli_12')
  assert.ok(!JSON.stringify(described).includes('super-secret'))
})
