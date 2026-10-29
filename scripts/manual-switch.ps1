param(
  [ValidateSet('pro', 'plus')]
  [string]$Target,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillRoot = Split-Path -Parent $scriptRoot
$switchScript = Join-Path $scriptRoot 'switch-account.cjs'
$configPath = Join-Path $skillRoot 'config.json'

if (-not (Test-Path -LiteralPath $switchScript -PathType Leaf)) {
  throw "找不到切换脚本：$switchScript"
}

$nodePath = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  try {
    $configured = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($configured.nodePath) { $nodePath = [string]$configured.nodePath }
  } catch {
    $nodePath = $null
  }
}
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) { $nodePath = $nodeCommand.Source }
}
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw '找不到 Node.js 24+。请先安装 Node.js，或在本机 config.json 中填写 nodePath。'
}

function Invoke-SwitchNode {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & $nodePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "切换命令失败，退出码：$LASTEXITCODE"
  }
}

if (-not $Target) {
  Write-Host ''
  Write-Host 'Codex 账号切换' -ForegroundColor Cyan
  Write-Host '1. 切换到 Plus'
  Write-Host '2. 切换到 Pro'
  Write-Host 'Q. 退出'
  $choice = (Read-Host '请选择').Trim().ToLowerInvariant()
  switch ($choice) {
    '1' { $Target = 'plus' }
    '2' { $Target = 'pro' }
    'q' { exit 0 }
    default { throw '无效选择，请重新双击桌面快捷方式运行。' }
  }
}

# 手动启动没有调用方轮次，底层活动检查会要求本机聊天全部空闲。
$env:CODEX_THREAD_ID = $null
$env:CODEX_TURN_ID = $null

Write-Host ''
Write-Host '当前状态：' -ForegroundColor DarkCyan
Invoke-SwitchNode @($switchScript, 'status')
Write-Host "`n目标预检：$Target" -ForegroundColor DarkCyan
Invoke-SwitchNode @($switchScript, 'plan', $Target)

if ($CheckOnly) {
  Write-Host "`n预检完成，未执行切换。" -ForegroundColor Green
  exit 0
}

Write-Host "`n开始切换到 $Target；Codex 会自动退出并重新打开。" -ForegroundColor Yellow
Invoke-SwitchNode @($switchScript, 'switch', $Target, '--execute')
Write-Host "`n已提交后台切换任务。关闭此窗口不会中断后续步骤。" -ForegroundColor Green
Read-Host '按回车退出'
