/**
 * 原生确认框：由操作系统渲染在主机屏幕上，只有真人能点。
 *
 * Windows / WSL 上是右下角的置顶小窗口（toast 形态），带正文预览和「展开全文」；
 * macOS 和 Linux 仍是居中的系统对话框，正文直接附在提示文字里。
 *
 * 返回 true 表示用户点了"允许"，其余一切情况（拒绝、关窗口、超时、工具缺失）
 * 都返回 false —— 调用方不需要区分，失败方向的默认行为都是"不放行"。
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const DEFAULT_TIMEOUT_MS = 60_000

/** 塞进系统窗口的正文上限，避免命令过长；超出部分在窗口里也读不过来。 */
const DETAIL_LIMIT = 4000

/** 检测 WSL：弹窗要交回 Windows 宿主，WSL 里没有可用的图形对话框。 */
function detectPlatform() {
  if (process.platform !== 'linux') return process.platform
  if (typeof process.env.WSL_DISTRO_NAME === 'string' && process.env.WSL_DISTRO_NAME !== '') return 'wsl'
  try {
    const version = readFileSync('/proc/version', 'utf8')
    if (/microsoft/i.test(version)) return 'wsl'
  } catch {
    /* 读不到就按普通 linux 处理 */
  }
  return 'linux'
}

function appleString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function powerShellString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function clipDetail(detail) {
  if (typeof detail !== 'string' || detail === '') return ''
  const text = detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}\n…（内容过长，后面省略）` : detail
  return text
}

/**
 * 右下角置顶小窗口：标题 + 正文预览 + 展开/收起 + 允许/拒绝。
 * 正文可滚动，窗口可以长高到接近整屏；退出码就是答案。
 */
function windowsScript(title, message, detail) {
  const hasDetail = detail !== ''
  const width = 340
  const baseHeight = hasDetail ? 186 : 138
  const buttonTop = baseHeight - 46

  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$anchorTLR = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right',
    '$anchorAll = $anchorTLR -bor [System.Windows.Forms.AnchorStyles]::Bottom',
    '$anchorBL = [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left',
    '$anchorBR = [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Right',
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = ${powerShellString(title)}`,
    '$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 11)',
    '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle',
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
    '$form.TopMost = $true',
    '$form.ShowInTaskbar = $true',
    '$form.MaximizeBox = $false',
    '$form.MinimizeBox = $false',
    `$form.ClientSize = New-Object System.Drawing.Size(${width}, ${baseHeight})`,
    '$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$form.Left = $area.Right - $form.Width - 24',
    '$form.Top = $area.Bottom - $form.Height - 24',
    '$header = New-Object System.Windows.Forms.Label',
    `$header.Text = ${powerShellString(message)}`,
    `$header.SetBounds(14, 10, ${width - 28}, ${hasDetail ? 46 : 50})`,
    '$header.Anchor = $anchorTLR',
    '$form.Controls.Add($header)',
  ]

  if (hasDetail) {
    lines.push(
      '$text = New-Object System.Windows.Forms.TextBox',
      '$text.Multiline = $true',
      '$text.ReadOnly = $true',
      '$text.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical',
      '$text.WordWrap = $true',
      '$text.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle',
      `$text.Text = ${powerShellString(detail)}`,
      `$text.SetBounds(14, 58, ${width - 28}, 28)`,
      '$text.Anchor = $anchorAll',
      '$form.Controls.Add($text)',
      '$expand = New-Object System.Windows.Forms.Button',
      "$expand.Text = '展开全文'",
      `$expand.SetBounds(14, ${buttonTop}, 96, 32)`,
      '$expand.Anchor = $anchorBL',
      '$form.Controls.Add($expand)',
      '$script:expanded = $false',
      '$expand.Add_Click({',
      '  if (-not $script:expanded) {',
      '    $target = [Math]::Min([Math]::Max(360, $area.Height - 120), 640)',
      `    $form.ClientSize = New-Object System.Drawing.Size(${width}, $target)`,
      "    $expand.Text = '收起'",
      '    $script:expanded = $true',
      '  } else {',
      `    $form.ClientSize = New-Object System.Drawing.Size(${width}, ${baseHeight})`,
      "    $expand.Text = '展开全文'",
      '    $script:expanded = $false',
      '  }',
      '  $form.Top = $area.Bottom - $form.Height - 24',
      '})',
    )
  }

  lines.push(
    '$deny = New-Object System.Windows.Forms.Button',
    "$deny.Text = '拒绝'",
    `$deny.SetBounds(${width - 186}, ${buttonTop}, 78, 32)`,
    '$deny.Anchor = $anchorBR',
    '$deny.Add_Click({ $script:answer = 1; $form.Close() })',
    '$form.Controls.Add($deny)',
    '$allow = New-Object System.Windows.Forms.Button',
    "$allow.Text = '允许'",
    `$allow.SetBounds(${width - 98}, ${buttonTop}, 78, 32)`,
    '$allow.Anchor = $anchorBR',
    '$allow.Add_Click({ $script:answer = 0; $form.Close() })',
    '$form.Controls.Add($allow)',
    '$form.AcceptButton = $allow',
    '$script:answer = 1',
    '[System.Windows.Forms.Application]::Run($form)',
    'exit $script:answer',
  )

  return lines.join("\n")
}

