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
| 斜杠命令 | `/new` `/bind` `/resume` `/stop` `/status` `/model` `/effort` `/permission` `/cwd` `/whoami` `/help`，不进模型上下文 |
| 提问人身份 | 每条消息首行带 `【飞书 · 群聊|单聊 · 张三(90abcdef)】`，模型一眼看到是谁、从哪来；详细字段走 `feishu_identity` 工具 |
| 飞书工具 | 只在飞书发起的轮次里可见：`feishu_identity`（查提问人）、`feishu_send`（主动补发一条文本）、`feishu_learn_approval_submit` / `feishu_learn_approval_status`（建审批单 / 查审批状态） |
| 选择题 | 模型用 `ask_user_question` 提问时，问题以卡片发到飞书：点按钮即答，也可以在卡片输入框自由输入（最多 200 字），或直接回文字 |
| 工具授权 | DSH 的工具需要授权时，发一张「允许一次 / 拒绝」卡片到飞书；点完这一轮直接继续，不用回网页。超时未点则转回网页，不会一直挂住 |
| 模型与推理强度 | `/model` 卡片按 provider 列模型（当前项打勾），点带推理强度的模型会接着让你选强度；`/effort` 单独换强度。走 `sessionController`，与网页端选模型同一条路径，重启后仍生效 |
| 权限模式 | `/permission` 卡片列出宿主的权限预设（只读 / 工作区读写 / 完全权限），点一下立刻改这条会话的沙箱与审批开关，网页端会话不受影响 |
| 网页端镜像 | `mirrorOtherTurns=true` 时，在电脑上（Web GUI / CLI）发起的轮次也推一张**只读**卡到飞书：执行过程 + 结论，没有按钮。`mirrorScope=bound` 只镜像已绑定会话，`all` 镜像全部（发往 `mirrorChatId`） |
| 绑定已有会话 | `/bind` 列最近 10 条 dsh 会话，`/bind <序号\|会话id>` 把当前飞书对话接到其中一条（`/resume` 同义）；活着的会话直接复用，落盘的恢复 |
| 飞书审批 | 模型调用飞书审批应用建单、用实例号查状态：典型用法是 `/learn` 进化前拿到 `APPROVED` 再动文件；审批定义号在插件页「审批」分组配置 |
| 执行过程 | 工具调用在卡片顶部的「执行过程」折叠面板里逐条显示：正在跑哪一步、成没成、耗时多少 —— 长任务不再是黑箱 |
| 子agent 唤醒轮 | 子agent 异步跑完把主 agent 叫醒时，这一轮的回复同样回传飞书：新开一张「子agent 回来了 · <id 前 6 位>」卡，执行过程面板照常；网页端轮次不受影响 |
| 正文模式 | 默认只把**本轮最终回复**写进卡片正文；中间步骤的旁白、思考自动收进「执行过程」面板，不再和答案混在一起（`replyBodyMode=live` 可退回旧行为） |
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
   | `contact:user.base:readonly`（建议开） | 把提问人姓名显示在消息首行；没开也能用，只是首行显示 open_id 尾号 |

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

