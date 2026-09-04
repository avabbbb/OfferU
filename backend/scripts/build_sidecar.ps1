param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$backendDir = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $backendDir
$frontendBinDir = Join-Path $projectRoot "frontend\src-tauri\binaries"
$tauriResourceDir = Join-Path $projectRoot ".tmp"
$agentRuntimeSourceDir = Join-Path $projectRoot "agent-runtime"
$agentRuntimeReleaseDir = Join-Path $tauriResourceDir "p"
$nodeResourcePath = Join-Path $tauriResourceDir "offeru-node-runtime.exe"
$legacyTauriResourceDir = Join-Path $projectRoot "frontend\src-tauri\resources"
$legacyAgentRuntimeDir = Join-Path $legacyTauriResourceDir "agent-runtime"
$legacyNodeResourcePath = Join-Path $legacyTauriResourceDir "node.exe"
$buildDir = Join-Path $projectRoot ".tmp\offeru-sidecar-build"
$distDir = if ($OutputDir) { $OutputDir } else { $frontendBinDir }

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
New-Item -ItemType Directory -Force -Path $tauriResourceDir | Out-Null
if (Test-Path -LiteralPath $legacyAgentRuntimeDir) {
    Remove-Item -LiteralPath $legacyAgentRuntimeDir -Recurse -Force
}
if (Test-Path -LiteralPath $legacyNodeResourcePath) {
    Remove-Item -LiteralPath $legacyNodeResourcePath -Force
}

$pythonPath = if ($env:OFFERU_PYTHON_PATH) {
    (Get-Item -LiteralPath $env:OFFERU_PYTHON_PATH -ErrorAction Stop).FullName
} else {
    Join-Path $backendDir ".venv312\Scripts\python.exe"
}
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    $pythonPath = (Get-Command python -ErrorAction Stop).Source
}

$nodePath = if ($env:OFFERU_NODE_PATH) {
    (Get-Item -LiteralPath $env:OFFERU_NODE_PATH -ErrorAction Stop).FullName
} else {
    (Get-Command node -ErrorAction Stop).Source
}
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "Node.js executable was not found; the packaged Pi runtime requires Node >=22.19.0"
}
$nodeVersionText = (& $nodePath --version).Trim()
$nodeVersion = $nodeVersionText.TrimStart("v")
try {
    $parsedNodeVersion = [version]$nodeVersion
} catch {
    throw "Unable to determine Node.js version from '$nodeVersionText'"
}
if ($parsedNodeVersion -lt [version]"22.19.0") {
    throw "Node.js $nodeVersionText is too old; the packaged Pi runtime requires Node >=22.19.0"
}

if (-not (Test-Path -LiteralPath (Join-Path $agentRuntimeSourceDir "src\worker.mjs") -PathType Leaf)) {
    throw "Pi runtime source is missing: agent-runtime/src/worker.mjs"
}
$sourceNodeModules = Join-Path $agentRuntimeSourceDir "node_modules"
if (-not (Test-Path -LiteralPath (Join-Path $sourceNodeModules "@earendil-works\pi-coding-agent") -PathType Container)) {
    throw "Pi runtime dependencies are missing; run npm ci in agent-runtime before packaging"
}

if (Test-Path -LiteralPath $agentRuntimeReleaseDir) {
    Remove-Item -LiteralPath $agentRuntimeReleaseDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $agentRuntimeReleaseDir "src") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $agentRuntimeReleaseDir "node_modules") | Out-Null
Copy-Item -LiteralPath (Join-Path $agentRuntimeSourceDir "src\worker.mjs") -Destination (Join-Path $agentRuntimeReleaseDir "src\worker.mjs") -Force
Copy-Item -LiteralPath (Join-Path $agentRuntimeSourceDir "package.json") -Destination (Join-Path $agentRuntimeReleaseDir "package.json") -Force
Get-ChildItem -LiteralPath $sourceNodeModules -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $agentRuntimeReleaseDir "node_modules") -Recurse -Force
}

# Pi is the minimum packaged live runtime. The optional Claude hosted worker
# is deliberately excluded so the release bundle does not ship its platform
# binary and SDK when that provider is not part of the core desktop path.
$releaseAnthropicDir = Join-Path $agentRuntimeReleaseDir "node_modules\@anthropic-ai"
if (Test-Path -LiteralPath $releaseAnthropicDir -PathType Container) {
    Get-ChildItem -LiteralPath $releaseAnthropicDir -Directory -Force |
        Where-Object { $_.Name -like "claude-agent-sdk*" } |
        Remove-Item -Recurse -Force
}
$releaseManifestPath = Join-Path $agentRuntimeReleaseDir "package.json"
$releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
$releaseManifest.dependencies.PSObject.Properties.Remove("@anthropic-ai/claude-agent-sdk")
$releaseManifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $releaseManifestPath -Encoding utf8
$npmPath = (Get-Command npm -ErrorAction Stop).Source
& $npmPath --prefix $agentRuntimeReleaseDir prune --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) {
    throw "Packaged Pi runtime dependency pruning failed with exit code $LASTEXITCODE"
}
Copy-Item -LiteralPath $nodePath -Destination $nodeResourcePath -Force

if (-not (Test-Path -LiteralPath (Join-Path $agentRuntimeReleaseDir "node_modules\@earendil-works\pi-coding-agent") -PathType Container)) {
    throw "Packaged Pi runtime staging failed: pi-coding-agent is missing"
}
if (-not (Test-Path -LiteralPath $nodeResourcePath -PathType Leaf)) {
    throw "Packaged Node.js runtime staging failed: $nodeResourcePath"
}
Write-Output "Staged Pi runtime at $agentRuntimeReleaseDir"
Write-Output "Staged Node.js runtime at $nodeResourcePath ($nodeVersionText)"

$entryPath = Join-Path $backendDir "sidecar_entry.py"
& $pythonPath -m PyInstaller `
    --clean `
    --noconfirm `
    --onefile `
    --name offeru-backend `
    --distpath $distDir `
    --workpath (Join-Path $buildDir "work") `
    --specpath (Join-Path $buildDir "spec") `
    --paths $backendDir `
    --collect-all app `
    --collect-submodules aiosqlite `
    --add-data "$(Join-Path $backendDir 'app\agents\skills');app\agents\skills" `
    --add-data "$(Join-Path $backendDir 'tests\fixtures');tests\fixtures" `
    $entryPath

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller sidecar build failed with exit code $LASTEXITCODE"
}

$builtPath = Join-Path $distDir "offeru-backend.exe"
$targetPath = Join-Path $distDir "offeru-backend-x86_64-pc-windows-msvc.exe"
if (-not (Test-Path -LiteralPath $builtPath -PathType Leaf)) {
    throw "PyInstaller did not produce $builtPath"
}

if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
    Remove-Item -LiteralPath $targetPath -Force
}
Move-Item -LiteralPath $builtPath -Destination $targetPath
Write-Output "Built $targetPath"
