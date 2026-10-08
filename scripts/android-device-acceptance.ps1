param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._:-]{3,120}$')]
    [string]$Serial,
    [switch]$AllowEmulator
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) { throw '请设置 ANDROID_HOME' }
if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { throw '请设置 JAVA_HOME（JDK 17）' }
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw '找不到 Android adb' }
$deviceLines = & $adb devices -l
if (-not ($deviceLines | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device\b" })) {
    throw '指定设备未连接或未授权 USB 调试'
}
$qemu = (& $adb -s $Serial shell getprop ro.kernel.qemu).Trim()
$emulator = $Serial.StartsWith('emulator-') -or $qemu -eq '1'
if ($emulator -and -not $AllowEmulator) { throw '真机验收不接受模拟器；脚本自测可显式传入 -AllowEmulator' }
$existing = (& $adb -s $Serial shell pm path io.roomillion.android 2>$null) -join "`n"
if ($existing -match 'package:') {
    throw '目标设备已安装千万间安卓宿主。请改用没有用户数据的专用测试设备；本脚本不会覆盖现有安装。'
}
$existingTest = (& $adb -s $Serial shell pm path io.roomillion.android.test 2>$null) -join "`n"
if ($existingTest -match 'package:') { throw '目标设备已安装旧测试包；请先在专用测试设备清理它' }

$reportDirectory = Join-Path $repository ('release\android-device-acceptance\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$manufacturer = (& $adb -s $Serial shell getprop ro.product.manufacturer).Trim()
$model = (& $adb -s $Serial shell getprop ro.product.model).Trim()
$api = (& $adb -s $Serial shell getprop ro.build.version.sdk).Trim()
$memoryLine = (& $adb -s $Serial shell cat /proc/meminfo | Select-Object -First 1).Trim()
$webview = (& $adb -s $Serial shell dumpsys webviewupdate | Where-Object { $_ -match 'Current WebView package' } | Select-Object -First 1)

Push-Location $repository
try {
    & npm.cmd run build:resources | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '公开资源构建失败' }
} finally { Pop-Location }

Push-Location (Join-Path $repository 'android')
try {
    & .\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug --no-daemon --console=plain | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '安卓 APK 构建或 Lint 失败' }
} finally { Pop-Location }

$appApk = Join-Path $repository 'android\app\build\outputs\apk\debug\app-debug.apk'
$testApk = Join-Path $repository 'android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
if (-not (Test-Path -LiteralPath $appApk) -or -not (Test-Path -LiteralPath $testApk)) {
    throw '缺少安卓宿主或测试 APK'
}
& $adb -s $Serial install $appApk | Out-Null
if ($LASTEXITCODE -ne 0) { throw '安卓宿主安装失败' }
& $adb -s $Serial install $testApk | Out-Null
if ($LASTEXITCODE -ne 0) { throw '安卓测试包安装失败' }

$raw = & $adb -s $Serial shell am instrument -w -r 'io.roomillion.android.test/androidx.test.runner.AndroidJUnitRunner' 2>&1
$exitCode = $LASTEXITCODE
$rawText = ($raw | ForEach-Object { "$_" }) -join "`n"
$rawPath = Join-Path $reportDirectory 'instrumentation.txt'
[System.IO.File]::WriteAllText($rawPath, $rawText + "`n", (New-Object System.Text.UTF8Encoding($false)))
$countMatch = [regex]::Match($rawText, 'OK \((\d+) tests?\)')
$testCount = if ($countMatch.Success) { [int]$countMatch.Groups[1].Value } else { 0 }
$skippedCount = [regex]::Matches($rawText, 'INSTRUMENTATION_STATUS_CODE:\s*-4').Count
$report = [ordered]@{
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    deviceSerial = $Serial
    emulator = $emulator
    manufacturer = $manufacturer
    model = $model
    androidApi = $api
    memory = $memoryLine
    webView = "$webview".Trim()
    appApkSha256 = (Get-FileHash -LiteralPath $appApk -Algorithm SHA256).Hash.ToLowerInvariant()
    testApkSha256 = (Get-FileHash -LiteralPath $testApk -Algorithm SHA256).Hash.ToLowerInvariant()
    instrumentationExitCode = $exitCode
    discoveredTests = $testCount
    skippedTests = $skippedCount
    passedTests = $testCount - $skippedCount
    passed = $exitCode -eq 0 -and $testCount -ge 56 -and $skippedCount -eq 2
    manualDeviceChecksPending = @('断网导入并使用物资台账、会议行动项', '触控与平板布局', '真实模型调用', '加密数据包迁移与恢复', '正式签名 APK 安装和升级')
}
$reportPath = Join-Path $reportDirectory 'result.json'
[System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 5) + "`n", (New-Object System.Text.UTF8Encoding($false)))
if (-not $report.passed) { throw "设备测试未通过；原始输出和设备信息保存在 $reportDirectory" }
Write-Output "设备自动测试通过：$testCount 项；报告保存在 $reportDirectory"
