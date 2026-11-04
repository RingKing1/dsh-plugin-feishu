# 需求：子agent 异步完成后，主 agent 唤醒轮的回复要回传到飞书

| 项 | 值 |
| --- | --- |
| 需求编号 | 待分配（本仓未启用需求池流程，按 `docs/` 存放） |
| 状态 | 已实现并验收（0.7.0 实现 / 0.7.1 修 bug，2026-11-05）；A5 情况 2 已实测通过 |
| 提出人 | 飞书单聊用户（open_id 尾号 `40dddce1`），2026-11-04 |
| 目标版本 | `dsh-plugin-feishu` 0.7.0（minor：新增能力，不改既有行为） |
| 代码基线 | 0.6.2（`61b6c12`）；文中行号均以该版本实测为准，升级后以 `rg` 命中行为准 |
| 改动落点 | `lib/bridge.js`（主要）、`lib/agents.js`（可能）、`test/*.test.mjs`（新增用例）、`CHANGELOG.md`、`README.md` |

## 1 背景

用户在飞书里让主 agent 起子agent 干长活（评审、调研、批量校验），主 agent 先结束本轮。子agent 跑完后，DSH 会把主 agent 唤醒处理结果——**这一段回复今天到不了飞书**。

用户原话（2026-11-04）：

> 能不能做到 主agent 收到子agent回复, 主agent新的回复可以发给飞书?
> 1. 主agent还没结束, 子agent结束, 这种我认为正常, 应该飞书能收到
> 2. 主agent结束, 子agent在之后结束, 主agent被唤醒处理, 处理后的回复也发给飞书, 这种预期是要能做到

情况 1 现状已满足；本需求只解决**情况 2**。注意缺陷性质：这里不是「重复发」，是**漏发**——过程在 Web GUI 里看得到，飞书侧完全无输出，用户只能等到下一次主动提问才知道结果。

## 2 现状与根因（0.6.2 实测证据）

### 2.1 归属模型：一条飞书入站消息 = 一张回复卡

插件不按「模型输出一段就发一条」，而由 `expectTurn` 集合决定归属（`lib/bridge.js`）：

- `:80` `this.expectTurn = new Set()`；`:76` `this.cards = new Map()`
- `:328` `this.expectTurn.add(key)` —— **全文件唯一的「认领一轮」入口**，位于飞书入站投递分支（`:318` `deliver` → `target.followup(...)`），紧随其后 `:330` `const early = this.cardFor(key)` 先建出一张「早卡」
- `:384-392` `onFrame()` 第一行 `if (!this.expectTurn.has(key) || !frame) return`（`:385`）；`:386` 在 `frame.type === 'start'` 时再调 `this.cardFor(key)` 兜底建卡（`:424` 定义）—— 只要 `expectTurn` 里有这个键，首帧就会自动拉起一张卡，**方案不需要手工 newCard**
- `:394-405` `onIdle()` 第一行（`:395`）`if (!this.expectTurn.delete(key)) return`，随后 `settleReactions` → `cards.delete(key)` → `card.finish({status:'done'})`
- `:407-421` `onError()` 同样以 `expectTurn.delete`（`:410`）作闸门

`lib/bridge.js:47` 的注释说明了这个设计的初衷：

> 只有本插件投递的轮次才推卡片（expectTurn），避免 web 端在同一会话里手动对话时凭空多出一张飞书卡片

这是**有意的防误伤**，本需求不得破坏它。

### 2.2 情况 1 为什么已可用

子agent 完成时 DSH 走 `parent.followup(message)`（`dsh-subagent/lib/index.js:1647-1648`），消息注入**同一轮** inbox。此时 `expectTurn.has(key)` 仍为真、`cards.get(key)` 仍有卡，`onFrame` 两道条件都过，内容继续流进同一张卡，不重复也不新开。

### 2.3 情况 2 的三处断点

主 agent 已 idle → `onIdle` 已执行 `expectTurn.delete(key)` + `cards.delete(key)`。子agent 完成触发唤醒，形成新的一轮后：

| # | 位置 | 代码 | 结果 |
| --- | --- | --- | --- |
| 1 | `lib/bridge.js:385` | `if (!this.expectTurn.has(key) \|\| !frame) return` | 所有流式帧被丢弃 |
| 2 | `lib/bridge.js:546`（函数自 `:539`） | `const card = this.cards.get(key)` → `if (!card) return` | 「执行过程」面板数据全丢 |
| 3 | `lib/bridge.js:395` | `if (!this.expectTurn.delete(key)) return` | 收尾也直接返回 |

