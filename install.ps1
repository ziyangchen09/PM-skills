param(
    [switch]$Force,
    [string]$TargetRoot
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$packInstaller = Join-Path $root "PM-skills-pre-PRD-pack-v2\install.ps1"
$copilot = Join-Path $root "pm-prd-copilot"
$uiContextBuilder = Join-Path $root "pm-ui-context-builder"
$prototypeStudio = Join-Path $root "pm-prototype-studio"

if (-not (Test-Path -LiteralPath $packInstaller -PathType Leaf)) {
    throw "Pre-PRD installer not found: $packInstaller"
}
if (-not (Test-Path -LiteralPath (Join-Path $copilot "SKILL.md") -PathType Leaf)) {
    throw "pm-prd-copilot source not found: $copilot"
}
if (-not (Test-Path -LiteralPath (Join-Path $uiContextBuilder "SKILL.md") -PathType Leaf)) {
    throw "pm-ui-context-builder source not found: $uiContextBuilder"
}
if (-not (Test-Path -LiteralPath (Join-Path $prototypeStudio "SKILL.md") -PathType Leaf)) {
    throw "pm-prototype-studio source not found: $prototypeStudio"
}

$arguments = @(
    "-CopilotSource", $copilot,
    "-UiContextBuilderSource", $uiContextBuilder,
    "-PrototypeStudioSource", $prototypeStudio
)
if ($Force) { $arguments += "-Force" }
if ($TargetRoot) { $arguments += @("-TargetRoot", $TargetRoot) }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $packInstaller @arguments
if ($LASTEXITCODE -ne 0) { throw "PM Skills installation failed with exit code $LASTEXITCODE" }
