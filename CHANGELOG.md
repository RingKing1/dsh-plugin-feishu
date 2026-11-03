# Changelog

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
