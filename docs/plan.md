# Relay 插件 · 方案

版本：v2（含鉴权与流式）
状态：已实现

---

## 0. 范围

**做**

- 本机 HTTP 入口，把外部请求转成 agent 消息
- 受理 / 投递 / 产出关联 / 取结果
- 三种交付：同步等、稍后取、SSE 流式
- 排队作废
- 调用方登记、凭证、分级授权、系统原生确认框

**不做（留给下一版）**

- 幂等、取消
- macOS / Linux 的角窗形态

---

## 1. 概念映射

| 外部世界 | DSH |
|---|---|
| 一次调用 | 一个 turn |
| 调用编号 | `message.id` |
| 对话 | `SessionId` |
| 提交 | 往 inbox 放一条 `UserMessage` 并唤醒 |
| 结果 | 该 turn 的 `assistant/message` |

---

## 2. 对外契约

### 2.1 端点

```
POST /x/relay/submit          提交
GET  /x/relay/result/{id}     取结果
GET  /x/relay/sessions        列出外部会话
GET  /x/relay/health          健康检查
```

前缀 `/x/relay` 可配置。挂到 DSH 现有的 3080 上，不自开端口。

### 2.2 提交

```json
{
  "content": "把这段话交给 agent",
  "source": "my-app",
  "session": "main",
  "wait": true,
  "timeout": 120
}
```

| 字段 | 必填 | 默认 | 说明 |
|---|:---:|---|---|
| `content` | ✅ | | 非空字符串 |
| `source` | | `"external"` | 自报应用名，`[A-Za-z0-9_-]{1,64}`。**无鉴权，不可信，仅用于让 agent 知道说话者** |
| `session` | | `"main"` | 外部会话名 |
| `wait` | | `false` | 是否挂住连接等结果 |
| `stream` | | `false` | 返回 SSE；与 `wait` 互斥，优先 |
| `timeout` | | `120` | 等待秒数，1–3600，仅 `wait=true` 时有效 |

### 2.3 响应

| 情况 | 码 | body |
|---|---|---|
| 请求格式错 | 400 | `{code, message}` |
| 会话不存在且不可建 | 404 | `{code, message}` |
| 受理成功，还没好 | 202 | `{id, status:"pending"}` |
| 受理成功，已有结果 | 200 | `{id, type:"final", session, source, content}` |
| 受理成功，任务失败 | 200 | `{id, type:"error", session, source, code, message}` |
| 排队超时作废 | 410 | `{id, code:"ERR_QUEUE_EXPIRED", message}` |
| 查 id：不存在 | 404 | `{code:"ERR_RESULT_NOT_FOUND", message}` |
| 插件内部异常 | 500 | `{code:"ERR_INTERNAL", message}` |

原则：**HTTP 码表达这次请求怎么了，`type` 表达这个任务怎么了。**

### 2.4 编号格式

```
{session}~{source}~{uuid4}
```

例：`main~my-app~3f2a1c9d8e7b6a5f4c3d2e1f0a9b8c7d`

用 `~` 分隔，因为 `source` 的字符集不含它。这样重启后拿到 id 就能直接解出会话名，不需要持久索引。

> 前提：`SessionId` 字符集不含 `~`。见 §7 待验证。

### 2.5 包装

进入 agent 的 content 是一段 JSON 文本：

```json
{"type":"external_request","source":"my-app","content":"调用方原文"}
```

必须用序列化而不是前缀拼接：外部原文作为一个 JSON 字符串字段，无法闭合引号伪造出包装结构。这是提示注入的边界，不是格式偏好。

`user_confirmed` 字段本版不加，做权限时再补。

---

## 3. 内部机制

### 3.1 会话与工作区

**外部会话全部住在插件独占的 workspace 里。** 加载时确保工作区与默认会话存在，其余会话首次被指定时惰性确保。

工作区：默认 `$DSH_HOME/relay/workspace`（`$DSH_HOME` 缺省 `~/.dsh`），标题 `Relay`，都可配置。解析优先级与官方 `dsh-home-paths` 一致：配置 > `$DSH_HOME` > `~/.dsh`。目录不存在就递归创建，然后 `workspaceRegistry.create(path, title)`（对已存在的目录返回既有实体）。

确保顺序：

