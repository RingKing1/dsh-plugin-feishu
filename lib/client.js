/**
 * dsh-plugin-feishu 的浏览器半侧（Web 客户端插件）。
 *
 * 两件事：
 *   1. 侧边栏入口：sidebar.panellist 注册「飞书」图标，main 槽位注册同名面板 ——
 *      和记忆系统（dsh-mnemon）同一套槽位，点图标就在主区域打开配置页。
 *   2. 插件详情页配置卡：plugins.bundle.config（键 = 包名），从插件清单进来也能改。
 *
 * 数据通路：界面不直接读配置文件，只用 configForms.get('feishu') 的表单句柄：
 *   - form.getSnapshot() -> { value, base, user, revision, writable }
 *   - form.mutate(ops, revision) 由 Host 校验完整 Config，再由 ConfigEditor 写进
 *     profile 的 cordis.patch.yml；volatile 字段原地生效，宿主侧会重建飞书连接。
 *
 * 构建方式：客户端模块系统要求 lazy-CJS factory 格式（window.__ModuleLoader__.load），
 * 这里手写，不依赖 tsdown 的 clientBundle 预设；样式用 dsh 的设计 token 变量，
 * 深浅色主题自动跟随，不引第三方组件库。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-feishu',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')

    /** 本插件的 profile 条目 id，同时也是设置命名空间 */
    const ENTRY_ID = 'feishu'
    /** 包名：作为 plugins.bundle.config 这个 keyed slot 的键 */
    const PACKAGE_NAME = 'dsh-plugin-feishu'
    /** 侧栏面板 id：sidebar.panellist 的 id 与 main 槽位的 key 必须一致 */
    const PANEL_ID = 'feishu'
    /** 侧栏顺序：记忆系统 30、技能 31，这里排在它们后面 */
    const PANEL_ORDER = 32

    /**
     * 颜色全部取 dsh 主题 token，深浅色自动跟随。
     *
     * 踩过的坑：`--dsw-alias-brand-primary` 在暗色主题里是**近白色**（neutral-bluish-50），
     * 拿它当主按钮背景再配白字，按钮在暗色下就"消失"了。主按钮必须用
     * `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` 这一对。
     */
    const BRAND = 'var(--dsw-alias-brand-text, #3370ff)'
    const ACCENT = 'var(--dsw-alias-state-business-primary, #3370ff)'
    const TOKENS = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      desc: 'var(--dsw-alias-label-secondary, #8a8f98)',
      tertiary: 'var(--dsw-alias-label-tertiary, #a8adb7)',
      dimmed: 'var(--dsw-alias-label-dimmed, #a8adb7)',
      border: 'var(--dsw-alias-border-l4, rgba(128, 134, 144, 0.32))',
      borderStrong: 'var(--dsw-alias-border-l3, rgba(128, 134, 144, 0.45))',
      field: 'var(--dsw-alias-bg-layer-1, rgba(128, 134, 144, 0.06))',
      subtle: 'var(--dsw-alias-interactive-bg-hover, rgba(128, 134, 144, 0.12))',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      success: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      onBrand: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      brandFill: 'var(--dsw-alias-button-primary-fill, #3370ff)',
      brandHover: 'var(--dsw-alias-button-primary-hover, #2860e1)',
    }

    /** 一次注入的样式表：:focus / :hover 这些伪类没法写在 inline style 里 */
    const STYLE_ID = 'dsh-plugin-feishu-style'
    const CSS = [
      '.dsh-feishu-root { --feishu-gap: 12px; }',
      '.dsh-feishu-input {',
      '  width: 100%; height: 34px; box-sizing: border-box; padding: 0 11px;',
      '  font: inherit; font-size: 13px; color: ' + TOKENS.text + ';',
      '  background: ' + TOKENS.field + '; border: 0.5px solid ' + TOKENS.border + ';',
      '  border-radius: 8px; outline: none;',
      '  transition: border-color 120ms ease, box-shadow 120ms ease;',
      '}',
      '.dsh-feishu-input::placeholder { color: ' + TOKENS.dimmed + '; }',
      '.dsh-feishu-input:hover:not(:disabled) { border-color: ' + TOKENS.borderStrong + '; }',
      '.dsh-feishu-input:focus { border-color: ' + ACCENT + '; box-shadow: 0 0 0 3px color-mix(in srgb, ' + ACCENT + ' 18%, transparent); }',
      '.dsh-feishu-input:disabled { opacity: 0.6; cursor: not-allowed; }',
      '.dsh-feishu-check { width: 16px; height: 16px; accent-color: ' + ACCENT + '; cursor: pointer; }',
      '.dsh-feishu-btn {',
      '  height: 34px; padding: 0 16px; font: inherit; font-size: 13px;',
      '  border-radius: 8px; cursor: pointer;',
      '  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;',
      '}',
      '.dsh-feishu-btn:disabled { opacity: 0.55; cursor: not-allowed; }',
      // 主按钮：fill + foreground 是主题给出的一对，暗色下自动变成「浅底深字」
      '.dsh-feishu-btn-primary { color: ' + TOKENS.onBrand + '; background: ' + TOKENS.brandFill + '; border: 0.5px solid transparent; }',
      '.dsh-feishu-btn-primary:hover:not(:disabled) { background: ' + TOKENS.brandHover + '; }',
      '.dsh-feishu-btn-ghost { color: ' + TOKENS.text + '; background: transparent; border: 0.5px solid ' + TOKENS.borderStrong + '; }',
      '.dsh-feishu-btn-ghost:hover:not(:disabled) { background: ' + TOKENS.subtle + '; }',
      '.dsh-feishu-qr { width: 180px; height: 180px; padding: 8px; border: 1px solid ' + TOKENS.border + '; border-radius: 12px; background: #fff; }',
      '.dsh-feishu-link { color: ' + BRAND + '; font-size: 12px; text-decoration: none; word-break: break-all; }',
      '.dsh-feishu-link:hover { text-decoration: underline; }',
    ].join('\n')

    /** 幂等注入样式表（热重载时不会重复插 <style>） */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      document.head.appendChild(element)
    }

    /** 连接状态轮询间隔：界面开着时才轮询，没有订阅者就停 */
    const STATUS_POLL_MS = 3000

    /**
     * 连接状态仓库。
     *
     * 数据来自宿主 /api/feishu.status（每台机器人一条：state = missing/connecting/online/reconnecting/error/stopped）。
     * 侧栏图标和面板读同一份，轮询也只跑一份 —— 多个组件订阅时共用一个定时器。
     */
    const statusStore = {
      listeners: new Set(),
      snapshot: { bots: [], fetchedAt: 0, error: null },
      timer: undefined,
      getSnapshot() {
        return statusStore.snapshot
      },
      setSnapshot(next) {
        statusStore.snapshot = next
        for (const listener of statusStore.listeners) listener()
      },
      async refresh() {
        try {
          const response = await fetch('/api/feishu.status', {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('宿主返回 HTTP ' + response.status)
          const data = await response.json()
          statusStore.setSnapshot({
            bots: Array.isArray(data && data.bots) ? data.bots : [],
            fetchedAt: Date.now(),
            error: null,
          })
        } catch (cause) {
          statusStore.setSnapshot({
            bots: statusStore.snapshot.bots,
            fetchedAt: Date.now(),
            error: cause && cause.message ? cause.message : String(cause),
          })
        }
      },
      subscribe(listener) {
        statusStore.listeners.add(listener)
        if (statusStore.timer === undefined) {
          void statusStore.refresh()
          statusStore.timer = setInterval(() => { void statusStore.refresh() }, STATUS_POLL_MS)
        }
        return () => {
          statusStore.listeners.delete(listener)
          if (statusStore.listeners.size === 0 && statusStore.timer !== undefined) {
            clearInterval(statusStore.timer)
            statusStore.timer = undefined
          }
        }
      },
    }

    /** 订阅连接状态：组件卸载后定时器自动停 */
    function useFeishuStatus() {
      const subscribe = react.useCallback((listener) => statusStore.subscribe(listener), [])
      const read = react.useCallback(() => statusStore.getSnapshot(), [])
      return react.useSyncExternalStore(subscribe, read, read)
    }

    /** 每台机器人的状态 -> 文案与颜色 */
    const STATUS_STYLE = {
      online: { label: '已连接', color: TOKENS.success },
      connecting: { label: '连接中', color: 'var(--dsw-alias-state-warn-primary, #e8a33d)' },
      reconnecting: { label: '重连中', color: 'var(--dsw-alias-state-warn-primary, #e8a33d)' },
      error: { label: '连接失败', color: TOKENS.danger },
      missing: { label: '缺少凭证', color: TOKENS.danger },
      stopped: { label: '已停止', color: TOKENS.desc },
    }

    /** 单台机器人的状态样式；宿主还没上报（刚保存、尚未重启）时显示「连接中」 */
    function statusStyleOf(botStatus, connecting) {
      if (botStatus !== undefined && botStatus !== null && STATUS_STYLE[botStatus.state] !== undefined) return STATUS_STYLE[botStatus.state]
      return connecting ? STATUS_STYLE.connecting : { label: '等待连接', color: TOKENS.desc }
    }

    /** 整体状态：只要有一台在线就算「已连接」 */
    function overallStatus(bots, configured) {
      if (!configured) return { level: 'idle', label: '未配置', color: TOKENS.desc }
      if (bots.length === 0) return { level: 'unknown', label: '等待连接', color: TOKENS.desc }
      if (bots.some((bot) => bot.state === 'online')) return { level: 'online', label: '已连接', color: TOKENS.success }
      if (bots.some((bot) => bot.state === 'connecting' || bot.state === 'reconnecting')) {
        return { level: 'pending', label: '连接中', color: 'var(--dsw-alias-state-warn-primary, #e8a33d)' }
      }
      if (bots.some((bot) => bot.state === 'error' || bot.state === 'missing')) return { level: 'error', label: '连接失败', color: TOKENS.danger }
      return { level: 'offline', label: '未连接', color: TOKENS.desc }
    }

    /** 字段清单：顺序即表单顺序；kind 决定控件与取值方式 */
    const FIELDS = [
      { key: 'appId', label: '旧版 App ID', kind: 'text', placeholder: 'cli_xxxxxxxxxxxx', hint: '仅在没有机器人列表时生效', section: 'advanced' },
      { key: 'appSecret', label: '旧版 App Secret', kind: 'password', placeholder: '留空表示不修改', hint: '保存后不回显，只能覆盖', section: 'advanced' },
      { key: 'domain', label: '开放平台域名', kind: 'text', placeholder: 'https://open.feishu.cn', hint: '国际版 Lark 用 open.larksuite.com', section: 'advanced' },
      { key: 'requireMentionInGroup', label: '群聊需要 @ 机器人', kind: 'boolean', hint: '关掉后群里任何消息都会触发', section: 'advanced' },
      { key: 'workdir', label: '默认工作目录', kind: 'text', placeholder: '留空 = 最近一次会话的工作区', hint: '飞书会话归到哪个工作区分组就看它', section: 'advanced' },
      { key: 'agentPreset', label: '会话预设', kind: 'text', placeholder: '留空 = dsh 默认预设', hint: '决定飞书会话能用哪些工具（standard / ptc / minimal / cordis）', section: 'advanced' },
      { key: 'permissionPreset', label: '会话权限', kind: 'text', placeholder: '留空 = workspace-write（带沙箱与逐次审批）', hint: '填 danger-full-access 关闭沙箱与审批；只改飞书会话的权限，下一轮对话生效', section: 'advanced' },
      { key: 'allowedOpenIds', label: '允许的 open_id', kind: 'list', placeholder: 'ou_xxx, ou_yyy', hint: '逗号分隔；留空表示不限制', section: 'advanced' },
      { key: 'approvalEnabled', label: '把审批发到飞书', kind: 'boolean', hint: '关掉后审批仍由网页端弹窗处理', section: 'approval' },
      { key: 'approvalTimeoutMs', label: '审批超时', kind: 'number', min: 10000, max: 3600000, unit: 'ms', hint: '默认 5 分钟，超时按下面那项处理', section: 'approval' },
      { key: 'approvalTimeoutAllow', label: '超时后自动允许', kind: 'boolean', hint: '默认关：超时按拒绝处理（fail closed）', section: 'approval' },
      { key: 'approvalAllowTools', label: '免审批工具', kind: 'list', placeholder: 'read, glob, grep', hint: '工具名精确匹配；命中不发卡片，直接放行', section: 'approval' },
      { key: 'streamIntervalMs', label: '卡片刷新间隔', kind: 'number', min: 200, max: 10000, unit: 'ms', hint: '飞书限频，不建议低于 200', section: 'advanced' },
      { key: 'maxReplyChars', label: '单卡正文上限', kind: 'number', min: 500, max: 50000, unit: '字', hint: '超出截断并提示', section: 'advanced' },
      { key: 'statePath', label: '会话映射文件', kind: 'text', placeholder: '留空 = ~/.dsh/feishu/state.json', hint: '记录飞书会话 ↔ dsh 会话的对应关系', section: 'advanced' },
      { key: 'debug', label: '输出调试日志', kind: 'boolean', hint: '排障时打开，日志写到 stderr', section: 'advanced' },
    ]

    /** 分组：默认只露凭证，其余收进「高级设置」——默认值就能跑通 */
    const SECTIONS = [
      { id: 'approval', title: '审批', desc: 'dsh 执行需要确认的操作时，把审批卡片发到飞书，点一下按钮就能放行或拒绝' },
      { id: 'advanced', title: '高级设置', desc: '一般不用改；最上面两项是 0.2.x 的单机器人写法，仅在没有机器人列表时生效' },
    ]

    const DEFAULTS = {
      appId: '',
      appSecret: '',
      domain: 'https://open.feishu.cn',
      workdir: '',
      agentPreset: '',
      permissionPreset: '',
      allowedOpenIds: [],
      requireMentionInGroup: true,
      approvalEnabled: true,
      approvalTimeoutMs: 300000,
      approvalTimeoutAllow: false,
      approvalAllowTools: [],
      streamIntervalMs: 700,
      maxReplyChars: 8000,
      statePath: '',
      debug: false,
    }

    /** 快照 -> 草稿（值缺失时用默认值，避免受控组件出现 undefined） */
    function draftOf(value) {
      const source = value && typeof value === 'object' ? value : {}
      const draft = {}
      for (const field of FIELDS) {
        const raw = source[field.key]
        if (field.kind === 'boolean') draft[field.key] = raw === undefined ? DEFAULTS[field.key] : Boolean(raw)
        else if (field.kind === 'number') draft[field.key] = raw === undefined ? String(DEFAULTS[field.key]) : String(raw)
        else if (field.kind === 'list') {
          draft[field.key] = Array.isArray(raw) ? raw.join(', ') : raw === undefined ? '' : String(raw)
        } else draft[field.key] = raw === undefined ? (field.key === 'appSecret' ? '' : String(DEFAULTS[field.key] ?? '')) : String(raw)
      }
      // 密钥不回显：无论快照里给了什么，输入框永远从空开始
      draft.appSecret = ''
      return draft
    }

    /** 一次保存要提交的操作；和继承值相同的字段用 unset 恢复默认 */
    function buildOps(draft, base) {
      const inherited = base && typeof base === 'object' ? base : {}
      const ops = []
      for (const field of FIELDS) {
        const key = field.key
        if (field.kind === 'password' && !draft[key]) continue
        if (field.kind === 'boolean') {
          const next = Boolean(draft[key])
          const prev = inherited[key] === undefined ? DEFAULTS[key] : Boolean(inherited[key])
          ops.push(next === prev ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: next })
          continue
        }
        if (field.kind === 'number') {
          const parsed = Number(draft[key])
          const next = Number.isFinite(parsed) ? Math.min(field.max ?? Number.MAX_SAFE_INTEGER, Math.max(field.min ?? 0, Math.trunc(parsed))) : DEFAULTS[key]
          const prev = inherited[key] === undefined ? DEFAULTS[key] : Number(inherited[key])
          ops.push(next === prev ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: next })
          continue
        }
        if (field.kind === 'list') {
          const next = String(draft[key] || '')
            .split(/[,，\s]+/)
            .map((item) => item.trim())
            .filter(Boolean)
          const prev = Array.isArray(inherited[key]) ? inherited[key] : []
          ops.push(JSON.stringify(next) === JSON.stringify(prev) ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: next })
          continue
        }
        const next = String(draft[key] ?? '').trim()
        const prev = inherited[key] === undefined ? DEFAULTS[key] : String(inherited[key])
        ops.push(next === prev ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: next })
      }
      return ops
    }

    /** 顶部状态徽标：颜色和文案都来自宿主上报的真实连接状态 */
    function StatusPill({ label, color, level }) {
      const configured = level !== 'idle'
      return react.createElement('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
          padding: '0 10px',
          borderRadius: 999,
          fontSize: 12,
          color,
          background: configured ? 'rgba(47, 158, 68, 0.12)' : TOKENS.subtle,
        },
      }, [
        react.createElement('span', {
          key: 'dot',
          style: { width: 6, height: 6, borderRadius: '50%', background: color },
        }),
        label,
      ])
    }

    /** 一个字段 = 标签行（标签 + 说明）+ 控件 */
    function FieldRow({ field, draft, busy, onChange }) {
      const key = field.key
      const control = field.kind === 'boolean'
        ? react.createElement('input', {
          type: 'checkbox',
          className: 'dsh-feishu-check',
          checked: Boolean(draft[key]),
          disabled: busy,
          onChange: (event) => onChange(key, event.target.checked),
        })
        : react.createElement('input', {
          type: field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text',
          className: 'dsh-feishu-input',
          value: draft[key],
          placeholder: field.placeholder,
          disabled: busy,
          min: field.min,
          max: field.max,
          autoComplete: 'off',
          spellCheck: false,
          onChange: (event) => onChange(key, event.target.value),
        })

      return react.createElement('div', {
        key,
        style: { display: 'flex', flexDirection: 'column', gap: 6 },
      }, [
        react.createElement('div', {
          key: 'label',
          style: { display: 'flex', alignItems: 'baseline', gap: 8, minHeight: 18 },
        }, [
          react.createElement('span', { key: 'name', style: { fontSize: 13, fontWeight: 500 } }, field.label),
          field.required ? react.createElement('span', { key: 'req', style: { color: TOKENS.danger, fontSize: 12 } }, '*') : null,
          react.createElement('span', { key: 'hint', style: { color: TOKENS.desc, fontSize: 12 } }, field.hint ?? ''),
          field.unit ? react.createElement('span', { key: 'unit', style: { color: TOKENS.tertiary, fontSize: 12, marginLeft: 'auto' } }, field.unit) : null,
        ]),
        field.kind === 'boolean'
          ? react.createElement('label', { key: 'control', style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: TOKENS.desc } }, [control, field.hint ?? ''])
          : control,
      ])
    }

    /** 一张分组卡 */
    function SectionCard({ section, fields, draft, busy, onChange }) {
      return react.createElement('section', {
        style: {
          border: '1px solid ' + TOKENS.border,
          borderRadius: 12,
          padding: '16px 18px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          background: 'transparent',
        },
      }, [
        react.createElement('header', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
          react.createElement('h3', { key: 'title', style: { margin: 0, fontSize: 13, fontWeight: 600 } }, section.title),
          section.desc ? react.createElement('p', { key: 'desc', style: { margin: 0, fontSize: 12, color: TOKENS.desc } }, section.desc) : null,
        ]),
        ...fields.map((field) => react.createElement(FieldRow, { key: field.key, field, draft, busy, onChange })),
      ])
    }

    /**
     * 扫码创建应用卡片。
     *
     * 宿主侧用飞书 SDK 的 registerApp（RFC 8628 设备授权）发起会话并渲染二维码，
     * 这里只负责轮询 /api/feishu.register —— 同源、已登录才拿得到。
     * 拿到凭证后交给父组件的 onCredentials 保存：真正写配置的仍然只有 configForms。
     */
    function RegisterCard({ onCredentials }) {
      const [snapshot, setSnapshot] = react.useState({ state: 'idle' })
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState(null)
      const [saved, setSaved] = react.useState(false)

      const call = react.useCallback(async (method) => {
        const response = await fetch('/api/feishu.register', {
          method,
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error('宿主返回 HTTP ' + response.status)
        return response.json()
      }, [])

      // 进页面先问一次：刷新时可能正有一个会话在等确认
      react.useEffect(() => {
        let alive = true
        call('GET')
          .then((next) => { if (alive) setSnapshot(next) })
          .catch(() => {})
        return () => { alive = false }
      }, [call])

      // 等确认期间每 2 秒轮询一次
      react.useEffect(() => {
        if (snapshot.state !== 'pending' && snapshot.state !== 'starting') return undefined
        let alive = true
        const timer = setInterval(() => {
          call('GET')
            .then((next) => { if (alive) setSnapshot(next) })
            .catch(() => {})
        }, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [call, snapshot.state])

      // 拿到凭证 → 让父组件保存（只保存一次）
      react.useEffect(() => {
        if (snapshot.state !== 'success' || !snapshot.credentials || saved) return
        setSaved(true)
        Promise.resolve(onCredentials(snapshot.credentials)).catch((cause) => {
          setError('已创建应用，但保存凭证失败：' + (cause && cause.message ? cause.message : String(cause)))
        })
      }, [snapshot, saved, onCredentials])

      const start = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        setSaved(false)
        try {
          setSnapshot(await call('POST'))
        } catch (cause) {
          setError('发起扫码失败：' + (cause && cause.message ? cause.message : String(cause)))
        } finally {
          setBusy(false)
        }
      }

      const cancel = async () => {
        if (busy) return
        setBusy(true)
        try {
          setSnapshot(await call('DELETE'))
        } catch (cause) {
          setError('取消失败：' + (cause && cause.message ? cause.message : String(cause)))
        } finally {
          setBusy(false)
        }
      }

      const pending = snapshot.state === 'pending' || snapshot.state === 'starting'
      const body = []

      if (snapshot.state === 'pending' && snapshot.qr) {
        body.push(react.createElement('img', {
          key: 'qr',
          className: 'dsh-feishu-qr',
          src: snapshot.qr,
          alt: '飞书扫码创建应用',
        }))
        body.push(react.createElement('div', { key: 'link', style: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 } }, [
          react.createElement('span', { key: 'tip', style: { fontSize: 12, color: TOKENS.desc } },
            '用飞书 / Lark 扫码确认，' + (snapshot.expireIn === undefined ? '' : snapshot.expireIn + ' 秒内有效')),
          snapshot.url ? react.createElement('a', { key: 'url', className: 'dsh-feishu-link', href: snapshot.url, target: '_blank', rel: 'noreferrer' }, '在手机浏览器里打开') : null,
        ]))
      }

      const actions = []
      if (pending) {
        actions.push(react.createElement('button', {
          key: 'cancel',
          type: 'button',
          className: 'dsh-feishu-btn dsh-feishu-btn-ghost',
          disabled: busy,
          onClick: cancel,
        }, '取消'))
      } else {
        actions.push(react.createElement('button', {
          key: 'start',
          type: 'button',
          className: 'dsh-feishu-btn dsh-feishu-btn-primary',
          disabled: busy,
          onClick: start,
        }, busy ? '正在生成…' : snapshot.state === 'success' ? '重新扫码创建' : '用飞书扫码创建'))
      }

      const status = snapshot.state === 'pending'
        ? '等待扫码确认…'
        : snapshot.state === 'starting'
          ? '正在生成二维码…'
          : snapshot.state === 'success'
            ? '已创建并保存凭证'
            : snapshot.state === 'expired'
              ? (snapshot.error && snapshot.error.message) || '二维码已过期'
              : snapshot.state === 'error'
                ? (snapshot.error && snapshot.error.message) || '创建失败'
                : ''

      return react.createElement('section', {
        style: {
          border: '1px solid ' + TOKENS.border,
          borderRadius: 12,
          padding: '16px 18px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        },
      }, [
        react.createElement('header', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          react.createElement('h3', { key: 'title', style: { margin: 0, fontSize: 13, fontWeight: 600 } }, '扫码创建应用'),
          react.createElement('span', {
            key: 'badge',
            style: { fontSize: 11, color: BRAND, background: 'rgba(51, 112, 255, 0.12)', padding: '1px 8px', borderRadius: 999 },
          }, '推荐'),
        ]),
        react.createElement('p', { key: 'desc', style: { margin: 0, fontSize: 12, color: TOKENS.desc } },
          '在飞书里扫一扫，自动创建机器人应用（已勾好收发消息、卡片更新所需权限），并把 App ID / App Secret 填好 —— 不用去开发者后台点一遍。'),
        ...body,
        react.createElement('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
          ...actions,
          status ? react.createElement('span', { key: 'status', style: { fontSize: 12, color: snapshot.state === 'success' ? TOKENS.success : TOKENS.desc } }, status) : null,
          error ? react.createElement('span', { key: 'err', style: { fontSize: 12, color: TOKENS.danger } }, error) : null,
        ]),
      ])
    }

    /**
     * 机器人列表：一个工作区可以绑多台飞书机器人（多个应用）。
     *
     * 数据形状是字典 `bots: { [appId]: { name, appSecret } }` —— 键就是 App ID，
     * 删除/改名都落在稳定的键路径上，不用碰数组下标。新增走扫码或手动填两种方式。
     */
    function BotsSection({ bots, legacyAppId, disabled, onRename, onRemove, onAdd, error, statusByAppId, connecting }) {
      const [adding, setAdding] = react.useState(false)
      const [appId, setAppId] = react.useState('')
      const [name, setName] = react.useState('')
      const [secret, setSecret] = react.useState('')

      const submit = () => {
        const id = appId.trim()
        if (!id) return
        onAdd({ appId: id, name: name.trim(), appSecret: secret.trim() })
        setAdding(false)
        setAppId('')
        setName('')
        setSecret('')
      }

      const rows = bots.map((bot) => react.createElement('div', {
        key: bot.appId,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 0',
          borderTop: '0.5px solid ' + TOKENS.border,
        },
      }, [
        react.createElement('input', {
          key: 'name',
          className: 'dsh-feishu-input',
          style: { flex: 1, minWidth: 120 },
          value: bot.name,
          placeholder: '机器人名称（留空用 App ID）',
          disabled,
          onChange: (event) => onRename(bot.appId, event.target.value),
        }),
        react.createElement('code', {
          key: 'id',
          style: { fontSize: 12, color: TOKENS.desc, minWidth: 170 },
        }, bot.appId),
        react.createElement('span', {
          key: 'status',
          title: statusByAppId[bot.appId]?.error || '',
          style: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 76, fontSize: 12, color: statusStyleOf(statusByAppId[bot.appId], connecting).color },
        }, [
          react.createElement('span', {
            key: 'dot',
            style: { width: 6, height: 6, borderRadius: '50%', background: statusStyleOf(statusByAppId[bot.appId], connecting).color },
          }),
          statusStyleOf(statusByAppId[bot.appId], connecting).label,
        ]),
        react.createElement('button', {
          key: 'remove',
          type: 'button',
          className: 'dsh-feishu-btn dsh-feishu-btn-ghost',
          disabled,
          onClick: () => onRemove(bot.appId),
        }, '移除'),
      ]))

      return react.createElement('section', {
        style: {
          border: '0.5px solid ' + TOKENS.border,
          borderRadius: 12,
          padding: '16px 18px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        },
      }, [
        react.createElement('header', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
          react.createElement('h3', { key: 'title', style: { margin: 0, fontSize: 13, fontWeight: 600 } }, '已绑定的机器人'),
          react.createElement('p', { key: 'desc', style: { margin: 0, fontSize: 12, color: TOKENS.desc } },
            '一个工作区可以绑多台飞书机器人：每台一份应用凭证、一条长连接，互不影响；它们共用工作目录与卡片设置。'),
        ]),
        bots.length === 0
          ? react.createElement('p', { key: 'empty', style: { margin: 0, fontSize: 12, color: TOKENS.tertiary } }, '还没有绑定机器人 —— 用上面的扫码创建，或下面手动添加。')
          : react.createElement('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column' } }, rows),
        legacyAppId
          ? react.createElement('p', { key: 'legacy', style: { margin: 0, fontSize: 12, color: TOKENS.tertiary } },
            '当前在用旧版单机器人配置（' + legacyAppId + '）：添加任意一台机器人后，以列表里的为准。')
          : null,
        adding
          ? react.createElement('div', { key: 'form', style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } }, [
            react.createElement('input', {
              key: 'appId',
              className: 'dsh-feishu-input',
              style: { flex: '1 1 180px' },
              value: appId,
              placeholder: 'App ID（cli_ 开头）',
              disabled,
              onChange: (event) => setAppId(event.target.value),
            }),
            react.createElement('input', {
              key: 'name',
              className: 'dsh-feishu-input',
              style: { flex: '1 1 140px' },
              value: name,
              placeholder: '名称（可选）',
              disabled,
              onChange: (event) => setName(event.target.value),
            }),
            react.createElement('input', {
              key: 'secret',
              type: 'password',
              className: 'dsh-feishu-input',
              style: { flex: '1 1 180px' },
              value: secret,
              placeholder: 'App Secret',
              disabled,
              onChange: (event) => setSecret(event.target.value),
            }),
            react.createElement('button', {
              key: 'ok',
              type: 'button',
              className: 'dsh-feishu-btn dsh-feishu-btn-primary',
              disabled: disabled || appId.trim() === '' || secret.trim() === '',
              onClick: submit,
            }, '添加'),
            react.createElement('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsh-feishu-btn dsh-feishu-btn-ghost',
              disabled,
              onClick: () => setAdding(false),
            }, '取消'),
          ])
          : react.createElement('button', {
            key: 'add',
            type: 'button',
            className: 'dsh-feishu-btn dsh-feishu-btn-ghost',
            style: { alignSelf: 'flex-start' },
            disabled,
            onClick: () => setAdding(true),
          }, '手动添加机器人'),
        error ? react.createElement('p', { key: 'err', style: { margin: 0, fontSize: 12, color: TOKENS.danger } }, error) : null,
      ])
    }

    /** 配置表单：侧栏主面板与插件详情页共用 */
    function FeishuSettingsPage(props) {
      const form = props.feishuForm
      const subscribe = react.useCallback((listener) => form.subscribe(listener), [form])
      const read = react.useCallback(() => form.getSnapshot(), [form])
      const snapshot = react.useSyncExternalStore(subscribe, read, read)

      const [draft, setDraft] = react.useState(() => draftOf(snapshot && snapshot.value))
      const [saving, setSaving] = react.useState(false)
      const [message, setMessage] = react.useState(null)
      const [error, setError] = react.useState(null)
      const lastKey = react.useRef(JSON.stringify((snapshot && snapshot.value) || {}))

      react.useEffect(() => { ensureStyle() }, [])

      react.useEffect(() => {
        const key = JSON.stringify((snapshot && snapshot.value) || {})
        if (key === lastKey.current) return
        lastKey.current = key
        setDraft(draftOf(snapshot.value))
      }, [snapshot])

      const writable = Boolean(snapshot && snapshot.writable)
      const busy = saving || !writable
      const value = (snapshot && snapshot.value) || {}
      const status = useFeishuStatus()
      /** appId -> 宿主上报的状态 */
      const statusByAppId = {}
      for (const row of status.bots) if (row && row.appId) statusByAppId[row.appId] = row
      const botTable = value.bots && typeof value.bots === 'object' && !Array.isArray(value.bots) ? value.bots : {}
      const botIds = Object.keys(botTable)
      const configured = botIds.length > 0 || Boolean(String(value.appId ?? '').trim())
      const legacyAppId = String(value.appId ?? '').trim()

      /** 改名先落在本地草稿，点保存时和其他字段一起提交 */
      const [names, setNames] = react.useState({})
      const nameOf = (appId) => (Object.prototype.hasOwnProperty.call(names, appId) ? names[appId] : String(botTable[appId]?.name ?? ''))
      const renameOps = botIds
        .filter((appId) => nameOf(appId) !== String(botTable[appId]?.name ?? ''))
        .map((appId) => ({ op: 'set', path: ['bots', appId, 'name'], value: nameOf(appId) }))
      const dirty = JSON.stringify(buildOps(draft, snapshot && snapshot.base)) !== '[]' || renameOps.length > 0

      const onField = (key, next) => {
        setDraft((current) => Object.assign({}, current, { [key]: next }))
        setMessage(null)
        setError(null)
      }

      const commit = async (ops, note) => {
        setSaving(true)
        setError(null)
        setMessage(null)
        try {
          const accepted = await form.mutate(ops, snapshot?.revision)
          if (accepted === false) setError('宿主拒绝了本次保存（设置可能已被其它窗口修改），请刷新后重试。')
          else {
            setMessage(note || '已保存，飞书连接会自动重建')
            // 配置变了，连接状态马上会变：立刻拉一次，别等 3 秒轮询
            void statusStore.refresh()
          }
        } catch (cause) {
          setError('保存失败：' + (cause && cause.message ? cause.message : String(cause)))
        } finally {
          setSaving(false)
        }
      }

      /** 扫码创建拿到凭证后追加一台机器人：和手动添加走同一条 mutate 通道 */
      const onCredentials = react.useCallback((credentials) => commit([
        { op: 'set', path: ['bots', credentials.appId], value: { name: '', appSecret: credentials.appSecret } },
      ], '扫码创建成功，机器人已添加，正在连接'), [form, snapshot])

      const onAddBot = (bot) => {
        void commit([
          { op: 'set', path: ['bots', bot.appId], value: { name: bot.name, appSecret: bot.appSecret } },
        ], '机器人已添加，正在连接')
      }

      const onRemoveBot = (appId) => {
        void commit([{ op: 'unset', path: ['bots', appId] }], '机器人已移除')
      }

      const [advanced, setAdvanced] = react.useState(false)

      const onSave = () => {
        if (busy) return
        void commit([...buildOps(draft, snapshot && snapshot.base), ...renameOps])
      }

      const onReset = () => {
        if (busy) return
        void commit(FIELDS.map((field) => ({ op: 'unset', path: [field.key] })), '已恢复继承值，飞书连接会自动重建')
      }

      const footer = react.createElement('div', {
        key: 'footer',
        style: { display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 },
      }, [
        react.createElement('button', {
          key: 'save',
          type: 'button',
          className: 'dsh-feishu-btn dsh-feishu-btn-primary',
          disabled: busy,
          onClick: onSave,
        }, saving ? '保存中…' : '保存'),
        react.createElement('button', {
          key: 'reset',
          type: 'button',
          className: 'dsh-feishu-btn dsh-feishu-btn-ghost',
          disabled: busy,
          onClick: onReset,
        }, '恢复继承值'),
        dirty ? react.createElement('span', { key: 'dirty', style: { color: TOKENS.tertiary, fontSize: 12 } }, '有未保存的修改') : null,
        react.createElement('span', { key: 'spacer', style: { flex: 1 } }),
        message ? react.createElement('span', { key: 'msg', style: { color: TOKENS.success, fontSize: 12 } }, message) : null,
        error ? react.createElement('span', { key: 'err', style: { color: TOKENS.danger, fontSize: 12 } }, error) : null,
      ])

      return react.createElement('div', {
        className: 'dsh-feishu-root',
        style: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13, lineHeight: '20px', color: TOKENS.text },
      }, [
        react.createElement(RegisterCard, { key: 'register', onCredentials }),
        react.createElement(BotsSection, {
          key: 'bots',
          bots: botIds.map((appId) => ({ appId, name: nameOf(appId) })),
          legacyAppId: botIds.length === 0 ? legacyAppId : '',
          disabled: busy,
          onRename: (appId, next) => setNames((current) => Object.assign({}, current, { [appId]: next })),
          onRemove: onRemoveBot,
          onAdd: onAddBot,
          error: null,
          statusByAppId,
          connecting: botIds.length > 0,
        }),
        SECTIONS.filter((section) => section.id !== 'advanced').map((section) => react.createElement(SectionCard, {
          key: section.id,
          section,
          fields: FIELDS.filter((field) => field.section === section.id),
          draft,
          busy,
          onChange: onField,
        })),
        react.createElement('button', {
          key: 'advanced-toggle',
          type: 'button',
          className: 'dsh-feishu-btn dsh-feishu-btn-ghost',
          style: { alignSelf: 'flex-start' },
          disabled: busy,
          onClick: () => setAdvanced((current) => !current),
        }, advanced ? '收起高级设置' : '高级设置'),
        advanced ? SECTIONS.filter((section) => section.id === 'advanced').map((section) => react.createElement(SectionCard, {
          key: section.id,
          section,
          fields: FIELDS.filter((field) => field.section === section.id),
          draft,
          busy,
          onChange: onField,
        })) : null,
        writable ? footer : react.createElement('div', {
          key: 'readonly',
          style: { fontSize: 12, color: TOKENS.desc },
        }, '当前 profile 不接受表单修改，请直接编辑 profile 的 cordis.patch.yml。'),
      ])
    }

    /**
     * 侧栏图标。外层的按钮、标签与选中态由 Sidebar 自己画，这里只交图形本身；
     * active 为 true 时用主色描边，和记忆系统保持一致的视觉语义。
     */
    function FeishuIcon({ size, active }) {
      const edge = typeof size === 'number' ? size : 18
      const stroke = active ? BRAND : 'currentColor'
      const status = useFeishuStatus()
      // 侧栏只在「有机器人」时点灯：全在线=绿，连接中=黄，失败=红；未配置不画点
      const level = status.bots.length === 0
        ? 'idle'
        : status.bots.some((bot) => bot.state === 'online')
          ? 'online'
          : status.bots.some((bot) => bot.state === 'connecting' || bot.state === 'reconnecting')
            ? 'pending'
            : status.bots.some((bot) => bot.state === 'error' || bot.state === 'missing')
              ? 'error'
              : 'idle'
      const dotColor = level === 'online'
        ? TOKENS.success
        : level === 'pending'
          ? 'var(--dsw-alias-state-warn-primary, #e8a33d)'
          : TOKENS.danger
      const dot = level === 'online'
        ? react.createElement('span', {
          key: 'dot',
          title: '飞书已连接',
          style: {
            position: 'absolute', right: -1, bottom: -1,
            width: 7, height: 7, borderRadius: '50%',
            background: dotColor, boxShadow: '0 0 0 2px var(--dsw-alias-bg-base, transparent)',
          },
        })
        : level === 'pending' || level === 'error'
          ? react.createElement('span', {
            key: 'dot',
            title: level === 'pending' ? '飞书连接中' : '飞书连接失败',
            style: {
              position: 'absolute', right: -1, bottom: -1,
              width: 7, height: 7, borderRadius: '50%',
              background: dotColor, boxShadow: '0 0 0 2px var(--dsw-alias-bg-base, transparent)',
            },
          })
          : null
      return react.createElement('span', {
        style: { position: 'relative', display: 'inline-flex', width: edge, height: edge },
      }, [react.createElement('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke,
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'data-dsh-plugin': 'dsh-plugin-feishu',
        'data-dsh-part': 'sidebar-icon',
      }, [
        react.createElement('path', { key: 'bubble', d: 'M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.4-5.1A8.5 8.5 0 1 1 21 11.5Z' }),
        react.createElement('path', { key: 'send', d: 'M8 12h8M12 8.5 15.5 12 12 15.5' }),
      ]), dot])
    }

    /** 侧栏面板的正文：标题 + 状态徽标 + 配置表单 */
    function FeishuMainPanel(props) {
      const snapshot = props.feishuForm && props.feishuForm.getSnapshot ? props.feishuForm.getSnapshot() : undefined
      const value = (snapshot && snapshot.value) || {}
      const botTable = value.bots && typeof value.bots === 'object' ? value.bots : {}
      const configured = Object.keys(botTable).length > 0 || Boolean(String(value.appId ?? '').trim())
      const status = useFeishuStatus()
      const overall = overallStatus(status.bots, configured)
      return react.createElement('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          padding: '28px 32px 40px',
          maxWidth: 860,
          height: '100%',
          overflowY: 'auto',
          boxSizing: 'border-box',
        },
      }, [
        react.createElement('header', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
          react.createElement('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
            react.createElement('h2', { key: 'title', style: { margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600 } }, '飞书 / Lark'),
            react.createElement(StatusPill, { key: 'pill', level: overall.level, label: overall.label, color: overall.color }),
          ]),
          react.createElement('p', {
            key: 'desc',
            style: { margin: 0, fontSize: 13, color: TOKENS.desc },
          }, '填好应用凭证后保存即可，插件会断开旧连接并用新凭证重连；App Secret 不会回显。'),
        ]),
        react.createElement(FeishuSettingsPage, { key: 'form', feishuForm: props.feishuForm }),
      ])
    }

    /** 浏览器侧插件同样声明依赖：slots 是槽位服务名 */
    const inject = ['slots']

    function apply(ctx) {
      if (!ctx || !ctx.slots) return
      try {
        ctx.inject?.(['configForms'], (sctx) => {
          const configForms = sctx.configForms
          const form = configForms.get(ENTRY_ID)
          // whileServed：只有 Host 真的服务了 feishu 这个配置命名空间，才注册界面
          return sctx.effect?.(() => {
            // 1) 插件详情页里的配置卡（保留：用户从插件清单找过来时也能看到）
            const stopCard = configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
              name: 'plugins.bundle.config',
              key: PACKAGE_NAME,
              inject: () => ({ feishuForm: form }),
            }, FeishuSettingsPage)))

            // 2) 侧边栏入口 + 主面板（和记忆系统同一套 sidebar.panellist / main 槽位）
            const stopPanel = configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
              const stopMain = ctx.slots.register({
                name: 'main',
                key: PANEL_ID,
                inject: () => ({ feishuForm: form }),
              }, FeishuMainPanel)
              let stopIcon
              try {
                stopIcon = ctx.slots.register({
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: PANEL_ORDER,
                  label: () => '飞书',
                }, FeishuIcon)
              } catch (error) {
                stopMain()
                throw error
              }
              return () => {
                stopIcon?.()
                stopMain()
              }
            })))

            return () => {
              stopPanel?.()
              stopCard?.()
            }
          })
        })
      } catch (error) {
        console.warn('[dsh-plugin-feishu] 界面注册异常（不影响飞书桥接本身）', error)
      }
    }

    exports.FeishuSettingsPage = FeishuSettingsPage
    exports.FeishuMainPanel = FeishuMainPanel
    exports.draftOf = draftOf
    exports.buildOps = buildOps
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
