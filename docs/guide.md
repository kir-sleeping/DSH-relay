# Relay · 开发者文档

版本：v1
适用对象：需要从本机其他进程、脚本或页面调用这个 agent 的开发者。

---

## 一、这是什么

> 附带的示例：[demo.html](demo.html)。一个单文件收件箱，演示两种请求方式（用户主动 / 应用后台）和完整错误处理，可以直接打开或对着改写。

给本机应用开的一个 HTTP 入口。调用它就像调一个普通 API：提交一段内容，拿一个编号，之后取回 agent 的回答。

几个要点：

- **所有调用共享同一个外部会话**。你的应用和别的应用看到的是同一条上下文线，agent 因此能跨应用记住事情。
- **默认会话是 `main`，建议就住在它里面**。除非你确实需要隔离，否则不要自建会话——上下文统一的价值全靠这一步。
- **提交是异步受理**。`POST /submit` 只回答"收没收到"，不回答"想好没有"。回答要么同步等回来，要么事后按编号取。
- **一次调用 = 一次独立的对话回合**。agent 会把它当成一轮完整的输入来处理，跑完后才给出答案。

**默认地址**

```
http://127.0.0.1:3080/x/relay
```

端口与前缀取决于 DSH 的部署；路径前缀可以在插件配置里改。

---

## 二、三分钟跑通

### 1. 确认服务在

```bash
curl -s http://127.0.0.1:3080/x/relay/health
```

```json
{"ok":true}
```

### 2. 提交

```bash
curl -s -X POST http://127.0.0.1:3080/x/relay/submit \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "把本周的会议记录整理成三条待办",
    "source": "my-app"
  }'
```

```json
{
  "id": "main~my-app~3f2a1c9d-8e7b-6a5f-4c3d-2e1f0a9b8c7d",
  "status": "pending"
}
```

### 3. 取结果

```bash
curl -s http://127.0.0.1:3080/x/relay/result/main~my-app~3f2a1c9d-8e7b-6a5f-4c3d-2e1f0a9b8c7d
```

还没好返回 `202 + {"status":"pending"}`；好了返回：

```json
{
  "id": "main~my-app~3f2a1c9d-8e7b-6a5f-4c3d-2e1f0a9b8c7d",
  "session": "main",
  "source": "my-app",
  "type": "final",
  "content": "1. 周三前确认预算…"
}
```

---

## 三、三个概念

### 3.1 外部会话（`session`）

一个会话是一条独立的上下文线。缺省是 `main`，所有不指定会话的调用都落在这里。

- 名字只允许 `[A-Za-z0-9_-]{1,64}`。
- **会话不存在会自动创建**，不需要预先准备。
- 同一会话内的任务**严格串行**：前一个跑完，后一个才开始。
- 不同会话之间并行。
- 会话会出现在用户的界面里，标题是「外部任务」。用户可以看到、插话、打断。

**外部会话住在专门的 Relay 工作区里**（默认 `$DSH_HOME/relay/workspace`，即 `~/.dsh/relay/workspace`；可用 `workspacePath` 改）。这带来三件事：

1. 用户界面按工作区分组时，外部会话单独一块，不会和自己的工作混在一起。
2. 在那个工作区里手工新建的会话，自动就能被外部通过名字调用——不需要额外登记。
3. agent 关于外部调用的长期记忆（笔记、配置、脚本）也写在这个目录，和会话在同一处。

**不在这个工作区里的会话，外部入口不能使用**——即使知道名字，也会返回 `409 + ERR_SESSION_OUTSIDE_WORKSPACE`。这是有意的隔离，避免外部应用读写用户的私人会话。

如果你的应用需要和别的应用隔开上下文，用不同会话名；如果想让 agent 跨应用记住你，就用同一个。

### 3.2 任务编号（`id`）

```
{session}~{source}~{uuid4}
```

它同时是这次调用的身份和取结果的钥匙。格式稳定但**不要解析它**——将来可能加字段。需要知道会话时，用响应里的 `session` 字段。

### 3.3 三种取结果方式

