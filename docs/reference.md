# Relay · 开发者参考

面向要改这个插件的人。接入方看 [guide.md](guide.md)，设计取舍看 [plan.md](plan.md)。

---

## 1. 文件

| 文件 | 职责 |
|---|---|
| `index.js` | 全部 Host 逻辑：路由、鉴权、准入、投递、事件关联、结果、流式 |
| `native-dialog.js` | 系统原生确认框。三平台各一条命令，超时与取消都要杀子进程 |
| `client.js` | 浏览器半：设置面板里的「应用权限」页 |
| `cordis.patch.yml` | 插入一行插件 |
| `README.md` | 包说明 |

`index.js` 里没有模块拆分，全部状态在 `apply` 闭包里——插件重载即清空，这是有意的：**除凭证和工作区之外，这个插件不该有任何需要持久化的状态**。

---

## 2. 一次请求的完整路径

```
POST /submit
  │
  ├─ 校验字段（content / source / session / trigger / timeout）
  ├─ 验凭证 ── 失败 401，不查 session、不生成编号
  ├─ 读级别，判断要不要弹窗
  │    └─ 需要确认 → 原生弹窗排队 → 允许/拒绝/超时
  ├─ 解析会话：get → resume → create（统一在工作区里）
  ├─ 生成 id：{session}~{source}~{uuid}
  ├─ 构造 UserMessage → agent.followup()
  ├─ 开流式（如果 stream）或直接返回 202
  └─ 之后靠事件认领产出
```

产出认领：

```
agent/inbox/claimed   → 绑定 id → turn
agent/assistant-stream (start) → 绑定 turn → 流式任务
                       (chunk) → 转发 text/reasoning 增量
                       (end)   → 解绑
session/event (assistant/message) → 收候选答案
              (turn/end)          → 结算
```

---

## 3. 五条不变式

改动时别破坏它们，每条都对应一个真实踩过的坑。

**① 用 `agent/inbox/claimed` 认领消息，不要用 `user/message`。**
turn 在进入 step 之前就失败时（例如没有可用模型），日志里有 `turn/start`、inbox 被取走、`turn/end`，但**不会产生 `user/message`**。用后者关联，任务会永远停在 pending。

**② 流式按 `start` 帧绑定，不要按 turn 查 chunk。**
`chunk` 帧不带 `turn`，只有 `start` 帧带。而且任务在队列里时流已经开着，同一会话可能有用户的轮次在跑——按 `start` 绑定意味着只有本轮开始后的增量会被转发。

**③ agent 作用域的事件要显式声明全局接收。**
`agent/assistant-stream`、`agent/disposed` 这类事件不会自动冒泡到根上下文，注册时要带全局选项，否则监听器根本不会被调用。

**④ `trigger` 与 `approved` 不能合并。**
`trigger` 是应用自报的发起方，`approved` 是这次调用是否被允许发生。用户点一次「允许」只改后者。合并会导致后台消息被标成用户发言。

**⑤ 包装必须序列化，不能拼前缀。**
外部原文作为 JSON 字符串字段，闭合不了引号，伪造不出包装结构。这是注入边界。

---

## 4. 内部状态

全部在 `apply` 闭包里：

| 名字 | 结构 | 生命周期 |
|---|---|---|
| `tasks` | `id → 任务` | 结算后保留 `resultTtlMs` |
| `byMessage` | `message.id → 任务` | 未认领期间 |
| `turnIndex` | `会话~turn → 任务` | 认领到结算 |
| `streamingByAgent` | `agent.id → 任务` | start 到 end |
| `agentCache` | `会话 → Promise<Agent>` | 防止并发重复创建 |
| `attached` | 已登记到工作区的会话 | 进程内 |
| `dialogChain` | Promise 链 | 保证同时只有一个系统对话框 |

任务对象：`{id, session, source, state, acceptedAt, waiters, candidate, claimed, turn, timer, ttl, event, stream, streamTimer}`。

`state`：`pending | final | error | expired`。

---

## 5. 存储

