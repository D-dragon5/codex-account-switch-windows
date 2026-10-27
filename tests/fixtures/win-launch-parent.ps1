[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$HelperPath
)

$ErrorActionPreference = 'Stop'
$deadline = [datetime]::UtcNow.AddSeconds(15)
while (-not (Test-Path -LiteralPath (Join-Path $Directory 'start.txt'))) {
    if ([datetime]::UtcNow -gt $deadline) { throw 'TEST_PARENT_NOT_ASSIGNED' }
    Start-Sleep -Milliseconds 25
}

# Values are deliberately synthetic and exist only in this test process.
$env:OPENAI_API_KEY = 'synthetic-test-value'
$env:NODE_OPTIONS = '--no-warnings'
$env:CODEX_TEST_SESSION_MARKER = 'synthetic-test-marker'
$probe = Join-Path $PSScriptRoot 'win-worker-probe.cjs'
$oldJob = Join-Path $Directory 'old-job.json'
$old = Start-Process -FilePath $NodePath -ArgumentList ('"' + $probe + '" worker "' + $oldJob + '"') -WindowStyle Hidden -PassThru
$exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$createdJson = & $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $HelperPath `
    -Action LaunchWorker -NodePath $NodePath -WorkerPath $probe `
    -JobPath (Join-Path $Directory 'new-job.json') -CodexHome (Join-Path $Directory 'home')
if ($LASTEXITCODE -ne 0) { throw 'TEST_WORKER_LAUNCH_FAILED' }
$created = $createdJson | ConvertFrom-Json
if (-not $created.ok -or -not $created.jobIsolated) { throw 'TEST_WORKER_NOT_ISOLATED' }
[ordered]@{oldPid = $old.Id; newPid = $created.pid; jobIsolated = $created.jobIsolated} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'launched.json') -Encoding utf8
Start-Sleep -Seconds 25
