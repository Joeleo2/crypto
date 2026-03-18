@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ═══════════════════════════════════════════════════════
::  CRYPTO TERMINAL v2.0  一键部署脚本
::  自动解压到 D:\workspace\币安交易，重启服务
:: ═══════════════════════════════════════════════════════

set "TARGET_DIR=D:\workspace\币安交易"
set "ZIP_FILE=%~dp0crypto-terminal.zip"
set "NODE_EXE=node"
set "PORT=3000"

echo.
echo  ╔═══════════════════════════════════════╗
echo  ║   CRYPTO TERMINAL v2.0  部署脚本      ║
echo  ╚═══════════════════════════════════════╝
echo.

:: ─── 1. 检查 Node.js ─────────────────────────────────
echo [1/5] 检查 Node.js 环境...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ✗ 未找到 Node.js，请先安装：
    echo    https://nodejs.org/  下载 LTS 版本
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  ✓ Node.js %NODE_VER%

:: ─── 2. 检查 ZIP 文件 ────────────────────────────────
echo [2/5] 检查安装包...
if not exist "%ZIP_FILE%" (
    echo  ✗ 未找到 crypto-terminal.zip
    echo    请将 deploy.bat 和 crypto-terminal.zip 放在同一目录
    pause
    exit /b 1
)
echo  ✓ 找到安装包: %ZIP_FILE%

:: ─── 3. 停止旧进程 ───────────────────────────────────
echo [3/5] 停止旧服务进程...
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo  → 停止端口 %PORT% 的进程 PID=%%p
    taskkill /F /PID %%p >nul 2>&1
)
:: 额外杀掉所有 server.js 进程
tasklist /fi "imagename eq node.exe" /fo csv 2>nul | findstr "node.exe" >nul
if %errorlevel% equ 0 (
    echo  → 清理残余 node 进程...
    for /f "tokens=2 delims=," %%p in ('wmic process where "name='node.exe' and commandline like '%%server.js%%'" get processid /format:csv 2^>nul ^| findstr /v "^$\|Node"') do (
        taskkill /F /PID %%~p >nul 2>&1
    )
)
timeout /t 1 /nobreak >nul
echo  ✓ 旧进程已清理

:: ─── 4. 解压到目标目录 ───────────────────────────────
echo [4/5] 解压文件到 %TARGET_DIR% ...

:: 创建目标目录
if not exist "%TARGET_DIR%" (
    mkdir "%TARGET_DIR%" 2>nul
    if %errorlevel% neq 0 (
        echo  ✗ 创建目录失败: %TARGET_DIR%
        echo    请检查磁盘权限
        pause
        exit /b 1
    )
    echo  → 已创建目录: %TARGET_DIR%
)

:: 清理旧文件（保留 data 目录 - 存有账户数据）
if exist "%TARGET_DIR%\server.js" (
    echo  → 清理旧版本文件...
    del /q "%TARGET_DIR%\*.js"   >nul 2>&1
    del /q "%TARGET_DIR%\*.json" >nul 2>&1
    del /q "%TARGET_DIR%\*.md"   >nul 2>&1
    if exist "%TARGET_DIR%\public" rmdir /s /q "%TARGET_DIR%\public" >nul 2>&1
)

:: 使用 PowerShell 解压（Windows 10+ 内置）
echo  → 正在解压...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%TEMP%\crypto_deploy' -Force; Write-Host 'OK' } catch { Write-Host 'FAIL:' $_.Exception.Message; exit 1 }"

if %errorlevel% neq 0 (
    echo  ✗ 解压失败，尝试备用方法...
    :: 备用：使用 jar（如果有 JDK）
    where jar >nul 2>&1
    if %errorlevel% equ 0 (
        cd /d "%TEMP%"
        mkdir crypto_deploy >nul 2>&1
        cd crypto_deploy
        jar xf "%ZIP_FILE%"
        cd /d "%~dp0"
    ) else (
        echo  ✗ 无法解压，请手动解压 crypto-terminal.zip 到 %TARGET_DIR%
        pause
        exit /b 1
    )
)

:: 拷贝解压内容（zip内有crypto子目录）
xcopy /E /Y /Q "%TEMP%\crypto_deploy\crypto\*" "%TARGET_DIR%\" >nul 2>&1
if %errorlevel% neq 0 (
    :: 尝试不带子目录
    xcopy /E /Y /Q "%TEMP%\crypto_deploy\*" "%TARGET_DIR%\" >nul 2>&1
)
rmdir /s /q "%TEMP%\crypto_deploy" >nul 2>&1

:: 验证
if not exist "%TARGET_DIR%\server.js" (
    echo  ✗ 解压后未找到 server.js，请手动检查
    pause
    exit /b 1
)
if not exist "%TARGET_DIR%\public\index.html" (
    echo  ✗ 解压后未找到 public\index.html
    pause
    exit /b 1
)
echo  ✓ 文件解压完成

:: ─── 5. 启动服务 ─────────────────────────────────────
echo [5/5] 启动 CRYPTO TERMINAL 服务...

:: 创建 data 目录
if not exist "%TARGET_DIR%\data" mkdir "%TARGET_DIR%\data"

:: 写启动脚本（供后续手动启动使用）
(
echo @echo off
echo chcp 65001 ^>nul
echo cd /d "%TARGET_DIR%"
echo echo 启动 CRYPTO TERMINAL...
echo echo 访问 http://localhost:%PORT%
echo node server.js
echo pause
) > "%TARGET_DIR%\start.bat"

:: 写停止脚本
(
echo @echo off
echo for /f "tokens=5" %%%%p in ^('netstat -aon 2^^^>nul ^^^| findstr ":%PORT% " ^^^| findstr "LISTENING"'^) do taskkill /F /PID %%%%p
echo echo 服务已停止
echo pause
) > "%TARGET_DIR%\stop.bat"

:: 在新窗口中启动服务
cd /d "%TARGET_DIR%"
start "CRYPTO TERMINAL" cmd /k "chcp 65001 && node server.js"

:: 等待服务启动
echo  → 等待服务启动...
timeout /t 3 /nobreak >nul

:: 验证端口
netstat -aon 2>nul | findstr ":%PORT% " | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo  ✓ 服务已在端口 %PORT% 启动
) else (
    echo  ⚠ 端口检测超时，服务可能仍在启动中...
)

:: 打开浏览器
echo  → 打开浏览器...
start "" "http://localhost:%PORT%"

echo.
echo  ╔═══════════════════════════════════════════════╗
echo  ║  ✓ 部署完成！                                 ║
echo  ║                                               ║
echo  ║  访问地址: http://localhost:%PORT%              ║
echo  ║  项目目录: %TARGET_DIR%  ║
echo  ║                                               ║
echo  ║  start.bat  → 手动启动服务                    ║
echo  ║  stop.bat   → 停止服务                        ║
echo  ╚═══════════════════════════════════════════════╝
echo.
pause
