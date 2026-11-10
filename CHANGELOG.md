# Changelog

## 0.9.0

飞书里可以自己选模型、推理强度和权限模式了，不用再回网页点。

### /model 与 /effort

- `/model` 发一张卡片：按 provider 分组列出可用模型，当前模型打勾（取自
  `sessionController.selectionFor(agent)`，与网页端同一个来源）。
- 点一个**声明了推理强度**的模型，卡片原地换成强度选择（默认 / 各档），
  一次选完；没声明的模型直接生效。
- `/effort [provider/model]` 单独选强度，省略参数就用当前模型。
- 切换走 `sessionController.selectForNextRequest`：与网页端选模型完全同一条路径，
  写 `model/selection` 事件，重启后仍生效。
- 模型目录按 provider 缓存 5 分钟（列模型可能要走网络），单个 provider 失败不影响其它。

### /permission

- `/permission`（别名 `/mode`）列出宿主真实的权限预设目录（`permissionPresets.catalog()`）：
  只读 / 工作区读写 / 完全权限，自动带出宿主配的名称与说明。
- 点击即 `preset.set(session, name)`：立刻改这条会话的沙箱与审批开关，下一轮工具调用生效。
- 只影响当前飞书会话，网页端会话不受影响。

### 其它

- `/status` 现在报真实模型（`provider/model · 强度`）与权限模式。
- 命令面板同步 `/model` `/effort` `/permission`。
- 新增单测 17 条（settings-card / session-settings / 命令卡片），全套 315 条通过。

## 0.8.0

两个能力补齐：DSH 的工具授权搬到飞书，以及把飞书会话绑定到已存在的 dsh 会话。

### 工具授权卡片（approval/request）

- **接 `approval/request` waterfall**（`prepend`）：本插件会话的工具需要授权时，
  发一张「允许一次 / 拒绝」卡片到飞书，点完这一轮直接继续，不再等网页弹窗。
- **一个会话同时只等一个授权**；已有授权在等时，新的请求直接交给下一个 answerer。
- **请求只放行一次**：按钮回的是 `allowed-once` / `rejected`，不存在永久放行。
- **超时/发卡失败 = 交回网页**：任何没拿到决定的路径都 `next()`，让网页 answerer 接手，
  不会把这一轮按 `unavailable` 直接判失败。
- **/stop、/new、插件停止**都会取消等待中的授权，不留悬空 Promise。
- 新增配置：`approvalInFeishu`（默认 `true`）、`approvalTimeoutMs`（默认 10 分钟），
  插件页「审批」分组可直接改。

### /bind 与 /resume

- `/bind`（无参数）列最近 10 条 dsh 会话：序号、会话 id 尾号、目录名、时间、是否运行中。
- `/bind <序号|会话id>`：写映射并立刻解析一次 —— 宿主里活着的会话直接借用，
  已落盘的恢复，都不行才新建；`/resume` 是它的别名。
- 只改映射、不动其它会话：网页端正在跑的会话不会被中断。
- 实现用 `ctx.sessionQuery.listSessions()` 的 live-preferred 语料，与网页端看到的范围一致；
  子agent 会话不进列表。

### 其它

- 新增单测：`approval-card`、`tool-approvals`、`bind`（共 27 条），全套 298 条通过。

## 0.7.2

按 `feishu-feature-report.md` 的 P0 修「卡片假活」：一张卡建好就再也不动，进程崩了也没人管。

### NFR-1 卡片存活感知

- **建卡竞态**：建卡请求还没返回时到达的工具调用 / 文本，原来被 `schedule()` 直接丢掉
  （`if (!this.cardId) return`），而 `doStart()` 只在有正文时才补刷新 —— 纯工具轮次因此
  「一张卡建好就冻住」。现在用 `pendingFlush` 记账，建卡成功后补排期。
- **心跳**：新增 15 秒心跳与顶部状态行（`element_id: status`），
  `⏳ 回复中 · 第 N 步 · bash pnpm build · 已用 12:11`。没有新事件也自己走字，
  飞书那侧「一动不动 = 卡死」的观感消失。

### NFR-2 终态兜底与自愈

- **收尾重试**：正文 / 过程 / 关流 / 终态卡片全部改走 `attempt()`（3 次，300/600/1200ms 退避）。
  以前一次超时就把卡片永久留在「回复中」。
- **巡检**：bridge 每 60 秒扫 `liveCards`，超过 3 分钟没有任何成功写入的卡片强制翻成
  「⛔ 已中断」。
- **启动清扫**：在册卡片落盘到 `statePath` 同目录 `running-cards-<appId>.json`，
  重启后逐张翻成「已中断 · 服务重启」，不再留着假活的卡。

### NFR-3 收尾失败可见

- 终态更新彻底失败时，纯文本兜底前面加 `⚠️ 卡片状态更新失败，以下为最终结果：`，
  不再静默降级。

### NFR-4 日志落盘

