[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Discover', 'LaunchWorker', 'StopDesktop', 'DesktopState', 'StartDesktop', 'SetPrivateAcl')]
    [string]$Action,
    [string]$NodePath,
    [string]$WorkerPath,
    [string]$JobPath,
    [string]$CodexHome,
    [string]$ManifestPath,
    [int[]]$RootIds,
    [string[]]$RootPaths,
    [int[]]$PreserveProcessIds = @(),
    [string]$DesktopPath,
    [string]$ProxyUrl,
    [ValidateRange(0,60)]
    [double]$CloseGraceSeconds = 5,
    [string]$FilePath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$shutdownAttempted = $false
$operationPhase = 'initializing'

function Write-Result([object]$Value) {
    $Value | ConvertTo-Json -Depth 12 -Compress
}

function Get-NormalPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    if (-not [IO.Path]::IsPathRooted($Value)) { throw 'An absolute file path is required.' }
    return [IO.Path]::GetFullPath($Value).TrimEnd('\')
}

function Test-DesktopPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $normal = (Get-NormalPath $Value).Replace('/', '\')
    if ($normal -match '\\bin\\') { return $false }
    return (
        $normal -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$' -or
        $normal -match '\\AppData\\Local\\OpenAI\\Codex\\(?:[^\\]+\\)*(?:ChatGPT|Codex)\.exe$'
    )
}

function Get-ProcessSnapshot {
    $records = @()
    foreach ($proc in @(Get-CimInstance -ClassName Win32_Process)) {
        $created = $null
        if ($proc.CreationDate) { $created = ([datetime]$proc.CreationDate).ToUniversalTime().ToString('o') }
        $records += [pscustomobject]@{
            pid = [int]$proc.ProcessId
            parentPid = [int]$proc.ParentProcessId
            name = [string]$proc.Name
            path = [string]$proc.ExecutablePath
            createdAt = $created
        }
    }
    return $records
}

function Get-RecordMap([object[]]$Records) {
    $map = @{}
    foreach ($record in $Records) { $map[[int]$record.pid] = $record }
    return $map
}

function Test-DesktopFullyExited([object[]]$Snapshot) {
    # Unknown paths are still counted. A closing error is benign only when no
    # desktop or account engine process remains at all.
    return @($Snapshot | Where-Object { $_.name -match '^(?:ChatGPT|Codex)\.exe$' }).Count -eq 0
}

function Test-SameInstance([object]$Expected, [object]$Actual) {
    if (-not $Expected -or -not $Actual) { return $false }
    if ([int]$Expected.pid -ne [int]$Actual.pid) { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$Expected.createdAt) -or
        [string]::IsNullOrWhiteSpace([string]$Actual.createdAt)) { return $false }
    if ([string]$Expected.createdAt -cne [string]$Actual.createdAt) { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$Expected.path) -or
        [string]::IsNullOrWhiteSpace([string]$Actual.path)) { return $false }
    return (Get-NormalPath ([string]$Expected.path)) -ieq (Get-NormalPath ([string]$Actual.path))
}

function Invoke-ExactProcessAction([object]$Expected, [ValidateSet('CloseWindow', 'Stop')][string]$Mode) {
    $handle = Get-Process -Id ([int]$Expected.pid) -ErrorAction SilentlyContinue
    if (-not $handle) { return $false }
    try {
        # Pin the process before revalidating its identity. Kill() uses this
        # handle, so a recycled PID cannot redirect the shutdown operation.
        [void]$handle.Handle
        $current = @(Get-ProcessSnapshot | Where-Object { [int]$_.pid -eq [int]$Expected.pid } | Select-Object -First 1)
        if ($current.Count -eq 0 -or -not (Test-SameInstance $Expected $current[0])) { return $false }
        if ($Mode -eq 'CloseWindow') { return $handle.CloseMainWindow() }
        $handle.Kill()
        return $true
    } catch {
        # Electron children and engines can exit together after a close/kill.
        # An already-exited exact process is a successful shutdown condition.
        if ($handle.HasExited) { return $false }
        throw
    } finally { $handle.Dispose() }
}

