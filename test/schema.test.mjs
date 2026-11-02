import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/schema.js'

// 这一组用例守的是「插件页有没有配置表单」：DSH 只为 volatile 字段生成表单，
// 少标一个字段，用户在界面上就少一个可填项（甚至整个表单都不出现）。
test('每个配置字段都标了 volatile，插件页才会渲染表单', () => {
  const dict = Config.dict || {}
  const keys = Object.keys(dict)
  assert.ok(keys.length >= 10, '配置字段数量异常：' + keys.length)
  for (const key of keys) {
    assert.equal(dict[key].meta?.volatile, true, key + ' 缺少 volatile，插件页里不会出现')
  }
})

test('appSecret 标了 secret 角色，保存后不会被读回', () => {
  assert.equal(Config.dict.appSecret.meta?.role, 'secret')
})

test('schema 里的默认值与运行期默认值一致', () => {
  const dict = Config.dict
  assert.equal(dict.streamIntervalMs.meta?.default, 700)
  assert.equal(dict.maxReplyChars.meta?.default, 8000)
  assert.equal(dict.requireMentionInGroup.meta?.default, true)
  assert.equal(dict.domain.meta?.default, 'https://open.feishu.cn')
  // 留空 = 跟随 dsh 默认权限，不能把所有人默认放开沙箱
  assert.equal(dict.permissionPreset.meta?.default, '')
  assert.deepEqual(dict.allowedOpenIds.meta?.default, [])
  // 新增字段的默认值必须与 resolveConfig 一致，否则「插件页显示的值」和「实际生效的值」会打架
  assert.equal(dict.resolveSenderName.meta?.default, false)
  assert.equal(dict.askTimeoutMs.meta?.default, 600000)
  assert.equal(dict.approvalCode.meta?.default, '')
  assert.equal(dict.approvalWidgetId.meta?.default, '')
})
