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
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 60_000

/** 塞进系统窗口的正文上限，避免命令过长；超出部分在窗口里也读不过来。 */
const DETAIL_LIMIT = 4000

/** 弹窗用的图标：Windows 吃 .ico，其它平台用 .png。 */
const ICON_ICO = fileURLToPath(new URL('./icon.ico', import.meta.url))
const ICON_PNG = fileURLToPath(new URL('./icon.png', import.meta.url))

/**
 * 给对话框算一个它能读懂的图标路径。
 *
 * 纯 Windows 直接用包里的路径。WSL 下插件跑在 Linux、弹窗由 Windows 进程渲染，
 * 必须换成 \\wsl.localhost\<发行版>\... 这种共享路径才读得到。
 * 拿不到发行版名就返回 undefined，图标缺席不影响弹窗。
 */
/** WSL 下把 Linux 路径换成 Windows 进程读得到的共享路径；取不到发行版名就放弃。 */
function windowsReadable(file) {
  const distro = process.env.WSL_DISTRO_NAME
  if (typeof distro !== 'string' || distro === '') return undefined
  return '\\\\wsl.localhost\\' + distro + file.replaceAll('/', '\\')
}

function dialogIcon(platform) {
  if (platform === 'win32') return ICON_ICO
  if (platform === 'wsl') return windowsReadable(ICON_ICO)
  return ICON_PNG
}

