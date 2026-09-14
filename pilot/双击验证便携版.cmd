@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-pilot.ps1"
echo.
echo 验证结束。请保留 pilot-result.json，并继续按试点验收手册完成手工项目。
pause
