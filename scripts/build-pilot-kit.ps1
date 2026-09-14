param([string]$Version = "0.2.0")

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"
if (-not $PSBoundParameters.ContainsKey("Version")) {
  $Version = (Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "版本号无效：$Version"
}
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "release"))
$kitName = "Roomillion-$Version-Pilot-Kit"
$stagePath = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot $kitName))
$zipPath = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot "$kitName.zip"))
$zipChecksumPath = "$zipPath.sha256"
$artifactName = "Roomillion-$Version-Portable.exe"
$artifactPath = Join-Path $releaseRoot $artifactName

function Get-Sha256Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash($stream)
    return ([System.BitConverter]::ToString($bytes)).Replace("-", "")
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

if (-not $stagePath.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "试点包暂存目录超出 release 范围"
}
if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
  throw "请先构建便携版：$artifactPath"
}

if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $zipChecksumPath) { Remove-Item -LiteralPath $zipChecksumPath -Force }
New-Item -ItemType Directory -Path $stagePath | Out-Null

Copy-Item -LiteralPath $artifactPath -Destination (Join-Path $stagePath $artifactName)
Copy-Item -LiteralPath (Join-Path $projectRoot "pilot\verify-pilot.ps1") -Destination (Join-Path $stagePath "verify-pilot.ps1")
Copy-Item -LiteralPath (Join-Path $projectRoot "pilot\双击验证便携版.cmd") -Destination (Join-Path $stagePath "验证便携版.cmd")
Copy-Item -LiteralPath (Join-Path $projectRoot "pilot\README.txt") -Destination (Join-Path $stagePath "README.txt")
Copy-Item -LiteralPath (Join-Path $projectRoot "pilot\pilot-feedback-core.js") -Destination (Join-Path $stagePath "pilot-feedback-core.js")
Copy-Item -LiteralPath (Join-Path $projectRoot "pilot\试点反馈表.html") -Destination (Join-Path $stagePath "试点反馈表.html")
Copy-Item -LiteralPath (Join-Path $projectRoot "pilot\汇总试点结果.html") -Destination (Join-Path $stagePath "汇总试点结果.html")
Copy-Item -LiteralPath (Join-Path $projectRoot "docs\14-0.2干净机试点验收手册.md") -Destination (Join-Path $stagePath "试点验收手册.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "resources\compliance\THIRD-PARTY-NOTICES.md") -Destination (Join-Path $stagePath "THIRD-PARTY-NOTICES.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "resources\compliance\sbom.cdx.json") -Destination (Join-Path $stagePath "sbom.cdx.json")

$hash = (Get-Sha256Hex $artifactPath).ToUpperInvariant()
Set-Content -LiteralPath (Join-Path $stagePath "SHA256SUMS.txt") -Value "$hash  $artifactName" -Encoding UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stagePath,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)
$zip = Get-Item -LiteralPath $zipPath
$zipHash = (Get-Sha256Hex $zipPath).ToUpperInvariant()
Set-Content -LiteralPath $zipChecksumPath -Value "$zipHash  $($zip.Name)" -Encoding UTF8
Write-Output ("PilotKit=" + $zip.FullName)
Write-Output ("Bytes=" + $zip.Length)
Write-Output ("ArtifactSHA256=" + $hash)
Write-Output ("PilotKitSHA256=" + $zipHash)
