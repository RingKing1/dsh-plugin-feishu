import Schema from '@deepseek-ai/schemastery'

/**
 * 插件配置 schema。
 *
 * 为什么每个字段都带 .volatile()：DSH 只把「volatile 字段」当作可在插件页即时编辑的配置。
 * 不标 volatile 的普通字段不会进入设置表单 —— 装好插件后侧栏插件页里一片空白，
 * 用户没有任何地方填 appId / appSecret，就是这个原因。
 *
 * appSecret 另外标 role('secret')：值不会回显进表单响应，保存后只能覆盖、不能被读回。
 */
export const Config = Schema.object({
  /**
   * 一个工作区可绑多个飞书机器人：每项一个应用的凭证 + 展示名。
   *
   * 用字典而不是数组：键就是 App ID —— 删除/改名都落在稳定的键路径上
   * （`bots.<appId>`），不需要按下标对数组做增删，也就不会出现下标偏移把别人的密钥搬到别的行。
   * 整个字典标 volatile：DSH 的 volatileForm 遇到 volatile 节点就整段开放。
   * 字典为空时回落到下面的单机器人 appId/appSecret（老配置不需要迁移）。
   */
  bots: Schema.dict(Schema.object({
    /** 展示名，留空用 App ID 代替 */
    name: Schema.string().default(''),
    appSecret: Schema.string().role('secret').default(''),
  })).default({}).volatile(),
  /** 单机器人写法（兼容旧配置）；bots 非空时忽略 */
  appId: Schema.string().default('').volatile(),
  /** 飞书自建应用 App Secret；留空时回落到环境变量 DSH_FEISHU_APP_SECRET */
  appSecret: Schema.string().role('secret').default('').volatile(),
  /** 国际版 Lark 用 https://open.larksuite.com */
  domain: Schema.string().default('https://open.feishu.cn').volatile(),
  /** 新建会话的工作目录；留空 = 自动（最近一次会话的工作区） */
  workdir: Schema.string().default('').volatile(),
  /**
   * 飞书会话用哪个 agent 预设；留空 = dsh 的默认预设（与网页端新建会话一致）。
   * 预设决定会话挂哪些工具（standard / ptc / minimal / cordis）；不挂预设就只有基础工具，
   * 连 read/write/bash 都没有。
   */
  agentPreset: Schema.string().default('').volatile(),
  /**
   * 飞书会话的权限预设；留空 = 跟随 dsh 默认（workspace-write + 逐次审批），
   * 填 danger-full-access = 关闭沙箱与审批。
   *
   * 为什么不做成全局默认：web 端会话和飞书共用一套 permissionPresets 服务，
   * 改全局会把网页端也一起放开；这里只在本插件建的会话上切，范围可控。
   * 已有会话在下一轮对话时也会被拉回这个预设（见 AgentPool.applyPermissionPreset）。
   */
  permissionPreset: Schema.string().default('').volatile(),
  /** 允许使用机器人的飞书 open_id 白名单；空数组 = 不限制 */
  allowedOpenIds: Schema.array(Schema.string()).default([]).volatile(),
  /** 群聊里是否必须 @ 机器人才响应 */
  requireMentionInGroup: Schema.boolean().default(true).volatile(),
  /**
   * 是否解析提问人姓名（通讯录 contact:user.base:readonly）。
   * 默认关闭：多一次通讯录请求，且权限没开时会静默拿不到名字；
   * 关闭时消息首行只显示 open_id 尾号，需要全量身份让模型调 feishu_identity。
   */
  resolveSenderName: Schema.boolean().default(false).volatile(),
  /** dsh 提问等多久算超时（毫秒）：默认 10 分钟，范围 10 秒 ~ 24 小时 */
  askTimeoutMs: Schema.number().default(600000).volatile(),
  /** 卡片流式刷新间隔（毫秒） */
  streamIntervalMs: Schema.number().default(700).volatile(),
  /** 单张卡片正文上限，超出截断 */
  maxReplyChars: Schema.number().default(8000).volatile(),
  /** 会话映射落盘位置；留空 = ~/.dsh/feishu/state.json */
  statePath: Schema.string().default('').volatile(),
  /** 输出 debug 日志（去重、忽略原因等） */
  debug: Schema.boolean().default(false).volatile(),
})
