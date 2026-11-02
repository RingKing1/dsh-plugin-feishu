import { randomUUID } from 'node:crypto'

/**
 * 飞书审批应用的能力封装（与具体业务无关）。
 *
 * 只做两件事：
 *   1. 建单：查审批定义 -> 找可填正文的文本控件 -> POST 一个审批实例，立即返回实例号；
 *   2. 查单：GET 一次实例状态，查不到一律按 PENDING（「不知道」绝不等于「已通过」）。
 *
 * 不在这里轮询、不阻塞整轮对话：模型拿到实例号后自己去查，
 * 否则审批人几小时不点，飞书会话就一直挂在那里。
 */

/** 审批实例状态；认不出的值按 PENDING，宁可继续等也不能误放行 */
export const APPROVAL_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELED: 'CANCELED',
}

/** 可填正文的控件类型，textarea 优先 */
const TEXT_WIDGET_TYPES = ['textarea', 'input']

/** 飞书状态值 -> 内部状态 */
export function mapInstanceStatus(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toUpperCase()
  if (value === 'APPROVED') return APPROVAL_STATUS.APPROVED
  if (value === 'REJECTED') return APPROVAL_STATUS.REJECTED
  if (value === 'CANCELED' || value === 'CANCELLED' || value === 'DELETED') return APPROVAL_STATUS.CANCELED
  return APPROVAL_STATUS.PENDING
}

/**
 * 从审批定义里解析控件数组。
 * 飞书返回的 form 可能是 JSON 字符串、数组，或 { widgets: [] }，三种都认。
 */
export function parseWidgets(definition) {
  const raw = definition && definition.form !== undefined
    ? definition.form
    : definition && definition.data && definition.data.form
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.widgets)) return parsed.widgets
  return []
}

/**
 * 挑一个可填正文的控件：配置了 approvalWidgetId 就精确找它，否则 textarea 优先，
 * 都不匹配时退回第一个控件（与桥接实现同一口径）。
 */
export function pickFormWidget(definition, preferredId) {
  const widgets = parseWidgets(definition)
  if (widgets.length === 0) return undefined
  const wanted = String(preferredId || '').trim()
  if (wanted) {
    const matched = widgets.find((widget) => String((widget && widget.id) || '').trim() === wanted)
    if (!matched) return undefined
    return { id: wanted, type: String((matched && matched.type) || 'textarea') }
  }
  let chosen
  for (const type of TEXT_WIDGET_TYPES) {
    chosen = widgets.find((widget) => String((widget && widget.type) || '').toLowerCase() === type)
    if (chosen) break
  }
  chosen = chosen || widgets[0]
  const id = String((chosen && chosen.id) || '').trim()
  if (!id) return undefined
  return { id, type: String((chosen && chosen.type) || 'textarea') }
}

/** 飞书要求 form 是压缩后的 JSON 字符串，控件类型沿用定义里的原类型 */
export function buildInstanceForm(widget, body) {
  return JSON.stringify([{ id: widget.id, type: widget.type, value: body }])
}

/** 建单结果 -> 给模型看的说明 */
export function formatSubmitOutcome(result) {
  if (!result || !result.ok || !result.instanceCode) {
    return '提交审批失败：' + ((result && result.detail) || '未知原因') + '。不要继续改动，把原因告诉用户。'
  }
  return '审批已提交（审批实例 ' + result.instanceCode + '）：请在飞书里完成审批。'
    + '拿到 APPROVED 之前不要继续改动；结果用 feishu_learn_approval_status 传这个实例号续查，'
    + '不要重复提交（重复提交会造出第二张单）。'
}

/** 查单结果 -> 给模型看的说明 */
export function formatApprovalOutcome(result) {
  const code = result && result.instanceCode ? '（审批实例 ' + result.instanceCode + '）' : ''
  const status = result && result.status
  if (status === APPROVAL_STATUS.APPROVED) {
    return '审批已通过' + code + '：可以继续执行被授权的操作。'
  }
  if (status === APPROVAL_STATUS.REJECTED) {
    return '审批被驳回' + code + '：不要执行被授权的操作，等审批人说明原因。'
  }
  if (status === APPROVAL_STATUS.CANCELED) {
    return '审批已被撤回/删除' + code + '：不要执行被授权的操作。'
  }
  const detail = result && result.detail ? '（' + result.detail + '）' : ''
  return '审批仍在进行中' + code + '：不要执行被授权的操作，隔一会儿用同一个实例号续查；PENDING 不等于通过。' + detail
}

