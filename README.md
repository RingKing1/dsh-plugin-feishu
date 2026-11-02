# dsh-plugin-feishu

**DeepSeek Harness（DSH）的飞书插件** —— 把 DSH 会话接进飞书 / Lark 长连接，回复以流式卡片回写。

- 这是 **DSH 插件**（cordis 插件包），装进 DSH 的 profile 后由 DSH 进程加载，**不需要**另起守护进程、不需要公网回调地址。
- 收发都走飞书**长连接（WebSocket）**，只要求本机出网；也没有 ngrok / 反向代理这些事。
- 与 [pi-feishu-bridge](https://github.com/suveng/pi-feishu-bridge) 的关系：那个是给 pi 用的独立桥接进程，本插件是它的 DSH 版思路 —— 直接嵌进宿主进程，用 DSH 自己的 Agent API 驱动会话。

## 能力

| 能力 | 说明 |
| --- | --- |
| 单聊 / 群聊 / 话题 | 一个飞书会话一个 DSH 会话，话题（thread）单独成会话 |
| 流式卡片 | 边生成边往卡片里写，飞书客户端逐步展开；轮次结束卡片转终态 |
| 会话保持 | 飞书会话 ↔ DSH 会话映射落盘，DSH 重启后接着聊；网页端正开着的同一条会话会被直接复用（真恢复不了才新建） |
| 消息串行 | 同一会话连发多条按顺序处理，不会两条消息抢同一个轮次 |
| 权限白名单 | 只认指定 open_id；留空则谁都能用（建议自用场景也配一下） |
| 斜杠命令 | `/new` `/stop` `/status` `/cwd` `/whoami` `/help`，不进模型上下文 |
| 提问人身份 | 每条消息首行带 `【飞书 · 群聊|单聊 · 张三(90abcdef)】`，模型一眼看到是谁、从哪来；详细字段走 `feishu_identity` 工具 |
| 飞书工具 | 只在飞书发起的轮次里可见：`feishu_identity`（查提问人）、`feishu_send`（主动补发一条文本） |
| 选择题 | 模型用 `ask_user_question` 提问时，问题以卡片发到飞书：点按钮即答，也可以直接回文字 |
| 审批 | DSH 执行需要确认的操作时，审批卡片发到飞书：点「允许一次」/「拒绝」即放行或拦下，也可以直接回文字；配置项在插件页「审批」分组里 |
| 执行过程 | 工具调用在卡片顶部的「执行过程」折叠面板里逐条显示：正在跑哪一步、成没成、耗时多少 —— 长任务不再是黑箱 |
| 停止按钮 | 回复中的卡片末尾有「停止」，点一下中断本轮（等价于 `/stop`），卡片转「已停止」 |
| 表情回执 | 收到消息先挂「收到」表情；跑完换成 `DONE`，失败换成 `CRY`（可关，可换收到时的表情） |
| 引用展开 | 回复某条消息时，插件会读出被引用内容并以 `[Quoted message]` 前缀附在正文前，模型知道「这个」指的是什么 |
| 内容去重 | 同一会话 5 秒内完全相同的一条文字只处理一次（飞书偶发重投换 message_id、手抖连发都在此列） |

## 工作原理

```text
飞书客户端
   │  长连接（WSClient，事件 im.message.receive_v1）
   ▼
FeishuBridge ── 归一化/去重/白名单 ── 每会话串行队列
   │
   ├─ 斜杠命令 ──► 插件内部处理（直接回文本）
   │
   └─ 普通消息 ──► AgentPool（飞书会话键 → DSH Agent）
                        │  agent.followup(用户消息)
                        ▼
                   DSH Agent 跑一轮
                        │  agent/assistant-stream（text-delta）
                        ▼
                   ReplyCard ── CardKit 局部更新 ──► 飞书卡片
                        ▲
   DSH session/event ───┘（tool/call、tool/result → 卡片里的「执行过程」面板）
```

## 环境要求

- Node.js >= 22
- DSH（DeepSeek Harness）>= 0.2.1-rc.2，< 0.3.0
- 一个飞书**自建应用**（企业自建应用），并开启下面的权限与事件

## 一、飞书开发者后台配置

1. 在 [飞书开放平台](https://open.feishu.cn/app) 创建**企业自建应用**，拿到 `App ID` / `App Secret`。
2. **权限管理**里开通：

   | 权限 | 用途 |
   | --- | --- |
   | `im:message`（获取与发送单聊、群组消息） | 收消息、发消息 |
   | `im:message:send_as_bot`（以应用身份发消息） | 发卡片与文本回复 |
   | `im:chat:readonly`（获取群组信息） | 读取群 / 话题会话信息 |
   | `im:message.p2p_msg:readonly` | 接收单聊消息 |
   | `contact:user.base:readonly`（可选） | 把提问人姓名显示在消息首行（`resolveSenderName=true` 才需要；没开也能用，只是首行显示 open_id 尾号） |

   群里**不 @ 机器人也要响应**时，额外开「获取群组中所有消息」（`im:message.group_msg`），
   并把插件配置 `requireMentionInGroup` 设为 `false`。

3. **事件与回调 → 事件配置**：订阅方式选**使用长连接接收事件**，添加事件 `im.message.receive_v1`（接收消息 v2.0）。
4. **事件与回调 → 回调配置**：订阅方式同样选**使用长连接**，添加回调 `card.action.trigger`（卡片回传交互）。
   不开这一步，飞书里的选择题卡片点了没反应，只能靠直接回文字。
5. **应用功能 → 机器人**：启用机器人。
6. 版本管理与发布 → 创建版本并发布（企业内自建应用一般需要管理员审核）。

> 长连接是**集群模式、不广播**：同一个 `appId` 开了多条连接，事件会随机落到其中一条。
> 所以一个飞书应用只能配一个 DSH 实例；要接多个工作区，请为每个工作区建一个独立应用。

## 二、安装插件

```bash
# 从本地目录安装（开发 / 自用）
dsh plugin --profile web add /absolute/path/to/dsh-plugin-feishu

# 发布到 npm 之后
dsh plugin --profile web add dsh-plugin-feishu
```

插件包自带 `cordis.patch.yml`（`dsh.bundle.patch`），安装后会在基础 bundle 之上插入一个 id 为 `feishu` 的插件行，
默认是**休眠状态**（没有凭证只打一条 warn，不影响 `dsh --dump-config` 和别的插件）。

## 插件市场（可选）

本仓自带一份格式 1 的插件索引，可直接添加为 dsh 的索引源（插件页 → 实验性插件 → 打开「自定义插件索引」→ 发现 → 添加索引源）：

~~~text
https://raw.githubusercontent.com/suveng/dsh-plugin-feishu/main/market/index.json
~~~

> DSH 不内置任何索引源，也不做集中收录：索引由发布者自己托管，谁信任谁添加。
> 索引里的 Git 版本按提交号钉死（git+https://…git#<commit>），装到的就是那一版。

## 三、配置

三种方式，任选其一（优先级：界面 / 配置文件 > 环境变量）。

> 界面配色全部取 dsh 主题 token（`--dsw-alias-*`），浅色/深色主题自动跟随。
> 主按钮用的是 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` 这一对 ——
> 不能拿 `--dsw-alias-brand-primary` 当按钮底色：它在深色主题里是近白色，配白字会看不见。

**A0. 扫码添加机器人（最省事，推荐）**

侧边栏 **飞书** → 「扫码创建应用」→ 用飞书 / Lark 扫码确认 → 应用自动创建好、作为**一台机器人**加进列表，插件立刻用它连上。

**一个工作区可以绑多台飞书机器人**（多个应用，每台一条长连接、互不影响）：

- 再扫一次二维码，或在「已绑定的机器人」里点**手动添加**填 App ID / App Secret，就多一台；
- 每台可以改展示名、随时移除（移除即断开那条连接），它们共用工作目录与卡片设置；
- 多台时每台各自落一份会话映射（`state-<appId>.json`），不会串会话；
- 配置形状是 `bots: { "cli_xxx": { name, appSecret } }` —— 键就是 App ID，删除/改名都落在稳定的键路径上。

- 底层是飞书 Node SDK 的 `registerApp`（OAuth 2.0 Device Authorization Grant / RFC 8628）：
  宿主调 SDK 拿到验证链接、渲染成二维码，浏览器轮询 `/api/feishu.register` 取状态。
- 创建时会在平台默认模板上**增量预填**收消息、发消息、更新卡片所需的最小权限，
  以及 `im.message.receive_v1` 事件；用户确认页里仍可自己增删。
- 不需要开发者后台点一圈，也不需要公网回调地址（长连接模式）。
- 二维码与凭证都只在本机同源、已登录的浏览器里流转；凭证同样经 `configForms` 写入 profile。

**A. 旧版单机器人写法（仍在用，兼容）**

两个入口，同一张表单：

- **侧边栏（推荐）**：左侧图标栏的**飞书**图标 → 主区域打开「飞书 / Lark」→ 填 `appId` / `appSecret` 等字段 → 保存。
  和记忆系统（dsh-mnemon）一样走 `sidebar.panellist` + `main` 槽位，不用每次钻到插件详情页。
- **插件页**：侧栏 **插件** → 选中 **dsh-plugin-feishu** → 「飞书 / Lark 连接」卡片。

- dsh 0.2 起，插件页的配置区不会自动渲染，必须由插件自己的**浏览器半侧**注册到 keyed slot
  `plugins.bundle.config`（键 = 包名）。本插件从 0.1.2 起自带 `lib/client.js` 提供这张卡片；
  只有宿主半侧、没有客户端半侧的插件，即使字段是 volatile 也不会出现配置界面。
- 所有字段都声明为 volatile，Host 才会为这个条目开配置命名空间（`feishu`），表单写入才允许；
  保存后插件**自动断开重连**，不用重启 dsh。
- 卡片里的「恢复继承值」会清掉当前条目的用户覆盖层，重新继承 profile / 包内默认值。
- `appSecret` 带 role('secret')：保存后不会被回显，只能覆盖。
- **连接状态是真的，不是「配置存在就点亮」**：宿主把每台机器人的长连接状态经
  `GET /api/feishu.status` 报给界面（`missing / connecting / online / reconnecting / error / stopped`）。
  侧栏图标右下角：绿=已连接、黄=连接中/重连中、红=连接失败；机器人列表里每行也有状态点，
  鼠标悬停能看到失败原因（比如 App Secret 不对）。
- 表单里没有的项（比如想用环境变量）保持默认即可。

**B. 环境变量（密钥不落地）**

```bash
export DSH_FEISHU_APP_ID=cli_xxxxxxxxxxxx
export DSH_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
```

**C. 写进配置文件**（profile 的 cordis 配置文件里 `feishu` 这一行的 `config`，改完要重启 dsh）：

```yaml
- id: feishu
  name: dsh-plugin-feishu
  config:
    appId: cli_xxxxxxxxxxxx
    appSecret: xxxxxxxxxxxxxxxxxxxx
    workdir: /home/me/work/my-repo
    allowedOpenIds:
      - ou_xxxxxxxxxxxxxxxx
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `appId` / `appSecret` | 空 | 飞书自建应用凭证；为空时读环境变量，仍为空则插件休眠 |
| `domain` | `https://open.feishu.cn` | 国际版 Lark 用 `https://open.larksuite.com` |
| `workdir` | 自动（最近一次 dsh 会话的工作区） | 飞书会话建在哪个工作区：留空 = 跟随你最近干活的目录；显式填写则固定用它。**不回落进程 cwd** —— 那样飞书会话会归到桌面壳的安装目录 |
| `agentPreset` | dsh 默认预设（本机为 `ptc`） | 飞书会话用哪个 agent 预设。预设决定挂哪些工具（standard / ptc / minimal / cordis）——不挂预设就只有基础工具，没有 read/write/bash/web |
| `permissionPreset` | 空（跟随 dsh 默认 = `workspace-write` + 逐次审批） | 飞书会话的权限预设：填 `danger-full-access` 关闭沙箱与审批，其它内置预设 `workspace-write` / `read-only` 同理。只改本插件建的会话，不动全局默认；建会话和恢复会话时各切一次，所以**改了配置下一轮对话就生效** |
| `allowedOpenIds` | `[]` | 允许使用的 open_id 列表；空表示不限制 |
| `requireMentionInGroup` | `true` | 群聊是否必须 @ 机器人才响应 |
| `streamIntervalMs` | `700` | 卡片流式刷新间隔（毫秒），飞书侧限频，不建议低于 200 |
| `maxReplyChars` | `8000` | 单张卡片正文上限，超出截断并在文末提示 |
| `progressMode` | `steps` | 执行过程清单的显示方式：`steps` 完整清单、`action` 只显示当前正在跑的一步、`off` 关闭（卡片上不再出现折叠面板） |
| `reactEmoji` | `Get` | 收到消息时挂的表情（飞书 emoji key）；留空 = 关闭表情回执。结束 / 失败固定用 `DONE` / `CRY` |
| `includeQuotedMessage` | `true` | 回复某条消息时是否展开被引用内容 |
| `quotedMessageMaxChars` | `8000` | 引用内容最多展开多少字符（100 ~ 50000），超出截断并注明 |
| `statePath` | `~/.dsh/feishu/state.json` | 会话映射落盘位置 |
| `resolveSenderName` | `false` | 是否调通讯录接口把提问人姓名放进消息首行。开了需要 `contact:user.base:readonly` 权限，且每个提问人 10 分钟内只查一次 |
| `askTimeoutMs` | `600000` | 选择题在飞书里等多久（毫秒，10 秒 ~ 24 小时）；超时按「没回答」结束这次提问 |
| `approvalEnabled` | `true` | 是否把 DSH 的审批接到飞书。关掉后不接管，审批仍由网页端弹窗处理 |
| `approvalTimeoutMs` | `300000` | 审批在飞书里等多久（毫秒，10 秒 ~ 1 小时）；超时按下一项处理 |
| `approvalTimeoutAllow` | `false` | 超时后是否自动允许。默认关 = 按拒绝处理（fail closed）—— 没人看着时放行一次写操作，代价比重新跑一遍大 |
| `approvalAllowTools` | `[]` | 免审批工具白名单（工具名精确匹配，大小写不敏感），如 `read, glob, grep`；命中直接放行、不发卡片 |
| `debug` | `false` | 输出调试日志（含去重、忽略原因） |

飞书里新建的会话用的是 **profile 的默认模型**（`agent-default-model` 条目的 `provider`/`model`，
DSH 里选过一次模型就会记在这里）。dsh 0.2 起新 agent 必须带模型选择，插件在 `create` / `resume`
时都会把它作为 `agentOptions` 传进去；没有默认模型时会话仍然建得起来，但第一次发言会报
`has no provider/model` —— 那种情况先在 dsh 界面里选一次模型即可。

飞书会话默认挂在 **dsh 的默认 agent 预设**上（与网页端新建会话一致）。插件建会话时会自己
`presets.resolve()` 并在 setup 回调里 `presets.mount()`，否则会话只有基础工具、连读文件都做不到；
恢复老会话时沿用日志里记录的预设，不会悄悄换一套工具。

飞书会话在 dsh 侧栏的位置：按工作目录归组。dsh 网页端新建会话时会显式把会话挂到工作区
（`workspace.attachSession`），插件建的会话也要补这一步，否则会一直挂在「未分组」。
插件按 cwd 找**同路径**的已有工作区补挂；没有同路径工作区就维持未分组（不会给任意目录新建工作区）。

## 四、启动与验证

```bash
dsh --profile web          # 启动后日志里应看到：feishu: 飞书长连接已启动
```

验证顺序：

1. 日志出现 `飞书机器人信息已获取` + `飞书长连接已启动`。
2. 飞书里私聊机器人发一句「你好」：卡片标题先显示 `回复中`，正文逐步出现，结束后变 `回复`。
3. 发 `/status`，应回一条文本消息，含会话 ID、工作目录、模型。
4. 发 `/new` 后再问「刚才我说了什么」，应该不知道上一轮内容（会话已重建）。
5. 重启 DSH 后直接发消息，应当接着原会话（日志 `已恢复 dsh 会话`，网页端正开着这条会话时是 `会话已在宿主中运行，直接复用`）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令说明 |
| `/new` | 结束当前会话，下一条消息在新上下文里执行 |
| `/stop` | 中断当前这一轮（等价于 `agent.cancel`） |
| `/status` | 会话 ID、工作目录、运行状态、模型 |
| `/cwd <目录>` | 记录本会话的工作目录，对下一次 `/new` 生效 |
| `/whoami` | 回显你的 `open_id` / `chat_id`（配白名单用） |

插件启动时会把这 6 条同步到**飞书输入框的「/」指令面板**（`application/v7/app_slash_commands`，
幂等：缺的建、描述变了才改、其余跳过）。这一步需要应用有 `application:app_slash_command:write` 权限
（扫码建的应用已自动预填）；没有权限或版本没发布时只记一条警告，命令仍可手打，不影响收发消息。

## 行为说明

- **只推自己发起的轮次**：插件只对经飞书投递的轮次建卡片；你在 DSH Web GUI 里手动对话时不会突然多出一张飞书卡片。
- **会话延续**：宿主重启后，网页端可能已经把同一条会话恢复成活的。这时飞书直接复用那条会话（两边共享同一个
  agent），不会再 resume 一次吃 `already registered` 而新建；日志是 `会话已在宿主中运行，直接复用`。网页端关掉
  这条会话后，下一条飞书消息会自动按映射重新恢复。`/new` 对借用的会话只解除绑定，不中断网页端正在跑的那一轮。
- **一卡一轮**：每轮开始建卡，结束收尾；建卡失败自动退化为纯文本回复，回复不会因为卡片故障丢失。
- **执行过程**：插件订阅 DSH 的 `session/event`，把 `tool/call` / `tool/result` 记进卡片顶部的折叠面板
  （工具名、参数摘要、耗时、成功/失败）；`progressMode=action` 只看当前一步，`off` 关闭。
  用户中断时，仍在跑的步骤会标成 ⛔，不会留一行停在「进行中」。
- **提问时的卡片顺序**：模型提问前，当前回复卡先定格成橙色「等你选择」并关流；回答（或超时 / 取消）后
  新开一张标题带「（接上条）」的卡承接后续输出。选择题卡片永远是**新消息**，绝不复用旧卡原地改写 ——
  否则新问题会出现在旧位置，把后发的卡片顶到下面去，用户看到的就是「问题被盖住 / 顺序颠倒」。
- **表情回执**：消息一落地先挂「收到」表情（比卡片更早给出反馈）；本轮结束撤掉并换成 `DONE`，
  失败换 `CRY`；命令、未授权、重复消息这类「没真正干活」的情况只撤不补，免得让人以为任务跑了。
- **引用展开**：回复某条消息时按 `parent_id` 读出被引用内容，按 `[Quoted message]` + `[User]` 两段拼进提示；
  查不到（消息被撤回 / 无权限）就按原消息投递，不会因为引用失败丢消息。
- **重投与内容去重**：按 `message_id` 挡住重复事件（保留最近 1000 条），另有 5 秒内容去重挡住
  「换个 message_id 再投一次」与连发重复句。
- **卡片收尾**：插件停止 / 宿主重启时，把在册的「回复中」卡片统一翻成「已停止」并注明「服务重启中，本轮回复已中断」，
  单卡最多等 2.5 秒 —— 否则卡片会永久停在「回复中」，用户以为还在跑。
- **去重**：飞书会重投事件，插件按 `message_id` 去重（保留最近 1000 条）。
- **文本与富文本都收**：飞书会把带格式的内容发成 `post` 富文本（例如输入框里敲出来的有序列表），插件先把标题
  与各段文字抽成纯文本再投递；富文本里夹的图片不下载。富文本里只有图片 / 附件，以及图片 / 文件 / 语音等其它类型，
  会给一次提示（同一会话 60 秒内不重复提示）。
- **审批**：DSH 执行需要确认的操作（沙箱外写入、执行命令等）时，插件抢先接管审批瀑布（`prepend`），把
  「工具名 + 理由」发成卡片；点按钮或回「允许」/「拒绝」后，暂停中的工具调用继续或终止。同一会话的审批排队发送，
  不会两张卡叠在一起；等审批期间用户发的普通文字只回一句提示，不投递成新一轮对话。关掉 `approvalEnabled`
  则不接管，仍由网页端处理。
- **身份**：每条消息的第一行是来源标记（`【飞书 · 群聊 · 张三(90abcdef)】`），与正文在同一个文本块里 ——
  模型读到正文时就看到了「谁、从哪来」，不需要额外调用；要精确字段（完整 open_id / chat_id）用 `feishu_identity`。
- **飞书工具按会话可见**：`feishu_identity` / `feishu_send` 只在**当前轮由飞书投递**的会话里出现在工具表里，
  Web GUI 的会话看不到、也调不了（强行调用返回 `not-feishu-session`）。
- **选择题**：模型调 `ask_user_question` 时，插件抢先接管（在 DSH 的提问瀑布里用 `prepend`），把题目发成卡片，
  等按钮点击 / 文字回复 / 超时；同一会话同时只允许一个待答问题，等答期间用户发的文字会被当成答案，不会再开新一轮。
  Web GUI 的会话不受影响，仍走原生问答。

## 开发

```bash
npm install          # 只有桥接层需要 @larksuiteoapi/node-sdk；单测不需要外部依赖
npm test             # node --test，纯函数单测（归一化 / 卡片 / 队列 / 会话映射 / 命令 / 流式卡片 / 执行过程 / 表情回执）
```

目录：

```text
lib/index.js          插件入口：name / inject / Config / apply
lib/config.js         配置归一化与校验（无凭证时休眠）
lib/bridge.js         飞书事件入口、串行队列、卡片生命周期、命令宿主
lib/agents.js         飞书会话键 → DSH Agent（恢复 / 新建 / 事件监听 / 回收）
lib/inbound.js        飞书事件归一化（纯函数）
lib/card.js           卡片 JSON 构造与截断（纯函数）
lib/reply-card.js     一轮回复对应的一张流式卡片（正文 + 执行过程 + 定格/收尾）
lib/progress.js       执行过程清单：工具调用摘要、耗时、折叠、字节裁剪（纯函数）
lib/reaction.js       消息表情回执：收到 / 完成 / 失败
lib/feishu-api.js     飞书 HTTP 接口（token 缓存、重试、错误包装）
lib/session-store.js  会话映射落盘（原子写）
lib/commands.js       斜杠命令
lib/identity.js       来源前缀（纯函数：单聊/群聊、姓名、open_id 尾号）
lib/questions.js      选择题：发卡片、收按钮/文字/超时、组装 answer
lib/question-card.js  选择题卡片 JSON 与回调解析（纯函数）
lib/approvals.js      审批：发卡片、收按钮/文字/超时、返回 dsh 的 outcome
lib/approval-card.js  审批卡片 JSON 与回调解析（纯函数）
lib/tools.js          飞书工具（feishu_identity / feishu_send）定义与注册
lib/queue.js          每会话串行队列
lib/log.js            统一日志
```

## 限制

- 每个飞书应用只能接一个 DSH 实例（长连接不广播）。
- 不支持多模态输入（图片 / 文件 / 语音；富文本里夹的图片同样只按纯文字处理）—— 需要的话建议先落到工作目录再让模型读文件。
- 卡片正文上限受飞书接口限制，超长内容会截断（可调 `maxReplyChars`）。
- 同一会话内严格串行：连发多条消息时，后一条要等前一轮跑完。
- 与网页端共用一条会话时（重启后复用），两个人同时说话会像「两个人在同一个聊天框里发言」，回复都落进这条会话。
- 选择题与审批卡片的按钮点击都依赖应用开通 `card.action.trigger` 回调（长连接模式）；没开通时卡片照样发得出，但点按钮没反应，只能直接回文字。
- 审批只认「允许一次」：没有「本轮总是允许」，每次写操作都要点一下。嫌烦可以把只读工具加进 `approvalAllowTools`，或把权限预设调到 `danger-full-access`（不建议）。

## License

MIT