监听本身是常驻的、没有被摘掉：`lib/agents.js:331-337` 在 **`agent.ctx`** 上挂了 `agent/assistant-stream` / `agent/status` / `agent/error` 三个监听，**任何**轮次（含唤醒轮、Web 端触发的轮）都会打到 `onFrame` / `onIdle`。所以缺的只是「认不认这一轮」，不是「收不收得到事件」。

### 2.4 可用的判别信号

DSH 已经给出足够信息来区分「唤醒轮」和「用户在飞书新发一条」：

- `dsh-agent/lib/types/runtime-types.d.ts:291-317`：`agent/inbox/inserted` 与 `agent/inbox/claimed` 事件。类型声明里 payload 带 `agent`，但 loop 实际 emit 的只有 `{ message }` / `{ message, turn }`（`dsh-agent-loop/lib/index.js:106`、`:200`），按实现写、别照声明写过滤；`message.source` 带来源声明
- `message.source.kind` 的取值由生产者自声明（`dsh-llm/lib/types/message.d.ts:103`，注释写明 consumers fall through unknown kinds）：
  - `'agent-message'` —— 子agent 主动发消息，`dsh-subagent/lib/index.js:447-470`
  - `'subagent-settled'` —— 子agent 完成汇总，`dsh-subagent/lib/index.js:511-549`
  - `'user'` —— 真实用户输入
- `agent/status`（`dsh-agent/lib/types/runtime-types.d.ts:279`）给出 `running` / `idle`，可判断「唤醒发生在哪个时刻」

## 3 需求

> 一句话：唤醒轮要有自己的卡，但「唤醒轮」必须是**可证明**的，不能靠「最近没投递过」猜。

**R1 唤醒轮推卡。** 当主 agent 因 `source.kind ∈ {'agent-message', 'subagent-settled'}` 的 inbox 消息被唤醒并开始新一轮时，该轮最终回复必须出现在飞书上（新开一张卡，或并入仍开着的卡，见 R5）。

**R2 不误伤。** Web 端（非飞书）发起的轮次、以及任何不是飞书入站投递的轮次，仍然不许凭空出卡。判定必须白名单化（只认 R1 的两种 `kind`），不得用「这个会话最近有飞书消息」之类的模糊条件。

**R3 卡片形态。** 新开的卡与入站卡形态一致：有「执行过程」面板（`onSessionEvent` 能挂上）、有停止按钮、结束转终态。标题需能让人一眼看出这是「子agent 回来的后续」，建议 `子agent 回来了 · <子agent id 前 6 位>`（文案待定，见 V3）。

**R4 收尾。** 唤醒轮 idle → 卡转 `done` 并清理 `expectTurn` / `cards`；唤醒轮 error → 卡转失败态并清理，行为与现有 `onError` 一致。

**R5 不重复。** 同一会话同一时刻最多一张活卡。若入站轮正在进行中（`expectTurn.has(key)` 已真），子agent 消息到来时**不得新开卡**，按现状并入（即情况 1 的行为保持不变）。

## 4 范围外（明确不做）

- 定时任务/主动推送的独立入口（另一需求）
- 入站消息类型扩展（`post`、图片等，见 README 能力表）
- Web GUI 的行为改动
- 「每个子agent 各一张卡」：一轮唤醒只出一张卡
- 子agent 的**过程**实时回传（只回传主 agent 处理后的结果，这是用户原话的口径）

## 5 方案要点（供评审）

**5.1 挂载点。** 在 `lib/agents.js` 的 `attach()`（`:327-345`，已有三个常驻监听）里再挂一个 `agent/inbox/claimed` 监听，或在 `bridge.js` 里由 agent 事件统一转发。选前者的理由：与现有三个监听同处一地，生命周期一致，不需要新增 ctx 依赖。

**5.2 判定表。**

| `message.source.kind` | 该会话在 `agents.live` 里 | arm（加入 expectTurn） | 出卡 |
| --- | --- | --- | --- |
| `subagent-settled` / `agent-message` | 是 | 是（若尚未 arm） | 是，新卡 |
| `subagent-settled` / `agent-message` | 否（非飞书会话） | 否 | 否 |
| `user` 且来自飞书投递 | — | 已在 `:328` arm | 沿用现有行为 |
| `user` 且来自 Web 端 | 是 | **否** | 否（守住 `:47` 的初衷） |
| 未知 kind | — | 否 | 否（fall through，与 DSH 注释一致） |

