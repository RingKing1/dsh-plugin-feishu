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

    const BRAND = 'var(--dsw-alias-brand-primary, #3370ff)'
    const TOKENS = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      desc: 'var(--dsw-alias-label-secondary, #8a8f98)',
      tertiary: 'var(--dsw-alias-label-tertiary, #a8adb7)',
      border: 'var(--dsw-alias-border-secondary, rgba(128, 134, 144, 0.28))',
      field: 'var(--dsw-alias-bg-primary, #ffffff)',
      subtle: 'var(--dsw-alias-bg-secondary, rgba(128, 134, 144, 0.08))',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      success: 'var(--dsw-alias-state-success-primary, #2f9e44)',
    }

    /** 一次注入的样式表：:focus / :hover 这些伪类没法写在 inline style 里 */
    const STYLE_ID = 'dsh-plugin-feishu-style'
    const CSS = [
      '.dsh-feishu-root { --feishu-gap: 12px; }',
      '.dsh-feishu-input {',
      '  width: 100%; height: 34px; box-sizing: border-box; padding: 0 11px;',
      '  font: inherit; font-size: 13px; color: ' + TOKENS.text + ';',
      '  background: ' + TOKENS.field + '; border: 1px solid ' + TOKENS.border + ';',
      '  border-radius: 8px; outline: none;',
      '  transition: border-color 120ms ease, box-shadow 120ms ease;',
      '}',
      '.dsh-feishu-input::placeholder { color: ' + TOKENS.tertiary + '; }',
      '.dsh-feishu-input:hover:not(:disabled) { border-color: ' + TOKENS.tertiary + '; }',
      '.dsh-feishu-input:focus { border-color: ' + BRAND + '; box-shadow: 0 0 0 3px rgba(51, 112, 255, 0.16); }',
      '.dsh-feishu-input:disabled { opacity: 0.6; cursor: not-allowed; }',
      '.dsh-feishu-check { width: 16px; height: 16px; accent-color: ' + BRAND + '; cursor: pointer; }',
      '.dsh-feishu-btn {',
      '  height: 34px; padding: 0 16px; font: inherit; font-size: 13px;',
      '  border-radius: 8px; cursor: pointer;',
      '  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;',
      '}',
      '.dsh-feishu-btn:disabled { opacity: 0.55; cursor: not-allowed; }',
      '.dsh-feishu-btn-primary { color: #fff; background: ' + BRAND + '; border: 1px solid transparent; }',
      '.dsh-feishu-btn-primary:hover:not(:disabled) { filter: brightness(1.06); }',
      '.dsh-feishu-btn-ghost { color: ' + TOKENS.text + '; background: transparent; border: 1px solid ' + TOKENS.border + '; }',
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

    /** 字段清单：顺序即表单顺序；kind 决定控件与取值方式 */
    const FIELDS = [
      { key: 'appId', label: 'App ID', kind: 'text', placeholder: 'cli_xxxxxxxxxxxx', hint: '飞书自建应用的 App ID', section: 'credentials', required: true },
      { key: 'appSecret', label: 'App Secret', kind: 'password', placeholder: '留空表示不修改', hint: '保存后不回显，只能覆盖', section: 'credentials' },
      { key: 'domain', label: '开放平台域名', kind: 'text', placeholder: 'https://open.feishu.cn', hint: '国际版 Lark 用 open.larksuite.com', section: 'advanced' },
      { key: 'requireMentionInGroup', label: '群聊需要 @ 机器人', kind: 'boolean', hint: '关掉后群里任何消息都会触发', section: 'advanced' },
      { key: 'workdir', label: '默认工作目录', kind: 'text', placeholder: '留空 = dsh 进程当前目录', hint: '新会话打开的项目目录', section: 'advanced' },
      { key: 'allowedOpenIds', label: '允许的 open_id', kind: 'list', placeholder: 'ou_xxx, ou_yyy', hint: '逗号分隔；留空表示不限制', section: 'advanced' },
      { key: 'streamIntervalMs', label: '卡片刷新间隔', kind: 'number', min: 200, max: 10000, unit: 'ms', hint: '飞书限频，不建议低于 200', section: 'advanced' },
      { key: 'maxReplyChars', label: '单卡正文上限', kind: 'number', min: 500, max: 50000, unit: '字', hint: '超出截断并提示', section: 'advanced' },
      { key: 'statePath', label: '会话映射文件', kind: 'text', placeholder: '留空 = ~/.dsh/feishu/state.json', hint: '记录飞书会话 ↔ dsh 会话的对应关系', section: 'advanced' },
      { key: 'debug', label: '输出调试日志', kind: 'boolean', hint: '排障时打开，日志写到 stderr', section: 'advanced' },
    ]

    /** 分组：默认只露凭证，其余收进「高级设置」——默认值就能跑通 */
    const SECTIONS = [
      { id: 'credentials', title: '应用凭证', desc: '扫码创建会自动填好；也可以手动粘贴 App ID / App Secret' },
      { id: 'advanced', title: '高级设置', desc: '一般不用改，默认值已经能跑通' },
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

    /** 顶部状态徽标：配了凭证 = 已配置，否则插件处于等待配置的状态 */
    function StatusPill({ configured }) {
      const color = configured ? TOKENS.success : TOKENS.desc
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
        configured ? '已配置' : '未配置',
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
      const configured = Boolean(String(value.appId ?? '').trim())
      const dirty = JSON.stringify(buildOps(draft, snapshot && snapshot.base)) !== '[]'

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

      /** 扫码创建拿到凭证后写进配置：和手动填走同一条 mutate 通道 */
      const onCredentials = react.useCallback((credentials) => commit([
        { op: 'set', path: ['appId'], value: credentials.appId },
        { op: 'set', path: ['appSecret'], value: credentials.appSecret },
      ], '扫码创建成功，凭证已保存，飞书连接会自动重建'), [form, snapshot])

      const [advanced, setAdvanced] = react.useState(false)

      const onSave = () => {
        if (busy) return
        void commit(buildOps(draft, snapshot && snapshot.base))
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

    /** 侧栏面板的正文：标题 + 状态徽标 + 配置表单 */
    function FeishuMainPanel(props) {
      const snapshot = props.feishuForm && props.feishuForm.getSnapshot ? props.feishuForm.getSnapshot() : undefined
      const configured = Boolean(String(((snapshot && snapshot.value) || {}).appId ?? '').trim())
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
            react.createElement(StatusPill, { key: 'pill', configured }),
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