- **同步等**：`"wait": true`，HTTP 连接挂住，出结果就返回。
- **稍后取**：默认，立刻返回编号，之后 `GET /result/{id}`。
- **流式**：`"stream": true`，响应变成 SSE，边生成边推送。

流式示例：

```bash
curl -N -X POST http://127.0.0.1:3080/x/relay/submit \
  -H 'Content-Type: application/json' \
  -d '{"content":"介绍秋天","source":"my-app","fingerprint":"…","stream":true}'
```

```text
event: accepted
data: {"id":"…","session":"external","source":"my-app"}

event: content
data: {"id":"…","text":"秋天"}

event: reasoning
data: {"id":"…","text":"让我想想…"}

event: end
data: {"id":"…","status":"completed","content":"秋天是…"}
```

| 事件 | 含义 |
|---|---|
| `accepted` | 已受理，流已打开 |
| `content` | 回答的增量，按顺序拼接即完整回答 |
| `reasoning` | 思考过程的增量，可能没有 |
| `error` | 任务失败，带 `code` / `message` |
| `end` | 结束，`status` 为 `completed` / `error` / `timeout` / `expired`；`completed` 时附带完整 `content` |

规则：

- 准入失败（凭证、拒绝、超时）**不会开流**，返回普通 JSON，按 `Content-Type` 区分。
- `end` 之后连接断开；`end` 已经把完整回答带上了，不一定要拼增量。
- 等待超过 `timeout` 只发 `end: timeout` 并断开，**任务继续跑**，之后仍可用编号查结果。
- 客户端断开不会取消任务。

---

### 3.4 凭证与权限

调用需要凭证。第一次接入时申请，之后每次提交都带上。

```bash
curl -s -X POST http://127.0.0.1:3080/x/relay/fingerprint \
  -H 'Content-Type: application/json' \
  -d '{"source":"my-app"}'
```

```json
{"source":"my-app","fingerprint":"9f3c…","level":1}
```

申请时主机会弹一个系统确认框，只有人能点。允许后拿到凭证，**级别固定为 1（每条消息都要确认）**。用户之后可以在「设置 → 应用权限」里调整：

| 级别 | 行为 |
|:---:|---|
| 0 | 禁止，静默拒绝 |
| 1 | 每条消息弹一次确认 |
| 2 | `trigger: "user"` 直接放行，`trigger: "app"` 仍要确认 |
| 3 | 完全信任 |

级别 2 看的是 `trigger`——谁发起的，不是"这条是否已被确认"。用户放行一次，不等于这句话是用户说的；两者的区别见下面的包装字段。

凭证只返回一次，丢了只能让用户重置。

## 四、接口参考

### 4.1 `POST /submit`

**请求体**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|:---:|---|---|
| `content` | string | ✅ | | 交给 agent 的内容，非空 |
| `source` | string | ✅ | | 调用方标识，`[A-Za-z0-9_-]{1,64}` |
| `fingerprint` | string | ✅ | | 申请时拿到的凭证 |
| `trigger` | string | | `"app"` | 谁发起的：`user` 用户点了按钮/说了话，`app` 应用自己发的。缺省 `app`（更保守） |
| `session` | string | | `"main"` | 外部会话名 |
| `wait` | boolean | | `false` | 是否挂住连接等结果 |
| `stream` | boolean | | `false` | 是否返回 SSE 流；与 `wait` 互斥，`stream` 优先 |
| `timeout` | number | | `120` | 等待秒数，1–3600，仅 `wait=true` 时有效 |

**响应**

| 情况 | 状态码 | body |
|---|---|---|
| 已受理，还没好 | `202` | `{"id","status":"pending"}` |
| 已受理，已有结果 | `200` | `{"id","session","source","type":"final","content"}` |
| 已受理，任务失败 | `200` | `{"id","session","source","type":"error","code","message"}` |
| 排队超时作废 | `410` | `{"id","session","source","code":"ERR_QUEUE_EXPIRED","message"}` |
| 请求有问题 | `4xx` | `{"code","message"}` |
| 服务端问题 | `500` | `{"code","message"}` |

### 4.2 `GET /result/{id}`

