# Changelog

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