**凭证**：`ctx.credentials` 的一条 `grant` 记录，key 为 `relay/<source>`，payload 为 `{fingerprint, level}`。

- `modifyRecord` 是独占读改写，轮换凭证不会丢写。
- `listRecords` 过滤 `relay/` 前缀即得登记表。
- 指纹比较用 `timingSafeEqual`，长度不等直接 false。

**会话与工作区**：会话 id 就是外部会话名，`cwd` 指向工作区目录。首次创建时以 `wx`（不存在才写）方式播种 `AGENTS.md`，内容解释包装字段、`trigger` 语义和不可信内容的处理方式；用户改过之后不覆盖。工作区里的会话自动可被外部调用——判断依据是 header 的 `cwd` 等于工作区路径，不依赖"是不是插件亲手创建的"。工作区外的会话一律 409。

**结果**：内存表 + 会话日志。缓存未命中时用 `sessionQuery.readSession` 重建，不加载 agent。

**Agent 组合**：创建 / 恢复时挂载默认 agent 预设（`agentPresets.resolve()` → `mount`），并把预设名写进会话头。

这一步不是可选的：不挂预设的 agent 拿到的是主机层裸组合——**没有 `AGENTS.md` 指令链，也没有任何工具**。`dsh-agent-instructions`、`tool-bash`、`tool-fs` 这些在主机层都是 `disabled: true`，只在预设里启用。

反过来，挂上预设就等于把完整工具集交给外部调用方。收窄之前不要给不信任的来源级别 3。

---

## 6. 扩展点

**加一个级别**：改 `LEVELS`、`LEVEL_LABEL`、`admitMessage` 的判定，以及设置页的下拉项。

**加一个流式事件**：`onAssistantStream` 里按 `chunk.type` 分支，`finishStream` 里补结束帧。协议变更要同步 `guide.md` 的事件表。

**加一个端点**：`handle()` 里加分支 + 一个 `handleXxx`，沿用 `readObject` / `fail` / `sendJson` 三个工具。

**放松/收紧的判定**：目前只有「升到更高级别」「重置凭证」「解除禁止」需要弹窗。加新操作时先问自己：它让应用获得更多能力吗？是就走弹窗。

---

## 7. 调试

**看一次调用到底传了什么**：会话日志里 `agent/inbox/spliced` 的 `inserted[].content[0].text` 就是包装后的 JSON。

日志在 `$DSH_HOME/sessions/<路径转义>/<会话名>/session.v4.jsonl.zstd`，是分帧 zstd，逐帧解压后按行 JSON 读。

```js
const z = require('zlib'); const fs = require('fs');
const buf = fs.readFileSync(path);
const starts = [];
for (let i = 0; i < buf.length - 3; i += 1) {
  if (buf[i] === 0x28 && buf[i+1] === 0xB5 && buf[i+2] === 0x2F && buf[i+3] === 0xFD) starts.push(i);
}
// 逐帧 zstdDecompressSync，再按 \n 分行
```

**看登记表**：`GET /x/relay/sources`（无凭证，只暴露有哪些应用接过入）。

**弹窗不出现**：先 `native-dialog.detectPlatform()` 看平台判定，再确认命令行工具存在（Windows 的 `powershell.exe`、Linux 的 `zenity`/`kdialog`、macOS 的 `osascript`）。中文乱码是 PowerShell 代码页问题，脚本必须用 UTF-16LE 编码传进去。

**流式没有增量**：依次确认全局接收、`start` 帧绑定、`turnIndex` 是否已建立。

---

## 8. 改动前后必查

```
□ node --check index.js native-dialog.js client.js
□ 重载插件后 /health 正常
□ 无凭证提交 → 401
□ 凭证正确 + 级别 3 → 正常返回
□ trigger 非法值 → 400
□ 会话在工作区外 → 409
□ 流式：accepted → content 增量 → end(completed)
□ 插件重载后用旧 id 查 → 从日志重建
```

**发布前从 registry 装一次验证。** 具体原因和步骤写在 `index.js` 头部注释里——那是改代码的人一定会看到的位置，文档里不重复。