function Get-Tree([object[]]$Records, [int[]]$SeedIds) {
    $selected = @{}
    foreach ($seed in $SeedIds) { $selected[[int]$seed] = $true }
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($record in $Records) {
            if (-not $selected.ContainsKey([int]$record.pid) -and $selected.ContainsKey([int]$record.parentPid)) {
                $selected[[int]$record.pid] = $true
                $changed = $true
            }
        }
    }
    return @($Records | Where-Object { $selected.ContainsKey([int]$_.pid) })
}

function Get-ProtectedIds([object[]]$Snapshot) {
    $protected = @{}
    foreach ($item in @($PreserveProcessIds) + @($PID)) { $protected[[int]$item] = $true }
    # The detached Node worker and its immediate shell helpers must survive. Stop
    # climbing at the Codex engine or desktop; those must exit for auth to reload.
    $map = Get-RecordMap $Snapshot
    $cursor = $PID
    while ($map.ContainsKey([int]$cursor)) {
        $parent = $map[[int]$cursor].parentPid
        if (-not $map.ContainsKey([int]$parent)) { break }
        $record = $map[[int]$parent]
        if ($record.name -notmatch '^(?:node|powershell|pwsh)\.exe$') { break }
        $protected[[int]$parent] = $true
        $cursor = [int]$parent
    }
    return $protected
}

function Assert-NoStandaloneCli([object[]]$Snapshot, [object[]]$Tree, [hashtable]$Protected) {
    $treeIds = @{}
    foreach ($item in $Tree) { $treeIds[[int]$item.pid] = $true }
    $external = @($Snapshot | Where-Object {
        $_.name -ieq 'codex.exe' -and -not (Test-DesktopPath $_.path) -and
        -not $treeIds.ContainsKey([int]$_.pid) -and -not $Protected.ContainsKey([int]$_.pid)
    })
    if ($external.Count -gt 0) { throw 'Standalone Codex CLI processes are running; close them before switching accounts.' }
}

function Get-ValidatedTargets([object]$Manifest, [object[]]$Snapshot, [hashtable]$Protected) {
    $map = Get-RecordMap $Snapshot
    $seeds = @()
    foreach ($root in @($Manifest.roots)) {
        if ($map.ContainsKey([int]$root.pid)) {
            if (-not (Test-SameInstance $root $map[[int]$root.pid])) { throw 'A captured desktop root changed identity; no process was stopped.' }
            $seeds += [int]$root.pid
        }
    }
    foreach ($old in @($Manifest.processes)) {
        if ($map.ContainsKey([int]$old.pid) -and (Test-SameInstance $old $map[[int]$old.pid])) {
            $seeds += [int]$old.pid
        }
    }
    $tree = @(Get-Tree $Snapshot $seeds)
    Assert-NoStandaloneCli $Snapshot $tree $Protected
    foreach ($record in $tree) {
        if ($record.name -match '^(?:ChatGPT|Codex)\.exe$' -and
            ([string]::IsNullOrWhiteSpace($record.path) -or [string]::IsNullOrWhiteSpace($record.createdAt))) {
            throw 'A desktop descendant cannot be identified safely; no forced shutdown was performed.'
        }
    }
    # Ancestry is used only to establish ownership. A desktop task may have
    # opened a browser, document editor, shell, or Node job; never kill those.
    # Only the recognized desktop executables and exact codex.exe engines hold
    # the account session this helper is authorized to close.
    $targets = @($tree | Where-Object {
        -not $Protected.ContainsKey([int]$_.pid) -and
        ((Test-DesktopPath $_.path) -or $_.name -ieq 'codex.exe')
    })
    foreach ($record in $targets) {
        if ([string]::IsNullOrWhiteSpace($record.path) -or [string]::IsNullOrWhiteSpace($record.createdAt)) {
            throw 'A desktop descendant cannot be identified safely; no forced shutdown was performed.'
        }
    }
    return $targets
}

