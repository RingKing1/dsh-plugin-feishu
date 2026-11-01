import test from 'node:test'
import assert from 'node:assert/strict'
import { botStatePath, resolveBots } from '../lib/config.js'
import { Config } from '../lib/schema.js'

test('bots 字典：键是 App ID，逐台归一化；名字可空', () => {
  const bots = resolveBots({
    bots: {
      cli_a: { name: '主号', appSecret: 's1' },
      cli_b: { name: '', appSecret: 's2' },
    },
  }, {})
  assert.equal(bots.length, 2)
  assert.deepEqual(bots[0], { key: 'cli_a', name: '主号', appId: 'cli_a', appSecret: 's1' })
  assert.deepEqual(bots[1], { key: 'cli_b', name: '', appId: 'cli_b', appSecret: 's2' })
})

test('bots 非空时忽略旧版单机器人字段', () => {
  const bots = resolveBots({ bots: { cli_new: { appSecret: 's' } }, appId: 'cli_old', appSecret: 'so' }, {})
  assert.deepEqual(bots.map((bot) => bot.appId), ['cli_new'])
})

test('没有 bots 时回落到旧版 appId/appSecret，也支持环境变量', () => {
  assert.deepEqual(resolveBots({ appId: 'cli_old', appSecret: 'so' }, {}).map((bot) => bot.key), ['cli_old'])
  assert.deepEqual(resolveBots({}, { DSH_FEISHU_APP_ID: 'cli_env', DSH_FEISHU_APP_SECRET: 'se' }).map((bot) => bot.key), ['cli_env'])
  assert.deepEqual(resolveBots({}, {}), [])
})

test('只填了一半的机器人不会被丢掉（启动日志要能提示缺什么）', () => {
  const bots = resolveBots({ bots: { cli_a: { name: 'x' } } }, {})
  assert.equal(bots.length, 1)
  assert.equal(bots[0].appSecret, '')
})

test('多机器人时按 App ID 分文件存会话，非法字符替换掉', () => {
  assert.equal(botStatePath('/tmp/state.json', 'cli_a1'), '/tmp/state-cli_a1.json')
  assert.equal(botStatePath('/tmp/state.json', 'cli/a:b'), '/tmp/state-cli_a_b.json')
})

test('schema：bots 是 volatile 字典，密钥字段带 secret 角色', () => {
  const dict = Config.dict.bots
  assert.ok(dict, 'bots 必须存在')
  assert.equal(dict.meta.volatile, true, 'bots 整体必须是 volatile，否则表单里看不到')
  assert.equal(dict.inner.dict.appSecret.meta.role, 'secret', '每台机器人的 appSecret 必须标 role(secret)')
  // 默认值：没有配置时是一张空表，插件据此进入休眠而不是报错
  assert.deepEqual(dict.meta.default, {})
  assert.deepEqual(Config.dict.appSecret.meta.default, '')
  assert.equal(Config.dict.streamIntervalMs.meta.default, 700)
})