| 情况 | 状态码 | body |
|---|---|---|
| 还在执行 | `202` | `{"id","status":"pending"}` |
| 已完成 | `200` | 同上 `final` / `error` |
| 已作废 | `410` | 同上 |
| 没有这个编号 | `404` | `{"code":"ERR_RESULT_NOT_FOUND","message"}` |

`id` 里含 `~` 和可能的其他字符，请按 URL 片段编码后再拼。

### 4.3 `GET /sessions`

需要凭证，用查询参数带上：

```bash
curl -s "http://127.0.0.1:3080/x/relay/sessions?source=my-app&fingerprint=…"
```

列出 Relay 工作区里的会话（含本进程见过的）：

```json
{"sessions":[{"id":"main"},{"id":"my-app"}]}
```

只包含外部入口用过的会话，不包含用户的私人会话。

### 4.4 `GET /health`

```json
{"ok":true}
```

---

## 五、响应判断顺序

`ok` 字段不存在，不要按它判断。按下面的顺序读：

```
1. HTTP 400          → 请求格式或字段有问题，看 code 修请求
2. HTTP 404          → 编号不存在（或从未被受理）
3. HTTP 410          → 排队超时，这次调用已作废，需要重新提交
4. HTTP 500          → 服务端问题，可重试
5. HTTP 202          → 已受理，还没好，继续等或继续轮询
6. data.type == "final" → 成功，读 content
7. data.type == "error" → 任务执行失败，读 code / message
```

**关键区分：HTTP 状态码说明"这次请求怎么了"，`type` 说明"这个任务怎么了"。** 任务失败时 HTTP 仍是 200。

---

## 六、错误码

### 请求类（4xx）

| code | 码 | 含义 |
|---|---|---|
| `ERR_REQUEST_JSON` | 400 | 请求体不是合法 JSON，或不是对象 |
| `ERR_CONTENT` | 400 | `content` 缺失或为空 |
| `ERR_SOURCE` | 400 | `source` 格式非法 |
| `ERR_SESSION` | 400 | `session` 格式非法 |
| `ERR_TIMEOUT` | 400 | `timeout` 不是正数 |
| `ERR_ID` | 400 | 结果查询的 id 为空 |
| `ERR_RESULT_NOT_FOUND` | 404 | 没有这个编号 |
| `ERR_NOT_FOUND` | 404 | 路径不存在 |
| `ERR_SESSION_OUTSIDE_WORKSPACE` | 409 | 该会话不在 Relay 工作区内，外部入口不能用 |
| `ERR_TRIGGER` | 400 | `trigger` 不是 `user` 或 `app` |
| `ERR_INPUT_FINGERPRINT` | 401 | 缺少凭证或与来源不匹配（不暴露来源是否存在） |
| `ERR_ACCESS_DENIED` | 403 | 来源处于禁止名单 |
| `ERR_AUTH_DENIED` | 403 | 用户当场拒绝了这次请求 |
| `ERR_AUTH_TIMEOUT` | 504 | 等待确认超时 |
| `ERR_AUTH_UNAVAILABLE` | 503 | 主机上没有可用的确认窗口 |
| `ERR_SOURCE_EXISTS` | 409 | 重复申请凭证 |

### 任务类（200 + `type:"error"`）

| code | 含义 |
|---|---|
| `ERR_TASK_FAILED` | 执行失败，通常是模型或配置问题 |
| `ERR_AGENT_DISPOSED` | 会话在任务完成前被关闭 |
| `ERR_TURN_<KIND>` | 回合以非正常原因结束（如 `ERR_TURN_ABORTED`） |

任务类失败通常重试同一请求无效，需要先修部署侧问题。

### 服务端（500）

| code | 含义 |
|---|---|
| `ERR_SESSION_UNAVAILABLE` | 会话无法创建或恢复 |
| `ERR_DELIVERY` | 消息投递失败 |
| `ERR_INTERNAL` | 插件内部异常 |

---

## 七、行为细节

### 7.1 串行与排队

同一会话的任务严格串行。提交时不会因为忙而被拒——**会排队**。

排队有上限：**10 分钟**。消息受理后 10 分钟内还没开始执行，会被作废（从队列撤回），此时无论你在等还是后来查，都得到 `410 + ERR_QUEUE_EXPIRED`。

