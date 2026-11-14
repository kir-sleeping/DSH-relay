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

当前以本地链接方式安装（开发形态）：

```bash
# 在 DSH 里
plugin_manager install_bundle /path/to/plugins/relay
```

或命令行：

```bash
dsh plugin add link:/path/to/plugins/relay
```

> 发布到 registry 之后：

```bash
dsh plugin add @kir_sleeping/dsh-relay
```

`link:` 会把绝对路径写进 profile，只适合本机开发。

安装后插件自动加载，并在 `$DSH_HOME/relay/workspace` 下建一个名为「外部任务」的会话。

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

完整的接入说明见 [开发者文档](../../relay-guide.md)，可运行的示例见 [relay-demo.html](../../relay-demo.html)。

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

---

## 状态

已实现并实测：受理 / 三种交付 / 事件关联 / 结果重建 / 排队作废 / 凭证与分级 / 原生确认框 / 流式。

已知限制：

- 没有桌面时无法弹确认框（远程访问、无人值守），需要确认的操作会返回 `ERR_AUTH_UNAVAILABLE`；级别 3 的已授权来源不受影响。
- 原生确认框的**右下角小窗**只在 Windows / WSL 上有；macOS 与 Linux 仍是居中对话框。
- 无幂等、无取消、无跨机器调用。
- `trigger` 是应用自报的，Relay 无法验证"真的是用户点的"——级别 3 下只能如实转述。

---

## 文档

| 文件 | 内容 |
|---|---|
| [relay-guide.md](../../relay-guide.md) | 接入方文档：接口、字段、错误码、示例 |
| [relay-demo.html](../../relay-demo.html) | 可运行的单文件示例 |
| [relay-reference.md](../../relay-reference.md) | 维护者参考：内部结构、不变式、扩展点 |
| [relay-plan.md](../../relay-plan.md) | 设计：契约与取舍 |
| [relay-auth-plan.md](../../relay-auth-plan.md) | 鉴权设计 |

---

## 文档位置

本 README 随包分发；其余文档（接入指南、示例、设计稿）在仓库根目录，不在 npm 包里。

## License

MIT。