- `lib/log.js` 新增文件落盘：默认 `~/.dsh/logs/feishu-<YYYY-MM-DD>.log`，
  每行带本地时间（含时区）、级别、来源 `[feishu:<机器人>]`、结构化细节；
  info/warn/error 无条件写，debug 跟随设置页开关；超 10MB 滚动、保留 3 份。
- 新增配置 `logDir` / `logMaxBytes`；`createLog(ctx, debug, { dir, maxBytes })`。
- `log.scope(label)` 取代 index.js 里手写的 `botLog`。
- 保留 0.7.1 的 `trace` 埋点：重试路径也会 `trace('flush-failed' / 'finish-update-failed')`。

测试 264 → 283（新增 `test/log.test.mjs`、`test/card-registry.test.mjs`，以及心跳 / 建卡竞态 / 收尾重试共 19 例）。

## 0.7.1

### 修正：0.7.0 的卡片正文全空（所有轮次，不只唤醒轮）

0.7.0 为了「只放行唤醒轮，不让网页端的轮次搭车出卡」，在 `onFrame` 里按 `frame.turn` 做归属判断。
但 dsh 的 `AssistantStreamAttempt` **只在 `start` 帧写 `turn` / `step`**，`chunk` 与 `end` 帧只有
`attemptId` / `revision` / `index`（`dsh-agent-loop/lib/index.js:387-441`）。于是 `Number(undefined) = NaN`，
第一帧定型后**所有正文增量与收尾帧全被丢掉**，卡片只留建卡时的占位符，收尾时 `finish({status:'done'})`
拿到空正文 —— 线上 trace 实测 10942 个 chunk + 9 个 end 帧全部 drop。

现在：

- `start` 帧按 `turn` 号放行，并记下这次 attempt 的 `attemptId`；
- `chunk` / `end` 帧不再看 turn，改为「这一轮已开过卡 + `attemptId` 对得上」才放行（上一次被丢弃的
  attempt 的尾帧不会写进当前卡）；
- 回归用例 `A1c`（chunk/end 不带 turn 必须进卡）与 `A1d`（别的 attempt 的尾帧不许混入）按**线上真实帧形态**
  写 fixture；此前的 fixture 给 chunk 帧塞了 `turn: 0`，所以单测没拦住这个回归。

### 修正：提问人姓名又变回 open_id 尾号

`resolveSenderName` 原来是 opt-in（`=== true`），profile 配置一旦被重建/漏写就静默退化。
现在默认开启（`!== false`，仍可在插件页关掉）：解析失败（没开 `contact:user.base:readonly`
或查不到人）只会在消息首行退化成 open_id 尾号，不报错、不拖慢投递，同一 open_id 缓存 10 分钟。
顺手把**卡片标题**也接上了解析结果：`飞书 · 苏文广`，拿不到姓名才退回 `飞书 · dddce1`（原来标题永远是尾号，
姓名只出现在消息首行前缀里）。

### 新增：可选的链路追踪（`debug: true` 时才有 IO）

`lib/trace.js` + `reply-card.js` 埋点：`deliver` / `arm` / `claimed` / `frame-drop` / `frame-start` /
`idle` / `finish` / `card-start` / `flush-ok` / `flush-failed` 等事件按 JSONL 追加到
`~/.dsh/feishu/trace.log`（超过 2MB 自动 truncate）。关掉 debug 时不产生任何 IO。

测试 261 → 263。

## 0.7.0

### 新增：子agent 异步完成后，主 agent 的唤醒轮回复也能回到飞书

主 agent 起一个长活子agent 后先结束本轮；子agent 跑完时 DSH 会把主 agent 唤醒（`parent.followup`）
处理结果——这一段回复以前**到不了飞书**（过程在 Web GUI 里看得到，飞书侧完全没输出，用户只能等下次
主动提问才知道）。原因是插件的推卡资格由 `expectTurn` 决定，而 `onIdle` 在上一轮结束时已经把它删了，
于是唤醒轮的流式帧、执行过程、收尾三道闸门全部直接返回。

现在：

- 新增 `agent/inbox/claimed` 监听（`lib/agents.js` 的 `attach()`，与既有的 assistant-stream / status /
  error 三个常驻监听同处一地）。**白名单**只认 `message.source.kind` 为 `subagent-settled`
  （子agent 跑完的汇总）与 `agent-message`（子agent 中途主动发消息）两种，其余（含 `user`、未知 kind）
  一律 fall through 不认领——网页端在同一会话里起的轮次仍然不会凭空多出一张飞书卡。
- 选 `claimed` 而不是 `inserted`：`inserted` 之后消息还可能被 `/stop` 清掉，认领了却没有轮次会残留到下一轮；
  `claimed` 表示「轮次已开、消息真的被取进这一步」，且带 `turn` 号。
