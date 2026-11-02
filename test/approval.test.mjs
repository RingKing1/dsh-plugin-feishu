import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_STATUS,
  FeishuApprovalClient,
  buildInstanceForm,
  formatApprovalOutcome,
  formatSubmitOutcome,
  mapInstanceStatus,
  parseWidgets,
  pickFormWidget,
} from '../lib/approval.js'

const silentLog = { debug() {}, info() {}, warn() {} }

function apiStub() {
  return {
    calls: [],
    definition: { form: JSON.stringify([{ id: 'text_1', type: 'input' }, { id: 'area_1', type: 'textarea' }]) },
    async getApprovalDefinition(approvalCode) {
      this.calls.push({ type: 'definition', approvalCode })
      if (this.failDefinition) throw new Error('没有审批权限')
      return this.definition
    },
    async createApprovalInstance(input) {
      this.calls.push({ type: 'create', ...input })
      if (this.failCreate) throw new Error('审批定义已停用')
      return { instance_code: 'I-1' }
    },
    async getApprovalInstance(instanceCode) {
      this.calls.push({ type: 'instance', instanceCode })
      if (this.failQuery) throw new Error('网络抖动')
      return { status: 'APPROVED' }
    },
  }
}

test('审批状态映射：认不出的值一律 PENDING，不误放行', () => {
  assert.equal(mapInstanceStatus('APPROVED'), APPROVAL_STATUS.APPROVED)
  assert.equal(mapInstanceStatus('approved'), APPROVAL_STATUS.APPROVED)
  assert.equal(mapInstanceStatus('REJECTED'), APPROVAL_STATUS.REJECTED)
  assert.equal(mapInstanceStatus('CANCELLED'), APPROVAL_STATUS.CANCELED)
  assert.equal(mapInstanceStatus('DELETED'), APPROVAL_STATUS.CANCELED)
  assert.equal(mapInstanceStatus('PENDING'), APPROVAL_STATUS.PENDING)
  assert.equal(mapInstanceStatus('WHATEVER'), APPROVAL_STATUS.PENDING)
  assert.equal(mapInstanceStatus(undefined), APPROVAL_STATUS.PENDING)
})

test('审批定义解析：JSON 字符串 / 数组 / {widgets} 三种形态都认', () => {
  assert.equal(parseWidgets({ form: '[{"id":"a","type":"textarea"}]' }).length, 1)
  assert.equal(parseWidgets({ form: [{ id: 'a', type: 'input' }] }).length, 1)
  assert.equal(parseWidgets({ form: { widgets: [{ id: 'a', type: 'input' }] } }).length, 1)
  assert.equal(parseWidgets({ form: '不是 JSON' }).length, 0)
  assert.equal(parseWidgets({}).length, 0)
})

test('挑控件：textarea 优先；指定 id 找不到就返回 undefined', () => {
  const definition = { form: [{ id: 'text_1', type: 'input' }, { id: 'area_1', type: 'textarea' }] }
  assert.deepEqual(pickFormWidget(definition), { id: 'area_1', type: 'textarea' })
  assert.deepEqual(pickFormWidget(definition, 'text_1'), { id: 'text_1', type: 'input' })
  assert.equal(pickFormWidget(definition, 'missing'), undefined)
  assert.equal(pickFormWidget({ form: [] }), undefined)
})

test('表单体是压缩后的 JSON 字符串，类型沿用定义', () => {
  assert.equal(buildInstanceForm({ id: 'area_1', type: 'textarea' }, '正文'), '[{"id":"area_1","type":"textarea","value":"正文"}]')
})

test('审批结论文案：没拿到 APPROVED 不许继续改动', () => {
  assert.match(formatSubmitOutcome({ ok: true, instanceCode: 'I-1' }), /APPROVED 之前不要继续改动/)
  assert.match(formatSubmitOutcome({ ok: false, detail: '没配置' }), /不要继续改动/)
  assert.match(formatApprovalOutcome({ status: APPROVAL_STATUS.PENDING, instanceCode: 'I-1' }), /PENDING 不等于通过/)
  assert.match(formatApprovalOutcome({ status: APPROVAL_STATUS.REJECTED, instanceCode: 'I-1' }), /驳回/)
})

test('没有配置审批定义时不发请求，直接返回可读失败', async () => {
  const api = apiStub()
  const client = new FeishuApprovalClient({ api, log: silentLog, config: { approvalCode: '  ' } })
  assert.equal(client.configured, false)
  const result = await client.create({ body: '要改文件', applicantOpenId: 'ou_1' })
  assert.equal(result.ok, false)
  assert.match(result.detail, /approvalCode/)
  assert.match(result.message, /不要继续改动/)
  assert.equal(api.calls.length, 0)
})

test('建单：查定义、挑 textarea、带发起人与 uuid，只建一次单', async () => {
  const api = apiStub()
  const client = new FeishuApprovalClient({ api, log: silentLog, config: { approvalCode: ' C-1 ' } })
  const result = await client.create({ body: '  要改 README  ', applicantOpenId: 'ou_1' })
  assert.equal(result.ok, true)
  assert.equal(result.instanceCode, 'I-1')
  assert.match(result.message, /I-1/)
  assert.deepEqual(api.calls.map((call) => call.type), ['definition', 'create'])
  const created = api.calls[1]
  assert.equal(created.approvalCode, 'C-1')
  assert.equal(created.openId, 'ou_1')
  assert.equal(created.form, '[{"id":"area_1","type":"textarea","value":"要改 README"}]')
  assert.equal(typeof created.uuid, 'string')
  assert.equal(created.uuid.length, 36)
  // 第二次建单复用已解析的控件，不再查定义
  await client.create({ body: '再来一次', applicantOpenId: 'ou_1' })
  assert.deepEqual(api.calls.map((call) => call.type), ['definition', 'create', 'create'])
})

test('建单失败：没控件 / 接口报错都返回 ok=false，不抛', async () => {
  const noWidget = apiStub()
  noWidget.definition = { form: [] }
  const client = new FeishuApprovalClient({ api: noWidget, log: silentLog, config: { approvalCode: 'C-1' } })
  const missing = await client.create({ body: '正文', applicantOpenId: 'ou_1' })
  assert.equal(missing.ok, false)
  assert.match(missing.detail, /找不到/)

  const failing = apiStub()
  failing.failCreate = true
  const client2 = new FeishuApprovalClient({ api: failing, log: silentLog, config: { approvalCode: 'C-1' } })
  const failed = await client2.create({ body: '正文', applicantOpenId: 'ou_1' })
  assert.equal(failed.ok, false)
  assert.match(failed.detail, /审批定义已停用/)
})

test('查单：只查一次；查询失败按 PENDING，绝不等于通过', async () => {
  const api = apiStub()
  const client = new FeishuApprovalClient({ api, log: silentLog, config: { approvalCode: 'C-1' } })
  const approved = await client.query(' I-1 ')
  assert.deepEqual([approved.ok, approved.status, approved.instanceCode], [true, 'APPROVED', 'I-1'])
  assert.equal(api.calls.length, 1)

  api.failQuery = true
  const failed = await client.query('I-1')
  assert.equal(failed.ok, false)
  assert.equal(failed.status, 'PENDING')
  assert.match(failed.message, /PENDING 不等于通过/)
  assert.match(failed.detail, /网络抖动/)
})