这条是为了避免"迟到的意图"被执行——排了十分钟才跑的任务，语义通常已经变了。

### 7.2 同步等的超时

`timeout` 只是"你愿意为这次调用等多久"，不是任务上限。

- 等到了：`200` + 结果。
- 等不到：`202` + 编号，**任务继续跑**。之后用 `GET /result/{id}` 继续取。

所以客户端要区分两件事：HTTP 客户端的超时（连接层）和 `timeout` 参数（业务层）。**客户端的 HTTP 超时必须大于 `timeout`**，否则连接先断，但任务还在跑。

### 7.3 结果能保存多久

进程内的结果缓存保留 24 小时。但这**不是**硬上限：结果本身写在会话日志里，缓存失效后会自动从日志重建。

所以只要会话还在，**已经跑完的任务**编号就一直能查到——包括插件重载、进程重启之后。

一个例外：**排队作废的任务**没有执行记录，重启后在日志里找不到，会返回 `404` 而不是 `410`。所以作废要在当次就处理掉，不要留到以后。

### 7.4 agent 看到的不是原文

外部内容进入 agent 前会被包装成：

```json
{"type":"external_request","source":"my-app","content":"你提交的原文"}
```

这是为了让 agent 分清"这是某个应用发来的"而不是"用户亲口说的"，也是为了防止原文伪造包装结构（你的内容被当作 JSON 字符串转义，闭合不了引号）。

对调用方没有影响：你只提交 `content`。

### 7.5 没有的东西

| 能力 | 本版状态 |
|---|---|
| 鉴权 | **无**。本机任何进程都能调用 |
| 流式输出 | 支持（SSE） |
| 幂等 | 无。重复提交会产生新任务、新的模型调用 |
| 取消 | 无 |
| 跨机器调用 | 不支持。只监听本机 |

---

## 八、代码示例

下面示例假设你已经有凭证，用 `fingerprint` 表示；每个提交都要带上它（先按 §3.4 申请）。

### 8.1 Python（仅标准库）

```python
import json
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:3080/x/relay"


class EntryError(RuntimeError):
    def __init__(self, code, message, status=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status


def _request(method, path, payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        body = json.loads(raw) if raw else {}
        return error.code, body


def ask(content, source="my-app", timeout=120, max_wait=None):
    status, body = _request("POST", "/submit", {
        "content": content,
        "source": source,
        "wait": True,
        "timeout": timeout,
    })
    if status not in (200, 202):
        raise EntryError(body.get("code", "ERR_HTTP"), body.get("message", ""), status)
    if body.get("type") == "final":
        return body["content"]
    if body.get("type") == "error":
        raise EntryError(body.get("code"), body.get("message"), status)

    # 202：还在跑，继续轮询
    task_id = body["id"]
    deadline = time.monotonic() + (max_wait if max_wait is not None else timeout + 60)
    delay = 0.5
    while time.monotonic() < deadline:
        status, body = _request("GET", "/result/" + urllib.parse.quote(task_id, safe=""))
        if status == 200:
            if body.get("type") == "final":
                return body["content"]
            raise EntryError(body.get("code"), body.get("message"), status)
        if status in (202, 404):
            time.sleep(delay)
            delay = min(delay * 1.5, 3.0)
            continue
        raise EntryError(body.get("code", "ERR_HTTP"), body.get("message", ""), status)

    raise EntryError("ERR_WAIT_TIMEOUT", f"任务 {task_id} 未在等待窗口内完成")


if __name__ == "__main__":
    print(ask("请只回复 OK"))
```

### 8.2 Node.js（18+）

