import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/** 说明：客户端半侧是 lazy-CJS factory（window.__ModuleLoader__.load），不是 ESM，
 * 这里用 vm 造一个最小宿主：假 window、假 require，只验证注册约定与表单运算。 */

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(clientPath, 'utf8')

/** 造一个最小 react 替身：只用到 useCallback/useState/useEffect/useSyncExternalStore/useRef */
function fakeReact() {
  const state = []
  let cursor = 0
  return {
    __state: state,
    useCallback: (fn) => fn,
    useState: (init) => {
      const index = cursor++
      if (!(index in state)) state[index] = typeof init === 'function' ? init() : init
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useEffect: () => { cursor++ },
    useRef: (init) => ({ current: init }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

/** 载入客户端模块，返回 factory 产出的导出对象 */
function loadClient() {
  let loaded
  const window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  const context = vm.createContext({ window, console, require: undefined, JSON, String, Number, Boolean, Array, Object, Math, Error })
  vm.runInContext(source, context, { filename: clientPath })
  assert.ok(loaded, '客户端模块必须调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-plugin-feishu')
  const require = (id) => {
    if (id === 'react') return fakeReact()
    throw new Error('意外的依赖：' + id)
  }
  return loaded.factory(require)
}

test('客户端模块用 lazy-CJS factory 注册，id 为包名', () => {
  const mod = loadClient()
  assert.equal(typeof mod.apply, 'function')
  // vm 里造出来的数组属另一个 realm，深比较要转成本 realm 的数组
  assert.deepEqual(Array.from(mod.inject), ['slots'])
})

test('同时注册插件页配置卡、侧栏入口与主面板，并都带上 feishu 表单句柄', () => {
  const mod = loadClient()
  const registrations = []
  const form = { marker: 'form' }
  const ctx = {
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    inject: (names, fn) => {
      assert.deepEqual(Array.from(names), ['configForms'])
      return fn({
        configForms: {
          get: (id) => { assert.equal(id, 'feishu'); return form },
          whileServed: (ids, fn2) => { assert.deepEqual(Array.from(ids), ['feishu']); return fn2() },
        },
        effect: (fn3) => fn3(),
      })
    },
  }
  mod.apply(ctx)

  const byName = new Map(registrations.map((row) => [row.options.name, row.options]))
  assert.deepEqual([...byName.keys()].sort(), ['main', 'plugins.bundle.config', 'sidebar.panellist'])

  // 插件详情页的配置卡：键 = 包名
  assert.equal(byName.get('plugins.bundle.config').key, 'dsh-plugin-feishu')
  // 侧栏入口与主面板必须共用同一个 id，Sidebar 才会把点击指向这个面板
  assert.equal(byName.get('main').key, 'feishu')
  assert.equal(byName.get('sidebar.panellist').id, 'feishu')
  assert.equal(byName.get('sidebar.panellist').order, 32)
  assert.equal(byName.get('sidebar.panellist').label(), '飞书')

  for (const name of ['main', 'plugins.bundle.config']) {
    assert.equal(byName.get(name).inject().feishuForm, form)
  }
})

test('缺少 slots 或 configForms 时静默降级，不抛异常', () => {
  const mod = loadClient()
  assert.doesNotThrow(() => mod.apply({}))
  assert.doesNotThrow(() => mod.apply({ slots: { inject: () => {}, register: () => {} } }))
})

test('draftOf：缺省值补齐，密钥永不回显', () => {
  const mod = loadClient()
  const draft = mod.draftOf({ appId: 'cli_x', appSecret: 'secret', allowedOpenIds: ['ou_a', 'ou_b'], streamIntervalMs: 500 })
  assert.equal(draft.appId, 'cli_x')
  assert.equal(draft.appSecret, '')
  assert.equal(draft.allowedOpenIds, 'ou_a, ou_b')
  assert.equal(draft.streamIntervalMs, '500')
  assert.equal(draft.requireMentionInGroup, true)
  assert.equal(draft.domain, 'https://open.feishu.cn')
})

test('buildOps：与继承值相同用 unset，不同用 set，secret 留空不提交', () => {
  const mod = loadClient()
  const base = { appId: 'cli_old', streamIntervalMs: 700, allowedOpenIds: ['ou_a'], requireMentionInGroup: true }
  const ops = mod.buildOps({ appId: 'cli_new', appSecret: '', streamIntervalMs: '700', allowedOpenIds: 'ou_a', requireMentionInGroup: 'true', domain: 'https://open.feishu.cn' }, base)
  const byPath = new Map(ops.map((op) => [op.path[0], op]))
  assert.equal(byPath.get('appId').op, 'set')
  assert.equal(byPath.get('appId').value, 'cli_new')
  assert.equal(byPath.has('appSecret'), false)
  assert.equal(byPath.get('streamIntervalMs').op, 'unset')
  assert.equal(byPath.get('allowedOpenIds').op, 'unset')
  assert.equal(byPath.get('requireMentionInGroup').op, 'unset')
  assert.equal(byPath.get('domain').op, 'unset')
})

test('新功能配置在「消息交互」分组，且是下拉/开关而不是自由文本', () => {
  const mod = loadClient()
  const byKey = new Map(Array.from(mod.FIELDS).map((field) => [field.key, field]))
  for (const key of ['progressMode', 'reactEmoji', 'includeQuotedMessage', 'quotedMessageMaxChars']) {
    assert.equal(byKey.get(key).section, 'interaction', key + ' 必须在消息交互分组')
  }
  const progress = byKey.get('progressMode')
  assert.equal(progress.kind, 'select')
  assert.deepEqual(Array.from(progress.options).map((option) => option.value), ['steps', 'action', 'off'])

  const emoji = byKey.get('reactEmoji')
  assert.equal(emoji.kind, 'select')
  assert.equal(emoji.allowCustom, true)
  assert.deepEqual(Array.from(emoji.options).map((option) => option.value), ['', 'Get', 'OK', 'THUMBSUP', 'SMILE', 'HEART'])

  const sections = Array.from(mod.SECTIONS).map((section) => section.id)
  // interaction 不是 advanced，默认就展开，不用点「高级设置」才看得到
  assert.equal(sections.includes('interaction'), true)
})

test('新功能配置的默认值与提交语义', () => {
  const mod = loadClient()
  const draft = mod.draftOf({})
  assert.equal(draft.progressMode, 'steps')
  assert.equal(draft.reactEmoji, 'Get')
  assert.equal(draft.includeQuotedMessage, true)
  assert.equal(draft.quotedMessageMaxChars, '8000')

  const base = { progressMode: 'steps', reactEmoji: 'Get', includeQuotedMessage: true, quotedMessageMaxChars: 8000 }
  const same = mod.buildOps({ progressMode: 'steps', reactEmoji: 'Get', includeQuotedMessage: true, quotedMessageMaxChars: '8000' }, base)
  for (const key of ['progressMode', 'reactEmoji', 'includeQuotedMessage', 'quotedMessageMaxChars']) {
    const op = same.find((row) => row.path[0] === key)
    assert.equal(op.op, 'unset', key + ' 与继承值相同应 unset')
  }

  const changed = mod.buildOps({ progressMode: 'off', reactEmoji: '', includeQuotedMessage: false, quotedMessageMaxChars: '1200' }, base)
  const byPath = new Map(changed.map((op) => [op.path[0], op]))
  assert.deepEqual([byPath.get('progressMode').op, byPath.get('progressMode').value], ['set', 'off'])
  // 空串是「关闭表情回执」的合法取值，不能被 trim 丢掉
  assert.deepEqual([byPath.get('reactEmoji').op, byPath.get('reactEmoji').value], ['set', ''])
  assert.deepEqual([byPath.get('includeQuotedMessage').op, byPath.get('includeQuotedMessage').value], ['set', false])
  assert.deepEqual([byPath.get('quotedMessageMaxChars').op, byPath.get('quotedMessageMaxChars').value], ['set', 1200])
})

test('审批配置是审批定义号与控件 id，默认未配置且默认可填', () => {
  const mod = loadClient()
  const byKey = new Map(Array.from(mod.FIELDS).map((field) => [field.key, field]))
  for (const key of ['approvalCode', 'approvalWidgetId']) {
    assert.equal(byKey.get(key).section, 'approval', key + ' 必须在审批分组')
    assert.equal(byKey.get(key).kind, 'text', key + ' 是填写不是开关')
  }
  const sections = Array.from(mod.SECTIONS)
  const approval = sections.find((section) => section.id === 'approval')
  assert.ok(approval, '审批分组必须存在')
  assert.match(approval.desc, /飞书审批应用/)

  const draft = mod.draftOf({})
  assert.equal(draft.approvalCode, '')
  assert.equal(draft.approvalWidgetId, '')
  const changed = mod.buildOps({ approvalCode: ' C-1 ', approvalWidgetId: '' }, {})
  const byPath = new Map(changed.map((op) => [op.path[0], op]))
  assert.deepEqual([byPath.get('approvalCode').op, byPath.get('approvalCode').value], ['set', 'C-1'])
  assert.equal(byPath.get('approvalWidgetId').op, 'unset')
})