function run(command, args, timeoutMs, signal) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
    } catch {
      resolve({ code: null, stdout: '', missing: true })
      return
    }

    let stdout = ''
    let settled = false
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
      resolve(result)
    }

    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
      finish({ code: null, stdout, aborted: true })
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', () => {})

    child.on('error', (error) => {
      finish({ code: null, stdout, missing: error && error.code === 'ENOENT' })
    })

    child.on('close', (code) => {
      finish({ code: typeof code === 'number' ? code : null, stdout })
    })

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
      finish({ code: null, stdout, timedOut: true })
    }, timeoutMs)

    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function runWindows(title, message, detail, timeoutMs, signal) {
  // 走 -EncodedCommand：脚本以 UTF-16LE 传进去，绕开控制台代码页。
  // 中文如果直接放在命令行或 ANSI 脚本里，PowerShell 会按系统代码页解码成乱码。
  const encoded = Buffer.from(windowsScript(title, message, detail), 'utf16le').toString('base64')
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    timeoutMs,
    signal,
  )

  if (result.missing) return { allowed: false, reason: 'unavailable' }
  if (result.timedOut) return { allowed: false, reason: 'timeout' }
  if (result.aborted) return { allowed: false, reason: 'aborted' }
  return { allowed: result.code === 0, reason: 'answered' }
}

async function runPosix(platform, title, message, detail, timeoutMs, signal) {
  const text = detail === ''
    ? message
    : `${message}\n\n${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`

  if (platform === 'darwin') {
    const result = await run('osascript', [
      '-e',
      `display dialog ${appleString(text)} buttons {"拒绝","允许"} default button "允许" with title ${appleString(title)}`,
    ], timeoutMs, signal)
    if (result.missing) return { allowed: false, reason: 'unavailable' }
    if (result.timedOut) return { allowed: false, reason: 'timeout' }
    if (result.aborted) return { allowed: false, reason: 'aborted' }
    return { allowed: result.stdout.includes('button returned:允许'), reason: 'answered' }
  }

  const answer = await run('zenity', [
    '--question', `--title=${title}`, `--text=${text}`, '--ok-label=允许', '--cancel-label=拒绝', '--no-wrap',
  ], timeoutMs, signal)

  if (answer.missing) {
    const fallback = await run('kdialog', [
      '--title', title, '--yesno', text, '--yes-label', '允许', '--no-label', '拒绝',
    ], timeoutMs, signal)
    if (fallback.missing) return { allowed: false, reason: 'unavailable' }
    if (fallback.timedOut) return { allowed: false, reason: 'timeout' }
    if (fallback.aborted) return { allowed: false, reason: 'aborted' }
    return { allowed: fallback.code === 0, reason: 'answered' }
  }

  if (answer.timedOut) return { allowed: false, reason: 'timeout' }
  if (answer.aborted) return { allowed: false, reason: 'aborted' }
  return { allowed: answer.code === 0, reason: 'answered' }
}

/**
 * 弹一个「允许 / 拒绝」确认框。
 *
 * @param {object} request
 * @param {string} request.title 窗口标题
 * @param {string} request.message 标题行；调用方负责把应用名嵌进固定句式
 * @param {string} [request.detail] 正文预览；空则不显示正文区
 * @param {number} [request.timeoutMs] 等待上限，缺省 60 秒
 * @param {AbortSignal} [request.signal] 调用方取消
 * @returns {Promise<{allowed: boolean, reason: string}>} reason 便于记录
 */
export async function confirm(request) {
  const platform = detectPlatform()
  const title = request.title ?? 'Relay'
  const message = request.message ?? ''
  const detail = clipDetail(request.detail ?? '')
  const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : DEFAULT_TIMEOUT_MS

  if (platform === 'win32' || platform === 'wsl') {
    return runWindows(title, message, detail, timeoutMs, request.signal)
  }
  return runPosix(platform, title, message, detail, timeoutMs, request.signal)
}

export { detectPlatform }