```
sessionQuery.readSession(sessionId)      存在 → 校验 header.cwd === workspace.path
  ├─ 不匹配 → RelayError(409, ERR_SESSION_OUTSIDE_WORKSPACE)
  ├─ 匹配且 agent 活着 → 直接复用
  └─ 匹配但未加载 → agents.resume({resumeSessionId})
  ↓ 不存在
agents.create({sessionId, meta:{cwd: workspace.path}})  → workspace.attachSession(id)
```

用 workspace 带来三件事：

1. **用户界面按工作区分组**，外部会话单独一块，不混进用户自己的工作区。
2. **工作区里的会话自动可被外部调用**——判断依据是 header 的 `cwd` 等于工作区路径，不依赖插件是否亲手创建。用户在界面里手工新建到该目录的会话，外部按名字就能用。
3. **记忆落点统一**——agent 在该工作区里写的文件（笔记、脚本、配置）和会话在同一目录。

反过来，工作区外的会话一律拒绝（409），即使调用方知道 id。这是隔离，不是限制。

**必须显式给 `agentOptions`。** 新建或恢复 agent 时如果不传 `provider` / `model`，agent 会在第一个 turn 直接失败（"has no provider/model"），且发生在进入 step 之前（见 §3.3）。取值来自 `ctx.agentDefaultModel.currentSelection()`。

新建后把标题设为「外部任务」（`ctx.sessionTitle.rename`）。会话会出现在用户界面的会话列表里，这是已确认的行为。

### 3.2 投递

```
id = `${session}~${source}~${uuid()}`
msg = {
  role: 'user',
  id,
  content: [{ type: 'text', text: wrapped }],
  source: { kind: 'user' }
}
agent.followup(msg)
```

`followup` 保证这条消息独占一个新 turn，因此不会和用户自己在同一会话里发的消息混到同一个 turn。

### 3.3 产出关联

投递没有返回值，只能从事件流里认领：

```
agent/inbox/claimed  → 消息被 agent 取走，给出 message + turn，绑定 id → {session, turn}
assistant/message    → 若 turn 匹配，且消息不含 tool-call 块，记为候选答案
turn/end             → 若 turn 匹配，结算：交出候选答案，或按结束原因报错
```

一个 turn 里可能有多条 `assistant/message`（工具轮次的中间产物），只取最后一条不含工具调用的。

**必须用 `agent/inbox/claimed`，不能用 `session/event` 里的 `user/message`。** 实测：turn 在进入 step 之前就失败时（例如没有可用模型），日志里只有 `turn/start`、inbox 被取走、`turn/end`，**不会产生 `user/message`**。用后者关联会导致任务永远停在 pending。

`turn/end` 的 `reason.kind` 为 `error` 时，`reason.error.code` 可能是 `UNKNOWN`，对外统一映射为 `ERR_TASK_FAILED`。

订阅 `session/event`，按 `sessionId` 过滤，只处理外部会话。

### 3.4 等待

每条在等的结果注册一个一次性 resolve。结算时唤醒；超过调用方给的 `timeout` 未结算 → 返回 202，任务继续。

等待时长包含排队时长。共享会话前面压着长任务时，等回来一个 202 是正常结果。

### 3.5 结果表与重建

内存表：`id → { state, event, sessionId, source, acceptedAt }`，`state` 为 `pending | final | error | expired`。

**缓存未命中时重建**（插件重启、进程重启、超出保留期）：

```
从 id 解出 sessionId
sessionQuery.listEvents(sessionId)  或 filterEvents 按消息 id 定位
找到 user/message = id 所在的 turn
取该 turn 最后一条无工具调用的 assistant/message
重建成功则写回内存表
```

重建走只读查询，不加载 agent，不会让会话在界面上变成活跃状态。代价是读一次日志，所以重建后缓存。

### 3.6 排队作废

受理时记 `acceptedAt`。定时器在 `acceptedAt + 10min` 触发：

- 该消息已被取走（出现过 `user/message`）→ 什么都不做
- 仍在 inbox 里 → `agent.inbox.remove(id)` 撤掉，状态置 `expired`，唤醒等待者

10 分钟只管排队，不管执行。已开始执行的任务不受影响，执行时长无上限。

### 3.7 并发