/** 标题栏里的大图标。POSIX 对话框没有这个位置，返回 undefined。 */
function dialogLogo(platform) {
  if (platform === 'win32') return ICON_PNG
  if (platform === 'wsl') return windowsReadable(ICON_PNG)
  return undefined
}

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
function windowsScript(title, message, detail, iconPath, logoPath) {
  const hasDetail = detail !== ''
  const width = 420
  const barHeight = 56
  const headerY = barHeight + 14
  const headerHeight = hasDetail ? 46 : 44
  const textY = headerY + headerHeight
  const textHeight = 62
  const buttonHeight = 34
  const bottomPad = 16
  const baseHeight = hasDetail
    ? textY + textHeight + 14 + buttonHeight + bottomPad
    : headerY + headerHeight + 12 + buttonHeight + bottomPad
  const buttonY = baseHeight - bottomPad - buttonHeight
  const buttonsTop = bottomPad + buttonHeight

  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$ink = [System.Drawing.ColorTranslator]::FromHtml('#111827')`,
    `$muted = [System.Drawing.ColorTranslator]::FromHtml('#6B7280')`,
    `$line = [System.Drawing.ColorTranslator]::FromHtml('#E5E7EB')`,
    `$field = [System.Drawing.ColorTranslator]::FromHtml('#F3F4F6')`,
    `$accent = [System.Drawing.ColorTranslator]::FromHtml('#2563EB')`,
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = ${powerShellString(title)}`,
    '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
    '$form.TopMost = $true',
    '$form.ShowInTaskbar = $true',
    '$form.BackColor = [System.Drawing.Color]::White',
    '$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)',
    // 展开动画逐帧改尺寸，不双缓冲会闪
    '$flags = [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic',
    '$buffered = [System.Windows.Forms.Form].GetProperty("DoubleBuffered", $flags)',
    'if ($null -ne $buffered) { $buffered.SetValue($form, $true) }',
    `$form.ClientSize = New-Object System.Drawing.Size(${width}, ${baseHeight})`,
    '$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$form.Left = $area.Right - $form.Width - 24',
    '$form.Top = $area.Bottom - $form.Height - 24',
    // 圆角窗口：WinForms 没有原生圆角，裁一个圆角 Region；尺寸变了要重算
    'function Set-Rounded {',
    '  $p = New-Object System.Drawing.Drawing2D.GraphicsPath',
    '  $r = 12; $w = $form.ClientSize.Width; $h = $form.ClientSize.Height',
    '  $p.AddArc(0, 0, $r * 2, $r * 2, 180, 90)',
    '  $p.AddArc($w - $r * 2, 0, $r * 2, $r * 2, 270, 90)',
    '  $p.AddArc($w - $r * 2, $h - $r * 2, $r * 2, $r * 2, 0, 90)',
    '  $p.AddArc(0, $h - $r * 2, $r * 2, $r * 2, 90, 90)',
    '  $p.CloseFigure()',
    '  $form.Region = New-Object System.Drawing.Region($p)',
    '  $p.Dispose()',
    '}',
    'Set-Rounded',
    // 统一的高度变更入口：文本框、按钮、圆角、贴底一次改完
    'function Set-Height([int]$h) {',
    '  $form.SuspendLayout()',
    `  $form.ClientSize = New-Object System.Drawing.Size(${width}, $h)`,
    `  $text.Height = $h - ${textY} - ${buttonsTop + 14}`,
    `  $allow.Top = $h - ${buttonsTop}`,
    '  $deny.Top = $allow.Top',
    '  $expand.Top = $allow.Top',
    '  $form.ResumeLayout($true)',
    '  Set-Rounded',
    '  $form.Top = $area.Bottom - $form.Height - 24',
    '}',
    // 标题栏：无边框窗口自己提供拖动和关闭
    '$bar = New-Object System.Windows.Forms.Panel',
    `$bar.SetBounds(0, 0, ${width}, ${barHeight})`,
    '$bar.BackColor = [System.Drawing.Color]::White',
    '$form.Controls.Add($bar)',
  ]

  if (typeof logoPath === 'string' && logoPath !== '') {
    lines.push(
      '$logo = New-Object System.Windows.Forms.PictureBox',
      '$logo.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom',
      '$logo.BackColor = [System.Drawing.Color]::White',
      `$logo.SetBounds(18, 12, 32, 32)`,
      `try { $logo.Image = [System.Drawing.Image]::FromFile(${powerShellString(logoPath)}) } catch { $logo.Visible = $false }`,
      '$bar.Controls.Add($logo)',
      '$titleX = 62',
    )
  } else {
    lines.push('$titleX = 18')
  }

  lines.push(
    '$titleLabel = New-Object System.Windows.Forms.Label',
    `$titleLabel.Text = ${powerShellString(title)}`,
    '$titleLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 11, [System.Drawing.FontStyle]::Bold)',
    '$titleLabel.ForeColor = $ink',
    '$titleLabel.BackColor = [System.Drawing.Color]::Transparent',
    '$titleLabel.SetBounds($titleX, 18, 260, 22)',
    '$bar.Controls.Add($titleLabel)',
    '$closeBtn = New-Object System.Windows.Forms.Button',
    "$closeBtn.Text = 'X'",
    '$closeBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat',
    '$closeBtn.FlatAppearance.BorderSize = 0',
    '$closeBtn.ForeColor = $muted',
    '$closeBtn.BackColor = [System.Drawing.Color]::White',
    '$closeBtn.TabStop = $false',
    `$closeBtn.SetBounds(${width} - 44, 16, 30, 26)`,
    '$closeBtn.Add_Click({ $script:answer = 1; $form.Close() })',
    '$bar.Controls.Add($closeBtn)',
    '$script:drag = $false',
    '$bar.Add_MouseDown({ param($s, $e) $script:drag = $true; $script:dragX = $e.X; $script:dragY = $e.Y })',
    '$titleLabel.Add_MouseDown({ param($s, $e) $script:drag = $true; $script:dragX = $e.X; $script:dragY = $e.Y })',
    '$bar.Add_MouseMove({ param($s, $e) if ($script:drag) { $form.Left += $e.X - $script:dragX; $form.Top += $e.Y - $script:dragY } })',
    '$titleLabel.Add_MouseMove({ param($s, $e) if ($script:drag) { $form.Left += $e.X - $script:dragX; $form.Top += $e.Y - $script:dragY } })',
    '$bar.Add_MouseUp({ param($s, $e) $script:drag = $false })',
    '$titleLabel.Add_MouseUp({ param($s, $e) $script:drag = $false })',
    '$divider = New-Object System.Windows.Forms.Panel',
    `$divider.SetBounds(0, ${barHeight}, ${width}, 1)`,
    '$divider.BackColor = $line',
    '$form.Controls.Add($divider)',
    // 来源名放最前：先看到"谁在问"，再决定
    '$header = New-Object System.Windows.Forms.Label',
    `$header.Text = ${powerShellString(message)}`,
    '$header.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)',
    '$header.ForeColor = $ink',
    '$header.BackColor = [System.Drawing.Color]::Transparent',
    `$header.SetBounds(18, ${headerY}, ${width - 36}, ${headerHeight})`,
    '$form.Controls.Add($header)',
  )

  if (typeof iconPath === 'string' && iconPath !== '') {
    // 任务栏图标；加载失败不该让弹窗打不开
    lines.push(`try { $form.Icon = New-Object System.Drawing.Icon(${powerShellString(iconPath)}) } catch { }`)
  }

  if (hasDetail) {
    lines.push(
      '$text = New-Object System.Windows.Forms.TextBox',
      '$text.Multiline = $true',
      '$text.ReadOnly = $true',
      '$text.WordWrap = $true',
      '$text.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical',
      '$text.BorderStyle = [System.Windows.Forms.BorderStyle]::None',
      '$text.BackColor = $field',
      '$text.ForeColor = $muted',
      `$text.Text = ${powerShellString(detail)}`,
      `$text.SetBounds(18, ${textY}, ${width - 36}, ${textHeight})`,
      '$form.Controls.Add($text)',
      '$expand = New-Object System.Windows.Forms.Button',
      "$expand.Text = '展开全文'",
      '$expand.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat',
      '$expand.FlatAppearance.BorderSize = 1',
      '$expand.FlatAppearance.BorderColor = $line',
      '$expand.ForeColor = $muted',
      '$expand.BackColor = [System.Drawing.Color]::White',
      `$expand.SetBounds(18, ${buttonY}, 96, ${buttonHeight})`,
      '$form.Controls.Add($expand)',
      '$script:expanded = $false',
      '$expand.Add_Click({',
      '  if (-not $script:expanded) {',
      '    # 展开有上限：最多到屏幕工作区的 60%，再长就靠文本框自己滚',
      '    $cap = [int]($area.Height * 0.6)',
      `    $target = [Math]::Max(${baseHeight}, [Math]::Min($cap, $area.Height - 120))`,
      '    $script:expanded = $true',
      "    $expand.Text = '收起'",
      '  } else {',
      `    $target = ${baseHeight}`,
      '    $script:expanded = $false',
      "    $expand.Text = '展开全文'",
      '  }',
      '  Set-Height $target',
      '})',
    )
  }

  lines.push(
    '$deny = New-Object System.Windows.Forms.Button',
    "$deny.Text = '拒绝'",
    '$deny.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat',
    '$deny.FlatAppearance.BorderSize = 1',
    '$deny.FlatAppearance.BorderColor = $line',
    '$deny.ForeColor = $ink',
    '$deny.BackColor = [System.Drawing.Color]::White',
    `$deny.SetBounds(${width} - 186, ${buttonY}, 78, ${buttonHeight})`,
    '$deny.Add_Click({ $script:answer = 1; $form.Close() })',
    '$form.Controls.Add($deny)',
    '$allow = New-Object System.Windows.Forms.Button',
    "$allow.Text = '允许'",
    '$allow.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat',
    '$allow.FlatAppearance.BorderSize = 0',
    '$allow.ForeColor = [System.Drawing.Color]::White',
    '$allow.BackColor = $accent',
    `$allow.SetBounds(${width} - 98, ${buttonY}, 78, ${buttonHeight})`,
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

async function runWindows(title, message, detail, timeoutMs, signal, iconPath, logoPath) {
  // 走 -EncodedCommand：脚本以 UTF-16LE 传进去，绕开控制台代码页。
  // 中文如果直接放在命令行或 ANSI 脚本里，PowerShell 会按系统代码页解码成乱码。
  const encoded = Buffer.from(windowsScript(title, message, detail, iconPath, logoPath), 'utf16le').toString('base64')
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

async function runPosix(platform, title, message, detail, timeoutMs, signal, iconPath) {
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
    ...(typeof iconPath === 'string' ? [`--window-icon=${iconPath}`] : []),
  ], timeoutMs, signal)

  if (answer.missing) {
    const fallback = await run('kdialog', [
      '--title', title, '--yesno', text, '--yes-label', '允许', '--no-label', '拒绝',
      ...(typeof iconPath === 'string' ? ['--icon', iconPath] : []),
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

  const iconPath = dialogIcon(platform)
  const logoPath = dialogLogo(platform)
  if (platform === 'win32' || platform === 'wsl') {
    return runWindows(title, message, detail, timeoutMs, request.signal, iconPath, logoPath)
  }
  return runPosix(platform, title, message, detail, timeoutMs, request.signal, iconPath)
}

export { detectPlatform }