**5.3 时序（已对源码实证，`dsh-agent-loop/lib/index.js`）。**

```
followup(input)                        :570
  → send(input, "next-turn", true)     :564
  → inbox.splice(...) → agent/inbox/inserted   :200
  → wakeDriver（真正的唤醒动作）
  → 打开 turn → 边界 claim(target, turn)       :103
      → 逐条 emit agent/inbox/claimed（带 turn 号）  :106
  → 构造 prompt → 首帧 agent/assistant-stream  → onFrame
```

arm 必须落在 `onFrame` 之前，两个候选挂载点都满足，取舍如下：

| 挂载点 | 时机 | 优点 | 缺点 |
| --- | --- | --- | --- |
| `agent/inbox/inserted` | 入队那一刻，`wakeDriver` 之前 | 最早，必然先于任何帧 | 消息可能随后被取消（`/stop`、splice）；arm 了却没起轮会**永久残留** `expectTurn`，下一轮用户消息会串进旧卡 |
| `agent/inbox/claimed` | turn 已开、消息真的被取进某一步 | 语义确定「这轮要跑了」，且带 turn 号便于按轮记账 | 个别情况 step 被拒后该轮无 step 收尾（类型注释已写明），仍需兜底 |

建议：**以 `claimed` 为准 arm**（0.7.0 已按此实现）。实测补正两处原稿的错误：

- **`claimed` / `inserted` 的 payload 运行期带 `agent` 字段**。声明里只有 `{ message, turn }`，但 `agentEvents` 的 `fused()` 会给所有 agent 事件补上 `agent`（`dsh-agent/lib/index.js:358-366`），所以照抄现有 `payload.agent === agent` 的过滤写法是安全的。
- **不需要 `agent/inbox/discarded`，也不需要超时兜底**。既然只在 `claimed` 认领，被丢弃的消息根本走不到认领；「claimed 之后 step 被拒」那一路，轮次收尾时必然有一次 idle，键会在 `onIdle` 里被清掉。

**5.4 `expectTurn` 的数据结构（已按此实现）。** `Set<string>` 换成 `Map<key, { turns: Set<number>, wildcard: boolean, title?: string }>`：

- `wildcard = true`：飞书入站投递时的认领（`followup` 之前还没有 turn 号），收到的首帧把它定型成具体 turn 号；
- `turns`：唤醒轮由 `agent/inbox/claimed` 直接带 `turn` 号认领，`onFrame` 只放行这几个 turn 的帧 —— 同一会话里网页端发起的轮次因此不会搭车出卡；
- 粒度仍到**会话**（一张活卡）：R5 要求同一时刻最多一张卡，卡片继续复用 `cards.get(key)`。

**为什么不用按 turn 记账来清理**（原稿的“`onIdle` 任一先结束就误删”不成立）：`agent/status` 的 `idle` 语义是「没有驱动在排队或运行」，`dsh-agent-loop/lib/index.js` 的 `kick()` 用 `while (await this.turn())` 在一个驱动里接着跑排队的轮次，`turn()` 末尾是 `if (!this.inbox.hasPending) return false` —— 只要有 pending 轮次就不返回 false，也就不会 `setPhase({kind:'idle'})`。所以 `onIdle` 只在整个会话静下来时触发，`expectTurn.delete(key)` 不会误删另一轮。

## 6 验收标准

**A1（单测）唤醒轮开卡。** 用 `Object.create(FeishuBridge.prototype)` + 假成员（骨架见 `test/bridge-stream.test.mjs:9` 的 `fakeBridge`）：先跑完一轮触发 `onIdle`，再投喂 `agent/inbox/claimed`（`source.kind='subagent-settled'`）→ 断言 `expectTurn.has(key)` 为真；随后喂 `assistant-stream` 的 start 帧 → 断言 `cards` 出现新卡且帧进了卡；再 `onIdle` → 断言卡已 `finish({status:'done'})` 且登记已清理。

**A2（单测）不误伤 Web 端。** 同样序列但 `source.kind='user'` 且不经过飞书投递 → 断言 `expectTurn` 未新增、无卡片被创建。这条用例是回归防线，任何实现都不得让它变红。

