@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "TARGET_DIR=D:\workspace\币安交易"

cd /d "%TARGET_DIR%"

:: 检查是否初始化过
if not exist ".git" (
    echo  ✗ 未绑定 GitHub，请先运行 github-init.bat
    pause & exit /b 1
)

echo.
echo  ╔═══════════════════════════════════════╗
echo  ║   推送代码到 GitHub                   ║
echo  ╚═══════════════════════════════════════╝
echo.

git status --short
echo.
set /p MSG=  提交信息 (回车使用默认): 
if "%MSG%"=="" (
    for /f "tokens=*" %%t in ('powershell -command "Get-Date -Format \"yyyy-MM-dd HH:mm\""') do set DT=%%t
    set "MSG=update: sync !DT!"
)

git add .
git commit -m "%MSG%"
if %errorlevel% equ 0 (
    git push origin main
    if %errorlevel% equ 0 (
        echo.
        echo  ✓ 推送成功！
        for /f "tokens=*" %%u in ('git remote get-url origin') do echo  仓库: %%u
    ) else (
        echo  ✗ push 失败，请检查网络或 Token 是否过期
    )
) else (
    echo  → 没有新改动需要提交
)
echo.
pause
