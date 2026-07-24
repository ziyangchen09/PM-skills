param(
    [switch]$Force,
    [string]$TargetRoot,
    [string]$CopilotSource,
    [string]$UiContextBuilderSource,
    [string]$PrototypeStudioSource
)

$ErrorActionPreference = "Stop"

$sources = [ordered]@{
    "pm-demand-intake" = Join-Path $PSScriptRoot "pm-demand-intake"
    "pm-evidence-research" = Join-Path $PSScriptRoot "pm-evidence-research"
    "pm-problem-framing" = Join-Path $PSScriptRoot "pm-problem-framing"
    "pm-solution-designer" = Join-Path $PSScriptRoot "pm-solution-designer"
    "pm-prd-readiness-gate" = Join-Path $PSScriptRoot "pm-prd-readiness-gate"
}
if ($CopilotSource) {
    $sources["pm-prd-copilot"] = [IO.Path]::GetFullPath($CopilotSource)
}
if ($UiContextBuilderSource) {
    $sources["pm-ui-context-builder"] = [IO.Path]::GetFullPath($UiContextBuilderSource)
}
if ($PrototypeStudioSource) {
    $sources["pm-prototype-studio"] = [IO.Path]::GetFullPath($PrototypeStudioSource)
}
$skills = @($sources.Keys)

$installRoot = if ($TargetRoot) { [IO.Path]::GetFullPath($TargetRoot) } else { Join-Path $HOME ".codex\skills" }
[void][IO.Directory]::CreateDirectory($installRoot)

$existingTargets = @()
foreach ($skill in $skills) {
    $source = [IO.Path]::GetFullPath($sources[$skill])
    $target = Join-Path $installRoot $skill
    if (-not (Test-Path -LiteralPath (Join-Path $source "SKILL.md") -PathType Leaf)) {
        throw "Skill is missing SKILL.md: $source"
    }
    if ((Get-Item -LiteralPath $source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing reparse-point source: $source"
    }
    if (Test-Path -LiteralPath $target) {
        if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing reparse-point target: $target"
        }
        $existingTargets += $target
    }
}

$quickValidate = Join-Path $HOME ".codex\skills\.system\skill-creator\scripts\quick_validate.py"
if (-not (Test-Path -LiteralPath $quickValidate -PathType Leaf)) {
    throw "Skill validator not found: $quickValidate"
}
foreach ($skill in $skills) {
    $source = [IO.Path]::GetFullPath($sources[$skill])
    & python -X utf8 $quickValidate $source
    if ($LASTEXITCODE -ne 0) { throw "Skill validation failed: $skill" }
}

$readinessValidator = Join-Path $sources["pm-prd-readiness-gate"] "scripts\validate_handoff.py"
& python -X utf8 $readinessValidator --self-test
if ($LASTEXITCODE -ne 0) { throw "Readiness validator self-test failed" }

if ($sources.Contains("pm-prd-copilot")) {
    $copilotScripts = @(
        "archive-feishu-prd.js",
        "archive-local-prd.js",
        "analyze-prd-change.js",
        "build-prd-context.js",
        "requirement-status.js",
        "save-prd.js",
        "sync-feishu-wiki.js",
        "validate-prd.js"
    )
    foreach ($script in $copilotScripts) {
        $file = Join-Path $sources["pm-prd-copilot"] "scripts\$script"
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Required Copilot script is missing: $file"
        }
        & node $file --self-test
        if ($LASTEXITCODE -ne 0) { throw "Copilot self-test failed: $script" }
    }
}

if ($sources.Contains("pm-ui-context-builder")) {
    $file = Join-Path $sources["pm-ui-context-builder"] "scripts\validate-design-context.js"
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required UI context script is missing: $file"
    }
    & node $file --self-test
    if ($LASTEXITCODE -ne 0) { throw "UI context validator self-test failed" }
}

if ($sources.Contains("pm-prototype-studio")) {
    $file = Join-Path $sources["pm-prototype-studio"] "scripts\init-vue-prototype.js"
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required prototype script is missing: $file"
    }
    & node $file --self-test
    if ($LASTEXITCODE -ne 0) { throw "Prototype initializer self-test failed" }
}

if ($existingTargets.Count -gt 0 -and -not $Force) {
    throw "Skills already exist; no changes made. Use -Force to replace: $($existingTargets -join ', ')"
}

$runId = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$stageRoot = Join-Path $installRoot ".pm-pre-prd-stage-$runId"
$backupRoot = if ($existingTargets.Count -gt 0) { Join-Path $installRoot ".pm-pre-prd-backup-$runId" } else { $null }
$backedUp = @()
$installed = @()

try {
    [void][IO.Directory]::CreateDirectory($stageRoot)

    # Stage and validate the whole pack before changing installed skills.
    foreach ($skill in $skills) {
        $source = [IO.Path]::GetFullPath($sources[$skill])
        $stage = Join-Path $stageRoot $skill
        Copy-Item -LiteralPath $source -Destination $stage -Recurse
        if (-not (Test-Path -LiteralPath (Join-Path $stage "SKILL.md") -PathType Leaf)) {
            throw "Staging validation failed: $skill"
        }
    }

    if ($backupRoot) {
        [void][IO.Directory]::CreateDirectory($backupRoot)
    }

    foreach ($skill in $skills) {
        $target = Join-Path $installRoot $skill
        $stage = Join-Path $stageRoot $skill
        $backup = if ($backupRoot) { Join-Path $backupRoot $skill } else { $null }
        if (Test-Path -LiteralPath $target) {
            Move-Item -LiteralPath $target -Destination $backup
            $backedUp += $skill
        }
        Move-Item -LiteralPath $stage -Destination $target
        $installed += $skill
        Write-Host "Installed: $skill"
    }
}
catch {
    $installError = $_
    $rollbackErrors = @()

    for ($i = $skills.Count - 1; $i -ge 0; $i--) {
        $skill = $skills[$i]
        $target = Join-Path $installRoot $skill
        $backup = if ($backupRoot) { Join-Path $backupRoot $skill } else { $null }
        if ($installed -contains $skill -and (Test-Path -LiteralPath $target)) {
            try {
                # ponytail: only removes a new copy installed by this run.
                Remove-Item -LiteralPath $target -Recurse -Force
            }
            catch {
                $rollbackErrors += "remove ${target}: $($_.Exception.Message)"
            }
        }
        if ($backedUp -contains $skill -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $target)) {
            try {
                Move-Item -LiteralPath $backup -Destination $target
            }
            catch {
                $rollbackErrors += "restore ${target}: $($_.Exception.Message)"
            }
        }
    }

    if ($rollbackErrors.Count -gt 0) {
        throw "Install failed: $($installError.Exception.Message). Rollback needs attention: $($rollbackErrors -join '; '). Backup: $backupRoot"
    }
    throw $installError
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        try {
            # ponytail: only removes the unique staging directory created by this run.
            Remove-Item -LiteralPath $stageRoot -Recurse -Force
        }
        catch {
            Write-Warning "Could not clean staging directory: $stageRoot"
        }
    }
}

if ($backupRoot) {
    Write-Host "Previous versions backed up to: $backupRoot"
}
Write-Host "Installation complete for $($skills.Count) Skills. Restart Codex."
