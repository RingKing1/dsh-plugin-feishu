/**
 * dsh-plugin-feishu 的浏览器半侧（Web 客户端插件）。
 *
 * 为什么需要它：dsh 0.2 起插件设置不再由宿主自动渲染成一个表单页 —— 插件页的配置区
 * 是 keyed slot `plugins.bundle.config`（键 = 包名），由插件自己的客户端半侧注册。
 * 没有这一半，即使用 volatile 字段让 Host 开放了配置命名空间，界面上也没有入口。
 *
 * 数据通路：本组件不直接读配置，而是拿 `configForms.get('feishu')` 的表单句柄：
 *   - form.getSnapshot() -> { value, base, user, revision, writable }
 *   - form.mutate(ops, revision) 由 Host 校验完整 Config，再由 ConfigEditor 写进
 *     profile 的 cordis.patch.yml；volatile 字段原地生效，宿主侧会重建飞书连接。
 *
 * 构建方式：客户端模块系统要求 lazy-CJS factory 格式（window.__ModuleLoader__.load），
 * 这里手写，不依赖 tsdown 的 clientBundle 预设。
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

    const COLORS = {
      desc: 'var(--dsw-alias-label-secondary, #8a8f98)',
      danger: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-danger, #e5484d))',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      border: 'var(--dsw-alias-border-secondary, #d0d5dd)',
      field: 'var(--dsw-alias-bg-secondary, #ffffff)',
    }

    const inputStyle = {
      minWidth: 260,
      padding: '5px 8px',
      fontSize: 13,
      lineHeight: '18px',
      color: 'inherit',
      background: COLORS.field,
      border: '1px solid ' + COLORS.border,
      borderRadius: 6,
    }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
    const labelStyle = { minWidth: 180, fontSize: 13 }
    const buttonStyle = {
      padding: '5px 14px',
      fontSize: 13,
      lineHeight: '18px',
      border: '1px solid ' + COLORS.border,
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }

    /** 字段清单：顺序即表单顺序；kind 决定控件与取值方式 */
    const FIELDS = [
      { key: 'appId', label: 'App ID', kind: 'text', placeholder: 'cli_xxxxxxxxxxxx', hint: '飞书自建应用的 App ID' },
      { key: 'appSecret', label: 'App Secret', kind: 'password', placeholder: '留空 = 不修改', hint: '保存后不回显，只能覆盖' },
      { key: 'domain', label: '开放平台域名', kind: 'text', placeholder: 'https://open.feishu.cn', hint: '国际版 Lark 用 https://open.larksuite.com' },
      { key: 'workdir', label: '工作目录', kind: 'text', placeholder: '留空 = dsh 进程当前目录', hint: '新会话默认工作目录' },
      { key: 'allowedOpenIds', label: '允许的 open_id', kind: 'list', placeholder: 'ou_xxx, ou_yyy', hint: '逗号分隔；留空 = 不限制' },
      { key: 'requireMentionInGroup', label: '群聊需要 @ 机器人', kind: 'boolean' },
      { key: 'streamIntervalMs', label: '卡片刷新间隔（毫秒）', kind: 'number', min: 200, max: 10000, hint: '飞书侧限频，不要低于 200' },
      { key: 'maxReplyChars', label: '单卡正文上限', kind: 'number', min: 500, max: 50000, hint: '超出截断并提示' },
      { key: 'statePath', label: '会话映射文件', kind: 'text', placeholder: '留空 = ~/.dsh/feishu/state.json' },
      { key: 'debug', label: '输出调试日志', kind: 'boolean' },
    ]

    const DEFAULTS = {
      appId: '',
      appSecret: '',
      domain: 'https://open.feishu.cn',
      workdir: '',
      allowedOpenIds: [],
      requireMentionInGroup: true,
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

    /** 插件页的「飞书」配置卡 */
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

      react.useEffect(() => {
        const key = JSON.stringify((snapshot && snapshot.value) || {})
        if (key === lastKey.current) return
        lastKey.current = key
        setDraft(draftOf(snapshot.value))
      }, [snapshot])

      const writable = Boolean(snapshot && snapshot.writable)
      const busy = saving || !writable

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
          else setMessage(note || '已保存，飞书连接会自动重建')
        } catch (cause) {
          setError('保存失败：' + (cause && cause.message ? cause.message : String(cause)))
        } finally {
          setSaving(false)
        }
      }

      const onSave = () => {
        if (busy) return
        void commit(buildOps(draft, snapshot && snapshot.base))
      }

      const onReset = () => {
        if (busy) return
        const ops = FIELDS.map((field) => ({ op: 'unset', path: [field.key] }))
        void commit(ops, '已恢复继承值，飞书连接会自动重建')
      }

      const children = [
        react.createElement('div', { key: 'head', style: { ...rowStyle, justifyContent: 'space-between' } }, [
          react.createElement('strong', { key: 'title' }, '飞书 / Lark 连接'),
          message ? react.createElement('span', { key: 'msg', style: { color: COLORS.ok, fontSize: 12 } }, message) : null,
          error ? react.createElement('span', { key: 'err', style: { color: COLORS.danger, fontSize: 12 } }, error) : null,
        ]),
        react.createElement('div', { key: 'desc', style: { color: COLORS.desc, fontSize: 12 } },
          writable
            ? '填好后保存即可，插件会断开旧连接并用新凭证重连；App Secret 不会回显。'
            : '当前 profile 不接受表单修改，请直接编辑 profile 的 cordis.patch.yml。'),
      ]

      for (const field of FIELDS) {
        const key = field.key
        let control
        if (field.kind === 'boolean') {
          control = react.createElement('input', {
            type: 'checkbox',
            checked: Boolean(draft[key]),
            disabled: busy,
            onChange: (event) => onField(key, event.target.checked),
          })
        } else {
          control = react.createElement('input', {
            type: field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text',
            value: draft[key],
            placeholder: field.placeholder,
            disabled: busy,
            min: field.min,
            max: field.max,
            autoComplete: 'off',
            style: inputStyle,
            onChange: (event) => onField(key, event.target.value),
          })
        }
        children.push(react.createElement('label', { key: key, style: rowStyle }, [
          react.createElement('span', { key: 'label', style: labelStyle }, field.label),
          control,
          field.hint ? react.createElement('span', { key: 'hint', style: { color: COLORS.desc, fontSize: 12 } }, field.hint) : null,
        ]))
      }

      children.push(react.createElement('div', { key: 'footer', style: { display: 'flex', gap: 8, marginTop: 2 } }, [
        react.createElement('button', {
          key: 'save',
          type: 'button',
          style: { ...buttonStyle, borderColor: COLORS.border, opacity: busy ? 0.6 : 1 },
          disabled: busy,
          onClick: onSave,
        }, saving ? '保存中…' : '保存'),
        react.createElement('button', {
          key: 'reset',
          type: 'button',
          style: { ...buttonStyle, opacity: busy ? 0.6 : 1 },
          disabled: busy,
          onClick: onReset,
        }, '恢复继承值'),
      ]))

      return react.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: '20px' },
      }, children)
    }

    /** 侧栏面板 id：sidebar.panellist 的 id 与 main 槽位的 key 必须一致 */
    const PANEL_ID = 'feishu'
    /** 侧栏顺序：记忆系统是 30、技能是 31，这里排在它们后面 */
    const PANEL_ORDER = 32

    /**
     * 侧栏图标。外层的按钮、标签与选中态由 Sidebar 自己画，这里只交图形本身；
     * active 为 true 时用主色描边，和记忆系统保持一致的视觉语义。
     */
    function FeishuIcon({ size, active }) {
      const edge = typeof size === 'number' ? size : 18
      const stroke = active ? 'var(--dsw-alias-brand-primary, #3370ff)' : 'currentColor'
      // 纸飞机/消息气泡：一眼能认出是「发消息给飞书机器人」
      return react.createElement('svg', {
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
      ])
    }

    /** 侧栏面板的正文：把同一张配置表单放进主区域，入口从插件详情页移到侧边栏 */
    function FeishuMainPanel(props) {
      return react.createElement('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '24px 28px',
          maxWidth: 780,
          height: '100%',
          overflowY: 'auto',
          boxSizing: 'border-box',
        },
      }, [
        react.createElement('h2', {
          key: 'title',
          style: { margin: 0, fontSize: 16, lineHeight: '24px' },
        }, '飞书 / Lark'),
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
    exports.draftOf = draftOf
    exports.buildOps = buildOps
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