/**
 * 审批客户端：只建单 / 只查一次，失败以 ok=false + detail 返回，不抛给工具层。
 */
export class FeishuApprovalClient {
  constructor(options) {
    const settings = options || {}
    this.api = settings.api
    this.log = settings.log
    this.config = settings.config || {}
    this.approvalCode = String(this.config.approvalCode || '').trim()
    this.widgetId = String(this.config.approvalWidgetId || '').trim()
    /** @type {{id: string, type: string}|undefined} 审批定义很少变，查到就缓存 */
    this.widget = undefined
  }

  /** 审批定义号没填时，工具可以明确告诉用户「还没配置」，而不是发一个空请求 */
  get configured() {
    return this.approvalCode !== ''
  }

  async resolveWidget() {
    if (this.widget) return this.widget
    if (!this.configured) throw new Error('插件还没有配置审批定义 approvalCode')
    const definition = await this.api.getApprovalDefinition(this.approvalCode)
    const widget = pickFormWidget(definition, this.widgetId)
    if (!widget) {
      const hint = this.widgetId
        ? '审批定义里找不到控件 ' + this.widgetId + '，请检查 approvalWidgetId'
        : '审批定义里找不到可填写的多行文本控件，请先在飞书审批后台加一个「多行文本」控件'
      throw new Error(hint)
    }
    this.widget = widget
    this.log?.info?.('飞书审批定义已解析', { approvalCode: this.approvalCode, widgetId: widget.id, type: widget.type })
    return widget
  }

  /**
   * 只建单：立即返回实例号，不轮询、不等待。
   * @param {{ body: string, applicantOpenId: string }} input
   */
  async create(input) {
    const body = String((input && input.body) || '').trim()
    const applicant = String((input && input.applicantOpenId) || '').trim()
    const fail = (detail) => ({ ok: false, instanceCode: '', detail, message: formatSubmitOutcome({ ok: false, detail }) })
    if (!this.configured) return fail('插件还没有配置审批定义 approvalCode')
    if (!body) return fail('审批正文为空')
    if (!applicant) return fail('拿不到发起人的 open_id，无法发起审批')
    let widget
    try {
      widget = await this.resolveWidget()
    } catch (error) {
      return fail(describeError(error))
    }
    let created
    try {
      created = await this.api.createApprovalInstance({
        approvalCode: this.approvalCode,
        openId: applicant,
        form: buildInstanceForm(widget, body),
        uuid: randomUUID(),
      })
    } catch (error) {
      const detail = '创建审批实例失败：' + describeError(error)
      this.log?.warn?.('创建飞书审批实例失败', { approvalCode: this.approvalCode, error: describeError(error) })
      return fail(detail)
    }
    const instanceCode = String((created && (created.instance_code || created.instanceCode)) || '').trim()
    if (!instanceCode) {
      return fail('创建审批实例失败：响应里没有实例号')
    }
    this.log?.info?.('飞书审批已提交', { instanceCode, approvalCode: this.approvalCode })
    return {
      ok: true,
      instanceCode,
      detail: '',
      message: formatSubmitOutcome({ ok: true, instanceCode }),
    }
  }

  /** 只查一次：查询失败按 PENDING 返回，绝不因为查不到就放行 */
  async query(instanceCode) {
    const code = String(instanceCode || '').trim()
    if (!code) {
      return { ok: false, status: APPROVAL_STATUS.PENDING, instanceCode: '', detail: '缺少审批实例号', message: formatApprovalOutcome({ status: APPROVAL_STATUS.PENDING, detail: '缺少审批实例号' }) }
    }
    try {
      const instance = await this.api.getApprovalInstance(code)
      const status = mapInstanceStatus(instance && instance.status)
      this.log?.info?.('飞书审批状态已查询', { instanceCode: code, status })
      return {
        ok: true,
        status,
        instanceCode: code,
        detail: '',
        message: formatApprovalOutcome({ status, instanceCode: code }),
      }
    } catch (error) {
      const detail = '查询审批状态失败：' + describeError(error)
      this.log?.warn?.('查询飞书审批状态失败', { instanceCode: code, error: describeError(error) })
      return {
        ok: false,
        status: APPROVAL_STATUS.PENDING,
        instanceCode: code,
        detail,
        message: formatApprovalOutcome({ status: APPROVAL_STATUS.PENDING, instanceCode: code, detail }),
      }
    }
  }
}

function describeError(error) {
  if (!error) return '未知错误'
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error.message || error)
}
