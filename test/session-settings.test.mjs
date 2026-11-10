import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionSettings } from '../lib/session-settings.js'

const silentLog = { info() {}, warn() {}, debug() {} }

function makeCtx(overrides) {
  const services = {
    llm: {
      listProviders: () => [
        { id: 'deepseek-account', name: 'DeepSeek' },
        { id: 'broken', name: 'Broken' },
      ],
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('provider down')
        return [
          { id: 'deepseek-flash', name: 'Flash' },
          { id: 'deepseek-pro', name: 'Pro' },
        ]
      },
      resolveModelInfo: async (provider, model) => {
        if (model !== 'deepseek-flash') return {}
        return { reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }], defaultEffort: 'high' } }
      },
    },
    sessionController: {
      selectionFor: () => ({ current: { provider: 'deepseek-account', model: 'deepseek-pro' } }),
      selectForNextRequest: (agent, selection) => {
        selected.push([agent, selection])
      },
    },
    permissionPresets: {
      catalog: () => ({
        options: [
          { value: 'read-only', name: '只读' },
          { value: 'workspace-write', name: '工作区写' },
          { value: 'danger-full-access', name: '完全权限', description: '不设沙箱' },
        ],
        defaultOptions: [],
        defaultPreset: 'workspace-write',
      }),
      current: () => 'workspace-write',
      set: (session, name) => {
        applied.push([session, name])
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    ...(overrides || {}),
  }
  const selected = []
  const applied = []
  const ctx = { get: (name) => services[name], selected, applied }
  return ctx
}

test('modelCatalog：按 provider 分组，带推理强度，provider 失败不影响其它组', async () => {
  const ctx = makeCtx()
  const settings = new SessionSettings({ ctx, log: silentLog })
  const catalog = await settings.modelCatalog()

  assert.deepEqual(catalog.map((group) => group.id), ['deepseek-account'])
  const flash = catalog[0].models.find((model) => model.id === 'deepseek-flash')
  assert.deepEqual(flash.reasoning.efforts.map((effort) => effort.id), ['high', 'low'])
  const pro = catalog[0].models.find((model) => model.id === 'deepseek-pro')
  assert.equal(pro.reasoning, undefined)
})

test('modelCatalog：5 分钟内走缓存，force 才重新问', async () => {
  const ctx = makeCtx()
  const settings = new SessionSettings({ ctx, log: silentLog })
  const first = await settings.modelCatalog()
  const second = await settings.modelCatalog()
  assert.equal(first, second, '应命中同一份缓存')
  const forced = await settings.modelCatalog({ force: true })
  assert.notEqual(first, forced, 'force 应重新读取')
})

test('currentSelection：会话级优先，没有 controller 就回落部署默认', () => {
  const ctx = makeCtx()
  const settings = new SessionSettings({ ctx, log: silentLog })
  assert.deepEqual(settings.currentSelection({}), { provider: 'deepseek-account', model: 'deepseek-pro' })

  const noController = new SessionSettings({
    ctx: { get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined) },
    log: silentLog,
  })
  assert.deepEqual(noController.currentSelection({}), { provider: 'p', model: 'm' })
  // 还没有 agent 时也回部署默认：/status 要能告诉用户「下一条消息会用哪个模型」
  assert.deepEqual(noController.currentSelection(undefined), { provider: 'p', model: 'm' })
})

test('applyModel：走 selectForNextRequest，空的强度字段不上送', () => {
  const ctx = makeCtx()
  const settings = new SessionSettings({ ctx, log: silentLog })
  const agent = { id: 'a' }
  settings.applyModel(agent, { provider: 'p', model: 'm' })
  settings.applyModel(agent, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(ctx.selected, [
    [agent, { provider: 'p', model: 'm' }],
    [agent, { provider: 'p', model: 'm', reasoningEffort: 'high' }],
  ])
})

test('applyModel：没有 sessionController 时抛明确错误', () => {
  const settings = new SessionSettings({ ctx: { get: () => undefined }, log: silentLog })
  assert.throws(() => settings.applyModel({}, { provider: 'p', model: 'm' }), /sessionController/)
})

test('权限：目录映射、当前值、切换都落到 permissionPresets', () => {
  const ctx = makeCtx()
  const settings = new SessionSettings({ ctx, log: silentLog })
  const options = settings.permissionOptions()
  assert.deepEqual(options.map((option) => option.value), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.equal(options[2].description, '不设沙箱')

  const agent = { session: { id: 's1' } }
  assert.equal(settings.currentPermission(agent), 'workspace-write')
  assert.equal(settings.applyPermission(agent, 'danger-full-access'), 'danger-full-access')
  assert.deepEqual(ctx.applied, [[agent.session, 'danger-full-access']])
})

test('权限：没有会话对象时拒绝执行，避免静默失败', () => {
  const ctx = makeCtx()
  const settings = new SessionSettings({ ctx, log: silentLog })
  assert.throws(() => settings.applyPermission({}, 'read-only'), /还没建起来/)
})

test('服务全缺时降级：空目录、空选项、当前值空串', async () => {
  const settings = new SessionSettings({ ctx: { get: () => undefined }, log: silentLog })
  assert.deepEqual(await settings.modelCatalog(), [])
  assert.deepEqual(settings.permissionOptions(), [])
  assert.equal(settings.currentPermission({ session: {} }), '')
  assert.equal(settings.currentSelection({}), undefined)
})
