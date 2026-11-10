/**
 * 会话设置：模型 / 推理强度 / 权限模式的读写封装。
 *
 * 全部通过宿主已有服务完成，不自己维护状态：
 *   - `llm`                 列 provider 与模型、查模型声明的推理强度
 *   - `sessionController`   把「下一条请求用哪个模型」落到会话（与网页端同一个入口）
 *   - `permissionPresets`   读权限目录、切当前会话的权限预设
 *   - `agentDefaultModel`   没有会话级选择时的兜底（部署默认模型）
 *
 * 任何服务缺失都返回明确的「不支持」，不抛到消息主流程里。
 */

/** 模型目录缓存：列模型可能要走网络，5 分钟内不重复问 */
const CATALOG_TTL_MS = 5 * 60 * 1000

export class SessionSettings {
  constructor(options) {
    const settings = options || {}
    this.ctx = settings.ctx
    this.log = settings.log
    this.cachedCatalog = undefined
    this.cachedAt = 0
  }

  service(name) {
    try {
      return this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get(name) : undefined
    } catch (error) {
      this.log.debug('读取服务失败', { name, error: String(error) })
      return undefined
    }
  }

  /**
   * 模型目录：按 provider 分组，每组带模型与（可选的）推理强度清单。
   * @param {{ force?: boolean }} [options]
   */
  async modelCatalog(options) {
    const force = Boolean(options && options.force)
    if (!force && this.cachedCatalog && Date.now() - this.cachedAt < CATALOG_TTL_MS) return this.cachedCatalog

    const llm = this.service('llm')
    if (!llm || typeof llm.listProviders !== 'function') return []

    let providers
    try {
      providers = llm.listProviders()
    } catch (error) {
      this.log.warn('读取 provider 列表失败', { error: String(error) })
      return []
    }

    const groups = []
    for (const provider of providers || []) {
      try {
        const models = typeof llm.listModels === 'function' ? await llm.listModels(provider.id) : []
        const entries = []
        for (const model of models || []) {
          entries.push({ id: model.id, name: model.name || model.id, ...(await this.reasoningOf(llm, provider.id, model.id)) })
        }
        groups.push({ id: provider.id, name: provider.name || provider.id, models: entries })
      } catch (error) {
        this.log.warn('读取模型列表失败', { provider: provider && provider.id, error: String(error) })
      }
    }

    this.cachedCatalog = groups
    this.cachedAt = Date.now()
    return groups
  }

  /** 一个模型声明的推理强度；没声明就不带这个字段（卡片据此决定要不要第二步） */
  async reasoningOf(llm, provider, model) {
    if (typeof llm.resolveModelInfo !== 'function') return {}
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const reasoning = info && info.reasoning
      if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return {}
      return {
        reasoning: {
          efforts: reasoning.efforts.map((effort) => ({
            id: String(effort.id),
            name: String(effort.name || effort.id),
            ...(effort.description ? { description: String(effort.description) } : {}),
          })),
          ...(reasoning.defaultEffort ? { defaultEffort: String(reasoning.defaultEffort) } : {}),
        },
      }
    } catch (error) {
      this.log.debug('读取模型能力失败（按无推理强度处理）', { provider, model, error: String(error) })
      return {}
    }
  }

  /** 找一条模型记录（含推理强度声明） */
  async findModel(provider, model) {
    const catalog = await this.modelCatalog()
    const group = catalog.find((item) => item.id === provider)
    if (!group) return undefined
    const found = group.models.find((item) => item.id === model)
    return found ? { provider: group, model: found } : undefined
  }

  /** 同步读缓存目录：卡片回调必须同步返回，不能在里面 await 列模型 */
  cachedCatalog() {
    return Array.isArray(this.cachedCatalog) ? this.cachedCatalog : []
  }

  /** 同步查一条缓存里的模型（含推理强度声明） */
  cachedModel(provider, model) {
    const group = this.cachedCatalog().find((item) => item.id === provider)
    if (!group) return undefined
    const found = group.models.find((item) => item.id === model)
    return found ? { ...found, provider: group } : undefined
  }

  /** 当前会话的模型选择：会话级优先，其次部署默认 */
  currentSelection(agent) {
    const controller = this.service('sessionController')
    if (controller && agent && typeof controller.selectionFor === 'function') {
      try {
        const selection = controller.selectionFor(agent)
        if (selection && selection.current) return selection.current
      } catch (error) {
        this.log.debug('读取会话模型选择失败', { error: String(error) })
      }
    }
    const defaults = this.service('agentDefaultModel')
    if (defaults && typeof defaults.currentSelection === 'function') {
      try {
        return defaults.currentSelection()
      } catch (error) {
        this.log.debug('读取默认模型失败', { error: String(error) })
      }
    }
    return undefined
  }

  /**
   * 切换模型（可选带推理强度）。走 sessionController 的 selectForNextRequest，
   * 与网页端选模型同一条路径：下一次请求生效，并落一条 model/selection 事件。
   */
  applyModel(agent, selection) {
    const controller = this.service('sessionController')
    if (!controller || typeof controller.selectForNextRequest !== 'function') {
      throw new Error('宿主没有 sessionController，无法切换模型')
    }
    const next = {
      provider: String(selection.provider),
      model: String(selection.model),
      ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
    }
    controller.selectForNextRequest(agent, next)
    return next
  }

  /** 权限目录（与网页端的权限下拉同一份） */
  permissionOptions() {
    const presets = this.service('permissionPresets')
    if (!presets) return []
    try {
      const catalog = typeof presets.catalog === 'function' ? presets.catalog() : undefined
      const options = catalog && Array.isArray(catalog.options) ? catalog.options : []
      return options.map((option) => ({
        value: String(option.value),
        name: String(option.name || option.value),
        ...(option.description ? { description: String(option.description) } : {}),
      }))
    } catch (error) {
      this.log.warn('读取权限目录失败', { error: String(error) })
      return []
    }
  }

  /** 当前会话生效的权限预设 */
  currentPermission(agent) {
    const presets = this.service('permissionPresets')
    if (!presets || !agent || !agent.session) return ''
    try {
      return String(presets.current(agent.session))
    } catch (error) {
      this.log.debug('读取当前权限失败', { error: String(error) })
      return ''
    }
  }

  /** 切换权限预设：立刻写进会话的沙箱 / 审批开关 */
  applyPermission(agent, preset) {
    const presets = this.service('permissionPresets')
    if (!presets || typeof presets.set !== 'function') throw new Error('宿主没有 permissionPresets，无法切换权限')
    if (!agent || !agent.session) throw new Error('会话还没建起来，先发一条消息再切权限')
    presets.set(agent.session, String(preset))
    return String(preset)
  }
}
