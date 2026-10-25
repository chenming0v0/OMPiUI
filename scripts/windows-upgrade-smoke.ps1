param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$BaselineInstaller,
    [Parameter(Mandatory = $true)][string]$CandidateDirectory
)

$ErrorActionPreference = 'Stop'
# Installing an app is deliberately unavailable on local or self-hosted machines.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $IsWindows) {
    throw 'This destructive install/upgrade smoke requires a disposable GitHub-hosted Windows runner.'
}
$Root = [IO.Path]::GetFullPath($Root)
$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $Root.StartsWith($runnerTemp, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $Root -Leaf) -ne "ompiui-upgrade-$env:GITHUB_RUN_ID") {
    throw 'Smoke root must be the current run-owned directory inside RUNNER_TEMP.'
}
$evidence = Join-Path $Root 'evidence'
New-Item -ItemType Directory -Force $evidence | Out-Null
$reportPath = Join-Path $evidence 'upgrade.json'
$report = [ordered]@{
    issue = 336; status = 'BLOCKED'; root = $Root; steps = @(); shortcutsPreserved = $false
    nativeGuiCwdAccepted = $false; processOwnership = @(); blocker = $null
}
$webViewPolicies = @()
$smokeStarted = Get-Date
function Install-OfficialWebViewRuntime {
    $url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
    $installer = Join-Path $Root 'MicrosoftEdgeWebview2Setup.exe'
    Invoke-WebRequest $url -OutFile $installer
    $signature = Get-AuthenticodeSignature -FilePath $installer
    Record-Step 'official-webview2-installer-provenance' @{ url = $url; sha256 = (Get-FileHash $installer -Algorithm SHA256).Hash; signatureStatus = $signature.Status.ToString(); signer = $signature.SignerCertificate.Subject }
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Official WebView2 bootstrapper must have a valid Microsoft Corporation Authenticode signature.' }
    $process = Start-Process -FilePath $installer -ArgumentList '/silent /install' -PassThru
    if (-not $process.WaitForExit(180000)) { throw 'Official WebView2 runtime installation did not complete; no host reboot is permitted.' }
    Record-Step 'official-webview2-runtime-install' @{ exitCode = $process.ExitCode; arguments = '/silent /install' }
    if ($process.ExitCode -ne 0) { throw "Official WebView2 runtime installation failed with exit $($process.ExitCode)." }
    $runtimeKeys = @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')
    $versions = @($runtimeKeys | ForEach-Object { if (Test-Path $_) { @{ key = $_; version = (Get-ItemProperty $_).pv } } })
    Record-Step 'official-webview2-installed-version' $versions
}
function Capture-OwnedCrashEvents([string]$stage) {
    # EventLog performs exact owned-path and run-time filtering, not a global
    # event scan followed by an unrelated-process text heuristic.
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = @(1000, 1001); StartTime = $smokeStarted; Data = $exe } -ErrorAction SilentlyContinue)
    Record-Step "$stage-exact-owned-crash-events" @($events | ForEach-Object { @{ id = $_.Id; at = $_.TimeCreated.ToUniversalTime().ToString('o'); provider = $_.ProviderName; message = $_.Message; xml = $_.ToXml() } })
}
function Capture-DirectGuiStartupDiagnostic([string]$stage) {
    # Diagnostic-only native GUI launch with inherited process environment and
    # stdout/stderr capture. This is never credited as shortcut/GUI acceptance.
    $process = Start-Process -FilePath $exe -ArgumentList ('"' + $project + '"') -WorkingDirectory $shortcutCwd -PassThru -RedirectStandardOutput (Join-Path $evidence "$stage-direct-gui-stdout.log") -RedirectStandardError (Join-Path $evidence "$stage-direct-gui-stderr.log")
    $exited = $process.WaitForExit(3000)
    Record-Step "$stage-diagnostic-only-direct-gui-launch" @{ pid = $process.Id; executable = $exe; exited = $exited; exitCode = $(if ($exited) { $process.ExitCode } else { $null }); acceptance = $false }
    Capture-OwnedGuiDiagnostics "$stage-direct-gui-diagnostic"
    Capture-OwnedCrashEvents "$stage-direct-gui-diagnostic"
    Stop-OwnedGui
}
function Set-OwnedWebViewPolicy([string]$option, [string]$value) {
    # Official WebView2 exact-process-name policy override, on this disposable
    # runner only. Elevated hosts honor HKLM, not user/env debug flags.
    # No wildcard or other-app value; the exact app value is restored below.
    $key = "HKLM:\Software\Policies\Microsoft\Edge\WebView2\$option"
    $name = 'ompiui.exe'
    $existed = Test-Path $key
    if (-not $existed) { New-Item -Path $key -Force | Out-Null }
    $item = Get-Item $key
    $hadValue = $item.GetValueNames() -contains $name
    $oldValue = if ($hadValue) { $item.GetValue($name) } else { $null }
    $oldKind = if ($hadValue) { $item.GetValueKind($name) } else { $null }
    $script:webViewPolicies += @{ key = $key; name = $name; existed = $existed; hadValue = $hadValue; oldValue = $oldValue; oldKind = $oldKind }
    New-ItemProperty -Path $key -Name $name -Value $value -PropertyType String -Force | Out-Null
    Record-Step 'exact-app-webview2-policy' @{ key = $key; name = $name; value = $value; hadPriorValue = $hadValue }
}
function Restore-OwnedWebViewPolicies {
    foreach ($saved in $webViewPolicies) {
        if ($saved.hadValue) {
            New-ItemProperty -Path $saved.key -Name $saved.name -Value $saved.oldValue -PropertyType $saved.oldKind -Force | Out-Null
        } else {
            Remove-ItemProperty -Path $saved.key -Name $saved.name -ErrorAction SilentlyContinue
        }
        if (-not $saved.existed -and (Test-Path $saved.key)) {
            $item = Get-Item $saved.key
            if ($item.ValueCount -eq 0 -and $item.SubKeyCount -eq 0) { Remove-Item $saved.key }
        }
    }
}
function Capture-OwnedGuiDiagnostics([string]$stage) {
    $roots = @(Get-CimInstance Win32_Process -Filter "Name='ompiui.exe'" | Where-Object { $_.ExecutablePath -eq $exe })
    $queue = [Collections.Queue]::new()
    $seen = @{}
    $details = @()
    foreach ($process in $roots) { $queue.Enqueue($process.ProcessId) }
    while ($queue.Count -gt 0) {
        $ownedPid = $queue.Dequeue()
        if ($seen.ContainsKey($ownedPid)) { continue }
        $seen[$ownedPid] = $true
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid" -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        $details += @{ pid = $process.ProcessId; parentPid = $process.ParentProcessId; path = $process.ExecutablePath; commandLine = $process.CommandLine; session = $process.SessionId }
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ownedPid")) { $queue.Enqueue($child.ProcessId) }
    }
    Record-Step "$stage-owned-gui-descendants" $details
    Capture-OwnedCrashEvents $stage
    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
        $image = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
        $graphics = [Drawing.Graphics]::FromImage($image)
        try {
            $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
            $image.Save((Join-Path $evidence "$stage-runner-desktop.png"), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $image.Dispose() }
    } catch { Record-Step "$stage-desktop-capture-unavailable" $_.Exception.Message }
}
function Save-Report { $report | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $reportPath }
function Record-Step([string]$name, $details) {
    $report.steps += [ordered]@{ name = $name; at = (Get-Date).ToUniversalTime().ToString('o'); details = $details }
    Save-Report
}
function Install-App([string]$installer, [string]$stage) {
    # /P exercises the real passive maintenance page, including old uninstall.
    # /UPDATE would bypass it; /S would skip custom maintenance pages altogether.
    $arguments = "/P /D=$install"
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -PassThru
    if (-not $process.WaitForExit(180000)) {
        Record-Step "$stage-timeout" @{ installer = $installer; pid = $process.Id; arguments = $arguments }
        throw "$stage installer did not finish in three minutes; an unattended GUI prompt may be blocking."
    }
    Record-Step $stage @{ installer = $installer; sha256 = (Get-FileHash $installer -Algorithm SHA256).Hash; arguments = $arguments; exitCode = $process.ExitCode }
    if ($process.ExitCode -ne 0) { throw "$stage installer failed with exit code $($process.ExitCode)" }
}
function Read-Link([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Installer shortcut missing: $path" }
    $link = $shell.CreateShortcut($path)
    return [ordered]@{
        path = $path; TargetPath = $link.TargetPath; WorkingDirectory = $link.WorkingDirectory
        Arguments = $link.Arguments; IconLocation = $link.IconLocation; WindowStyle = $link.WindowStyle
        sha256 = (Get-FileHash $path -Algorithm SHA256).Hash
    }
}
function Stop-OwnedGui {
    # Only this run's installed GUI can be stopped. Never inspect/kill generic omp,
    # WebView, terminal, or server processes; maintenance owns its child shutdown.
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='ompiui.exe'" | Where-Object { $_.ExecutablePath -eq $exe })
    foreach ($process in $owned) {
        $report.processOwnership += @{ pid = $process.ProcessId; executable = $process.ExecutablePath; commandLine = $process.CommandLine }
        Stop-Process -Id $process.ProcessId -Force
    }
    Start-Sleep -Milliseconds 1000
    Save-Report
}
function Launch-Link([string]$path, [string]$stage) {
    $link = Read-Link $path
    # ShellExecute uses the actual .lnk, not a reconstructed command line.
    Start-Process -FilePath $path | Out-Null
    Record-Step $stage $link
    Start-Sleep -Milliseconds 500
    Capture-OwnedGuiDiagnostics $stage
}
function Run-WebView([string]$stage) {
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='ompiui.exe'" | Where-Object { $_.ExecutablePath -eq $exe })
    @{ pids = @($owned | ForEach-Object { $_.ProcessId }); executable = $exe } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Root "$stage-process.json")
    if ($owned.Count -eq 0) {
        @{ issue = 336; stage = $stage; status = 'BLOCKED'; blocker = 'Actual shortcut-launched GUI exited before CDP; no repeated CDP timeout.' } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $evidence "$stage-gui.json")
        Capture-OwnedGuiDiagnostics "$stage-gui-exited"
        Capture-DirectGuiStartupDiagnostic $stage
        return $false
    }
    & node (Join-Path $PSScriptRoot 'windows-upgrade-webview.mjs') --root $Root --stage $stage --port 9336 --project $project
    $accepted = $LASTEXITCODE -eq 0
    if (-not $accepted) {
        Capture-OwnedGuiDiagnostics "$stage-gui-blocked"
        Capture-DirectGuiStartupDiagnostic $stage
    }
    return $accepted
}

