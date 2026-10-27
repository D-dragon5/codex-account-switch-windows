[CmdletBinding()]
param([string]$NodePath)

# Windows-only regression checks. No account credentials, proxy, network or
# real desktop shutdown is used. Every terminated process belongs to this test.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
}
$NodePath = [IO.Path]::GetFullPath($NodePath)
$helper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\windows-session.ps1'))
$probe = Join-Path $PSScriptRoot 'fixtures\win-worker-probe.cjs'
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-switch-win-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $runRoot 'home') | Out-Null

$parseTokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($helper, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'HELPER_PARSE_FAILED' }
# Load declarations, never the helper's action-dispatch entry point.
foreach ($definition in $ast.FindAll({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
    Invoke-Expression $definition.Extent.Text
}
$snapshotDefinition = (Get-Item Function:\Get-ProcessSnapshot).ScriptBlock
$owned = @(); $passed = @(); $job = [IntPtr]::Zero; $parent = $null

function Assert-Test([bool]$Condition, [string]$Code) { if (-not $Condition) { throw $Code } }
function Read-TestJson([string]$File, [int]$TimeoutSeconds = 15) {
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-Path -LiteralPath $File) {
            try { return (Get-Content -LiteralPath $File -Raw | ConvertFrom-Json) } catch { }
        }
        Start-Sleep -Milliseconds 50
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'TEST_MARKER_TIMEOUT'
}
function New-OwnedSleeper {
    $jobFile = Join-Path $runRoot 'sleep-job.json'
    '{"role":"sleep"}' | Set-Content -LiteralPath $jobFile -Encoding utf8
    $process = Start-Process -FilePath $NodePath -ArgumentList ('"' + $probe + '" worker "' + $jobFile + '"') -WindowStyle Hidden -PassThru
    $script:owned += ,$process
    $record = @(Get-ProcessSnapshot | Where-Object { [int]$_.pid -eq $process.Id })
    Assert-Test ($record.Count -eq 1) 'TEST_CHILD_NOT_CAPTURED'
    return [pscustomobject]@{process = $process; record = $record[0]}
}

try {
    $child = New-OwnedSleeper
    Assert-Test ((Invoke-ExactProcessAction $child.record 'Stop') -and $child.process.WaitForExit(5000)) 'EXACT_PROCESS_STOP_FAILED'
    $passed += 'exact-process-stop'

    $child = New-OwnedSleeper
    $mismatch = [pscustomobject]@{pid = $child.record.pid; path = $child.record.path; createdAt = '2000-01-01T00:00:00.0000000Z'}
    Assert-Test (-not (Invoke-ExactProcessAction $mismatch 'Stop') -and -not $child.process.HasExited) 'IDENTITY_MISMATCH_WAS_STOPPED'
    $passed += 'identity-mismatch-preserved'
    $child.process.Kill(); [void]$child.process.WaitForExit(5000)

    $child = New-OwnedSleeper
    $child.process.Kill(); [void]$child.process.WaitForExit(5000)
    Assert-Test (-not (Invoke-ExactProcessAction $child.record 'Stop')) 'ALREADY_EXITED_PROCESS_REJECTED'
    $passed += 'already-exited-tolerated'

    $child = New-OwnedSleeper
    $script:racingProcess = $child.process; $script:staleRecord = $child.record
    function Get-ProcessSnapshot {
        $script:racingProcess.Kill(); [void]$script:racingProcess.WaitForExit(5000)
        return $script:staleRecord
    }
    Assert-Test (-not (Invoke-ExactProcessAction $child.record 'Stop') -and $child.process.HasExited) 'EXIT_DURING_RECHECK_REJECTED'
    Set-Item Function:\Get-ProcessSnapshot -Value $snapshotDefinition
    $passed += 'exit-during-revalidation-tolerated'

    Assert-Test (Test-DesktopFullyExited @([pscustomobject]@{name = 'node.exe'})) 'DESKTOP_EXIT_PREDICATE_FAILED'
    foreach ($name in @('ChatGPT.exe', 'codex.exe')) {
        Assert-Test (-not (Test-DesktopFullyExited @([pscustomobject]@{name = $name; path = $null}))) 'UNKNOWN_ACCOUNT_PROCESS_IGNORED'
    }
    $passed += 'unknown-account-process-blocks-exit-confirmation'

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AccountSwitchTestJob {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
    $job = [AccountSwitchTestJob]::CreateJobObject([IntPtr]::Zero, $null)
    Assert-Test ($job -ne [IntPtr]::Zero) 'TEST_JOB_CREATE_FAILED'
    '{"role":"old"}' | Set-Content -LiteralPath (Join-Path $runRoot 'old-job.json') -Encoding utf8
    '{"role":"new"}' | Set-Content -LiteralPath (Join-Path $runRoot 'new-job.json') -Encoding utf8
    $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $parentFixture = Join-Path $PSScriptRoot 'fixtures\win-launch-parent.ps1'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $parentFixture + '" -Directory "' + $runRoot + '" -NodePath "' + $NodePath + '" -HelperPath "' + $helper + '"'
    $parent = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Assert-Test ([AccountSwitchTestJob]::AssignProcessToJobObject($job, $parent.Handle)) 'TEST_JOB_ASSIGN_FAILED'
    'start' | Set-Content -LiteralPath (Join-Path $runRoot 'start.txt') -Encoding ascii
    $launched = Read-TestJson (Join-Path $runRoot 'launched.json')
    $oldReady = Read-TestJson (Join-Path $runRoot 'old-ready.json')
    $newReady = Read-TestJson (Join-Path $runRoot 'new-ready.json')
    Assert-Test ($oldReady.pid -eq $launched.oldPid -and $newReady.pid -eq $launched.newPid) 'TEST_PID_MARKER_MISMATCH'
    $oldProcess = Get-Process -Id $launched.oldPid
    $newProcess = Get-Process -Id $launched.newPid
    $owned += ,$oldProcess; $owned += ,$newProcess
    Assert-Test ($oldProcess.Path -ieq $NodePath -and $newProcess.Path -ieq $NodePath) 'TEST_PROCESS_PATH_MISMATCH'
    $oldInJob = $false; $newInJob = $false
    Assert-Test ([AccountSwitchTestJob]::IsProcessInJob($oldProcess.Handle, $job, [ref]$oldInJob)) 'OLD_JOB_QUERY_FAILED'
    Assert-Test ([AccountSwitchTestJob]::IsProcessInJob($newProcess.Handle, $job, [ref]$newInJob)) 'NEW_JOB_QUERY_FAILED'
    Assert-Test ($oldInJob -and -not $newInJob -and $launched.jobIsolated) 'WORKER_INHERITED_CALLER_JOB'
    $passed += 'real-launchworker-independent-from-caller-job'
    Assert-Test ($newReady.codexHome -ieq (Join-Path $runRoot 'home')) 'WORKER_HOME_MISMATCH'
    Assert-Test (-not $newReady.apiKeyInherited -and -not $newReady.nodeOptionsInherited -and -not $newReady.sessionMarkerInherited) 'WORKER_ENVIRONMENT_NOT_FILTERED'
    $passed += 'worker-home-and-environment-filtering'
    Assert-Test ($newProcess.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId) 'WORKER_SESSION_MISMATCH'
    $workerCim = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $newProcess.Id)
    $owner = Invoke-CimMethod -InputObject $workerCim -MethodName GetOwnerSid
    Assert-Test ($owner.ReturnValue -eq 0 -and $owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'WORKER_USER_MISMATCH'
    $passed += 'worker-current-user-and-session'
    Assert-Test ([AccountSwitchTestJob]::TerminateJobObject($job, 0)) 'TEST_JOB_TERMINATION_FAILED'
    Assert-Test ($parent.WaitForExit(5000) -and $oldProcess.WaitForExit(5000)) 'CALLER_JOB_DID_NOT_EXIT'
    'release' | Set-Content -LiteralPath (Join-Path $runRoot 'release.txt') -Encoding ascii
    $finished = Read-TestJson (Join-Path $runRoot 'new-finished.json') 5
    Assert-Test ($finished.completed -and -not (Test-Path -LiteralPath (Join-Path $runRoot 'old-finished.json'))) 'WORKER_DID_NOT_SURVIVE_CALLER_EXIT'
    Assert-Test ($newProcess.WaitForExit(5000)) 'WORKER_DID_NOT_FINISH'
    $passed += 'worker-completes-after-caller-job-termination'
    [ordered]@{ok = $true; tests = $passed; count = $passed.Count; realDesktopTouched = $false; credentialsRead = $false; networkUsed = $false} | ConvertTo-Json -Depth 3
} finally {
    if ($job -ne [IntPtr]::Zero) {
        [void][AccountSwitchTestJob]::TerminateJobObject($job, 0)
        [void][AccountSwitchTestJob]::CloseHandle($job)
    }
    if ($parent) {
        try { if (-not $parent.HasExited) { $parent.Kill(); [void]$parent.WaitForExit(5000) } } catch { }
        $parent.Dispose()
    }
    foreach ($process in $owned) {
        try { if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) } } catch { }
        $process.Dispose()
    }
    $fullRoot = [IO.Path]::GetFullPath($runRoot).TrimEnd('\')
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($fullRoot) -ine $tempRoot -or [IO.Path]::GetFileName($fullRoot) -notmatch '^codex-switch-win-test-[a-f0-9]{32}$') {
        throw 'UNSAFE_TEST_DIRECTORY_CLEANUP'
    }
    Remove-Item -LiteralPath $fullRoot -Recurse -Force
}
