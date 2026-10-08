param(
    [Parameter(Mandatory = $true)][string]$Apk,
    [Parameter(Mandatory = $true)][string]$ExpectedSignerSha256,
    [Parameter(Mandatory = $true)][int]$ExpectedVersionCode,
    [Parameter(Mandatory = $true)][string]$ExpectedVersionName,
    [string]$ExpectedPackage = 'io.roomillion.android'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Apk -PathType Leaf)) { throw '找不到待验收的 APK' }
if ([System.IO.Path]::GetExtension($Apk) -ine '.apk') { throw '只能校验 APK 文件' }
if ($ExpectedVersionCode -lt 1) { throw '预期 versionCode 必须是正整数' }
$expectedSigner = $ExpectedSignerSha256.Replace(':', '').Trim().ToLowerInvariant()
if ($expectedSigner -notmatch '^[0-9a-f]{64}$') { throw '预期签名 SHA-256 指纹必须是 64 位十六进制字符' }
if ($ExpectedVersionName -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') {
    throw '预期 versionName 必须是语义版本号'
}
if ($ExpectedPackage -notmatch '^[A-Za-z][A-Za-z0-9_.]{2,199}$') { throw '预期包名无效' }
if ([string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) { throw '请设置 ANDROID_HOME' }
if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { throw '请设置 JAVA_HOME（JDK 17）' }
$apksigner = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\apksigner.bat'
$aapt = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\aapt.exe'
foreach ($tool in @($apksigner, $aapt)) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "缺少 Android 构建工具：$tool" }
}
$resolvedApk = (Resolve-Path -LiteralPath $Apk).Path
$signature = & $apksigner verify --verbose --print-certs $resolvedApk
if ($LASTEXITCODE -ne 0) { throw 'APK 签名校验失败' }
$signatureText = $signature -join "`n"
if ($signatureText -notmatch '(?m)^Number of signers:\s*1\s*$') { throw 'APK 必须恰好有一个签名者' }
if ($signatureText -notmatch '(?m)^Verified using v[23](?:\.1)? scheme[^:]*:\s*true\s*$') {
    throw 'APK 缺少有效的 v2/v3 签名'
}
$fingerprint = [regex]::Match($signatureText, '(?m)^Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\s*$')
if (-not $fingerprint.Success) { throw '无法读取 APK 签名指纹' }
$actualSigner = $fingerprint.Groups[1].Value.ToLowerInvariant()
if ($actualSigner -ne $expectedSigner) { throw 'APK 签名指纹与预期不一致' }

$badging = & $aapt dump badging $resolvedApk
if ($LASTEXITCODE -ne 0) { throw '无法读取 APK 包信息' }
$packageLine = $badging | Select-Object -First 1
$package = [regex]::Match($packageLine, "^package:\s+name='([^']+)'\s+versionCode='([0-9]+)'\s+versionName='([^']+)'" )
if (-not $package.Success) { throw '无法解析 APK 包名或版本' }
if ($package.Groups[1].Value -cne $ExpectedPackage) { throw 'APK 包名与预期不一致' }
if ([int64]$package.Groups[2].Value -ne $ExpectedVersionCode) { throw 'APK versionCode 与预期不一致' }
if ($package.Groups[3].Value -cne $ExpectedVersionName) { throw 'APK versionName 与预期不一致' }

$result = [ordered]@{
    apk = $resolvedApk
    package = $ExpectedPackage
    versionCode = $ExpectedVersionCode
    versionName = $ExpectedVersionName
    signerSha256 = $actualSigner
    apkSha256 = (Get-FileHash -LiteralPath $resolvedApk -Algorithm SHA256).Hash.ToLowerInvariant()
    verified = $true
}
$result | ConvertTo-Json -Depth 3
