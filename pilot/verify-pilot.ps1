param(
  [string]$ArtifactName = "Roomillion-0.2.0-Portable.exe",
  [string]$ChecksumName = "SHA256SUMS.txt"
)

$ErrorActionPreference = "Stop"
$kitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$checksumPath = Join-Path $kitRoot $ChecksumName
$resultPath = Join-Path $kitRoot "pilot-result.json"
$smokeReportPath = Join-Path $kitRoot "workbench-smoke-report.json"

function Test-CommandPresent([string]$Name) {
  return [bool](Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

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

if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
  throw "找不到校验文件：$ChecksumName"
}

$checksumLine = Get-Content -LiteralPath $checksumPath -Encoding UTF8 | Select-Object -First 1
$checksumParts = $checksumLine.Trim() -split "\s+", 2
if ($checksumParts.Count -lt 2) {
  throw "SHA256SUMS.txt 格式无效"
}
$checksumArtifactName = $checksumParts[1]
if (-not $PSBoundParameters.ContainsKey("ArtifactName")) {
  $ArtifactName = $checksumArtifactName
}
if ($checksumArtifactName -ne $ArtifactName) {
  throw "SHA256SUMS.txt 格式或文件名不匹配"
}
$artifactPath = Join-Path $kitRoot $ArtifactName
if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
  throw "找不到便携版：$ArtifactName"
}
$expectedHash = $checksumParts[0].ToUpperInvariant()
$actualHash = (Get-Sha256Hex $artifactPath).ToUpperInvariant()
$hashMatches = $actualHash -eq $expectedHash

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$toolPresence = [ordered]@{
  node = Test-CommandPresent "node"
  npm = Test-CommandPresent "npm"
  bun = Test-CommandPresent "bun"
  git = Test-CommandPresent "git"
}
$noDevelopmentToolsOnPath = -not ($toolPresence.Values -contains $true)

$smokeExitCode = $null
$smokeTimedOut = $false
$smokeStdout = ""
$smokeStderr = ""
$offlineAuditPassed = $false
$outboundNetworkAttempts = $null
$startedAt = Get-Date
if ($hashMatches) {
  if (Test-Path -LiteralPath $smokeReportPath) { Remove-Item -LiteralPath $smokeReportPath -Force }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $artifactPath
  $startInfo.Arguments = "--smoke --offline-audit"
  $startInfo.WorkingDirectory = $kitRoot
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["PATH"] = Join-Path $env:SystemRoot "System32"
  $startInfo.EnvironmentVariables["ZHIBIAN_SMOKE_REPORT_PATH"] = $smokeReportPath
  $process = [System.Diagnostics.Process]::Start($startInfo)
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(180000)) {
    $smokeTimedOut = $true
    $process.Kill()
    $process.WaitForExit()
  } else {
    $smokeExitCode = $process.ExitCode
  }
  $smokeStdout = $stdoutTask.Result
  $smokeStderr = $stderrTask.Result
  if (Test-Path -LiteralPath $smokeReportPath -PathType Leaf) {
    try {
      $smokeReport = Get-Content -LiteralPath $smokeReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $outboundNetworkAttempts = $smokeReport.offlineAudit.networkAttempts
      $offlineAuditPassed = ($smokeReport.kind -eq "roomillion-smoke-report") -and
        ($smokeReport.formatVersion -eq "0.1") -and
        ($smokeReport.result -eq "PASS") -and
        ($smokeReport.offlineAudit.enabled -eq $true) -and
        ($outboundNetworkAttempts -eq 0)
    } catch {
      $offlineAuditPassed = $false
    }
  }
  $process.Dispose()
}
$elapsedSeconds = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)

$environmentQualified = (-not $isAdministrator) -and $noDevelopmentToolsOnPath
$automaticChecksPassed = $hashMatches -and (-not $smokeTimedOut) -and ($smokeExitCode -eq 0) -and $offlineAuditPassed
$result = [ordered]@{
  formatVersion = "0.1"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  artifact = [ordered]@{
    name = $ArtifactName
    bytes = (Get-Item -LiteralPath $artifactPath).Length
    expectedSha256 = $expectedHash
    actualSha256 = $actualHash
    hashMatches = $hashMatches
  }
  environment = [ordered]@{
    windowsVersion = [Environment]::OSVersion.Version.ToString()
    architecture = $env:PROCESSOR_ARCHITECTURE
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    currentProcessIsAdministrator = $isAdministrator
    developmentToolsOnPath = $toolPresence
    noDevelopmentToolsOnPath = $noDevelopmentToolsOnPath
    environmentQualified = $environmentQualified
  }
  automaticSmoke = [ordered]@{
    pathWasRestrictedToSystem32 = $true
    outboundNetworkAuditEnabled = $true
    outboundNetworkAttempts = $outboundNetworkAttempts
    outboundNetworkAuditPassed = $offlineAuditPassed
    exitCode = $smokeExitCode
    timedOut = $smokeTimedOut
    elapsedSeconds = $elapsedSeconds
    passed = $automaticChecksPassed
  }
  manualChecksStillRequired = @(
    "确认测试期间已物理断网或严格阻断出网",
    "记录是否出现 UAC、SmartScreen 或杀毒软件告警",
    "按试点验收手册完成数据、权限、AI 和诊断人工场景"
  )
  verdict = if ($automaticChecksPassed -and $environmentQualified) { "PASS" } elseif ($automaticChecksPassed) { "PASS_ENVIRONMENT_NOT_CLEAN" } else { "FAIL" }
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8
Write-Host ""
Write-Host "千万间 Roomillion 试点自动验收结果：$($result.verdict)"
Write-Host "哈希匹配：$hashMatches"
Write-Host "普通用户进程：$(-not $isAdministrator)"
Write-Host "PATH 无 Node/npm/Bun/Git：$noDevelopmentToolsOnPath"
Write-Host "便携版最小 PATH 冒烟退出码：$smokeExitCode"
Write-Host "本地闭环出站网络尝试为 0：$offlineAuditPassed"
Write-Host "结果文件：pilot-result.json"
Write-Host ""
Write-Host "请继续完成《试点验收手册》中的断网、SmartScreen 和用户任务。"

if ($automaticChecksPassed -and $environmentQualified) { exit 0 }
exit 1