> 执行过程、表情回执、引用展开这四项在侧边栏 **飞书 → 「消息交互」** 分组里（默认就展开，不在「高级设置」里）：
> 执行过程是下拉（完整清单 / 只显示当前一步 / 不显示），表情回执是下拉（含「自定义…」可填任意飞书 emoji key），
> 引用展开是开关 + 字数上限。改完保存，下一轮消息生效，不用手改 yaml。

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
| `replyBodyMode` | `final` | 卡片正文写什么：`final` 只写本轮最后一步的文本（中间旁白进过程面板）；`live` 把全过程的文本按顺序拼进正文（旧行为） |
| `showReasoning` | `false` | 是否把模型的思考（`reasoning-delta`）也记进「执行过程」面板，每条前加 🧠。默认关：思考量大，开着面板会很长 |
| `reactEmoji` | `Get` | 收到消息时挂的表情（飞书 emoji key）；留空 = 关闭表情回执。结束 / 失败固定用 `DONE` / `CRY` |
| `includeQuotedMessage` | `true` | 回复某条消息时是否展开被引用内容 |
| `quotedMessageMaxChars` | `8000` | 引用内容最多展开多少字符（100 ~ 50000），超出截断并注明 |
| `statePath` | `~/.dsh/feishu/state.json` | 会话映射落盘位置 |
| `resolveSenderName` | `true` | 是否调通讯录接口把提问人姓名放进消息首行（需要 `contact:user.base:readonly` 权限；没权限时自动退化成 open_id 尾号）。每个提问人 10 分钟内只查一次；关掉可省这次请求 |
| `askTimeoutMs` | `600000` | 选择题在飞书里等多久（毫秒，10 秒 ~ 24 小时）；超时按「没回答」结束这次提问 |
| `mirrorOtherTurns` | `false` | 网页端轮次也推飞书（只读卡，不给按钮）；默认关，避免电脑前干活被刷屏 |
| `mirrorScope` | `bound` | `bound` 只镜像已绑定飞书会话上的轮次；`all` 镜像所有会话 |
| `mirrorChatId` | 空 | `scope=all` 时发往的 chat_id；留空 = 最近一次对话的会话 |
| `identityHeader` | `true` | 消息首行是否写 `【飞书 · 单聊 · 张三(1a2b3c4d)】`；关掉后正文只保留用户原话，身份仍可用 `feishu_identity` 查 |
| `approvalInFeishu` | `true` | 工具授权是否搬到飞书：`true` 发「允许一次 / 拒绝」卡片，`false` 保持旧行为只在网页弹 |
| `approvalTimeoutMs` | `600000` | 飞书里等授权多久（毫秒，10 秒 ~ 24 小时）；超时后请求转回 DSH 网页 |
| `approvalCode` | 空（未配置） | 飞书审批定义号（`approval_code`）：模型调用提交工具时用它建单。留空 = 未配置，工具明确返回失败，不发空请求 |
| `approvalWidgetId` | 空（自动） | 审批表单里接收正文的控件 id；留空 = 自动挑（多行文本优先，其次单行文本）。审批定义有多个控件、自动挑错时才填 |
| `debug` | `false` | 输出调试日志（含去重、忽略原因）；同时决定 debug 级是否落盘 |
| `logDir` | `~/.dsh/logs` | 日志文件目录。按天分文件（`feishu-2026-11-05.log`），单文件超限滚动保留 3 份；info/warn/error 无条件落盘 |
| `logMaxBytes` | `0` | 单个日志文件上限（字节），超出滚动；`0` = 用默认 10MB |

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
| `/status` | 会话 ID、工作目录、运行状态、模型（`provider/model · 强度`）与权限模式 |
| `/cwd <目录>` | 记录本会话的工作目录，对下一次 `/new` 生效 |
| `/bind [序号\|会话id\|标题]` | 绑定到一条已存在的 dsh 会话；不带参数列出最近 10 条（带会话标题） |
| `/resume` | `/bind` 的别名 |
| `/model` | 选择模型（卡片；有推理强度的模型会接着让你选强度） |
| `/effort [provider/model]` | 选择推理强度；省略模型 = 当前模型（`/reasoning` 同义） |
| `/permission` | 选择权限模式：只读 / 工作区读写 / 完全权限（`/mode` 同义） |
| `/whoami` | 回显你的 `open_id` / `chat_id`（配白名单用） |

插件启动时会把这些命令同步到**飞书输入框的「/」指令面板**（`application/v7/app_slash_commands`，
幂等：缺的建、描述变了才改、其余跳过）。这一步需要应用有 `application:app_slash_command:write` 权限
（扫码建的应用已自动预填）；没有权限或版本没发布时只记一条警告，命令仍可手打，不影响收发消息。

## 行为说明

- **只推自己发起的轮次**：插件只对经飞书投递的轮次建卡片；你在 DSH Web GUI 里手动对话时不会突然多出一张飞书卡片。
- **子agent 唤醒轮也回传**：主 agent 起了长活子agent 后先结束本轮，子agent 跑完时 DSH 用 `followup` 把主 agent
  叫醒，这一段回复会以新卡发到飞书（标题 `子agent 回来了 · <子agent 会话 id 前 6 位>`），执行过程面板、停止按钮、
  终态都与入站卡一致。判据是 `agent/inbox/claimed` 的 `message.source.kind` 白名单（`subagent-settled` /
  `agent-message`），并按该轮的 `turn` 号放行——同一会话里网页端发起的轮次不会被带出来。子agent 回来的那一刻
  若入站轮还在跑，就并进那张仍开着的卡，不会同时挂两张。注意判据只看「谁叫醒了主 agent」，所以网页端起的长活
  子agent 结束时同样会收到一张飞书卡。
- **会话延续**：宿主重启后，网页端可能已经把同一条会话恢复成活的。这时飞书直接复用那条会话（两边共享同一个
  agent），不会再 resume 一次吃 `already registered` 而新建；日志是 `会话已在宿主中运行，直接复用`。网页端关掉
  这条会话后，下一条飞书消息会自动按映射重新恢复。`/new` 对借用的会话只解除绑定，不中断网页端正在跑的那一轮。
- **一卡一轮**：每轮开始建卡，结束收尾；建卡失败自动退化为纯文本回复，回复不会因为卡片故障丢失。
- **正文只放答案**：DSH 的一个 turn 里有多个 step（模型思考 → 调工具 → 再说话），每个 step 都会吐文本。
  插件按 `assistant-stream` 的 `turn` / `step` / `attemptId` 分段：**只有最后一个 step 的文本进正文**，
  前面 step 的文本以 `💬 旁白` 记进「执行过程」面板；同一步重试（`attemptId` 变了）会把上一版的文本清掉重来，
  `abandoned` 的 attempt 直接丢弃，不会把废稿留在卡片上。想恢复「全过程拼在一起」就用 `replyBodyMode=live`。
