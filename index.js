/**
 * 外部任务入口：把本机 HTTP 请求转成 DSH agent 消息。
 *
 * ── 开发与发布（改这个文件前先读） ────────────────────────────────────────────
 *
 * 开发时这个包是用 link: 装进 profile 的：
 *     dsh plugin add link:<本机源码目录>
 * 改代码即生效，不用重新打包。源码目录是自己的，不要写进仓库、也不要写死在文档里。
 *
 * 发布前必须把它换成 registry 安装再验一次：
 *     dsh plugin remove @kir_sleeping/dsh-relay
 *     dsh plugin add @kir_sleeping/dsh-relay
 *     curl -s http://127.0.0.1:3080/x/relay/health
 *
 * 原因：link 是符号链接，源码目录里有什么就能读到什么，缺文件永远不会报错；
 * 只有从 registry 装解压后的真实目录，才能确认发出去的包是完整的。
 * 验完切回 link 继续开发。
 *
 * ── 端点 ─────────────────────────────────────────────────────────────────────
 *
 * 所有外部会话都落在插件自己的 workspace 里：用户界面按工作区分组时能一眼分开，
 * 工作区里的会话自动成为可被外部调用的会话，agent 关于外部调用的长期记忆也写在同一处。
 *
 * 端点（前缀可配置，默认 /x/relay）：
 *   POST /submit           提交任务
 *   GET  /result/{id}      取结果
 *   GET  /sessions         列出外部会话
 *   GET  /health           健康检查
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { confirm } from './native-dialog.js'

export const name = 'relay'

export const inject = ['webServer', 'agents', 'sessionQuery', 'workspaceRegistry', 'credentials']

/** 会话名与 source 共用的字符集；`~` 被留作 id 分隔符。 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u

const DEFAULT_TITLE = '外部任务'

const MAX_BODY_BYTES = 1024 * 1024

/** 凭证记录的 key 前缀。 */
const SOURCE_PREFIX = 'relay/'

const LEVELS = new Set([0, 1, 2, 3])

const DEFAULTS = {
  pathPrefix: '/x/relay',
  defaultSession: 'main',
  workspacePath: join(resolveDshHome(), 'relay', 'workspace'),
  workspaceTitle: 'Relay',
  queueLimitMs: 600_000,
  maxWaitMs: 3_600_000,
  resultTtlMs: 86_400_000,
  authTimeoutMs: 60_000,
}