同一会话的多条提交由 DSH 的 inbox 排队，各自成 turn，串行执行。插件不做额外排队，也不拒绝。

不同会话之间并行。

---

## 4. 插件形态

### 4.1 包

名字：**Relay**，包名 `@kir_sleeping/dsh-relay`，patch entry id `relay`。

```
package.json          @kir_sleeping/dsh-relay；dsh.bundle.patch 指向 cordis.patch.yml
cordis.patch.yml      insert 一行：id relay，name @kir_sleeping/dsh-relay
index.js              apply(ctx, config)；export const name = 'relay'
locale/en.json        meta.title / meta.description
locale/zh.json
icon.svg
```

### 4.2 依赖注入

```js
export const inject = ['webServer', 'agents', 'sessionQuery']
```

其余按需取，缺失时降级，不阻塞激活：

| 服务 | 用途 | 缺失时 |
|---|---|---|
| `sessionTitle` | 把会话标题写成「外部任务」 | 跳过 |
| `workingDirectory` | 取默认工作目录作 `cwd` | 不传 `meta.cwd` |
| `agentDefaultModel` | 取 `provider` / `model` | 不传 `agentOptions`（会导致每个 turn 失败） |

### 4.3 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `pathPrefix` | `/x/relay` | 路由前缀 |
| `defaultSession` | `main` | 默认外部会话名 |
| `workspacePath` | `$DSH_HOME/relay/workspace` | 外部会话所属工作区目录（必须绝对路径） |
| `workspaceTitle` | `Relay` | 工作区显示名 |
| `queueLimitMs` | `600000` | 排队作废阈值 |
| `maxWaitMs` | `3600000` | 单次等待上限 |
| `resultTtlMs` | `86400000` | 内存结果保留时长 |

### 4.4 卸载

`ctx.effect` 里注册的一切随插件卸载清理：路由、事件订阅、定时器、内存表。

插件创建的 agent 随 owner ctx 释放；会话本身持久，重载后按 §3.1 恢复。

---

## 5. 实现顺序

1. 骨架：package、patch、locale、icon、`apply` 空转、health 路由
2. 会话：`ensure(sessionId)` 三级解析 + 标题
3. 投递 + 关联：`followup`，订阅事件，认领产出
4. 等待：同步等 + 超时回 202
5. 结果表 + 重建：`sessionQuery` 回读
6. 排队作废：定时器 + `inbox.remove`
7. 验收

---

## 6. 验收

```
□ POST submit（wait=false）→ 202 + id；轮询 → 200 + final
□ POST submit（wait=true）→ 200 + final
□ wait=true 但任务长于 timeout → 202 + id，之后能查到
□ 同一会话连续两次提交 → 都受理，串行执行，各自拿到自己的答案
□ 不同会话并发 → 互不阻塞
□ 插件重载后，用旧 id 查询 → 能从日志重建，返回同样结果
□ 提交后不等到 10 分钟 → 410 + ERR_QUEUE_EXPIRED
□ 任务执行失败 → 200 + type:"error" + code
□ 用户界面能看到「外部任务」会话，能打开、插话、打断
□ 外部原文里的引号、花括号、`"source":"别的应用"` 不会破坏包装
□ 工作区目录被创建，会话出现在该工作区分组下
□ 工作区外的会话（如 old `main`）提交 → 409 + ERR_SESSION_OUTSIDE_WORKSPACE
□ 在工作区目录里手工新建的会话，外部按名字可直接调用
```

---

## 7. 待验证（实现时先确认）

1. ~~**`SessionId` 字符集是否含 `~`。**~~ 已确认：`SessionStore` 对传入的 id 只做重复检查，不限制字符集；会话名已由插件自己约束为 `[A-Za-z0-9_-]`，`~` 安全。
2. ~~**自定义 `sessionId` 是否被 store 的 id 策略接受。**~~ 已确认：接受，原样 `brandString`。
3. ~~**`sessionTitle.rename` 的调用契约**~~ 已确认：`rename(session, title)`，需要活会话。实测标题生效。
4. **长响应实测。** 按用户要求跳过一小时挂起测试。
5. ~~**`sessionQuery.filterEvents` 的过滤能力**~~ 改用 `readSession` 全量读，够用且简单。

