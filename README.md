# Relay

把本机任何应用接到同一个 agent 上。

应用不需要内置 AI、不需要自己管会话、不需要理解 agent 的内部结构——像调一个普通 HTTP API 一样把任务交出去，拿回结果。所有调用共享同一份上下文，所以 agent 在邮件应用里知道你在便签里写过什么。

```
应用 A ─┐
应用 B ─┼─→ Relay ─→ DSH agent ─→ 同一个会话
应用 C ─┘
```

---

## 它解决什么

现在的 AI 是每个应用各配一个，彼此失忆：你在每个里面都要重新解释一遍自己。Relay 把这件事反过来——**agent 在应用外面，应用来调它**。

由此得到三件单应用做不到的事：

- **上下文统一**：谁说过的话都在一条线上，不用重复交代。
- **应用不需要内置 AI**：接进来只改一个请求，模型、工具、权限、压缩都不用自己实现。
- **应用可以把数据交出去**：不是让用户复制粘贴，而是把结构化数据连同任务一起发过去。

---

## 能力

| | |
|---|---|
| 入口 | `POST /x/relay/submit`，可配置前缀，挂在 DSH 现有端口上 |
| 交付 | 同步等 / 稍后取 / SSE 流式 |
| 鉴权 | 凭证 + 0–3 级授权，首次接入需用户在系统原生确认框里点「允许」 |
| 会话 | 默认 `main`，全部落在独立的 Relay 工作区里 |
| 区分发起方 | `trigger: user \| app`——用户点的，还是应用自己发的 |

---

## 安装

```bash
dsh plugin add @kir_sleeping/dsh-relay
```

开发时用软链安装（`dsh plugin add link:<本机源码目录>`），改代码即生效，不用反复打包。

> 开发与发布的注意事项写在 `index.js` 头部注释里，改代码前先看那段。

安装后插件自动加载，并在 `$DSH_HOME/relay/workspace` 下建一个名为「外部任务」的会话（目录权限 700）。

首次创建时会写一份 `AGENTS.md`——它告诉 agent：这些消息是谁发的、`trigger` / `approved` 各是什么意思、哪些内容要当不可信数据处理、回答会返回给谁。用户可以随便改，改过之后插件不会覆盖（只在文件不存在时写入）。

---

## 快速开始

```bash
# 1. 申请凭证。这一步会在主机上弹系统确认框，用户点「允许」才继续
curl -s -X POST http://127.0.0.1:3080/x/relay/fingerprint \
  -H 'Content-Type: application/json' -d '{"source":"my-app"}'
# → {"source":"my-app","fingerprint":"…","level":1}

# 2. 提交
curl -s -X POST http://127.0.0.1:3080/x/relay/submit \
  -H 'Content-Type: application/json' \
  -d '{"content":"请只回复 OK","source":"my-app","fingerprint":"…","trigger":"user","wait":true}'

# 3. 或者流式
curl -N -X POST http://127.0.0.1:3080/x/relay/submit \
  -H 'Content-Type: application/json' \
  -d '{"content":"介绍一下这个项目","source":"my-app","fingerprint":"…","trigger":"user","stream":true}'
```

完整契约见下面的「接口」一节，可运行的示例见 [docs/demo.html](docs/demo.html)。

---

## 配置

在 profile 的 `cordis.patch.yml` 里那一行插件的 `config` 中设置，全部可选：

| 键 | 默认 | 说明 |
|---|---|---|
| `pathPrefix` | `/x/relay` | 路由前缀 |
| `defaultSession` | `main` | 默认外部会话名 |
| `workspacePath` | `$DSH_HOME/relay/workspace` | 外部会话所属工作区目录 |
| `workspaceTitle` | `Relay` | 工作区显示名 |
| `queueLimitMs` | `600000` | 排队多久未开始就作废 |
| `maxWaitMs` | `3600000` | 单次等待上限 |
| `resultTtlMs` | `86400000` | 结果在内存里保留多久（过期后从会话日志重建） |
| `authTimeoutMs` | `60000` | 确认框等待上限 |

> `workspacePath` 改了会让所有既有会话变成"不在工作区里"（会话的目录在创建时定死），不要随便改。

---

## 安全模型

**应用不是可信的，用户才是。**

- 首次接入必须由用户在系统原生确认框里点「允许」，才拿到凭证。默认级别 1（每条消息都要确认）。
- 级别在「设置 → 应用权限」里随时可改、可撤销，不需要应用配合。撤销立即生效。
- **`trigger` 表示谁发起的，`approved` 表示这次调用被允许发生。两者独立。** 后台发起的消息永远不会被当成用户说的话，即使用户在确认框里点过允许——放行不等于署名。
- 外部入口只能触达 Relay 工作区里的会话，碰不到用户的私人会话。
- 服务只监听 `127.0.0.1`。不要用反向代理把它暴露出去。

