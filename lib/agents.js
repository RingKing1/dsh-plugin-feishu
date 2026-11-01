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

  /**
   * 决定飞书会话的工作目录。
   *
   * 优先级：显式配置 `workdir` > 这个 chat 上次用的目录 > **最近一次 dsh 会话的工作区** > 进程 cwd。
   *
   * 为什么不用进程 cwd 兜底：dsh 宿主是桌面壳拉起来的，进程 cwd 往往是壳的安装目录
   * （比如 ~/github/dsh-desktop-rs），飞书会话就会莫名其妙出现在那个工作区分组里。
   * 用户当前的语境显然是「我最近在哪个项目里干活」，所以拿最近一次会话的 cwd 更合直觉。
   *
   * @param {string|undefined} savedCwd 该 chat 上次记录的目录
   * @returns {Promise<string>}
   */
  async resolveCwd(savedCwd) {
    if (this.config.workdir) return this.config.workdir

    // 0.3.3 之前的版本把 process.cwd() 当默认值写进了映射表；宿主是桌面壳拉起的，
    // 那个目录通常是壳的安装目录。这种情况按「没写过」处理，重新推断，免得老会话
    // 永远钉在错误的工作区分组里。用户显式配过 workdir 的（上面已返回）不受影响。
    if (savedCwd && savedCwd !== process.cwd()) return savedCwd

    const inferred = await this.recentWorkspaceCwd()
    if (inferred) return inferred
    return process.cwd()
  }

  /** 最近一次（非飞书自己建的）dsh 会话的工作区 */
  async recentWorkspaceCwd() {
    try {
      const query = typeof this.ctx.get === 'function' ? this.ctx.get('sessionQuery') : this.ctx.sessionQuery
      if (!query || typeof query.listSessions !== 'function') return undefined
      const records = await query.listSessions()
      // 飞书自己建的会话不参与推断，否则插件会把自己的 cwd 越推越偏
      const own = new Set()
      for (const value of this.store.sessions.values()) own.add(value.sessionId)
      const candidates = records
        .filter((record) => record && record.header && typeof record.header.cwd === 'string' && record.header.cwd !== '' && !own.has(record.header.id))
        .sort((left, right) => (right.header.createdAt || 0) - (left.header.createdAt || 0))
      return candidates.length > 0 ? candidates[0].header.cwd : undefined
    } catch (error) {
      this.log.warn('推断工作目录失败，退回进程 cwd', { error: String(error) })
      return undefined
    }
  }

  /** 取当前会话的存活 agent；没有就按已保存映射恢复，恢复不了就新建。 */
  async resolve(key) {
    const current = this.live.get(key)
    if (current) return current.agent

    const saved = this.store.get(key)
    const cwd = await this.resolveCwd(saved && saved.cwd)

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
      cwd: (saved && saved.cwd) || this.config.workdir || '（自动）',
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
