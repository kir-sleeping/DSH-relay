# Relay · 现状与待办

更新时间：2026-11-13
当前版本：v1（仅转接，无鉴权）

---

## 一、已经做完的

**Relay** —— 让本机应用通过 HTTP 把任务交给 DSH 的 agent。

| 项 | 状态 |
|---|---|
| 包位置 | `plugins/relay`（**开发期以 `link:` 安装**，见 §四） |
| 包名 / entry id | `@kir_sleeping/dsh-relay` / `relay` |
| 路由 | `/x/relay/{submit,result,sessions,health}`，挂在 DSH 现有 3080 |
| 会话 | 默认 `main`，全部在 `$DSH_HOME/relay/workspace` 工作区里 |
| 交付 | 同步等、稍后取、SSE 流式 |
| 鉴权 | 凭证 + 级别 0–3 + 系统原生确认框 |
| 文档 | [plan.md](plan.md)（方案）、[guide.md](guide.md)（开发者文档）、[auth-plan.md](auth-plan.md)（鉴权） |

**实测通过**

- 异步提交 → 轮询 → 200 final
- 同步等 → 200 final
- 插件重载后用旧 id 查 → 从会话日志重建
- 同会话并发 3 条 → 各自拿到自己的答案
- 排队超时 → 410 `ERR_QUEUE_EXPIRED`（用 5 秒阈值测的，已改回 10 分钟）
- 工作区外会话 → 409 `ERR_SESSION_OUTSIDE_WORKSPACE`
- 400 / 404 各类请求错误

**实测没覆盖**

- 一小时挂起（按决定跳过）
- 任务执行失败的返回路径（`200 + type:"error"`）——代码在，但没有构造出真实失败跑通
- 插件在管理界面里的标题/图标渲染（无浏览器可看）

---

## 二、鉴权准入（已实现，部分未实测）

方案见 [auth-plan.md](auth-plan.md)。当前实现状态：

| 能力 | 状态 |
|---|---|
| 凭证申请（弹系统确认框，允许即级别 1） | 已实现；**允许路径未实测**（需要人点） |
| 申请超时 | 已实测：5 秒超时返回 504，且不落任何记录 |
| 提交时验凭证 | 已实测：缺失/错误 → 401 |
| 级别 3 直接放行 | 已实测：带正确凭证提交，正常返回结果 |
| 级别 1 / 2 的确认框 | 已实现，未实测 |
| 管理接口（列表 / 改级别 / 重置 / 解除 / 删除） | 已实现，仅「列表」实测 |
| 设置面板「应用权限」页 | 已安装，**界面未目视确认** |
| 原生弹窗（三平台） | WSL→Windows 路径已实测（超时并杀进程）；macOS/Linux 未测 |

原「待办一」的约束和决策已全部并入方案文档。

现在**任何能访问 3080 的本机进程都能让 agent 干活**，且 `source` 是自报的。v1 是有意如此，但这是发布前必须补的一块。

### 2.1 已经定下来的约束

这些是讨论中明确过的，做设计时不要再推翻：

1. **归属必须写进 content，不能依赖 `source` 字段。** DSH 的 `MessageSource` 不进模型视野——provider 适配器只读 `role` 和 `content`，`source` 只用于回放/轨迹区分。所以要让 agent 知道"这是哪个应用说的"，只能进正文。
2. **必须序列化，不能拼前缀。** 外部原文作为 JSON 字符串字段，闭合不了引号，伪造不出包装结构。这是注入边界，不是格式偏好。
3. **系统侧身份不占消息字段。** 原项目要把 `source` 一路带着是因为 Output 靠它路由；DSH 没有这层，结果靠 `message.id` 关联。所以系统侧身份放插件自己的登记表即可。
4. **安全判断在层里做，不依赖模型"相信"谁。** 模型只需要知道"这不是用户亲自说的"。
5. **`Users` 这个内部来源大概率不需要。** 它原本存在只是因为"项目前端也是一路外部调用"；DSH 里 Web UI 根本不经过这个口。

### 2.2 DSH 已有的、可以直接用的

| 需求 | 现成机制 |
|---|---|
| 存凭证 | `ctx.credentials` 的 `readRecord` / `modifyRecord` / `listRecords` / `deleteRecord` |
| 问用户"允不允许" | `ctx.userQuestions.ask()`，请求体 `questions[].intent.kind = 'approval'`（`approve` / `reject` / `always` + 本地化 `display`） |
| 超时 / 取消 | `userQuestions.askTimed` / `attachWait` |
| 工具级审批策略 | `ctx.approval`（per-agent `ApprovalPolicy`）——注意这是工具审批，不是渠道准入 |

