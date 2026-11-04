import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DOMAIN, describeConfig, readField, resolveConfig } from '../lib/config.js'

test('readField 同时支持 volatile 引用与普通值', () => {
  // 插件页保存后字段是 Volatile 引用
  assert.equal(readField({ get: () => 'from-volatile' }, 'fallback'), 'from-volatile')
  // 单测与旧入口直接传值
  assert.equal(readField('plain', 'fallback'), 'plain')
  // 空值回落，但 0 / false / '' 这类合法值不能被当成空
  assert.equal(readField(undefined, 'fallback'), 'fallback')
  assert.equal(readField(null, 'fallback'), 'fallback')
  assert.equal(readField(0, 700), 0)
  assert.equal(readField(false, true), false)
  assert.equal(readField('', 'x'), '')
  // get() 返回 undefined 时同样回落
  assert.equal(readField({ get: () => undefined }, 'fallback'), 'fallback')
})

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
  // workdir 留空表示「自动」：由 AgentPool 取最近一次会话的工作区，
  // 回落 process.cwd() 会让飞书会话归到桌面壳的安装目录
  assert.equal(config.workdir, '')
  const explicit = resolveConfig({ appId: 'a', appSecret: 'b', workdir: '/tmp/x' }, {})
  assert.equal(explicit.workdir, '/tmp/x')
  // 权限预设留空 = 跟随 dsh 默认；填了才切（去空格）
  assert.equal(config.permissionPreset, '')
  assert.equal(resolveConfig({ appId: 'a', appSecret: 'b', permissionPreset: ' danger-full-access ' }, {}).permissionPreset, 'danger-full-access')
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

test('姓名解析默认关闭，只有显式 true 才开', () => {
  // 默认开启：权限没开时 resolveSenderName() 自己退化成 open_id 尾号，不报错
  assert.equal(resolveConfig({ appId: 'a', appSecret: 'b' }, {}).resolveSenderName, true)
  assert.equal(resolveConfig({ appId: 'a', appSecret: 'b', resolveSenderName: false }, {}).resolveSenderName, false)
  assert.equal(resolveConfig({ appId: 'a', appSecret: 'b', resolveSenderName: true }, {}).resolveSenderName, true)
})

test('提问超时默认 10 分钟，越界被夹到 10 秒 ~ 24 小时', () => {
  assert.equal(resolveConfig({ appId: 'a', appSecret: 'b' }, {}).askTimeoutMs, 600000)
  assert.equal(resolveConfig({ appId: 'a', appSecret: 'b', askTimeoutMs: 1 }, {}).askTimeoutMs, 10000)
  assert.equal(resolveConfig({ appId: 'a', appSecret: 'b', askTimeoutMs: 86400001 }, {}).askTimeoutMs, 86400000)
  // 0 / 空值回落默认值，不能变成「立刻超时」
  assert.equal(resolveConfig({ appId: 'a', appSecret: 'b', askTimeoutMs: 0 }, {}).askTimeoutMs, 600000)
})


test('飞书审批定义默认未配置；填了去首尾空白', () => {
  const defaults = resolveConfig({ appId: 'a', appSecret: 'b' }, {})
  assert.equal(defaults.approvalCode, '')
  assert.equal(defaults.approvalWidgetId, '')
  const configured = resolveConfig({ appId: 'a', appSecret: 'b', approvalCode: '  C123  ', approvalWidgetId: ' widget_1 ' }, {})
  assert.equal(configured.approvalCode, 'C123')
  assert.equal(configured.approvalWidgetId, 'widget_1')
})