```javascript
const BASE = 'http://127.0.0.1:3080/x/relay'

async function post(path, payload) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return [res.status, await res.json()]
}

async function get(path) {
  const res = await fetch(BASE + path)
  return [res.status, await res.json()]
}

async function ask(content, source = 'my-app', timeout = 120) {
  const [status, body] = await post('/submit', { content, source, wait: true, timeout })
  if (status !== 200 && status !== 202) throw new Error(`${body.code}: ${body.message}`)
  if (body.type === 'final') return body.content
  if (body.type === 'error') throw new Error(`${body.code}: ${body.message}`)

  const deadline = Date.now() + (timeout + 60) * 1000
  let delay = 500
  while (Date.now() < deadline) {
    const [s, b] = await get('/result/' + encodeURIComponent(body.id))
    if (s === 200) {
      if (b.type === 'final') return b.content
      throw new Error(`${b.code}: ${b.message}`)
    }
    if (s !== 202 && s !== 404) throw new Error(`HTTP ${s}`)
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 1.5, 3000)
  }
  throw new Error('等待超时')
}

ask('请只回复 OK').then(console.log).catch(console.error)
```

### 8.3 浏览器页面

本机页面（`file://` 或 `localhost` 上的页面）可以直接 `fetch`，服务端会返回 CORS 头。**其他站点不行**——如果页面部署在别的域名，需要由你自己的后端转发。

```html
<!doctype html>
<meta charset="utf-8">
<title>入口测试</title>
<textarea id="input" rows="4" cols="60">请只回复 OK</textarea><br>
<button id="send">交给 agent</button>
<pre id="output"></pre>

<script type="module">
const BASE = 'http://127.0.0.1:3080/x/relay'

document.querySelector('#send').onclick = async () => {
  const output = document.querySelector('#output')
  output.textContent = '提交中…'

  const res = await fetch(BASE + '/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: document.querySelector('#input').value,
      source: 'web-page',
      wait: true,
      timeout: 120,
    }),
  })

  const body = await res.json()
  if (body.type === 'final') { output.textContent = body.content; return }

  if (body.type === 'error' || res.status === 410) {
    output.textContent = `${body.code}: ${body.message}`
    return
  }

  if (res.status === 202) {
    output.textContent = '排队中…'
    const id = body.id
    const timer = setInterval(async () => {
      const r = await fetch(BASE + '/result/' + encodeURIComponent(id))
      const b = await r.json()
      if (r.status === 200 && b.type === 'final') {
        clearInterval(timer)
        output.textContent = b.content
      } else if (b.type === 'error' || r.status === 410) {
        clearInterval(timer)
        output.textContent = `${b.code}: ${b.message}`
      }
    }, 1000)
  }
}
</script>
```

---

## 九、轮询建议

```
delay = 0.5s
deadline = now + 600s

while now < deadline:
    GET /result/{id}
    200 → 处理结果，结束
    202 → sleep(delay); delay = min(delay * 1.5, 3s)
    404 → 编号不存在，检查是否写错
    410 → 已作废，重新提交
    其他 → 按错误处理
```

不要固定 100ms 高频轮询。任务动辄几十秒，退避到 2–3 秒足够。

---

## 十、接入检查清单

```
□ /health 返回 {"ok":true}？
□ 提交后能拿到 id？
□ 能区分 202 / 200 / 410 / 404？
□ 任务失败走的是 200 + type:"error"，代码里处理了吗？
□ 客户端 HTTP 超时 > wait 的 timeout？
□ 收到 202 后用同一个 id 继续取，而不是重新提交？
□ 重试逻辑不会导致重复提交（本版没有幂等）？
□ session 名用的是合法字符集？
□ 知道所有应用共享上下文（除非指定不同 session）？
□ 知道排队超过 10 分钟会作废？
□ 只在 Relay 工作区里给会话命名，不要指向用户自己的会话（会 409）
```

---

## 十一、安全边界

**有凭证，有用户批准。**

- 每个来源第一次接入必须由用户在系统确认框里点"允许"，才拿到凭证。
- 凭证证明"知道这个来源的密钥"，**不证明"这是用户本人发的消息"**——`trigger` 是应用自报的。
- **后台发起的消息永远不标成用户发言**，即使用户在确认框里点过允许：放行和署名是两件事。
- 权限可以在「设置 → 应用权限」里随时调整或撤销，不需要应用配合。撤销立即生效。
- 服务只监听 `127.0.0.1`。本机其他用户或恶意进程如果能访问这个端口，仍然需要凭证才能提交。
- 没有桌面时（远程访问、无人值守）无法弹确认框：申请会返回 `ERR_AUTH_UNAVAILABLE`，但级别 3 的已授权来源不受影响。
