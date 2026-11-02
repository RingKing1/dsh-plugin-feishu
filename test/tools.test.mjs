import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFeishuTools, registerFeishuTools } from '../lib/tools.js'

/** 假的 defineTool：真正的宿主包在测试环境不一定可解析，这里只验证我们声明的形状 */
const fakeDefine = (definition) => definition
const silentLog = { debug() {}, info() {}, warn() {} }

const agent = { id: 'agent-1' }
const other = { id: 'agent-2' }

function makeRegistry() {
  const sent = []
  const api = {
    async sendText(chatId, text) {
      sent.push({ chatId, text })
      return 'om_sent'
    },
  }
  const registry = {
    ownerOf: (value) =>
      value === agent
        ? {
            bridge: { api },
            key: 'oc_1',
            turn: { chatId: 'oc_1', chatType: 'group', openId: 'ou_1', senderName: '张三', sessionId: 'session-1' },
          }
        : undefined,
    owns: (value) => value === agent,
  }
  return { registry, sent }
}

function tools() {
  const { registry, sent } = makeRegistry()
  const list = buildFeishuTools({ registry, defineTool: fakeDefine })
  return { sent, list, byName: (name) => list.find((tool) => tool.name === name) }
}

test('构造出两个工具，名字稳定', () => {
  const { list } = tools()
  assert.deepEqual(list.map((tool) => tool.name), ['feishu_identity', 'feishu_send'])
})

test('输出 schema 是显式闭合对象（宿主强制要求 additionalProperties）', () => {
  const { byName } = tools()
  for (const tool of [byName('feishu_identity'), byName('feishu_send')]) {
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, false)
    assert.equal(tool.output.schema.properties.ok.required, true)
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('feishu_identity：飞书会话里返回完整身份', async () => {
  const { byName } = tools()
  const value = await byName('feishu_identity').execute({}, { agent })
  assert.deepEqual(value, {
    ok: true,
    chatId: 'oc_1',
    chatType: 'group',
    openId: 'ou_1',
    senderName: '张三',
    chatKey: 'oc_1',
    sessionId: 'session-1',
  })
})

test('feishu_identity：非飞书会话返回 not-feishu-session', async () => {
  const { byName } = tools()
  const value = await byName('feishu_identity').execute({}, { agent: other })
  assert.deepEqual(value, { ok: false, reason: 'not-feishu-session' })
})

test('feishu_send：发到当前会话并回 message_id', async () => {
  const { byName, sent } = tools()
  const value = await byName('feishu_send').execute({ text: '  结论在这里  ' }, { agent })
  assert.deepEqual(value, { ok: true, messageId: 'om_sent' })
  assert.deepEqual(sent, [{ chatId: 'oc_1', text: '结论在这里' }])
})

test('feishu_send：空文本与非飞书会话都不发消息', async () => {
  const { byName, sent } = tools()
  assert.deepEqual(await byName('feishu_send').execute({ text: '   ' }, { agent }), { ok: false, reason: '文本为空' })
  assert.equal((await byName('feishu_send').execute({ text: 'hi' }, { agent: other })).ok, false)
  assert.equal(sent.length, 0)
})

test('feishu_send：飞书接口报错时返回 ok=false，不抛出', async () => {
  const { registry } = makeRegistry()
  registry.ownerOf = () => ({
    bridge: {
      api: {
        async sendText() {
          throw new Error('token 失效')
        },
      },
    },
    key: 'oc_1',
    turn: { chatId: 'oc_1' },
  })
  const tool = buildFeishuTools({ registry, defineTool: fakeDefine }).find((item) => item.name === 'feishu_send')
  const value = await tool.execute({ text: 'hi' }, { agent })
  assert.deepEqual(value, { ok: false, reason: 'token 失效' })
})

test('注册时带上 when 守卫：只对飞书会话可见', () => {
  const { registry } = makeRegistry()
  const captured = []
  const ctx = { tools: { register(definition, options) { captured.push({ definition, options }) } } }

  const count = registerFeishuTools({ ctx, registry, log: silentLog, defineTool: fakeDefine })
  assert.equal(count, 2)
  assert.equal(captured.length, 2)
  for (const item of captured) {
    assert.equal(item.options.when({ agent }), true)
    assert.equal(item.options.when({ agent: other }), false)
    assert.equal(item.options.when(undefined), false)
  }
})

test('宿主没有 tools 服务时静默降级（返回 0，不抛）', () => {
  const { registry } = makeRegistry()
  const warnings = []
  const count = registerFeishuTools({
    ctx: {},
    registry,
    log: { ...silentLog, warn: (message) => warnings.push(message) },
    defineTool: fakeDefine,
  })
  assert.equal(count, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /tools/)
})
