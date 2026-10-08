param(
    [ValidateSet('realAiDebateUsesTwoConfiguredModelsWhenCredentialIsStaged', 'realAiButtonsWorkInInventoryAndMeetingRoomsWhenCredentialIsStaged')]
    [string]$TestMethod = 'realAiDebateUsesTwoConfiguredModelsWhenCredentialIsStaged'
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($env:MIMO_API_KEY) -or -not $env:MIMO_API_KEY.StartsWith('tp-')) {
    throw '请在当前进程设置中国区 MiMo Token Plan 的 MIMO_API_KEY'
}
if ([string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) { throw '请设置 ANDROID_HOME' }
if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { throw '请设置 JAVA_HOME（JDK 17）' }
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw '找不到 Android adb' }
$avd = (& $adb emu avd name | Select-Object -First 1).Trim()
if ($avd -notlike 'roomillion-test-*') { throw '真实模型烟测只在 roomillion-test-* 专用模拟器运行' }

Push-Location (Join-Path $repository 'android')
try {
    & .\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon --console=plain
    if ($LASTEXITCODE -ne 0) { throw '安卓测试 APK 构建失败' }
} finally { Pop-Location }

& $adb install -r (Join-Path $repository 'android\app\build\outputs\apk\debug\app-debug.apk') | Out-Null
if ($LASTEXITCODE -ne 0) { throw '安卓宿主安装失败' }
& $adb install -r (Join-Path $repository 'android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk') | Out-Null
if ($LASTEXITCODE -ne 0) { throw '安卓测试包安装失败' }
& $adb shell run-as io.roomillion.android mkdir -p files
if ($LASTEXITCODE -ne 0) { throw '无法建立应用私有测试目录' }

try {
    $env:MIMO_API_KEY | & $adb shell "run-as io.roomillion.android sh -c 'cat > files/.real-ai-test-key'"
    if ($LASTEXITCODE -ne 0) { throw '无法写入临时测试凭据' }
    $result = & $adb shell am instrument -w -e class `
        "io.roomillion.android.RoomRuntimeTest#$TestMethod" `
        'io.roomillion.android.test/androidx.test.runner.AndroidJUnitRunner'
    $result | ForEach-Object { Write-Output $_ }
    if (($result -join "`n") -notmatch 'OK \(1 test\)') { throw '安卓真实双模型辩论烟测未通过' }
} finally {
    & $adb shell run-as io.roomillion.android rm -f files/.real-ai-test-key | Out-Null
}
