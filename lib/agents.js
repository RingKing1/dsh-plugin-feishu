import { randomUUID } from 'node:crypto'

/**
 * 飞书会话键 -> 存活的 dsh Agent。
 *
 * 职责边界：只处理「会话生命周期」——恢复/新建、挂事件监听、回收；
 * 不碰飞书 API，也不管卡片，事件通过回调抛给上层。
 *
 * 事件为什么挂在 agent.ctx 上：dsh 的事件从 agent 自身上下文向上冒泡，
 * 挂在插件自己的 ctx 上收不到兄弟子树里 agent 的事件；挂在 agent.ctx 上
 * 则一定能收到它自己的事件（并且不会被子 agent 的事件污染 —— 仍按 agent 身份过滤）。
 */
export class AgentPool {
  constructor(options) {
    const settings = options || {}
    this.ctx = settings.ctx
    this.config = settings.config
    this.store = settings.store
    this.log = settings.log
    this.onFrame = settings.onFrame
    this.onIdle = settings.onIdle
    this.onError = settings.onError
    /** @type {Map<string, { agent: any, handle: any, sessionId: string, disposers: Function[] }>} */
    this.live = new Map()
  }

  /**
   * 新建/恢复会话时带的模型选择。
   *
   * dsh 0.2 起：新 agent 只有在 `AgentOptions.provider/model` 或会话里已记录过选择时
   * 才允许跑模型（否则 pre-step 直接抛 "has no provider/model"）。
   * 飞书这边没有「选模型」的界面，就沿用 profile 里保存的默认模型
   * （ctx.agentDefaultModel.currentSelection()）—— 和 webhook 等其他入口一个口径。
   *
   * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
   */
  defaultAgentOptions() {
    try {
      const service = typeof this.ctx.get === 'function'
        ? this.ctx.get('agentDefaultModel')
        : this.ctx.agentDefaultModel
      const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined
      const provider = String(selection && selection.provider ? selection.provider : '').trim()
      const model = String(selection && selection.model ? selection.model : '').trim()
      if (provider === '' || model === '') return undefined
      return {
        provider,
        model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      }
    } catch (error) {
      this.log.warn('读取默认模型失败，按无模型启动', { error: String(error) })
      return undefined
    }
  }

  /** 取当前会话的存活 agent；没有就按已保存映射恢复，恢复不了就新建。 */
  async resolve(key) {
    const current = this.live.get(key)
    if (current) return current.agent

    const saved = this.store.get(key)
    const cwd = (saved && saved.cwd) || this.config.workdir

    if (saved && saved.sessionId) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: saved.sessionId,
          agentOptions: this.defaultAgentOptions(),
        })
        this.log.info('已恢复 dsh 会话', { key, sessionId: saved.sessionId })
        return this.attach(key, handle, saved.sessionId)
      } catch (error) {
        // 会话可能已被 web 端删除，或落盘目录不在本机：退化新建，不阻断消息
        this.log.warn('恢复会话失败，改为新建会话', { sessionId: saved.sessionId, error: String(error) })
      }
    }

    const sessionId = 'session-' + randomUUID()
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: this.defaultAgentOptions(),
    })
    await this.store.set(key, { sessionId, cwd })
    this.log.info('已新建 dsh 会话', { key, sessionId, cwd })
    return this.attach(key, handle, sessionId)
  }

  attach(key, handle, sessionId) {
    this.release(key)
    const agent = handle.agent
    const disposers = [
      agent.ctx.on('agent/assistant-stream', (payload) => {
        if (payload && payload.agent === agent) this.onFrame(key, payload.frame)
      }),
      agent.ctx.on('agent/status', (payload) => {
        if (payload && payload.agent === agent && payload.status === 'idle') this.onIdle(key)
      }),
      agent.ctx.on('agent/error', (payload) => {
        if (payload && payload.agent && payload.agent !== agent) return
        this.onError(key, payload && payload.error ? payload.error : payload)
      }),
    ]
    this.live.set(key, { agent, handle, sessionId, disposers })
    return agent
  }

  get(key) {
    return this.live.get(key)
  }

  /** 中断当前轮次；没有存活 agent 或没有在跑时返回 false。 */
  cancel(key, cause) {
    const entry = this.live.get(key)
    if (!entry || entry.agent.status !== 'running') return false
    try {
      entry.agent.cancel(cause || new Error('feishu: stop'))
      return true
    } catch (error) {
      this.log.warn('中断会话失败', { key, error: String(error) })
      return false
    }
  }

  /** 只摘监听，不动会话（换 agent 时用）。 */
  release(key) {
    const entry = this.live.get(key)
    if (!entry) return
    for (const dispose of entry.disposers) {
      try {
        dispose()
      } catch (error) {
        this.log.debug('摘除事件监听失败', { key, error: String(error) })
      }
    }
    this.live.delete(key)
  }

  /** 彻底结束一个会话：中断、摘监听、释放 handle、删映射。 */
  async destroy(key) {
    const entry = this.live.get(key)
    if (entry) {
      try {
        if (entry.agent.status === 'running') entry.agent.cancel(new Error('feishu: /new'))
      } catch (error) {
        this.log.warn('中断会话失败', { key, error: String(error) })
      }
      this.release(key)
      if (entry.handle && typeof entry.handle.dispose === 'function') {
        try {
          await entry.handle.dispose()
        } catch (error) {
          this.log.warn('释放会话句柄失败', { key, error: String(error) })
        }
      }
    }
    await this.store.delete(key)
  }

  /** 状态摘要（/status 用）。 */
  describe(key) {
    const entry = this.live.get(key)
    const saved = this.store.get(key)
    let model = '未知'
    if (entry) {
      try {
        const current = entry.agent.model.current()
        model = current ? current.provider + '/' + current.model : '未选择'
      } catch (error) {
        model = '读取失败：' + String(error)
      }
    }
    return {
      sessionId: (saved && saved.sessionId) || (entry && entry.sessionId) || '',
      cwd: (saved && saved.cwd) || this.config.workdir,
      status: entry ? entry.agent.status : '未加载',
      model,
    }
  }

  /** 插件卸载：摘监听、中断在跑的任务。 */
  disposeAll() {
    for (const key of Array.from(this.live.keys())) {
      const entry = this.live.get(key)
      try {
        if (entry && entry.agent.status === 'running') entry.agent.cancel(new Error('feishu: plugin dispose'))
      } catch {
        // 卸载阶段不再报错，避免干扰其它插件的回收
      }
      this.release(key)
    }
  }
}