原项目里那 222 行的确认队列（FIFO、60 秒超时、取消、断线唤醒）在 DSH 里可以整段不要。

### 2.3 还没定的

1. **分级的形态。** 原项目是 0/1/2/3（禁止 / 每条确认 / 只信已确认标记 / 完全信任）。`intent.kind='approval'` 只有三档按钮，四选一得走普通 `questions` 的 options。是一次请求给四个按钮，还是先问"允不允许"再问"什么级别"，要定。
2. **确认界面没开时怎么办。** `userQuestions` 需要 Web UI 在线，否则请求会挂住或失败。原项目对应 `ERR_AUTH_UNAVAILABLE`，要决定是拒绝还是降级。
3. **身份与工作区的关系。** 现在工作区即边界（外部只能碰 Relay 工作区里的会话）。加了调用方身份之后，是"应用级隔离"（每个 source 只能碰自己的会话）还是"工作区级共享"（拿到授权的应用共享工作区），是两种不同的产品。
4. **长期记忆的归属。** 如果每个 source 有自己的偏好，存在哪——`AGENTS.md` 是工作区级的，不是 source 级的。

---

## 三、待办二：分发（暂缓）

**暂不动的原因**：鉴权没做完，现在分发出的是一个任何本机进程都能调用的入口。等准入做完再打包。

### 3.1 文档给出的结论

- 分发的单位是**包**，不是目录。源码放哪不影响。
- `install_bundle` 接受的 spec：registry 名（`name` / `name@x.y.z` / `^x.y.z`）、绝对路径、`file:` / `link:`、git 地址、tarball。
- **`link:` 是开发形态**。原文：*"Source Web and development Desktop offer `link:<absolute workspace package directory>`"*。
- **只有以自身名字、以 registry spec 安装的第三方 bundle 才进"可更新"列表**。tarball、git、别名、link 都不进。
- 版本要求看 `engines.dsh`，没有则看 DSH 的 peerDependencies；不满足会**阻止安装和激活**。
- host-plugin.md 要求：打包/发布形态必须核对**真实的打包清单**，不能只信 `files` 字段。

### 3.2 分发字段（已补齐）

| 项 | 值 |
|---|---|
| 包名 | `@kir_sleeping/dsh-relay` |
| 版本 | `0.1.0` |
| 协议 | MIT（`LICENSE` 已随包） |
| 作者 | sleeping |
| repository | `git+https://github.com/kir-sleeping/DSH-relay.git` |
| engines | `dsh: >=0.2.2-rc.1 <0.3.0` |
| publishConfig | `access: public` |
| 打包内容 | 10 个文件，含 README 与 LICENSE |

`npm pack --dry-run` 通过。

### 3.3 两条路

- **registry**：换自有 scope 的包名，补齐上表，`npm publish`。用户 `install_bundle` 用包名。
- **tarball**：`npm pack` 出 `.tgz`，对方 `install_bundle` 指向 tgz。包名不用改。

两条都不影响开发期继续用 `link:`——那个保留，只是要在文档里标明"这是开发安装，不是分发方式"。

---

## 四、已知遗留

1. **旧的 `~/Relay` 工作区还在**。上一轮把工作区挪到 `$DSH_HOME/relay/workspace` 之前建的，里面有测试会话 `relay`、`work`（只有测试内容）。界面上会看到两个都叫 Relay 的工作区。正确清法是在界面工作区列表里删掉 `/home/kmom/Relay`，再 `rmdir ~/Relay`。直接改 `workspace.json` 会被运行中的 host 覆盖回去。
2. **profile 里是 `link:` 安装**，指向 `/home/kmom/dsh_workspace/plugins/relay`。这个目录一挪，插件就废。开发期可接受，分发前必须换。
3. **执行失败路径没跑通**。`turn/end` 的 `reason.kind === 'error'` 分支写了，但没有真实触发过。
4. **一小时挂起未实测**（按决定跳过）。

---

## 五、文件索引

| 文件 | 内容 |
|---|---|
| [plugins/relay/index.js](plugins/relay/index.js) | 实现 |
| [plan.md](plan.md) | 设计：契约、机制、验收 |
| [guide.md](guide.md) | 开发者文档：怎么接 |

> 原 AutoChild 入口层的分析文档（`entry-src-analysis.md`）已经不在工作区里了；它的结论已并入 [plan.md](plan.md)，不再单独保留。