try {
    Save-Report
    $provenance = Get-Content (Join-Path $Root 'provenance.json') -Raw | ConvertFrom-Json
    $candidate = @(Get-ChildItem -LiteralPath $CandidateDirectory -File -Filter '*_x64-setup-lite.exe')
    if ($candidate.Count -ne 1) { throw 'Exact-source artifact must contain exactly one x64 lite NSIS installer.' }
    $version = (Get-Content (Join-Path $env:GITHUB_WORKSPACE 'candidate-source/package.json') -Raw | ConvertFrom-Json).version
    if ($candidate[0].Name -ne "OMPiUI_${version}_x64-setup-lite.exe") { throw 'Candidate installer filename does not match exact-source package version.' }
    Record-Step 'installer-provenance' @{ candidateSha = $provenance.candidateSha; candidateVersion = $version; candidateInstaller = $candidate[0].FullName; sha256 = (Get-FileHash $candidate[0].FullName -Algorithm SHA256).Hash; baseline = $provenance.baseline }

    $isolatedHome = Join-Path $Root 'home'; $temp = Join-Path $Root 'temp'
    $install = Join-Path $Root 'installed-app'
    $project = Join-Path $Root 'original-project'
    $shortcutCwd = Join-Path $Root 'custom-shortcut-cwd'
    New-Item -ItemType Directory -Force $isolatedHome, $temp, $project, $shortcutCwd | Out-Null
    $env:HOME = $isolatedHome; $env:USERPROFILE = $isolatedHome
    # SHGetKnownFolderPath(flags=0), used by Tauri's HTTP cookie cache,
    # verifies the expanded Windows profile folders already exist.
    $env:LOCALAPPDATA = Join-Path $isolatedHome 'AppData/Local'
    $env:APPDATA = Join-Path $isolatedHome 'AppData/Roaming'
    New-Item -ItemType Directory -Force $env:LOCALAPPDATA, $env:APPDATA | Out-Null
    Record-Step 'owned-windows-known-folders' @{ localAppData = $env:LOCALAPPDATA; roamingAppData = $env:APPDATA }
    $env:TEMP = $temp; $env:TMP = $temp; $env:TMPDIR = $temp
    $env:XDG_CONFIG_HOME = Join-Path $isolatedHome 'config'; $env:XDG_DATA_HOME = Join-Path $isolatedHome 'data'
    $env:XDG_STATE_HOME = Join-Path $isolatedHome 'state'; $env:XDG_CACHE_HOME = Join-Path $isolatedHome 'cache'
    $env:OMPIUI_BACKGROUND_DIR = Join-Path $Root 'background'
    $env:OMPIUI_DATA_DIR = Join-Path $Root 'webui'
    $env:PI_CODING_AGENT_DIR = Join-Path $Root 'agent'
    $env:OMPI_OMP_RUNTIME_DIR = Join-Path $Root 'native-runtime'
    $env:OMPI_OMP_BIN = Join-Path $env:OMPI_OMP_RUNTIME_DIR 'bin/omp.exe'
    $env:OMPI_BUN_BIN = Join-Path $env:OMPI_OMP_RUNTIME_DIR 'bin/bun.exe'
    $env:OMPI_OMP_PACKAGE_ROOT = Join-Path $env:OMPI_OMP_RUNTIME_DIR 'node_modules/@oh-my-pi/pi-coding-agent'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9336 --remote-debugging-address=127.0.0.1'
    Set-OwnedWebViewPolicy 'AdditionalBrowserArguments' $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    Set-OwnedWebViewPolicy 'UserDataFolder' (Join-Path $Root 'webview-profile')
    $env:PATH = (Join-Path $env:OMPI_OMP_RUNTIME_DIR 'bin') + ';' + $env:PATH
    $runtime = Get-Content (Join-Path $env:OMPI_OMP_RUNTIME_DIR 'runtime.json') -Raw | ConvertFrom-Json
    if ($runtime.version -ne '18.12.6' -or $runtime.bunVersion -ne '1.3.14') { throw 'Smoke requires official OMP 18.12.6 with public sources and Bun 1.3.14.' }
    Record-Step 'runner-environment' @{ userInteractive = [Environment]::UserInteractive; sessionId = (Get-Process -Id $PID).SessionId; os = [Environment]::OSVersion.ToString(); runtime = $runtime; project = $project; shortcutCwd = $shortcutCwd }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Issue336Token {
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetTokenInformation(IntPtr token, int infoClass, out int information, int length, out int returnedLength);
}
'@
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = 0; $returnedLength = 0
    if (-not [Issue336Token]::GetTokenInformation($identity.Token, 20, [ref]$elevated, 4, [ref]$returnedLength)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    Record-Step 'actual-runner-token-elevation' @{ elevated = $elevated -ne 0; identity = $identity.Name; policySource = 'https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags'; policyScope = 'HKLM exact ompiui.exe values on this disposable runner only' }
    Install-OfficialWebViewRuntime
    $env:SMOKE_ROOT = $Root
    $providerScript = Join-Path $PSScriptRoot 'windows-upgrade-provider.mjs'
    $provider = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + $providerScript + '"') -PassThru -RedirectStandardOutput (Join-Path $evidence 'provider-stdout.log') -RedirectStandardError (Join-Path $evidence 'provider-stderr.log')
    $ready = Join-Path $Root 'provider-ready.json'
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $ready) -and (Get-Date) -lt $deadline -and -not $provider.HasExited) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path $ready)) { throw 'Owned local native provider did not initialize its modelRoles/models.yml; see provider logs.' }
    Record-Step 'owned-local-test-provider' (Get-Content (Join-Path $evidence 'local-provider.json') -Raw | ConvertFrom-Json)

    Install-App $BaselineInstaller 'baseline-install'
    $exe = Join-Path $install 'ompiui.exe'
    if (-not (Test-Path $exe)) { throw "Actual installed GUI unavailable: $exe" }
    Record-Step 'baseline-installed-binary' @{ path = $exe; version = (Get-Item $exe).VersionInfo.ProductVersion; sha256 = (Get-FileHash $exe -Algorithm SHA256).Hash }
    $shell = New-Object -ComObject WScript.Shell
    $startMenu = Join-Path $shell.SpecialFolders.Item('Programs') 'OMPiUI.lnk'
    $desktop = Join-Path $shell.SpecialFolders.Item('Desktop') 'OMPiUI.lnk'
    # The baseline installer must have produced the Start Menu link. Desktop
    # creation is a genuine user shortcut operation because /P skips Finish.
    Read-Link $startMenu | Out-Null
    $initial = $shell.CreateShortcut($startMenu)
    $initial.TargetPath = $exe; $initial.WorkingDirectory = $shortcutCwd
    $initial.Arguments = '"' + $project + '"'
    $initial.Save()
    Launch-Link $startMenu 'baseline-gui-launch'
    $baselineGuiAccepted = Run-WebView 'baseline'
    $report.baselineGuiAccepted = $baselineGuiAccepted
    Stop-OwnedGui

    foreach ($path in @($startMenu, $desktop)) {
        $link = $shell.CreateShortcut($path)
        $link.TargetPath = $exe
        $link.WorkingDirectory = $shortcutCwd
        # A quoted existing project is the supported explicit-directory argv.
        # Desktop deliberately has no argv, so its differing WorkingDirectory
        # must not replace the GUI's persisted original project.
        $link.Arguments = if ($path -eq $startMenu) { '"' + $project + '"' } else { '' }
        $link.IconLocation = "$exe,0"
        $link.WindowStyle = 1
        $link.Save()
    }
    $before = @((Read-Link $startMenu), (Read-Link $desktop))
    $report.before = $before
    Record-Step 'customized-shortcuts-before-upgrade' $before
    Install-App $candidate[0].FullName 'candidate-upgrade'
    $installedVersion = (Get-Item $exe).VersionInfo.ProductVersion
    if ($installedVersion -notlike "$version*") { throw "Installed binary version $installedVersion does not match candidate $version." }
    Record-Step 'candidate-installed-binary' @{ path = $exe; version = $installedVersion; sha256 = (Get-FileHash $exe -Algorithm SHA256).Hash }
    $after = @((Read-Link $startMenu), (Read-Link $desktop))
    $report.after = $after
    Record-Step 'shortcuts-after-upgrade' $after
    for ($index = 0; $index -lt $before.Count; $index++) {
        foreach ($field in @('TargetPath', 'WorkingDirectory', 'Arguments', 'IconLocation', 'WindowStyle', 'sha256')) {
            if ($before[$index][$field] -cne $after[$index][$field]) { throw "Shortcut $($before[$index].path) changed $field during the real upgrade." }
        }
    }
    $report.shortcutsPreserved = $true
    Launch-Link $desktop 'upgraded-gui-launch-via-preserved-shortcut'
    $candidateGuiAccepted = Run-WebView 'candidate'
    $report.nativeGuiCwdAccepted = $candidateGuiAccepted
    if (-not $baselineGuiAccepted -or -not $candidateGuiAccepted) {
        $report.status = 'SHORTCUT_ONLY'
        Record-Step 'partial-shortcut-upgrade-acceptance' @{ shortcutsPreserved = $true; baselineGuiAccepted = $baselineGuiAccepted; candidateGuiAccepted = $candidateGuiAccepted }
        throw 'Real install/upgrade preserved shortcuts, but saved project plus actual native GUI new-chat cwd acceptance is incomplete; see native GUI reports and owned runner diagnostics.'
    }
    $report.status = 'ACCEPTED'
    Record-Step 'acceptance' @{ shortcutsPreserved = $true; nativeGuiCwdAccepted = $true }
} catch {
    $report.blocker = $_.Exception.Message
    Save-Report
    Write-Error $report.blocker -ErrorAction Continue
    exit 1
} finally {
    try {
        if ($exe) { Stop-OwnedGui }
        if ($provider -and -not $provider.HasExited) { Stop-Process -Id $provider.Id -Force }
    } finally {
        Restore-OwnedWebViewPolicies
        Record-Step 'exact-app-webview2-policy-restored' @{ count = $webViewPolicies.Count }
        Save-Report
    }
}