- `expectTurn` 从 `Set<string>` 改成 `Map<key, { turns: Set<number>, wildcard, title }>`：
  唤醒轮按 **turn 号**放行，同一会话里别的入口的轮次不能搭车出卡；飞书入站投递仍是无 turn 号的
  通配认领，由首帧定型。`onIdle` 依旧按会话键清理——`agent/status` 的 `idle` 语义是「没有驱动在排队或运行」
  （`dsh-agent-loop/lib/index.js` 的 `kick()` 用 `while (await this.turn())` 在同一个驱动里接着跑排队轮次），
  所以它只在整条会话静下来时才触发，不会出现「一轮结束把另一轮的资格删掉」。
- 唤醒轮新开一张卡，标题 `子agent 回来了 · <子agent 会话 id 前 6 位>`；形态与入站卡一致（执行过程面板、
  停止按钮、结束转终态）。**同一时刻最多一张活卡**：若这一轮到来时入站轮还在跑（情况 1），按原行为并入
  那张卡，不新开。

已知边界：`source.kind` 只说明「谁叫醒了主 agent」，不区分这个子agent 是飞书起的还是网页端起的，
所以网页端起的长活子agent 结束后同样会收到一张卡。要区分得再引入「子agent 来源」判据（见需求文档 V7）。

测试 254 → 261（新增 `test/bridge-wake.test.mjs`：唤醒轮开卡、turn 号隔离、Web 端不误伤、无会话记录不认领、
情况 1 不回归、错误路径、idle 早于 claimed 不残留）。

## 0.6.2

### 修正：执行过程只显示一条（建卡时没留元件，后续推送全被 400 拒）

线上实测（真 api 建卡、回放一轮 6 个工具调用的真实会话）发现三个叠加缺陷：

- **建卡时清单还是空的就不建过程面板**。CardKit 只能更新已存在的 `element_id`，
  建卡后每次 `PUT /elements/progress/content` 都返回
  `not find elementID : progress`（一轮里失败 43 次）。面板因此定格在建卡那一刻的
  内容上——通常只有第一条工具，标题也永远停在「执行过程」。
  现在 `progressMode ≠ off` 时始终建出面板元件（清单为空用单个空格占位）。
- **`tool/result` 的 callId 取错字段**。dsh 的载荷是 `ToolMessage`，id 在
  `message.toolCallId`；只认 `message.callId` 导致**所有行永远停在 ⏳**，
  收尾后也看不到 ✅ 与耗时。
- **正文与过程并发写入导致 `sequence number compare failed`**。飞书按 sequence
  严格递增校验整卡更新，两个刷新只要交错一次，后来的请求就被拒。现在所有卡片写入
  排进同一条串行队列。

另外把「有没有结束」的判断从真值改成 `!== undefined`，假时钟从 0 起时不再把已结束的行渲染成 ⏳。

测试 250 → 254。

## 0.6.1

### 修正：工具执行期间卡片停在一句「正在继续…」

0.6.0 在切步时立刻把正文清空，于是「模型去调工具」的几十秒里卡片只剩一句占位，
看上去像卡死。现在：

- 切步**不清空**正文：上一步的文字留在卡片上，新一步真正开口（第一个 text-delta）时才整段替换；
- 正文确实为空时，占位改成实时的「⏳ 正在执行 bash pnpm test…」，而不是静态一句「正在处理…」；
- 正文写入统一以状态机算出的全文为准（`setText`），不再做增量拼接，切步后不可能把两段接在一起。

## 0.6.0

### 修正：中间过程混进正文

- 卡片正文改为按 `assistant-stream` 的 `turn` / `step` / `attemptId` 分段（新增 `lib/reply-stream.js` 状态机）：
  - 只有**本轮最后一个 step** 的文本进正文，之前各步的文本以 `💬 旁白` 进「执行过程」面板；
  - 同一步重试（`attemptId` 变化）清掉上一版的流式文本重新渲染，`abandoned` 的 attempt 直接丢弃；
  - 同一 attempt 里多个 text 块之间补空行，不再粘成一段；
  - `block-end` 的权威全文用于校正流式少字，`finish.reason=max-tokens` 时在卡片顶部提示已截断；
  - 末步为空（只调工具 / 被中断）回落到最后一个有文本的步骤，不会推一张空卡。
- 新增配置 `replyBodyMode`：`final`（默认，只发最终回复）/ `live`（全过程拼进正文，旧行为）。
- 新增配置 `showReasoning`：把 `reasoning-delta` 记进过程面板（默认关）。

### 修正：ptc 预设下过程面板只剩一行 `run_code`

- 订阅 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`，`run_code` 内部的 `read` / `bash` 等子调用现在逐条可见。

### 其他

- 过程面板标题带「第 N 步」；条目上限 200 条，避免长任务把卡片撑爆。
- 卡片正文不会推空串（切步清空时推「正在继续…」占位，飞书拒收空 content）。
- `done` 终态也支持备注，超长截断提示不再丢失。

## 0.5.4

- 注册飞书会话判据（新增 `lib/feishu-agent.js`），`/learn` 等能力可识别飞书发起的会话。
- README 补充说明，配套测试。

（更早版本见 git history）
