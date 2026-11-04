import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'

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
    this.onClaimed = settings.onClaimed
    /** 每会话一条存活记录；borrowed = 复用宿主里已有的 agent（如网页端开着的会话），不能 dispose */
    /** @type {Map<string, { agent: any, handle: any, sessionId: string, disposers: Function[], borrowed?: boolean }>} */
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

  /** agentPresets 服务（按需取，没装就是 undefined） */
  presetsService() {
    try {
      return typeof this.ctx.get === 'function' ? this.ctx.get('agentPresets') : this.ctx.agentPresets
    } catch {
      return undefined
    }
  }

  /**
   * 组装「这次建/恢复会话要挂哪个 agent 预设」。
   *
   * 为什么必须有：预设决定会话挂哪些工具插件。dsh 网页端建会话走 session-controller，
   * 那里会 presets.resolve() 再在 setup 回调里 presets.mount(agentCtx, id)
   * （packages/api/session-controller/src/agent.ts:275-284）；插件直接调
   * ctx.agents.create() 绕过了这一步，会话就只有基础工具 —— 没有 read/write/bash/web，
   * 连「读一下这个仓的源码」都做不到。
   *
   * 优先级：配置里的 agentPreset > 会话已记录的预设 > dsh 默认预设。
   *
   * @param {string} [recorded] 会话日志里记录过的预设 id
   * @returns {Promise<{ presetId?: string, setup?: Function }>}
   */
  async presetComposition(recorded) {
    const presets = this.presetsService()
    if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') return {}
    const wanted = this.config.agentPreset || recorded || undefined
    const preset = await presets.resolve(wanted)
    const presetId = preset && preset.id ? String(preset.id) : undefined
    if (!presetId) return {}
    return {
      presetId,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, presetId)
      },
    }
  }

  /**
   * 从会话日志里找这条会话记录过的预设（agent-preset/selected 事件）。
   * 恢复老会话时要沿用原来的组合，不能悄悄换一套工具。
   *
   * @param {string} sessionId
   * @returns {Promise<string|undefined>}
   */
  async recordedPreset(sessionId) {
    try {
      const query = typeof this.ctx.get === 'function' ? this.ctx.get('sessionQuery') : this.ctx.sessionQuery
      if (!query || typeof query.observeSession !== 'function') return undefined
      const observation = await query.observeSession(sessionId)
      try {
        const events = (observation && observation.events) || []
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event && event.type === 'agent-preset/selected' && event.data && event.data.agentPreset) {
            return String(event.data.agentPreset)
          }
        }
      } finally {
        // observeSession 返回可释放观测，用完必须放掉，否则会一直占着日志句柄
        if (observation && typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
      }
    } catch (error) {
      this.log.warn('读取会话预设失败，按默认预设恢复', { sessionId, error: String(error) })
    }
    return undefined
  }

  /**
   * 宿主里已经存活的同 id agent。网页端开的会话也在同一份注册表里，
   * 所以飞书可以直接复用它，与网页共享同一条会话。
   *
   * @param {string} sessionId
   * @returns {any|undefined}
   */
  liveSessionAgent(sessionId) {
    const agents = this.ctx && this.ctx.agents
    if (!agents || typeof agents.get !== 'function') return undefined
    try {
      const agent = agents.get(sessionId)
      if (agent && (!agent.session || agent.session.id === sessionId)) return agent
    } catch (error) {
      this.log.debug('查询存活会话失败', { sessionId, error: String(error) })
    }
    return undefined
  }

  /** 取当前会话的存活 agent；没有就按已保存映射恢复，恢复不了就新建。 */
  async resolve(key) {
    const current = this.live.get(key)
    if (current) {
      // 借来的会话属于网页端，可能已被关掉：句柄失效就重新解析（走下面的恢复路径）
      if (!current.borrowed || this.liveSessionAgent(current.sessionId) === current.agent) return current.agent
      this.log.debug('借用的会话已不在宿主里，重新解析', { key, sessionId: current.sessionId })
      this.release(key)
    }

    const saved = this.store.get(key)
    const cwd = await this.resolveCwd(saved && saved.cwd)

    if (saved && saved.sessionId) {
      // 宿主里已经有一条同 id 的活会话（典型：网页端正开着它）。这时再 resume 会被
      // 注册表拒绝（agent "…" is already registered），以前会退化成新建会话，
      // 宿主重启后看起来就像「会话没延续」。这里直接复用同一个 agent。
      const shared = this.liveSessionAgent(saved.sessionId)
      if (shared) {
        this.log.info('会话已在宿主中运行，直接复用', { key, sessionId: saved.sessionId })
        return this.attach(key, { agent: shared }, saved.sessionId, { borrowed: true })
      }
      try {
        // 沿用这条会话当初记录的预设；恢复老会话不能悄悄换工具集
        const recorded = await this.recordedPreset(saved.sessionId)
        const composition = await this.presetComposition(recorded)
        const handle = await this.ctx.agents.resume({
          resumeSessionId: saved.sessionId,
          agentOptions: this.defaultAgentOptions(),
          ...(composition.setup ? { setup: composition.setup } : {}),
        })
        this.log.info('已恢复 dsh 会话', { key, sessionId: saved.sessionId })
        this.applyPermissionPreset(handle.agent, saved.sessionId)
        await this.attachWorkspace(saved.sessionId, cwd)
        return this.attach(key, handle, saved.sessionId)
      } catch (error) {
        // 会话可能已被 web 端删除，或落盘目录不在本机：退化新建，不阻断消息
        this.log.warn('恢复会话失败，改为新建会话', { sessionId: saved.sessionId, error: String(error) })
      }
    }

    const sessionId = 'session-' + randomUUID()
    // 没有预设就没有工具：必须像网页端一样 resolve + mount（见 presetComposition 注释）
    const composition = await this.presetComposition()
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd, ...(composition.presetId ? { agentPreset: composition.presetId } : {}) },
      agentOptions: this.defaultAgentOptions(),
      ...(composition.setup ? { setup: composition.setup } : {}),
    })
    this.applyPermissionPreset(handle.agent, sessionId)
    await this.store.set(key, { sessionId, cwd })
    await this.attachWorkspace(sessionId, cwd)
    this.log.info('已新建 dsh 会话', { key, sessionId, cwd })
    return this.attach(key, handle, sessionId)
  }

  /**
   * 按配置切飞书会话的权限预设（例如 danger-full-access = 关闭沙箱与审批）。
   *
   * 权限不能在建会话时指定：宿主在 agent/created 时用「默认预设」把 sandbox/approval
   * 钉进会话（packages/interaction/permission-presets/src/index.ts 的 pinInitialPermission），
   * 之后唯一写路径是 set(session, name)。所以建完/恢复完再切一次，效果等同用户点了一下。
   *
   * 恢复老会话也切：这条配置说的是「飞书会话的权限策略」，配置改了下一轮就该生效；
   * set 对同值不追加事件，不会每一轮都刷一条 permission/preset。
   *
   * 失败只记日志：权限是可用性偏好，切不过去也要能收发消息。
   */
  applyPermissionPreset(agent, sessionId) {
    const preset = String(this.config.permissionPreset || '').trim()
    if (!preset) return
    const session = agent && agent.session
    if (!session) {
      this.log.warn('拿不到会话对象，跳过权限预设', { sessionId, preset })
      return
    }
    try {
      const service = typeof this.ctx.get === 'function'
        ? this.ctx.get('permissionPresets')
        : this.ctx.permissionPresets
      if (!service || typeof service.set !== 'function') {
        this.log.warn('没有 permissionPresets 服务，跳过权限预设', { sessionId, preset })
        return
      }
      service.set(session, preset)
      this.log.info('已切换会话权限预设', { sessionId, preset })
    } catch (error) {
      this.log.warn('切换会话权限预设失败（不影响收发消息）', { sessionId, preset, error: String(error) })
    }
  }

  /**
   * 把飞书建的会话补挂到对应的工作区分组里。
   *
   * dsh 的侧栏分组**不是**按 cwd 自动归的：网页端新建会话时由 session-controller
   * 显式调用 `workspace.attachSession(sessionId)`
   * （packages/api/session-controller/src/commands.ts:130-132）。插件自己建会话绕过了
   * 那条路径，于是侧栏里一直挂在「未分组」。
   * 这里按 cwd 找到同路径的工作区补一次 attach；没有同路径工作区就维持未分组，
   * 不擅自给任意目录新建工作区（那会把侧栏撑爆）。
   *
   * 失败只记日志：归组是展示层的事，不能影响消息收发。
   */
  async attachWorkspace(sessionId, cwd) {
    try {
      const registry = typeof this.ctx.get === 'function'
        ? this.ctx.get('workspaceRegistry')
        : this.ctx.workspaceRegistry
      if (!registry || typeof registry.list !== 'function') return
      const target = await realpath(cwd)
      for (const workspace of registry.list()) {
        let path
        try {
          path = await realpath(workspace.path)
        } catch {
          continue
        }
        if (path !== target) continue
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return
        await workspace.attachSession(sessionId)
        this.log.info('会话已归入工作区', { sessionId, workspace: workspace.path })
        return
      }
    } catch (error) {
      this.log.warn('会话归入工作区失败（不影响收发消息）', { sessionId, error: String(error) })
    }
  }

  /**
   * 把 agent 挂到某个飞书会话键上（订阅它的流式帧与状态）。
   *
   * @param {string} key
   * @param {{ agent: any }} handle
   * @param {string} sessionId
   * @param {{ borrowed?: boolean }} [options] borrowed = 复用的是宿主里别的入口（如网页端）开着的会话
   */
  attach(key, handle, sessionId, options) {
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
      // 子agent 完成后主 agent 被叫醒时，这一轮不是飞书入站投递的（没有 expectTurn），
      // 得靠 claimed 里的 message.source 重新认领，否则唤醒轮的回复发不到飞书。
      // 注意：声明里 payload 只有 { message, turn }，但 dispatch 会 fuse 上 agent 字段
      // （dsh-agent/lib/index.js 的 agentEvents → fused），过滤写法与上面三个监听一致。
      agent.ctx.on('agent/inbox/claimed', (payload) => {
        if (payload && payload.agent && payload.agent !== agent) return
        if (typeof this.onClaimed === 'function') this.onClaimed(key, payload)
      }),
    ]
    const borrowed = Boolean(options && options.borrowed)
    this.live.set(key, { agent, handle, sessionId, disposers, borrowed })
    return agent
  }

  get(key) {
    return this.live.get(key)
  }

  /** 这个会话是不是借用了别的入口（网页端）开着的 agent */
  isBorrowed(key) {
    const entry = this.live.get(key)
    return Boolean(entry && entry.borrowed)
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
      // 借来的会话属于网页端：飞书端 /new 只解除绑定，不中断也不释放它的 agent
      if (!entry.borrowed) {
        try {
          if (entry.agent.status === 'running') entry.agent.cancel(new Error('feishu: /new'))
        } catch (error) {
          this.log.warn('中断会话失败', { key, error: String(error) })
        }
      }
      this.release(key)
      if (!entry.borrowed && entry.handle && typeof entry.handle.dispose === 'function') {
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
