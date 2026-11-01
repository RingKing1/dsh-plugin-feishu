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
| 会话保持 | 飞书会话 ↔ DSH 会话映射落盘，DSH 重启后接着聊（恢复失败自动新建） |
| 消息串行 | 同一会话连发多条按顺序处理，不会两条消息抢同一个轮次 |
| 权限白名单 | 只认指定 open_id；留空则谁都能用（建议自用场景也配一下） |
| 斜杠命令 | `/new` `/stop` `/status` `/cwd` `/whoami` `/help`，不进模型上下文 |

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

   群里**不 @ 机器人也要响应**时，额外开「获取群组中所有消息」（`im:message.group_msg`），
   并把插件配置 `requireMentionInGroup` 设为 `false`。

3. **事件与回调 → 事件配置**：订阅方式选**使用长连接接收事件**，添加事件 `im.message.receive_v1`（接收消息 v2.0）。
4. **应用功能 → 机器人**：启用机器人。
5. 版本管理与发布 → 创建版本并发布（企业内自建应用一般需要管理员审核）。

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

三种方式，任选其一（优先级：插件页 / 配置文件 > 环境变量）。

**A. 插件页直接改（推荐，改完即时生效）**

侧栏 **插件** → 选中 **dsh-plugin-feishu** → 「配置」里填 `appId` / `appSecret` 等字段 → 保存。

- 所有字段都声明为 volatile，Host 才会为这个条目开配置命名空间、插件页才会渲染表单；保存后插件**自动断开重连**，不用重启 dsh。
- `appSecret` 带 role('secret')：保存后不会被回显，只能覆盖。
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
| `workdir` | DSH 进程当前目录 | 新建会话的工作目录 |
| `allowedOpenIds` | `[]` | 允许使用的 open_id 列表；空表示不限制 |
| `requireMentionInGroup` | `true` | 群聊是否必须 @ 机器人才响应 |
| `streamIntervalMs` | `700` | 卡片流式刷新间隔（毫秒），飞书侧限频，不建议低于 200 |
| `maxReplyChars` | `8000` | 单张卡片正文上限，超出截断并在文末提示 |
| `statePath` | `~/.dsh/feishu/state.json` | 会话映射落盘位置 |
| `debug` | `false` | 输出调试日志（含去重、忽略原因） |

## 四、启动与验证

```bash
dsh --profile web          # 启动后日志里应看到：feishu: 飞书长连接已启动
```

验证顺序：

1. 日志出现 `飞书机器人信息已获取` + `飞书长连接已启动`。
2. 飞书里私聊机器人发一句「你好」：卡片标题先显示 `回复中`，正文逐步出现，结束后变 `回复`。
3. 发 `/status`，应回一条文本消息，含会话 ID、工作目录、模型。
4. 发 `/new` 后再问「刚才我说了什么」，应该不知道上一轮内容（会话已重建）。
5. 重启 DSH 后直接发消息，应当接着原会话（日志 `已恢复 dsh 会话`）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令说明 |
| `/new` | 结束当前会话，下一条消息在新上下文里执行 |
| `/stop` | 中断当前这一轮（等价于 `agent.cancel`） |
| `/status` | 会话 ID、工作目录、运行状态、模型 |
| `/cwd <目录>` | 记录本会话的工作目录，对下一次 `/new` 生效 |
| `/whoami` | 回显你的 `open_id` / `chat_id`（配白名单用） |

## 行为说明

- **只推自己发起的轮次**：插件只对经飞书投递的轮次建卡片；你在 DSH Web GUI 里手动对话时不会突然多出一张飞书卡片。
- **一卡一轮**：每轮开始建卡，结束收尾；建卡失败自动退化为纯文本回复，回复不会因为卡片故障丢失。
- **去重**：飞书会重投事件，插件按 `message_id` 去重（保留最近 1000 条）。
- **只支持文本消息**：图片 / 文件 / 语音等会给一次提示（同一会话 60 秒内不重复提示）。
- **审批**：插件不代理 DSH 的审批。用飞书驱动任务时，请把 DSH 审批策略设为不询问（或只放开只读工具），否则会话会卡在等审批。

## 开发

```bash
npm install          # 只有桥接层需要 @larksuiteoapi/node-sdk；单测不需要外部依赖
npm test             # node --test，纯函数单测（归一化 / 卡片 / 队列 / 会话映射 / 命令 / 流式卡片）
```

目录：

```text
lib/index.js          插件入口：name / inject / Config / apply
lib/config.js         配置归一化与校验（无凭证时休眠）
lib/bridge.js         飞书事件入口、串行队列、卡片生命周期、命令宿主
lib/agents.js         飞书会话键 → DSH Agent（恢复 / 新建 / 事件监听 / 回收）
lib/inbound.js        飞书事件归一化（纯函数）
lib/card.js           卡片 JSON 构造与截断（纯函数）
lib/reply-card.js     一轮回复对应的一张流式卡片
lib/feishu-api.js     飞书 HTTP 接口（token 缓存、重试、错误包装）
lib/session-store.js  会话映射落盘（原子写）
lib/commands.js       斜杠命令
lib/queue.js          每会话串行队列
lib/log.js            统一日志
```

## 限制

- 每个飞书应用只能接一个 DSH 实例（长连接不广播）。
- 不支持多模态输入（图片 / 文件 / 语音）—— 需要的话建议先落到工作目录再让模型读文件。
- 卡片正文上限受飞书接口限制，超长内容会截断（可调 `maxReplyChars`）。
- 同一会话内严格串行：连发多条消息时，后一条要等前一轮跑完。

## License

MIT
