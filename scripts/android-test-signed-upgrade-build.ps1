param()

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repository 'release'))
$name = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$output = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot (Join-Path 'android-upgrade-smoke' $name)))
if (-not $output.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase)) { throw '测试输出必须位于 release 目录内' }
if ([string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) { throw '请设置 ANDROID_HOME' }
if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { throw '请设置 JAVA_HOME（JDK 17）' }
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
$apksigner = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\apksigner.bat'
$aapt = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\aapt.exe'
foreach ($tool in @($keytool, $apksigner, $aapt)) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "缺少构建工具：$tool" }
}
New-Item -ItemType Directory -Path $output -Force | Out-Null
$keyFile = Join-Path $output 'test-only.p12'
$password = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$alias = 'roomillion-test'
try {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $keytool -genkeypair -alias $alias -keyalg RSA -keysize 3072 -validity 1 `
        -storetype PKCS12 -keystore $keyFile -storepass $password -keypass $password `
        -dname 'CN=Roomillion Android Test, O=Roomillion, C=CN' -noprompt *> (Join-Path $output 'keytool.log')
    $keytoolExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorAction
    if ($keytoolExitCode -ne 0) { throw '生成一次性测试签名失败' }
    $env:ROOMILLION_ANDROID_KEYSTORE = $keyFile
    $env:ROOMILLION_ANDROID_STORE_PASSWORD = $password
    $env:ROOMILLION_ANDROID_KEY_ALIAS = $alias
    $env:ROOMILLION_ANDROID_KEY_PASSWORD = $password

    Push-Location $repository
    try {
        $ErrorActionPreference = 'Continue'
        & npm.cmd run build:resources *> (Join-Path $output 'resources.log')
        $resourceExitCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($resourceExitCode -ne 0) { throw '安卓资源构建失败' }
    } finally { $ErrorActionPreference = 'Stop'; Pop-Location }

    Push-Location (Join-Path $repository 'android')
    try {
        foreach ($version in @(@{ Code = 1; Name = '0.1.0'; File = 'v1.apk' },
                               @{ Code = 2; Name = '0.1.1'; File = 'v2.apk' })) {
            $ErrorActionPreference = 'Continue'
            & .\gradlew.bat :app:assembleRelease "-ProomillionAndroidVersionCode=$($version.Code)" `
                "-ProomillionAndroidVersionName=$($version.Name)" --no-daemon --console=plain `
                *> (Join-Path $output ($version.File + '.build.log'))
            $gradleExitCode = $LASTEXITCODE
            $ErrorActionPreference = 'Stop'
            if ($gradleExitCode -ne 0) { throw "$($version.File) 构建失败" }
            Copy-Item -LiteralPath 'app\build\outputs\apk\release\app-release.apk' `
                -Destination (Join-Path $output $version.File)
        }
    } finally { $ErrorActionPreference = 'Stop'; Pop-Location }

    $packages = @()
    $signers = @()
    foreach ($version in @(@{ Code = 1; Name = '0.1.0'; File = 'v1.apk' },
                           @{ Code = 2; Name = '0.1.1'; File = 'v2.apk' })) {
        $apk = Join-Path $output $version.File
        $ErrorActionPreference = 'Continue'
        & $apksigner verify --verbose $apk *> (Join-Path $output ($version.File + '.signature.log'))
        $signExitCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($signExitCode -ne 0) { throw "$($version.File) 签名校验失败" }
        $certificate = & $apksigner verify --print-certs $apk
        if ($LASTEXITCODE -ne 0) { throw "$($version.File) 无法读取签名证书" }
        $fingerprint = [regex]::Match(($certificate -join "`n"),
            'Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})')
        if (-not $fingerprint.Success) { throw "$($version.File) 缺少签名指纹" }
        $signers += $fingerprint.Groups[1].Value.ToLowerInvariant()
        $badgingOutput = & $aapt dump badging $apk
        $aaptExitCode = $LASTEXITCODE
        $badging = $badgingOutput | Select-Object -First 1
        if ($aaptExitCode -ne 0 -or $badging -notmatch "versionCode='$($version.Code)'" -or
            $badging -notmatch "versionName='$([regex]::Escape($version.Name))'") {
            throw "$($version.File) 版本号不符合预期"
        }
        $packages += [ordered]@{ file = $version.File; versionCode = $version.Code
            versionName = $version.Name; sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
            signerSha256 = $signers[-1] }
    }
    if (@($signers | Select-Object -Unique).Count -ne 1) { throw '两版 APK 的签名者不一致' }
    $report = [ordered]@{ kind = 'ephemeral-test-signature'; createdAtUtc = [DateTime]::UtcNow.ToString('o')
        packages = $packages; signedAndVerified = $true; sameSigner = $true; deviceUpgradeTested = $false }
    [System.IO.File]::WriteAllText((Join-Path $output 'build-result.json'),
        ($report | ConvertTo-Json -Depth 5) + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "TEST_SIGNED_APKS_READY $output"
} finally {
    Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
    Remove-Item Env:ROOMILLION_ANDROID_KEYSTORE, Env:ROOMILLION_ANDROID_STORE_PASSWORD, `
        Env:ROOMILLION_ANDROID_KEY_ALIAS, Env:ROOMILLION_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
}