/** 带对外错误码的失败，供 HTTP 层映射成具体状态码。 */
class RelayError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'RelayError'
    this.code = code
    this.status = status
  }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const prefix = cfg.pathPrefix

  /** id → 任务。 */
  const tasks = new Map()
  /** message.id → 还在等的任务。 */
  const byMessage = new Map()
  /** 「会话~turn」→ 任务。 */
  const turnIndex = new Map()
  /** 会话 → 创建中的 agent Promise，避免并发重复创建。 */
  const agentCache = new Map()
  /** 本进程见过并确认属于本工作区的会话。 */
  const knownSessions = new Set()
  /** 已向工作区登记过的会话，避免重复写盘。 */
  const attached = new Set()
  /** 插件独占的工作区（懒建立）。 */
  let workspace = null
  /** 弹窗串行链：同一时刻只允许一个系统对话框。 */
  let dialogChain = Promise.resolve()
  /** agent.id → 正在接收增量的任务。chunk 帧不带 turn，只能按 agent 定位。 */
  const streamingByAgent = new Map()
  /** 所有存活定时器，卸载时统一清掉。 */
  const timers = new Set()

  // ════════════════════════════════════════
  //  定时器
  // ════════════════════════════════════════

  function later(callback, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback()
    }, delay)
    timers.add(timer)
    return timer
  }

  function cancel(timer) {
    if (timer !== null && timer !== undefined) {
      clearTimeout(timer)
      timers.delete(timer)
    }
  }

  // ════════════════════════════════════════
  //  来源与授权
  // ════════════════════════════════════════

  function recordKey(source) {
    return `${SOURCE_PREFIX}${source}`
  }

  function decodePayload(record) {
    if (!record || record.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') return {}
    return record.payload
  }

  async function readSource(source) {
    try {
      const payload = decodePayload(await ctx.credentials.readRecord(recordKey(source)))
      const level = Number.isInteger(payload.level) && LEVELS.has(payload.level) ? payload.level : 1
      const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint : null
      if (payload.level === undefined && fingerprint === null) return undefined
      return { level, fingerprint }
    } catch {
      return undefined
    }
  }

  async function writeSource(source, value) {
    await ctx.credentials.modifyRecord(recordKey(source), async () => ({
      kind: 'grant',
      payload: { fingerprint: value.fingerprint ?? null, level: value.level },
    }))
  }

  async function removeSource(source) {
    await ctx.credentials.deleteRecord(recordKey(source))
  }

  async function listSources() {
    const rows = []
    for (const entry of await ctx.credentials.listRecords()) {
      const key = String(entry.key)
      if (!key.startsWith(SOURCE_PREFIX)) continue
      const source = key.slice(SOURCE_PREFIX.length)
      const payload = decodePayload(await ctx.credentials.readRecord(key))
      rows.push({
        source,
        level: Number.isInteger(payload.level) && LEVELS.has(payload.level) ? payload.level : 1,
        hasFingerprint: typeof payload.fingerprint === 'string',
      })
    }
    return rows.sort((left, right) => left.source.localeCompare(right.source))
  }

  function newFingerprint() {
    return randomBytes(32).toString('base64url')
  }

  function sameSecret(expected, given) {
    if (typeof expected !== 'string' || typeof given !== 'string') return false
    const left = Buffer.from(expected, 'utf8')
    const right = Buffer.from(given, 'utf8')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }

  function askUser(message, options = {}) {
    const run = dialogChain.then(() => confirm({
      title: 'Relay',
      message,
      detail: typeof options.detail === 'string' ? options.detail : '',
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : cfg.authTimeoutMs,
    }))
    dialogChain = run.then(() => undefined, () => undefined)
    return run
  }

  function dialogFailure(answer) {
    if (answer.reason === 'unavailable') {
      return { ok: false, status: 503, code: 'ERR_AUTH_UNAVAILABLE', message: '主机上没有可用的确认窗口。' }
    }
    return { ok: false, status: 504, code: 'ERR_AUTH_TIMEOUT', message: '等待用户确认超时。' }
  }

  async function enroll(source) {
    const existing = await readSource(source)
    if (existing && existing.level === 0) {
      return { ok: false, status: 403, code: 'ERR_ACCESS_DENIED', message: '这个来源处于禁止名单。' }
    }
    if (existing && existing.fingerprint !== null) {
      return { ok: false, status: 409, code: 'ERR_SOURCE_EXISTS', message: '这个来源已经接过入了。' }
    }

    const answer = await askUser(
      `应用「${source}」请求接入 Relay，是否允许？\n\n允许后它可以向这个 agent 提交任务。你之后可以在「设置 → 外部应用」里调整它的权限级别。`,
    )
    if (answer.reason !== 'answered') return dialogFailure(answer)
    if (!answer.allowed) {
      await writeSource(source, { fingerprint: null, level: 0 })
      return { ok: false, status: 403, code: 'ERR_ACCESS_DENIED', message: '用户拒绝了这个来源。' }
    }

    const fingerprint = newFingerprint()
    await writeSource(source, { fingerprint, level: 1 })
    return { ok: true, data: { source, fingerprint, level: 1 } }
  }

  async function verifyCredential(source, given) {
    const record = await readSource(source)
    if (!record || record.fingerprint === null) return { ok: false, record: null }
    if (!sameSecret(record.fingerprint, given)) return { ok: false, record: null }
    return { ok: true, record }
  }

  /**
   * 验完身份后决定这条消息要不要再问一次用户。
   *
   * trigger 表示谁发起的，approved 表示这次调用是否被允许发生。两者独立：
   * 用户放行一次，不等于这句话是用户说的。后台发起的消息无论如何都不会被
   * 标记成用户发言——包括用户点过允许的情况。
   */
  async function admitMessage(source, record, trigger, content) {
    if (record.level === 0) {
      return { ok: false, status: 403, code: 'ERR_ACCESS_DENIED', message: '这个来源处于禁止名单。' }
    }

    const needsConfirm = record.level === 1 || (record.level === 2 && trigger !== 'user')
    if (!needsConfirm) return { ok: true, approved: true }

    const answer = await askUser(
      trigger === 'user'
        ? `应用「${source}」请求发送一条消息，是否允许？`
        : `应用「${source}」在后台请求处理一条消息，是否允许？`,
      { detail: content },
    )
    if (answer.reason !== 'answered') return dialogFailure(answer)
    if (!answer.allowed) {
      return { ok: false, status: 403, code: 'ERR_AUTH_DENIED', message: '用户拒绝了这条消息。' }
    }
    return { ok: true, approved: true }
  }

  // ════════════════════════════════════════
  //  任务结算
  // ════════════════════════════════════════

  function settle(task, state, event) {
    if (task.state !== 'pending') return
    task.state = state
    task.event = event
    cancel(task.timer)
    task.timer = null

    if (byMessage.get(task.id) === task) byMessage.delete(task.id)
    if (task.turn !== null && turnIndex.get(turnKey(task.session, task.turn)) === task) {
      turnIndex.delete(turnKey(task.session, task.turn))
    }

    const waiters = Array.from(task.waiters)
    task.waiters.clear()
    for (const waiter of waiters) {
      try {
        waiter()
      } catch {
        /* 等待者自己的异常不能影响结算 */
      }
    }

    finishStream(task)

    task.ttl = later(() => {
      if (tasks.get(task.id) === task) tasks.delete(task.id)
    }, cfg.resultTtlMs)
  }

  function settleFromReason(task, reason) {
    const kind = reason && typeof reason.kind === 'string' ? reason.kind : 'unknown'
    const base = {
      id: task.id,
      session: task.session,
      source: task.source,
    }

    if (kind === 'completed') {
      settle(task, 'final', {
        ...base,
        type: 'final',
        content: task.candidate === null ? '' : task.candidate,
      })
      return
    }

    if (kind === 'error') {
      const failure = reason.error && typeof reason.error === 'object' ? reason.error : {}
      const code = typeof failure.code === 'string' && failure.code !== 'UNKNOWN' ? failure.code : 'ERR_TASK_FAILED'
      settle(task, 'error', {
        ...base,
        type: 'error',
        code,
        message: typeof failure.message === 'string' ? failure.message : '任务执行失败。',
      })
      return
    }

    settle(task, 'error', {
      ...base,
      type: 'error',
      code: `ERR_TURN_${kind.toUpperCase()}`,
      message: `任务未正常结束：${kind}。`,
    })
  }

  function turnKey(session, turn) {
    return `${session}~${turn}`
  }

  // ════════════════════════════════════════
  //  流式输出
  // ════════════════════════════════════════

  function openStream(res, task, origin, budgetMs) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    const send = (event, data) => {
      if (res.writableEnded || res.destroyed) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    task.stream = { send, res }
    send('accepted', { id: task.id, session: task.session, source: task.source })

    task.streamTimer = later(() => {
      task.streamTimer = null
      if (task.stream) {
        task.stream.send('end', { id: task.id, status: 'timeout' })
        finishStream(task)
      }
    }, Math.max(1, budgetMs))

    res.on('close', () => {
      if (task.stream && task.stream.res === res) {
        task.stream = null
        if (task.streamTimer !== null) {
          cancel(task.streamTimer)
          task.streamTimer = null
        }
      }
    })
  }

  function finishStream(task) {
    if (task.streamTimer !== null) {
      cancel(task.streamTimer)
      task.streamTimer = null
    }
    if (!task.stream) return
    const stream = task.stream
    task.stream = null
    if (streamingByAgent.get(task.session) === task) streamingByAgent.delete(task.session)

    if (task.state === 'final') {
      stream.send('end', { id: task.id, status: 'completed', content: task.event.content })
    } else if (task.state === 'expired') {
      stream.send('error', { id: task.id, code: task.event.code, message: task.event.message })
      stream.send('end', { id: task.id, status: 'expired' })
    } else if (task.state === 'error') {
      stream.send('error', { id: task.id, code: task.event.code, message: task.event.message })
      stream.send('end', { id: task.id, status: 'error' })
    }

    try {
      if (!stream.res.writableEnded && !stream.res.destroyed) stream.res.end()
    } catch {
      /* 客户端可能已经断开 */
    }
  }

  /**
   * 模型增量。
   *
   * chunk 帧不带 turn，只有 start 帧带，所以按 start 绑定、按 end 解绑：
   * 开始那一刻确认这个 turn 属于我们某个在等流式的任务，之后同 agent 的增量就归它。
   */
  function onAssistantStream(payload) {
    const agent = payload && payload.agent
    const frame = payload && payload.frame
    if (!agent || !frame) return

    if (frame.type === 'start') {
      const task = turnIndex.get(turnKey(agent.id, frame.turn))
      if (task && task.stream) streamingByAgent.set(agent.id, task)
      else streamingByAgent.delete(agent.id)
      return
    }

    if (frame.type === 'end') {
      streamingByAgent.delete(agent.id)
      return
    }

    if (frame.type !== 'chunk' || !frame.chunk) return
    const task = streamingByAgent.get(agent.id)
    if (!task || !task.stream) return

    const chunk = frame.chunk
    if (chunk.type === 'text-delta' && chunk.text) {
      task.stream.send('content', { id: task.id, text: chunk.text })
      return
    }
    if (chunk.type === 'reasoning-delta' && chunk.text) {
      task.stream.send('reasoning', { id: task.id, text: chunk.text })
    }
  }

  // ════════════════════════════════════════
  //  等待
  // ════════════════════════════════════════

  function waitFor(task, budgetMs) {
    if (task.state !== 'pending') return Promise.resolve()

    const budget = Math.max(0, Math.min(budgetMs, cfg.maxWaitMs))
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        cancel(timer)
        task.waiters.delete(finish)
        resolve()
      }
      const timer = later(() => {
        task.waiters.delete(finish)
        if (done) return
        done = true
        resolve()
      }, budget)
      task.waiters.add(finish)
    })
  }

  // ════════════════════════════════════════
  //  会话
  // ════════════════════════════════════════

  async function ensureWorkspace() {
    if (workspace) return workspace
    mkdirSync(cfg.workspacePath, { recursive: true })
    workspace = await ctx.workspaceRegistry.create(cfg.workspacePath, cfg.workspaceTitle)
    return workspace
  }

  async function attach(sessionId) {
    if (attached.has(sessionId)) return
    try {
      await workspace.attachSession(sessionId)
      attached.add(sessionId)
    } catch (error) {
      console.warn(
        `[relay] 会话 ${sessionId} 未能登记到工作区：`,
        error && error.message ? error.message : error,
      )
    }
  }

  async function readHeader(sessionName) {
    try {
      const snapshot = await ctx.sessionQuery.readSession(sessionName)
      return snapshot && snapshot.session ? snapshot.session : null
    } catch {
      return null
    }
  }

  function modelOptions() {
    const service = ctx.get('agentDefaultModel')
    if (!service || typeof service.currentSelection !== 'function') return undefined
    const selection = service.currentSelection()
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
    const options = { provider: selection.provider, model: selection.model }
    if (typeof selection.reasoningEffort === 'string') options.reasoningEffort = selection.reasoningEffort
    return options
  }

  async function createOrResume(sessionName) {
    const agentOptions = modelOptions()
    await ensureWorkspace()

    const header = await readHeader(sessionName)
    if (header) {
      if (header.cwd !== workspace.path) {
        throw new RelayError(
          'ERR_SESSION_OUTSIDE_WORKSPACE',
          `会话「${sessionName}」不在 Relay 工作区（${workspace.path}）内，外部入口不能使用它。`,
          409,
        )
      }
      const live = ctx.agents.get(sessionName)
      if (live) {
        await attach(live.id)
        return live
      }
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionName,
        ...(agentOptions ? { agentOptions } : {}),
      })
      await attach(handle.agent.id)
      return handle.agent
    }

    const handle = await ctx.agents.create({
      sessionId: sessionName,
      meta: { cwd: workspace.path },
      ...(agentOptions ? { agentOptions } : {}),
    })
    try {
      const titles = ctx.get('sessionTitle')
      if (titles && typeof titles.rename === 'function') {
        titles.rename(handle.agent.session, DEFAULT_TITLE)
      }
    } catch {
      /* 标题只是显示，失败不影响入口 */
    }
    await attach(handle.agent.id)
    return handle.agent
  }

  async function ensureAgent(sessionName) {
    let pending = agentCache.get(sessionName)
    if (!pending) {
      pending = createOrResume(sessionName)
      agentCache.set(sessionName, pending)
      pending.catch(() => {
        if (agentCache.get(sessionName) === pending) agentCache.delete(sessionName)
      })
    }

    const agent = await pending
    knownSessions.add(sessionName)
    return agent
  }

  // ════════════════════════════════════════
  //  事件关联
  // ════════════════════════════════════════

  function onSessionEvent(session, event) {
    if (!event || typeof event.type !== 'string') return
    const sessionId = session.id
    const data = event.data
    if (!data || typeof data !== 'object') return

    if (event.type === 'assistant/message') {
      const task = turnIndex.get(turnKey(sessionId, data.turn))
      if (!task || task.state !== 'pending') return
      if (!hasToolCall(data.message)) task.candidate = extractText(data.message)
      return
    }

    if (event.type === 'turn/end') {
      const task = turnIndex.get(turnKey(sessionId, data.turn))
      if (!task) return
      settleFromReason(task, data.reason)
    }
  }

  /**
   * 消息被 agent 取走时触发，比 `user/message` 可靠：
   * turn 在进入 step 之前就失败时不会产生 `user/message`，但一定会经过这里。
   */
  function onInboxClaimed(payload) {
    const agent = payload && payload.agent
    const message = payload && payload.message
    if (!agent || !message || typeof message.id !== 'string') return
    const task = byMessage.get(message.id)
    if (!task || task.state !== 'pending' || task.claimed) return
    task.turn = payload.turn
    task.claimed = true
    turnIndex.set(turnKey(agent.id, payload.turn), task)
  }

  function onAgentDisposed(payload) {
    const agent = payload && payload.agent
    if (!agent) return
    const sessionId = agent.id
    agentCache.delete(sessionId)
    for (const task of Array.from(tasks.values())) {
      if (task.session !== sessionId || task.state !== 'pending') continue
      settle(task, 'error', {
        id: task.id,
        session: task.session,
        source: task.source,
        type: 'error',
        code: 'ERR_AGENT_DISPOSED',
        message: '会话在任务完成前被关闭。',
      })
    }
  }

  // ════════════════════════════════════════
  //  消息构造
  // ════════════════════════════════════════

  function serialize(content, source, trigger, approved) {
    return JSON.stringify({ type: 'external_request', source, trigger, approved, content })
  }

  function hasToolCall(message) {
    const blocks = message && message.content
    return Array.isArray(blocks) && blocks.some((block) => block && block.type === 'tool-call')
  }

  function extractText(message) {
    const blocks = message && message.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }

  // ════════════════════════════════════════
  //  id
  // ════════════════════════════════════════

  function parseId(id) {
    const parts = String(id).split('~')
    if (parts.length !== 3) return null
    const [session, source] = parts
    if (!NAME_PATTERN.test(session) || !NAME_PATTERN.test(source)) return null
    return { session, source }
  }

  function buildId(session, source) {
    return `${session}~${source}~${randomUUID()}`
  }

  // ════════════════════════════════════════
  //  日志重建
  // ════════════════════════════════════════

  async function rebuild(id) {
    const parsed = parseId(id)
    if (!parsed) return null

    let snapshot
    try {
      snapshot = await ctx.sessionQuery.readSession(parsed.session)
    } catch {
      return null
    }

    const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
    const index = events.findIndex(
      (event) => event && event.type === 'user/message' && event.data && event.data.id === id,
    )
    if (index < 0) return null

    let turn = null
    for (let i = index - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (!event) continue
      if (event.type === 'turn/end') return null
      if (event.type === 'turn/start' && event.data) {
        turn = event.data.turn
        break
      }
    }
    if (turn === null) return null

    let candidate = null
    let end = null
    for (let i = index + 1; i < events.length; i += 1) {
      const event = events[i]
      if (!event) continue
      if (event.type === 'turn/end' && event.data && event.data.turn === turn) {
        end = event
        break
      }
      if (event.type === 'assistant/message' && event.data && event.data.turn === turn && !hasToolCall(event.data.message)) {
        candidate = extractText(event.data.message)
      }
    }
    if (!end) return null

    const task = {
      id,
      session: parsed.session,
      source: parsed.source,
      state: 'pending',
      acceptedAt: typeof end.time === 'number' ? end.time : Date.now(),
      waiters: new Set(),
      candidate,
      claimed: true,
      turn,
      timer: null,
      ttl: null,
      event: null,
      stream: null,
      streamTimer: null,
    }
    settleFromReason(task, end.data.reason)
    return task
  }

  // ════════════════════════════════════════
  //  HTTP 工具
  // ════════════════════════════════════════

  function allowedOrigin(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '') return null
    if (origin === 'null') return origin
    try {
      const url = new URL(origin)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      const host = url.hostname
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return origin
    } catch {
      return null
    }
    return null
  }

  function sendJson(res, status, body, origin) {
    if (res.writableEnded || res.destroyed) return
    const buffer = Buffer.from(JSON.stringify(body), 'utf8')
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Cache-Control', 'no-store')
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
    res.end(buffer)
  }

  function fail(res, status, code, message, origin) {
    sendJson(res, status, { code, message }, origin)
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.trim() === '') {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  // ════════════════════════════════════════
  //  处理器
  // ════════════════════════════════════════

  function respondTask(res, task, origin) {
    if (task.state === 'pending') {
      sendJson(res, 202, { id: task.id, status: 'pending' }, origin)
      return
    }
    if (task.state === 'expired') {
      sendJson(res, 410, task.event, origin)
      return
    }
    sendJson(res, 200, task.event, origin)
  }

  async function readObject(req, res, origin) {
    let body
    try {
      body = await readJson(req)
    } catch {
      fail(res, 400, 'ERR_REQUEST_JSON', '请求体不是合法的 JSON 对象。', origin)
      return undefined
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      fail(res, 400, 'ERR_REQUEST_JSON', '请求体必须是 JSON 对象。', origin)
      return undefined
    }
    return body
  }

  function validSourceField(value) {
    return typeof value === 'string' && NAME_PATTERN.test(value)
  }

  const LEVEL_LABEL = { 0: '禁止', 1: '每条消息都确认', 2: '信任已确认标记', 3: '完全信任' }

  async function handleEnroll(req, res, origin) {
    const body = await readObject(req, res, origin)
    if (body === undefined) return
    if (!validSourceField(body.source)) {
      fail(res, 400, 'ERR_SOURCE', 'source 必须是 1-64 位字母、数字、下划线或连字符。', origin)
      return
    }
    try {
      const result = await enroll(body.source)
      if (!result.ok) {
        fail(res, result.status, result.code, result.message, origin)
        return
      }
      sendJson(res, 200, result.data, origin)
    } catch (error) {
      fail(res, 500, 'ERR_INTERNAL', error && error.message ? String(error.message) : '接入失败。', origin)
    }
  }

  async function handleFingerprintReset(req, res, origin) {
    const body = await readObject(req, res, origin)
    if (body === undefined) return
    if (!validSourceField(body.source) || typeof body.fingerprint !== 'string') {
      fail(res, 401, 'ERR_INPUT_FINGERPRINT', '需要 source 和当前凭证。', origin)
      return
    }
    try {
      const verified = await verifyCredential(body.source, body.fingerprint.trim())
      if (!verified.ok) {
        fail(res, 401, 'ERR_INPUT_FINGERPRINT', '来源与凭证不匹配。', origin)
        return
      }
      const answer = await askUser(`应用「${body.source}」请求更换凭证，是否允许？`)
      if (answer.reason !== 'answered') {
        const failure = dialogFailure(answer)
        fail(res, failure.status, failure.code, failure.message, origin)
        return
      }
      if (!answer.allowed) {
        fail(res, 403, 'ERR_AUTH_DENIED', '用户拒绝更换凭证。', origin)
        return
      }
      const fingerprint = newFingerprint()
      await writeSource(body.source, { fingerprint, level: verified.record.level })
      sendJson(res, 200, { source: body.source, fingerprint }, origin)
    } catch (error) {
      fail(res, 500, 'ERR_INTERNAL', error && error.message ? String(error.message) : '凭证轮换失败。', origin)
    }
  }

  async function handleSources(req, res, origin) {
    try {
      sendJson(res, 200, { sources: await listSources() }, origin)
    } catch (error) {
      fail(res, 500, 'ERR_INTERNAL', error && error.message ? String(error.message) : '读取来源失败。', origin)
    }
  }

  async function handleLevel(req, res, origin) {
    const body = await readObject(req, res, origin)
    if (body === undefined) return
    if (!validSourceField(body.source) || !LEVELS.has(body.level)) {
      fail(res, 400, 'ERR_PERMISSION_LEVEL', 'source 或 level 不合法。', origin)
      return
    }
    try {
      const record = await readSource(body.source)
      if (!record || record.fingerprint === null) {
        fail(res, 409, 'ERR_SOURCE_NOT_ONBOARDED', '这个来源还没有凭证。', origin)
        return
      }
      const loosening = body.level > record.level
      if (loosening) {
        const answer = await askUser(
          `把应用「${body.source}」的权限从「${LEVEL_LABEL[record.level]}」改为「${LEVEL_LABEL[body.level]}」，是否允许？`,
        )
        if (answer.reason !== 'answered') {
          const failure = dialogFailure(answer)
          fail(res, failure.status, failure.code, failure.message, origin)
          return
        }
        if (!answer.allowed) {
          fail(res, 403, 'ERR_AUTH_DENIED', '用户拒绝了这次提权。', origin)
          return
        }
      }
      await writeSource(body.source, { fingerprint: record.fingerprint, level: body.level })
      sendJson(res, 200, { source: body.source, level: body.level }, origin)
    } catch (error) {
      fail(res, 500, 'ERR_INTERNAL', error && error.message ? String(error.message) : '修改级别失败。', origin)
    }
  }

  async function handleClear(req, res, origin) {
    const body = await readObject(req, res, origin)
    if (body === undefined) return
    if (!validSourceField(body.source)) {
      fail(res, 400, 'ERR_SOURCE', 'source 不合法。', origin)
      return
    }
    try {
      const record = await readSource(body.source)
      if (!record || record.fingerprint !== null || record.level !== 0) {
        fail(res, 409, 'ERR_SOURCE_NOT_FOUND', '没有可解除的禁止记录。', origin)
        return
      }
      const answer = await askUser(`解除对应用「${body.source}」的禁止，是否允许？`)
      if (answer.reason !== 'answered') {
        const failure = dialogFailure(answer)
        fail(res, failure.status, failure.code, failure.message, origin)
        return
      }
      if (!answer.allowed) {
        fail(res, 403, 'ERR_AUTH_DENIED', '用户取消了操作。', origin)
        return
      }
      await removeSource(body.source)
      sendJson(res, 200, { source: body.source }, origin)
    } catch (error) {
      fail(res, 500, 'ERR_INTERNAL', error && error.message ? String(error.message) : '解除禁止失败。', origin)
    }
  }

  async function handleDelete(req, res, origin) {
    const body = await readObject(req, res, origin)
    if (body === undefined) return
    if (!validSourceField(body.source)) {
      fail(res, 400, 'ERR_SOURCE', 'source 不合法。', origin)
      return
    }
    try {
      await removeSource(body.source)
      sendJson(res, 200, { source: body.source }, origin)
    } catch (error) {
      fail(res, 500, 'ERR_INTERNAL', error && error.message ? String(error.message) : '删除失败。', origin)
    }
  }

  async function handleSubmit(req, res, origin) {
    let body
    try {
      body = await readJson(req)
    } catch {
      fail(res, 400, 'ERR_REQUEST_JSON', '请求体不是合法的 JSON 对象。', origin)
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      fail(res, 400, 'ERR_REQUEST_JSON', '请求体必须是 JSON 对象。', origin)
      return
    }

    const content = body.content
    if (typeof content !== 'string' || content.trim() === '') {
      fail(res, 400, 'ERR_CONTENT', 'content 必须是非空字符串。', origin)
      return
    }

    const source = body.source === undefined ? 'external' : body.source
    if (typeof source !== 'string' || !NAME_PATTERN.test(source)) {
      fail(res, 400, 'ERR_SOURCE', 'source 必须是 1-64 位字母、数字、下划线或连字符。', origin)
      return
    }

    const sessionName = body.session === undefined ? cfg.defaultSession : body.session
    if (typeof sessionName !== 'string' || !NAME_PATTERN.test(sessionName)) {
      fail(res, 400, 'ERR_SESSION', 'session 必须是 1-64 位字母、数字、下划线或连字符。', origin)
      return
    }

    const trigger = body.trigger === undefined ? 'app' : body.trigger
    if (trigger !== 'user' && trigger !== 'app') {
      fail(res, 400, 'ERR_TRIGGER', 'trigger 只能是 user 或 app。', origin)
      return
    }

    const fingerprint = body.fingerprint
    if (typeof fingerprint !== 'string' || fingerprint.trim() === '') {
      fail(res, 401, 'ERR_INPUT_FINGERPRINT', '缺少凭证，请先通过 POST /fingerprint 申请。', origin)
      return
    }

    let gate
    try {
      const verified = await verifyCredential(source, fingerprint.trim())
      if (!verified.ok) {
        fail(res, 401, 'ERR_INPUT_FINGERPRINT', '来源与凭证不匹配。', origin)
        return
      }
      gate = await admitMessage(source, verified.record, trigger, content)
    } catch (error) {
      fail(res, 500, 'ERR_INTERNAL', error && error.message ? String(error.message) : '授权检查失败。', origin)
      return
    }
    if (!gate.ok) {
      fail(res, gate.status, gate.code, gate.message, origin)
      return
    }

    let timeoutMs = cfg.maxWaitMs
    if (body.timeout !== undefined) {
      const seconds = Number(body.timeout)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        fail(res, 400, 'ERR_TIMEOUT', 'timeout 必须是正数秒。', origin)
        return
      }
      timeoutMs = Math.min(seconds * 1000, cfg.maxWaitMs)
    }

    let agent
    try {
      agent = await ensureAgent(sessionName)
    } catch (error) {
      const message = error && error.message ? String(error.message) : '会话无法创建或恢复。'
      const code = error instanceof RelayError ? error.code : 'ERR_SESSION_UNAVAILABLE'
      const status = error instanceof RelayError ? error.status : 500
      fail(res, status, code, message, origin)
      return
    }

    const id = buildId(sessionName, source)
    const task = {
      id,
      session: sessionName,
      source,
      state: 'pending',
      acceptedAt: Date.now(),
      waiters: new Set(),
      candidate: null,
      claimed: false,
      turn: null,
      timer: null,
      ttl: null,
      event: null,
      stream: null,
      streamTimer: null,
    }
    tasks.set(id, task)
    byMessage.set(id, task)

    const message = {
      role: 'user',
      id,
      content: [{ type: 'text', text: serialize(content, source, trigger, gate.approved) }],
      source: { kind: 'user' },
    }

    try {
      agent.followup(message)
    } catch (error) {
      tasks.delete(id)
      byMessage.delete(id)
      fail(res, 500, 'ERR_DELIVERY', error && error.message ? String(error.message) : '消息投递失败。', origin)
      return
    }

    task.timer = later(() => {
      if (task.state !== 'pending' || task.claimed) return
      try {
        if (agent.inbox && typeof agent.inbox.remove === 'function') agent.inbox.remove(task.id)
      } catch {
        /* 撤不掉也要按作废处理 */
      }
      settle(task, 'expired', {
        id: task.id,
        session: task.session,
        source: task.source,
        code: 'ERR_QUEUE_EXPIRED',
        message: `排队超过 ${Math.round(cfg.queueLimitMs / 1000)} 秒仍未开始执行，已作废。`,
      })
    }, cfg.queueLimitMs)

    if (body.stream === true) {
      openStream(res, task, origin, timeoutMs)
      return
    }

    if (body.wait !== true) {
      sendJson(res, 202, { id, status: 'pending' }, origin)
      return
    }

    await waitFor(task, timeoutMs)
    respondTask(res, task, origin)
  }

  async function handleResult(res, id, origin) {
    if (typeof id !== 'string' || id === '') {
      fail(res, 400, 'ERR_ID', 'id 不能为空。', origin)
      return
    }

    let task = tasks.get(id)
    if (!task) {
      task = await rebuild(id)
      if (!task) {
        fail(res, 404, 'ERR_RESULT_NOT_FOUND', '没有这个任务，或它从未被受理。', origin)
        return
      }
      tasks.set(id, task)
    }

    respondTask(res, task, origin)
  }

  function handleOptions(req, res, origin) {
    if (!origin) {
      fail(res, 403, 'ERR_ORIGIN', 'Origin not allowed.', null)
      return
    }
    res.statusCode = 204
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '600')
    res.end()
  }

  async function handle(req, res) {
    const origin = allowedOrigin(req)
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname

    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      fail(res, 404, 'ERR_NOT_FOUND', '没有这个路径。', origin)
      return
    }

    const rest = path.slice(prefix.length) || '/'

    if (req.method === 'OPTIONS') {
      handleOptions(req, res, origin)
      return
    }

    if (rest === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true }, origin)
      return
    }

    if (rest === '/fingerprint' && req.method === 'POST') {
      await handleEnroll(req, res, origin)
      return
    }

    if (rest === '/fingerprint/reset' && req.method === 'POST') {
      await handleFingerprintReset(req, res, origin)
      return
    }

    if (rest === '/sources' && req.method === 'GET') {
      await handleSources(req, res, origin)
      return
    }

    if (rest === '/sources/level' && req.method === 'POST') {
      await handleLevel(req, res, origin)
      return
    }

    if (rest === '/sources/clear' && req.method === 'POST') {
      await handleClear(req, res, origin)
      return
    }

    if (rest === '/sources/delete' && req.method === 'POST') {
      await handleDelete(req, res, origin)
      return
    }

    if (rest === '/sessions' && req.method === 'GET') {
      const query = url.searchParams
      const givenSource = query.get('source')
      const givenFingerprint = query.get('fingerprint')
      if (typeof givenSource !== 'string' || typeof givenFingerprint !== 'string') {
        fail(res, 401, 'ERR_INPUT_FINGERPRINT', '会话列表需要 source 和 fingerprint。', origin)
        return
      }
      const verified = await verifyCredential(givenSource, givenFingerprint)
      if (!verified.ok || verified.record.level === 0) {
        fail(res, 401, 'ERR_INPUT_FINGERPRINT', '来源与凭证不匹配。', origin)
        return
      }
      const ids = new Set(knownSessions)
      try {
        await ensureWorkspace()
        for (const id of workspace.sessionIds) ids.add(id)
      } catch {
        /* 工作区不可用时退回本进程见过的集合 */
      }
      sendJson(res, 200, {
        sessions: Array.from(ids).sort().map((id) => ({ id })),
      }, origin)
      return
    }

    if (rest === '/submit' && req.method === 'POST') {
      await handleSubmit(req, res, origin)
      return
    }

    if (rest.startsWith('/result/') && req.method === 'GET') {
      await handleResult(res, decodeURIComponent(rest.slice('/result/'.length)), origin)
      return
    }

    fail(res, 404, 'ERR_NOT_FOUND', '没有这个路径。', origin)
  }

  function route(req, res) {
    handle(req, res).catch((error) => {
      fail(res, 500, 'ERR_INTERNAL', error && error.message ? String(error.message) : '内部错误。', allowedOrigin(req))
    })
  }

  // ════════════════════════════════════════
  //  装配
  // ════════════════════════════════════════

  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/inbox/claimed', onInboxClaimed)
  // global: true —— agent 作用域的事件不会自动冒泡到根上下文
  ctx.on('agent/assistant-stream', onAssistantStream, { global: true })
  ctx.on('agent/disposed', onAgentDisposed, { global: true })

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: route,
    })

    return () => {
      disposeRoute()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      tasks.clear()
      byMessage.clear()
      turnIndex.clear()
      agentCache.clear()
      attached.clear()
      knownSessions.clear()
      streamingByAgent.clear()
      workspace = null
    }
  })

  ensureAgent(cfg.defaultSession).catch((error) => {
    console.error('[relay] 默认外部会话初始化失败：', error)
  })
}