**外部会话的 agent 以默认预设创建，拥有完整工具集**（bash、读写文件、联网搜索、定时任务……）——这样它才能读工作区里的 `AGENTS.md`、真正做事。代价是：一个级别 3 的应用，理论上可以让 agent 在你机器上执行命令。

这是当前版本有意选择的激进姿态：先把能力打通，等权限系统支持按工具收窄之后再收紧。**在收紧之前，不要给不信任的应用级别 3。**

---

## 状态

已实现并实测：受理 / 三种交付 / 事件关联 / 结果重建 / 排队作废 / 凭证与分级 / 原生确认框 / 流式。

已知限制：

- 没有桌面时无法弹确认框（远程访问、无人值守），需要确认的操作会返回 `ERR_AUTH_UNAVAILABLE`；级别 3 的已授权来源不受影响。
- 原生确认框的**右下角小窗**只在 Windows / WSL 上有；macOS 与 Linux 仍是居中对话框。
- 无幂等、无取消、无跨机器调用。
- `trigger` 是应用自报的，Relay 无法验证"真的是用户点的"——级别 3 下只能如实转述。

---

## 接口

全部挂在 `http://127.0.0.1:3080/x/relay`（前缀可配置）。

### `POST /fingerprint`　`{source}`

首次接入。会在主机上弹系统确认框，用户点「允许」才返回凭证，级别固定为 1。阻塞最长 60 秒。

```json
{"source":"my-app","fingerprint":"…","level":1}
```

### `POST /submit`

| 字段 | 必填 | 说明 |
|---|:---:|---|
| `content` | ✅ | 交给 agent 的内容 |
| `source` | ✅ | 应用标识，`[A-Za-z0-9_-]{1,64}` |
| `fingerprint` | ✅ | 凭证 |
| `trigger` | | `user` 用户亲手触发 / `app` 应用自己在后台发起。缺省 `app` |
| `session` | | 会话名，缺省 `main` |
| `wait` | | 挂住连接等结果 |
| `stream` | | 返回 SSE，优先于 `wait` |
| `timeout` | | 等待秒数，缺省 120，上限 3600 |

响应：`202` 已受理 / `200` 有结果 / `410` 排队超时作废 / `4xx` 请求或授权问题。

结果体：`{"id","session","source","type":"final","content"}` 或 `{"type":"error","code","message"}`。

### `GET /result/{id}`

`202` 未完成 · `200` 已完成 · `404` 不存在 · `410` 已作废。结果过期会从会话日志重建。

### `GET /sessions?source=&fingerprint=`

列出 Relay 工作区里的会话，需要凭证。

### `GET /sources`

登记列表（无凭证），供设置页读取。只暴露"有哪些应用接过入"。

### 流式事件

```
event: accepted   data: {"id","session","source"}
event: content    data: {"id","text"}        ← 回答增量，拼接即完整回答
event: reasoning  data: {"id","text"}        ← 思考增量，可能没有
event: error      data: {"id","code","message"}
event: end        data: {"id","status","content"}   status: completed|error|timeout|expired
```

准入失败时不开流，仍返回普通 JSON——按 `Content-Type` 区分。

### 错误码

| code | HTTP | 含义 |
|---|---|---|
| `ERR_TRIGGER` / `ERR_CONTENT` / `ERR_SOURCE` / `ERR_SESSION` / `ERR_TIMEOUT` | 400 | 请求字段有问题 |
| `ERR_INPUT_FINGERPRINT` | 401 | 缺凭证或不匹配 |
| `ERR_ACCESS_DENIED` | 403 | 来源在禁止名单 |
| `ERR_AUTH_DENIED` | 403 | 用户当场拒绝 |
| `ERR_AUTH_TIMEOUT` | 504 | 确认超时 |
| `ERR_AUTH_UNAVAILABLE` | 503 | 主机没有可用桌面 |
| `ERR_SESSION_OUTSIDE_WORKSPACE` | 409 | 会话不在 Relay 工作区 |
| `ERR_QUEUE_EXPIRED` | 410 | 排队超时作废 |
| `ERR_RESULT_NOT_FOUND` | 404 | 没有这个编号 |

## 文档

| 文件 | 内容 |
|---|---|
| [docs/usage.md](docs/usage.md) | 普通使用者看的：权限级别、弹窗什么时候出现、怎么管 |
| [docs/reference.md](docs/reference.md) | 要改代码的人看的：内部结构、不变式、扩展点 |
| [docs/demo.html](docs/demo.html) | 可运行的单文件示例：收件箱 + 每日小报 + 流式对话 |

---

## 文档位置

本 README 随包分发；其余文档在仓库的 `docs/` 目录，不在 npm 包里。

## License

MIT。
