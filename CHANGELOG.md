# Changelog

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

（此前版本见 git history）