function Assert-ExistingFile([string]$Value) {
    $normal = Get-NormalPath $Value
    $item = Get-Item -LiteralPath $normal -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A regular existing file is required.'
    }
    return $normal
}

function Quote-ProcessArgument([string]$Value) {
    # Windows command-line quoting: double backslashes before quotes/end quote.
    if ($null -eq $Value) { return '""' }
    return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}

function Get-WorkerEnvironment([string]$HomePath) {
    $homePathNormal = Get-NormalPath $HomePath
    if (-not $homePathNormal -or -not (Test-Path -LiteralPath $homePathNormal -PathType Container)) {
        throw 'WORKER_HOME_INVALID'
    }
    # Keep only normal Windows process settings. In particular, API keys,
    # CODEX_* session associations and Node options must not cross this boundary.
    $names = @('SystemRoot', 'SystemDrive', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
        'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC', 'PROGRAMDATA',
        'ALLUSERSPROFILE', 'USERNAME', 'USERDOMAIN', 'PUBLIC', 'OS', 'SESSIONNAME',
        'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
        'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'ProgramFiles', 'ProgramFiles(x86)',
        'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432')
    $entries = @()
    foreach ($name in $names) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrEmpty($value)) { $entries += $name + '=' + $value }
    }
    return @($entries) + @('CODEX_HOME=' + $homePathNormal)
}