/** 与 @deepseek-ai/dsh-home-paths 相同的优先级：配置 > $DSH_HOME > ~/.dsh。 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') {
    return expandHome(configured.trim())
  }
  return join(homedir(), '.dsh')
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {}

  let pathPrefix = typeof source.pathPrefix === 'string' && source.pathPrefix.trim() !== ''
    ? source.pathPrefix.trim().replace(/\/+$/u, '')
    : DEFAULTS.pathPrefix
  if (!pathPrefix.startsWith('/')) pathPrefix = `/${pathPrefix}`

  const defaultSession = typeof source.defaultSession === 'string' && NAME_PATTERN.test(source.defaultSession)
    ? source.defaultSession
    : DEFAULTS.defaultSession

  const workspacePath = typeof source.workspacePath === 'string' && isAbsolute(source.workspacePath)
    ? source.workspacePath
    : DEFAULTS.workspacePath

  const workspaceTitle = typeof source.workspaceTitle === 'string' && source.workspaceTitle.trim() !== ''
    ? source.workspaceTitle.trim()
    : DEFAULTS.workspaceTitle

  return {
    pathPrefix,
    defaultSession,
    workspacePath,
    workspaceTitle,
    queueLimitMs: positive(source.queueLimitMs, DEFAULTS.queueLimitMs),
    maxWaitMs: positive(source.maxWaitMs, DEFAULTS.maxWaitMs),
    resultTtlMs: positive(source.resultTtlMs, DEFAULTS.resultTtlMs),
    authTimeoutMs: positive(source.authTimeoutMs, DEFAULTS.authTimeoutMs),
  }
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
