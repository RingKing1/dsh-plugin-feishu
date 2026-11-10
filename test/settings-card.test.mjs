import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModelCard,
  buildEffortCard,
  buildPermissionCard,
  parseSettingsAction,
  describeSelection,
} from '../lib/settings-card.js'

const providers = [
  {
    id: 'deepseek-account',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'Flash', reasoning: true },
      { id: 'deepseek-pro', name: 'Pro' },
    ],
  },
]

test('buildModelCard：当前模型打勾、按 provider 分组出按钮', () => {
  const card = buildModelCard({
    providers,
    current: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })
  assert.equal(card.header.title.content, '选择模型')
  const buttons = card.elements.filter((element) => element.tag === 'action').flatMap((element) => element.actions)
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].text.content, '✓ Flash')
  assert.equal(buttons[0].type, 'primary')
  assert.deepEqual(buttons[0].value, { dshm: 'deepseek-account|deepseek-flash' })
  assert.equal(buttons[1].text.content, 'Pro')
  // 顶部写明当前值
  assert.match(card.elements[0].text.content, /^当前：deepseek-account\/deepseek-flash/)
})

test('buildModelCard：没有模型时给明确说明，不留空白卡', () => {
  const card = buildModelCard({ providers: [] })
  assert.ok(card.elements.some((element) => String(element.text && element.text.content).includes('没有读到可用模型')))
})

test('buildEffortCard：默认 + 各强度按钮，当前项打勾', () => {
  const card = buildEffortCard({
    provider: 'p',
    model: 'm',
    modelName: 'M',
    efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }],
    current: 'high',
  })
  const buttons = card.elements.filter((element) => element.tag === 'action').flatMap((element) => element.actions)
  assert.deepEqual(buttons.map((button) => button.value.dshe), ['p|m|', 'p|m|high', 'p|m|low'])
  assert.equal(buttons[1].text.content, '✓ 高')
})

test('buildEffortCard：模型没有强度时不出按钮', () => {
  const card = buildEffortCard({ provider: 'p', model: 'm', efforts: [] })
  assert.equal(card.elements.some((element) => element.tag === 'action'), false)
  assert.ok(card.elements.some((element) => String(element.text && element.text.content).includes('没有声明推理强度')))
})

test('buildPermissionCard：只读 / 工作区 / 完全权限，当前项打勾', () => {
  const card = buildPermissionCard({
    options: [
      { value: 'read-only', name: '只读' },
      { value: 'workspace-write', name: '工作区读写' },
      { value: 'danger-full-access', name: '完全权限' },
    ],
    current: 'workspace-write',
  })
  const buttons = card.elements.filter((element) => element.tag === 'action').flatMap((element) => element.actions)
  assert.deepEqual(buttons.map((button) => button.value.dshp), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.equal(buttons[1].text.content, '✓ 工作区读写')
})

test('parseSettingsAction：三种键各自解析，其它卡片返回 undefined', () => {
  assert.deepEqual(parseSettingsAction({ action: { value: { dshm: 'p|m' } } }), { kind: 'model', provider: 'p', model: 'm' })
  assert.deepEqual(parseSettingsAction({ action: { value: { dshe: 'p|m|high' } } }), { kind: 'effort', provider: 'p', model: 'm', effort: 'high' })
  assert.deepEqual(parseSettingsAction({ action: { value: { dshe: 'p|m|' } } }), { kind: 'effort', provider: 'p', model: 'm', effort: '' })
  assert.deepEqual(parseSettingsAction({ action: { value: { dshp: 'read-only' } } }), { kind: 'permission', preset: 'read-only' })

  assert.equal(parseSettingsAction(undefined), undefined)
  assert.equal(parseSettingsAction({ action: { value: { dshq: 'q' } } }), undefined)
  assert.equal(parseSettingsAction({ action: { value: { dshm: 'no-pipe' } } }), undefined)
  assert.equal(parseSettingsAction({ action: { value: { dshp: '' } } }), undefined)
})

test('describeSelection：没选择时说明跟随默认', () => {
  assert.equal(describeSelection(undefined), '（跟随 dsh 默认）')
  assert.equal(describeSelection({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(describeSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m · 强度 high')
})
