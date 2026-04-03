@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ═══════════════════════════════════════════════════════
::  CRYPTO TERMINAL - 智能部署脚本
::  · 已绑定 GitHub：自动 git pull 拉取最新版本
::  · 未绑定 GitHub：从 zip 包解压部署
:: ═══════════════════════════════════════════════════════

set "TARGET_DIR=D:\workspace\币安交易"
set "PORT=3000"

echo.
echo  ╔═══════════════════════════════════════╗
echo  ║   CRYPTO TERMINAL  智能部署           ║
echo  ╚═══════════════════════════════════════╝
echo.

:: ─── 1. 检查 Node.js ─────────────────────────────────
echo [1/4] 检查环境...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ✗ 未找到 Node.js，请先安装：https://nodejs.org/
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo  ✓ Node.js %%v

:: ─── 2. 停止旧进程 ───────────────────────────────────
echo [2/4] 停止旧服务...
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1
)
timeout /t 1 /nobreak >nul
echo  ✓ 旧进程已清理

:: ─── 3. 更新代码 ─────────────────────────────────────
echo [3/4] 更新代码...

:: 判断是否已绑定 GitHub
if exist "%TARGET_DIR%\.git" (
    echo  → 检测到 Git 仓库，从 GitHub 拉取最新版本...
    cd /d "%TARGET_DIR%"
    git fetch origin >nul 2>&1
    git pull origin main
    if !errorlevel! neq 0 (
        echo  ⚠ git pull 失败，尝试强制更新...
        git reset --hard origin/main
        git pull origin main
    )
    for /f "tokens=*" %%h in ('git log --oneline -1') do echo  ✓ 当前版本: %%h
    goto :start_server
)

:: 没有 Git，从 zip 解压
set "ZIP_FILE=%~dp0crypto-terminal.zip"
if not exist "%ZIP_FILE%" (
    echo  ✗ 未找到 crypto-terminal.zip，且未绑定 GitHub
    echo    请先运行 github-init.bat 绑定仓库，或放置 zip 包
    pause & exit /b 1
)
echo  → 从 zip 包解压...

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

:: 清理旧文件（保留 data 目录）
if exist "%TARGET_DIR%\server.js" (
    del /q "%TARGET_DIR%\*.js" >nul 2>&1
    del /q "%TARGET_DIR%\*.json" >nul 2>&1
    del /q "%TARGET_DIR%\*.md" >nul 2>&1
    del /q "%TARGET_DIR%\*.bat" >nul 2>&1
    if exist "%TARGET_DIR%\public" rmdir /s /q "%TARGET_DIR%\public" >nul 2>&1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%TEMP%\ct_deploy' -Force" >nul 2>&1

xcopy /E /Y /Q "%TEMP%\ct_deploy\crypto\*" "%TARGET_DIR%\" >nul 2>&1
if %errorlevel% neq 0 xcopy /E /Y /Q "%TEMP%\ct_deploy\*" "%TARGET_DIR%\" >nul 2>&1
rmdir /s /q "%TEMP%\ct_deploy" >nul 2>&1

if not exist "%TARGET_DIR%\server.js" (
    echo  ✗ 解压失败，请手动解压 zip 到 %TARGET_DIR%
    pause & exit /b 1
)
echo  ✓ 解压完成，运行 github-init.bat 可绑定 GitHub

:start_server
if not exist "%TARGET_DIR%\data" mkdir "%TARGET_DIR%\data" >nul 2>&1

:: ─── 4. 启动服务 ─────────────────────────────────────
echo [4/4] 启动服务...
cd /d "%TARGET_DIR%"
start "CRYPTO TERMINAL" cmd /k "chcp 65001 && echo CRYPTO TERMINAL 运行中... && echo 访问 http://localhost:%PORT% && node server.js"
timeout /t 3 /nobreak >nul

netstat -aon 2>nul | findstr ":%PORT% " | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo  ✓ 服务已启动
) else (
    echo  ⚠ 服务启动中，请稍候...
)
start "" "http://localhost:%PORT%"

echo.
echo  ╔═══════════════════════════════════════════════╗
echo  ║  ✓ 部署完成                                   ║
echo  ║  访问: http://localhost:%PORT%                   ║
echo  ║                                               ║
echo  ║  github-init.bat → 首次绑定 GitHub            ║
echo  ║  git-push.bat    → 推送代码到 GitHub           ║
echo  ║  deploy.bat      → 拉取最新版本并重启          ║
echo  ╚═══════════════════════════════════════════════╝
echo.
pause