- **执行过程**：插件订阅 DSH 的 `session/event`，把工具调用记进卡片顶部的折叠面板
  （工具名、参数摘要、耗时、成功/失败）。除了 `tool/call` / `tool/result`，也接 `tool/ptc-dispatch-start` /
  `tool/ptc-dispatch` —— ptc 预设下模型写的 `run_code` 里再调 `read` / `bash`，这些子调用同样会逐条出现，
  不会只剩一行 `run_code`。旁白与（可选的）思考也在同一面板里，标题带「第 N 步」；
  `progressMode=action` 只看当前一步，`off` 关闭。用户中断时，仍在跑的步骤会标成 ⛔，不会留一行停在「进行中」。
- **超长收尾**：正文超过 `maxReplyChars` 会截断，并在卡片顶部补一句「本轮输出达到长度上限，已被截断」。
- **提问时的卡片顺序**：模型提问前，当前回复卡先定格成橙色「等你选择」并关流；选择题以新消息发一张「请选择」卡。
  回答（或超时 / 取消）后，选择题卡原地刷新成绿色「已选择」/ 灰色「选择超时」「已结束」，回复卡也翻成灰色「已选择」，
  再新开一张「回复（接上条）」承接后续输出。选择题卡片本身是新消息，只在原位刷新，不会另发一条把顺序打乱。
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
- **飞书审批**：模型通过 `feishu_learn_approval_submit` 调飞书审批应用建单（正文写进审批表单的文本控件），
  立即拿到实例号，不在这里等审批；之后用 `feishu_learn_approval_status` 查一次。只有 `APPROVED` 才能继续执行
  被授权的操作；`PENDING` / 查询失败都按未通过处理，必须用同一实例号续查，不能重复建单。
  插件不接管 DSH 自己的工具执行审批，那部分仍由网页端处理。
  同时把「当前 agent 是不是飞书会话」注册成进程级判据 `dsh.feishu.isFeishuAgent`（值为 `registry.owns`），
  供 knowledge-flow 的 `/learn 应用` 按会话识别审批通道；本地会话仍走降级分支。
- **身份**：每条消息的第一行是来源标记（`【飞书 · 群聊 · 张三(90abcdef)】`），与正文在同一个文本块里 ——
  模型读到正文时就看到了「谁、从哪来」，不需要额外调用；要精确字段（完整 open_id / chat_id）用 `feishu_identity`。
- **飞书工具按会话可见**：`feishu_identity` / `feishu_send` / `feishu_learn_approval_submit` /
  `feishu_learn_approval_status` 只在**当前轮由飞书投递**的会话里出现在工具表里，
  Web GUI 的会话看不到、也调不了（强行调用返回 `not-feishu-session`）。
- **选择题**：模型调 `ask_user_question` 时，插件抢先接管（在 DSH 的提问瀑布里用 `prepend`），把题目发成卡片，
  等按钮点击 / 卡片输入框 / 文字回复 / 超时；卡片输入框可自由作答（最多 200 字），适合选项都不合适的情况。
  每题答完卡片原地刷新，全部答完标题变绿「已选择」，超时变灰「选择超时」；同一会话同时只允许一个待答问题，
  等答期间用户发的文字会被当成答案，不会再开新一轮。Web GUI 的会话不受影响，仍走原生问答。

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
lib/approval.js       飞书审批应用：建单 / 查单、状态映射、表单控件解析
lib/tools.js          飞书工具（身份 / 发消息 / 审批提交与查询）定义与注册
lib/queue.js          每会话串行队列
lib/log.js            统一日志（宿主 + 按天落盘 / 滚动）
lib/card-registry.js  在册卡片（崩溃后启动清扫残留的「回复中」卡片）
```

## 限制

- 每个飞书应用只能接一个 DSH 实例（长连接不广播）。
- 不支持多模态输入（图片 / 文件 / 语音；富文本里夹的图片同样只按纯文字处理）—— 需要的话建议先落到工作目录再让模型读文件。
- 卡片正文上限受飞书接口限制，超长内容会截断（可调 `maxReplyChars`）；`replyBodyMode=final` 下只截最终回复。
- 正文模式按 step 切分，**假定最后一个 step 才是答案**：模型如果习惯在中间步骤写完答案、最后一步只补一句「完成」，卡片正文就只有那句。此时把 `replyBodyMode` 设成 `live`。
- 同一会话内严格串行：连发多条消息时，后一条要等前一轮跑完。
- 与网页端共用一条会话时（重启后复用），两个人同时说话会像「两个人在同一个聊天框里发言」，回复都落进这条会话。
- 选择题卡片的按钮点击依赖应用开通 `card.action.trigger` 回调（长连接模式）；没开通时卡片照样发得出，但点按钮没反应，只能直接回文字。
- 飞书审批的通过 / 拒绝由审批人在飞书审批应用里完成；插件只负责建单与查一次状态，不轮询、不代为审批，也不会把结果主动推回会话。

## License

MIT
