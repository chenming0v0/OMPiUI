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
}
function Run-WebView([string]$stage) {
    & node (Join-Path $PSScriptRoot 'windows-upgrade-webview.mjs') --root $Root --stage $stage --port 9336 --project $project
    if ($LASTEXITCODE -ne 0) { throw "$stage native WebView GUI acceptance failed; see $stage-gui.json and screenshots." }
}

try {
    Save-Report
    $provenance = Get-Content (Join-Path $Root 'provenance.json') -Raw | ConvertFrom-Json
    $candidate = @(Get-ChildItem -LiteralPath $CandidateDirectory -File -Filter '*_x64-setup-lite.exe')
    if ($candidate.Count -ne 1) { throw 'Exact-source artifact must contain exactly one x64 lite NSIS installer.' }
    $version = (Get-Content (Join-Path $env:GITHUB_WORKSPACE 'candidate-source/package.json') -Raw | ConvertFrom-Json).version
    if ($candidate[0].Name -ne "OMPiUI_${version}_x64-setup-lite.exe") { throw 'Candidate installer filename does not match exact-source package version.' }
    Record-Step 'installer-provenance' @{ candidateSha = $provenance.candidateSha; candidateVersion = $version; candidateInstaller = $candidate[0].FullName; sha256 = (Get-FileHash $candidate[0].FullName -Algorithm SHA256).Hash; baseline = $provenance.baseline }

    $home = Join-Path $Root 'home'; $temp = Join-Path $Root 'temp'
    $install = Join-Path $Root 'installed-app'
    $project = Join-Path $Root 'original-project'
    $shortcutCwd = Join-Path $Root 'custom-shortcut-cwd'
    New-Item -ItemType Directory -Force $home, $temp, $project, $shortcutCwd | Out-Null
    $env:HOME = $home; $env:USERPROFILE = $home
    $env:TEMP = $temp; $env:TMP = $temp; $env:TMPDIR = $temp
    $env:XDG_CONFIG_HOME = Join-Path $home 'config'; $env:XDG_DATA_HOME = Join-Path $home 'data'
    $env:XDG_STATE_HOME = Join-Path $home 'state'; $env:XDG_CACHE_HOME = Join-Path $home 'cache'
    $env:OMPIUI_BACKGROUND_DIR = Join-Path $Root 'background'
    $env:OMPIUI_DATA_DIR = Join-Path $Root 'webui'
    $env:PI_CODING_AGENT_DIR = Join-Path $Root 'agent'
    $env:OMPI_OMP_RUNTIME_DIR = Join-Path $Root 'native-runtime'
    $env:OMPI_OMP_BIN = Join-Path $env:OMPI_OMP_RUNTIME_DIR 'bin/omp.exe'
    $env:OMPI_BUN_BIN = Join-Path $env:OMPI_OMP_RUNTIME_DIR 'bin/bun.exe'
    $env:OMPI_OMP_PACKAGE_ROOT = Join-Path $env:OMPI_OMP_RUNTIME_DIR 'node_modules/@oh-my-pi/pi-coding-agent'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9336 --remote-debugging-address=127.0.0.1'
    $env:PATH = (Join-Path $env:OMPI_OMP_RUNTIME_DIR 'bin') + ';' + $env:PATH
    $runtime = Get-Content (Join-Path $env:OMPI_OMP_RUNTIME_DIR 'runtime.json') -Raw | ConvertFrom-Json
    if ($runtime.version -ne '18.12.6' -or $runtime.bunVersion -ne '1.3.14') { throw 'Smoke requires official OMP 18.12.6 with public sources and Bun 1.3.14.' }
    Record-Step 'runner-environment' @{ userInteractive = [Environment]::UserInteractive; sessionId = (Get-Process -Id $PID).SessionId; os = [Environment]::OSVersion.ToString(); runtime = $runtime; project = $project; shortcutCwd = $shortcutCwd }

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
    Run-WebView 'baseline'
    Stop-OwnedGui

    foreach ($path in @($startMenu, $desktop)) {
        $link = $shell.CreateShortcut($path)
        $link.TargetPath = $exe
        $link.WorkingDirectory = $shortcutCwd
        $link.Arguments = '--issue-336-upgrade-smoke'
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
    Run-WebView 'candidate'
    $report.nativeGuiCwdAccepted = $true
    $report.status = 'ACCEPTED'
    Record-Step 'acceptance' @{ shortcutsPreserved = $true; nativeGuiCwdAccepted = $true }
} catch {
    $report.blocker = $_.Exception.Message
    Save-Report
    Write-Error $report.blocker -ErrorAction Continue
    exit 1
} finally {
    if ($exe) { Stop-OwnedGui }
    Save-Report
}