**A3（单测）情况 1 不回归。** 入站轮进行中（`expectTurn.has` 为真、已有卡）时投喂子agent 消息 → 断言**不新建卡**，后续帧仍进原卡。

**A4（单测）错误路径。** 唤醒轮中 `onError` → 断言卡转失败态、登记被清理，下一轮不受影响。

**A1–A4（单测，已绿）。** 落盘在 `test/bridge-wake.test.mjs`，共 7 条（含 turn 号隔离、无会话记录不认领、idle 早于 claimed 不残留）。

**A5（手工，发布前必做；2026-11-05 实测通过）。** 飞书里发：「起一个后台子agent 跑 5 分钟，起完你直接结束本轮」→ 5 分钟后子agent 完成 → **飞书应出现一张新卡**，卡内是主 agent 处理后的结论，执行过程面板有内容；卡片终态为 done。反向验证：Web 端同一会话里**手动发一句**，飞书侧不应出现任何卡。

> 注：原稿的反向验证写的是「Web 端起子agent，飞书侧不应出现卡」，与 R1/R2 的白名单判据矛盾——`source.kind` 只说「谁叫醒了主 agent」，不区分子agent 是谁起的。0.7.0 按 R1/R2 字面实现（会出卡），严格版需要「子agent 来源」判据，见 V7。

**A6（回归）。** `npm test` 全绿；用例总数 254 → ≥258（新增 4 条），且 A2 必须独立存在。

## 7 风险与未决

| 编号 | 风险/未决点 | 处理 |
| --- | --- | --- |
| V1 | `expectTurn` 粒度（见 5.4）：并发两轮共用一键 | 已按 5.4 改成 `Map<key, {turns, wildcard}>`；idle 只在会话静下来时触发，键级清理成立 |
| V2 | 唤醒轮与飞书入站轮**同时**发生（用户恰好在这时发消息） | 已定死：并入最早那张活卡（R5），唤醒轮的 turn 号一并登记，不新开卡；A3 守这条 |
| V3 | 卡片标题与是否合并「连续多次子agent 回来」 | 已确认：标题 `子agent 回来了 · <id 前 6 位>`；连续回来各开一张，不合并 |
| V4 | `keyOfSession`（`lib/bridge.js:560`）在唤醒轮能否解析 | 只查 `agents.live`，会话在 live 里即可；A1 需覆盖 |
| V5 | 生效方式 | 改完须「发版 + 重装 profile」或本地 `dsh plugin --profile web add <path>`，**重启宿主**才生效 |
| V6 | 与 pi 桥接仓（`pi-feishu-bridge`）职责混淆 | 本需求只动 DSH 插件；桥接仓那条链路的发图/话题问题不在此列 |
| V7 | 网页端起的长活子agent 结束时也会收到飞书卡 | 0.7.0 已知边界：`source.kind` 不携带子agent 来源。要区分得在子agent 被创建的那一轮上记账（`subagent/descriptor` + 该轮是否由本插件投递），另开需求 |

## 8 工作量与交付

- 实际改动：`lib/bridge.js` +89/-9（新增 `armTurn` / `onClaimed`，`onFrame` 加 turn 号放行，`cardFor` 接标题），`lib/agents.js` +9（第 4 个常驻监听），新增 `test/bridge-wake.test.mjs` 7 条用例，`test/bridge-stream.test.mjs` 的 `fakeBridge` 改为 `armTurn` 认领。测试 254 → 261。
- 交付顺序：改代码 → `npm test` 全绿 → 补 `CHANGELOG.md` 0.7.0 段 → README 能力表加一行「子agent 唤醒轮回传」→ 发版或本地重装 → 重启宿主 → 按 A5 验收
- 文档：本文档已转 `已确认 / 已实现`，5.3 / 5.4 的实测补正已回写。

## 9 附：本轮取证命令（可复核）

```bash
P=~/.dsh/profiles/web/node_modules/dsh-plugin-feishu
node -p "require('$P/package.json').version"
rg -n 'expectTurn' "$P/lib" -g '*.js' --no-ignore -uu
rg -n 'onFrame|onIdle|onSessionEvent' "$P/lib/bridge.js"
rg -n 'inbox/claimed|inbox/inserted' ~/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts
rg -n "'agent-message'|'subagent-settled'" ~/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js
```