function Test-WorkerJobIsolation([int]$ProcessId) {
    if (-not ('CodexWorkerProcessIsolation' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexWorkerProcessIsolation {
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job,
        [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    public static int JobState(int processId) {
        IntPtr handle = OpenProcess(0x1000, false, processId);
        if (handle == IntPtr.Zero) return -1;
        try {
            bool inJob;
            if (!IsProcessInJob(handle, IntPtr.Zero, out inJob)) return -1;
            return inJob ? 1 : 0;
        } finally { CloseHandle(handle); }
    }
}
'@
    }
    $state = [CodexWorkerProcessIsolation]::JobState($ProcessId)
    if ($state -lt 0) { throw 'WORKER_ISOLATION_UNAVAILABLE' }
    return $state -eq 0
}

try {
    switch ($Action) {
        'Discover' {
            $snapshot = @(Get-ProcessSnapshot)
            $desktop = @($snapshot | Where-Object {
                $_.name -match '^(?:ChatGPT|Codex)\.exe$' -and (Test-DesktopPath $_.path)
            })
            $desktopIds = @{}
            foreach ($item in $desktop) { $desktopIds[[int]$item.pid] = $true }
            $roots = @($desktop | Where-Object { -not $desktopIds.ContainsKey([int]$_.parentPid) })
            $tree = @(Get-Tree $snapshot @($roots | ForEach-Object { [int]$_.pid }))
            $treeIds = @{}
            foreach ($item in $tree) { $treeIds[[int]$item.pid] = $true }
            $cli = @($snapshot | Where-Object { $_.name -ieq 'codex.exe' -and -not (Test-DesktopPath $_.path) })
            $standalone = @($cli | Where-Object { -not $treeIds.ContainsKey([int]$_.pid) })
            $cliPaths = @($cli | Where-Object { $_.path } | ForEach-Object {
                [pscustomobject]@{ path = $_.path; exists = [bool](Test-Path -LiteralPath $_.path -PathType Leaf) }
            } | Sort-Object -Property path -Unique)
            Write-Result ([ordered]@{ ok = $true; roots = $roots; processes = $tree; standaloneCli = $standalone; cliPaths = $cliPaths; capturedAt = [datetime]::UtcNow.ToString('o') })
        }
        'LaunchWorker' {
            $node = Assert-ExistingFile $NodePath
            $worker = Assert-ExistingFile $WorkerPath
            $job = Assert-ExistingFile $JobPath
            $command = (Quote-ProcessArgument $node) + ' ' + (Quote-ProcessArgument $worker) + ' worker ' + (Quote-ProcessArgument $job)
            $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
                ShowWindow = [uint16]0
                # CREATE_BREAKAWAY_FROM_JOB | CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS
                CreateFlags = [uint32]0x01000408
                EnvironmentVariables = [string[]](Get-WorkerEnvironment $CodexHome)
            }
            # WMI is the independent parent. Never fall back to a process still
            # owned by the desktop's job when this launch or verification fails.
            $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
                CommandLine = $command
                CurrentDirectory = [IO.Path]::GetDirectoryName($worker)
                ProcessStartupInformation = $startup
            }
            if ($created.ReturnValue -ne 0 -or [int]$created.ProcessId -le 0) { throw 'WORKER_CREATE_FAILED' }
            $started = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$created.ProcessId)
            if (-not $started -or (Get-NormalPath ([string]$started.ExecutablePath)) -ine $node) {
                throw 'WORKER_IDENTITY_MISMATCH'
            }
            $owner = Invoke-CimMethod -InputObject $started -MethodName GetOwnerSid
            if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
                [int]$started.SessionId -ne [int](Get-Process -Id $PID).SessionId) {
                throw 'WORKER_IDENTITY_MISMATCH'
            }
            if (-not (Test-WorkerJobIsolation ([int]$started.ProcessId))) { throw 'WORKER_ISOLATION_FAILED' }
            Write-Result ([ordered]@{ ok = $true; pid = [int]$started.ProcessId; detached = $true; jobIsolated = $true })
        }
        'DesktopState' {
            $snapshot = @(Get-ProcessSnapshot)
            # Any unknown desktop or CLI also blocks a duplicate restart.
            $running = -not (Test-DesktopFullyExited $snapshot)
            Write-Result ([ordered]@{ ok = $true; desktopRunning = [bool]$running })
        }
        'StopDesktop' {
            $operationPhase = 'validating_manifest'
            $manifestFile = Assert-ExistingFile $ManifestPath
            try { $manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json } catch { throw 'Desktop manifest is invalid.' }
            if (-not $manifest.roots -or -not $manifest.processes) { throw 'Desktop manifest has no captured desktop tree.' }
            $manifestIds = @{}
            foreach ($root in @($manifest.roots)) {
                if ([int]$root.pid -le 0 -or -not (Test-DesktopPath ([string]$root.path)) -or -not $root.createdAt) {
                    throw 'Desktop manifest contains an invalid root.'
                }
                $manifestIds[[int]$root.pid] = $true
            }
            $validManifestTree = @(Get-Tree @($manifest.processes) @($manifest.roots | ForEach-Object { [int]$_.pid }))
            if ($validManifestTree.Count -ne @($manifest.processes).Count) { throw 'Desktop manifest contains unrelated processes.' }
            if ($RootIds) {
                $expected = @($RootIds | Sort-Object -Unique)
                $actual = @($manifest.roots | ForEach-Object { [int]$_.pid } | Sort-Object -Unique)
                if (@(Compare-Object $expected $actual).Count -ne 0) { throw 'Requested desktop roots do not match the manifest.' }
            }
            if ($RootPaths) {
                $expected = @($RootPaths | ForEach-Object { (Get-NormalPath $_).ToLowerInvariant() } | Sort-Object -Unique)
                $actual = @($manifest.roots | ForEach-Object { (Get-NormalPath $_.path).ToLowerInvariant() } | Sort-Object -Unique)
                if (@(Compare-Object $expected $actual).Count -ne 0) { throw 'Requested desktop paths do not match the manifest.' }
            }
            $operationPhase = 'validating_live_targets'
            $snapshot = @(Get-ProcessSnapshot)
            $protected = Get-ProtectedIds $snapshot
            $targets = @(Get-ValidatedTargets $manifest $snapshot $protected)
            foreach ($root in @($manifest.roots)) {
                if ($protected.ContainsKey([int]$root.pid)) { throw 'A preserved process is a desktop root; shutdown is unsafe.' }
                $current = @($snapshot | Where-Object { [int]$_.pid -eq [int]$root.pid } | Select-Object -First 1)
                if ($current.Count -gt 0 -and (Test-SameInstance $root $current[0])) {
                    $operationPhase = 'closing_window'
                    $shutdownAttempted = $true
                    [void](Invoke-ExactProcessAction $root 'CloseWindow')
                }
            }
            $deadline = [datetime]::UtcNow.AddSeconds($CloseGraceSeconds)
            $operationPhase = 'waiting_for_exit'
            do {
                Start-Sleep -Milliseconds 250
                $snapshot = @(Get-ProcessSnapshot)
                $targets = @(Get-ValidatedTargets $manifest $snapshot $protected)
            } while ($targets.Count -gt 0 -and [datetime]::UtcNow -lt $deadline)
            $stopped = @()
            # Stop children first. Recheck each exact process immediately before it
            # is stopped so PID reuse never grants shutdown of another process.
            $remaining = @($targets)
            $operationPhase = 'stopping_remaining_processes'
            while ($remaining.Count -gt 0) {
                $parentIds = @{}
                foreach ($record in $remaining) { $parentIds[[int]$record.parentPid] = $true }
                $leaves = @($remaining | Where-Object { -not $parentIds.ContainsKey([int]$_.pid) })
                if ($leaves.Count -eq 0) { throw 'Desktop process ancestry is inconsistent.' }
                foreach ($record in $leaves) {
                    $shutdownAttempted = $true
                    if (Invoke-ExactProcessAction $record 'Stop') {
                        $stopped += [int]$record.pid
                    }
                }
                $leafIds = @{}
                foreach ($record in $leaves) { $leafIds[[int]$record.pid] = $true }
                $remaining = @($remaining | Where-Object { -not $leafIds.ContainsKey([int]$_.pid) })
            }
            $operationPhase = 'confirming_desktop_exit'
            $left = @(Get-ValidatedTargets $manifest @(Get-ProcessSnapshot) $protected)
            if ($left.Count -gt 0) { throw 'Some captured desktop processes remain; credentials must not be replaced.' }
            # A relaunch can produce a new root outside the captured ancestry.
            # Do not chase or kill it: refuse the credential replacement instead.
            $finalSnapshot = @(Get-ProcessSnapshot)
            $residual = @($finalSnapshot | Where-Object {
                -not $protected.ContainsKey([int]$_.pid) -and
                ((Test-DesktopPath $_.path) -or $_.name -ieq 'codex.exe')
            })
            if ($residual.Count -gt 0) { throw 'Some captured desktop or newly started Codex processes remain; credentials must not be replaced.' }
            $unidentified = @($finalSnapshot | Where-Object {
                $_.name -match '^(?:ChatGPT|Codex)\.exe$' -and
                ([string]::IsNullOrWhiteSpace($_.path) -or [string]::IsNullOrWhiteSpace($_.createdAt))
            })
            if ($unidentified.Count -gt 0) { throw 'A desktop descendant or new root cannot be identified safely; credentials must not be replaced.' }
            Write-Result ([ordered]@{ ok = $true; stoppedPids = $stopped; desktopClosed = $true; shutdownAttempted = $shutdownAttempted })
        }
        'StartDesktop' {
            $desktop = Assert-ExistingFile $DesktopPath
            if (-not (Test-DesktopPath $desktop)) { throw 'The restart target is not a recognized Codex desktop executable.' }
            if (-not [string]::IsNullOrEmpty($ProxyUrl)) {
                $proxyMatch = [regex]::Match($ProxyUrl, '^http://127\.0\.0\.1:([0-9]{1,5})$')
                if (-not $proxyMatch.Success) { throw 'The restart proxy must be an HTTP loopback URL with a valid port.' }
                $proxyPort = [int]$proxyMatch.Groups[1].Value
                if ($proxyPort -lt 1 -or $proxyPort -gt 65535) { throw 'The restart proxy must be an HTTP loopback URL with a valid port.' }
                # Process-local overrides: the desktop and engines it launches
                # inherit these values; user/system environment is untouched.
                $env:HTTP_PROXY = $ProxyUrl
                $env:HTTPS_PROXY = $ProxyUrl
                $env:ALL_PROXY = $ProxyUrl
                $env:NO_PROXY = 'localhost,127.0.0.1,::1'
                $proxyArgument = Quote-ProcessArgument ('--proxy-server=' + $ProxyUrl)
                $started = Start-Process -FilePath $desktop -ArgumentList $proxyArgument -WorkingDirectory ([IO.Path]::GetDirectoryName($desktop)) -PassThru
            } else {
                $started = Start-Process -FilePath $desktop -WorkingDirectory ([IO.Path]::GetDirectoryName($desktop)) -PassThru
            }
            Write-Result ([ordered]@{ ok = $true; pid = [int]$started.Id; started = $true; proxyApplied = -not [string]::IsNullOrEmpty($ProxyUrl) })
        }
        'SetPrivateAcl' {
            $target = Assert-ExistingFile $FilePath
            $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl = New-Object Security.AccessControl.FileSecurity
            $acl.SetAccessRuleProtection($true, $false)
            # Keep the existing owner. Setting owner even to the same SID needs
            # WRITE_OWNER, while the owner already has the right to set the DACL.
            foreach ($allowedSid in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
                $rule = New-Object Security.AccessControl.FileSystemAccessRule($allowedSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
                $acl.AddAccessRule($rule)
            }
            # Use Framework ACL APIs directly: this helper runs under Windows
            # PowerShell 5.1 even when its parent uses a PowerShell 7 module path.
            [IO.File]::SetAccessControl($target, $acl)
            $actual = [IO.File]::GetAccessControl($target)
            $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
            $unexpected = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed })
            if (-not $actual.AreAccessRulesProtected -or $unexpected.Count -ne 0) { throw 'Private credential-file permissions could not be verified.' }
            Write-Result ([ordered]@{ ok = $true; privatePermissions = $true })
        }
    }
    exit 0
} catch {
    $helperFailure = $_
    if ($Action -eq 'StopDesktop' -and $shutdownAttempted) {
        try {
            if (Test-DesktopFullyExited @(Get-ProcessSnapshot)) {
                Write-Result ([ordered]@{ ok = $true; desktopClosed = $true;
                    shutdownAttempted = $true; verifiedAfterClosingError = $true })
                exit 0
            }
        } catch { # An uncertain snapshot must retain the original failure.
        }
    }
    # Never serialize ErrorRecord/InvocationInfo: callers may pass private paths
    # or arguments. Only fixed, deliberately authored messages reach the log.
    $safeMessage = 'Windows session helper failed; no sensitive details were logged.'
    if ($helperFailure.Exception.Message -match '^(An absolute file path|A regular existing file|Standalone Codex CLI processes|A captured desktop root|A desktop descendant|Desktop manifest|Requested desktop|A preserved process|Desktop process ancestry|Some captured desktop|The restart target|The restart proxy|Private credential-file permissions)') {
        $safeMessage = $helperFailure.Exception.Message
    }
    $errorCode = switch ($Action) {
        'LaunchWorker' { 'WORKER_LAUNCH_FAILED' }
        'StopDesktop' { 'DESKTOP_STOP_FAILED' }
        'StartDesktop' { 'DESKTOP_START_FAILED' }
        'SetPrivateAcl' { 'PRIVATE_ACL_FAILED' }
        default { 'WINDOWS_DISCOVERY_FAILED' }
    }
    $workerCodes = @('WORKER_HOME_INVALID', 'WORKER_CREATE_FAILED', 'WORKER_IDENTITY_MISMATCH',
        'WORKER_ISOLATION_UNAVAILABLE', 'WORKER_ISOLATION_FAILED')
    if ($Action -eq 'LaunchWorker' -and $workerCodes -contains [string]$helperFailure.Exception.Message) { $errorCode = [string]$helperFailure.Exception.Message }
    Write-Result ([ordered]@{ ok = $false; error = $safeMessage; errorCode = $errorCode;
        phase = $operationPhase; errorKind = $helperFailure.Exception.GetType().Name; shutdownAttempted = $shutdownAttempted })
    exit 1
}
