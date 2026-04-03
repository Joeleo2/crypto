@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ═══════════════════════════════════════════════════════
::  CRYPTO TERMINAL - GitHub 一次性初始化脚本
::  运行一次后，后续用 git-push.bat 一键同步
:: ═══════════════════════════════════════════════════════

set "TARGET_DIR=D:\workspace\币安交易"
set "REPO_NAME=crypto-terminal"

echo.
echo  ╔═══════════════════════════════════════════╗
echo  ║   GitHub 仓库初始化                       ║
echo  ╚═══════════════════════════════════════════╝
echo.

:: ─── 检查 Git ────────────────────────────────────────
echo [1/5] 检查 Git 环境...
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ✗ 未找到 Git，正在打开下载页面...
    start "" "https://git-scm.com/download/win"
    echo    请安装 Git 后重新运行此脚本
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('git --version') do echo  ✓ %%v

:: ─── 检查项目目录 ────────────────────────────────────
echo [2/5] 检查项目目录...
if not exist "%TARGET_DIR%\server.js" (
    echo  ✗ 未找到项目文件，请先运行 deploy.bat
    pause & exit /b 1
)
echo  ✓ 项目目录: %TARGET_DIR%

:: ─── 输入 GitHub 信息 ────────────────────────────────
echo [3/5] 配置 GitHub 信息
echo.
echo  请输入你的 GitHub 用户名（例如: johnsmith）：
set /p GH_USER=  用户名: 
if "%GH_USER%"=="" (echo  ✗ 用户名不能为空 & pause & exit /b 1)

echo.
echo  请输入仓库名（直接回车使用默认: %REPO_NAME%）：
set /p INPUT_REPO=  仓库名: 
if not "%INPUT_REPO%"=="" set "REPO_NAME=%INPUT_REPO%"

echo.
echo  ────────────────────────────────────────────
echo  将创建仓库: github.com/%GH_USER%/%REPO_NAME%
echo  ────────────────────────────────────────────
echo.
echo  ⚠ 请先在 GitHub 网站手动创建空仓库：
echo    1. 打开 https://github.com/new
echo    2. 仓库名填: %REPO_NAME%
echo    3. 选 Private 或 Public（推荐 Private）
echo    4. 【不要】勾选 README / .gitignore
echo    5. 点击 "Create repository"
echo.
echo  创建完成后按任意键继续...
pause >nul

:: ─── 初始化 Git ──────────────────────────────────────
echo [4/5] 初始化本地 Git 仓库...
cd /d "%TARGET_DIR%"

:: 创建 .gitignore
(
echo node_modules/
echo data/
echo *.log
echo .env
) > .gitignore

:: 初始化
git init >nul 2>&1
git config user.name "%GH_USER%"
git config user.email "%GH_USER%@users.noreply.github.com"

git add .
git commit -m "feat: initial commit - Crypto Terminal v2.0" >nul 2>&1
git branch -M main

:: 设置远程
set "REMOTE_URL=https://github.com/%GH_USER%/%REPO_NAME%.git"
git remote remove origin >nul 2>&1
git remote add origin "%REMOTE_URL%"

echo  ✓ 本地仓库初始化完成

:: ─── 推送 ────────────────────────────────────────────
echo [5/5] 推送到 GitHub...
echo.
echo  首次推送需要 GitHub 认证：
echo  - 浏览器会自动弹出授权页面，或
echo  - 输入你的 GitHub 用户名 + Personal Access Token
echo  （Token 创建: GitHub → Settings → Developer settings → Personal access tokens）
echo.

git push -u origin main
if %errorlevel% neq 0 (
    echo.
    echo  ✗ 推送失败，常见原因：
    echo    1. 仓库还未在 GitHub 创建
    echo    2. Token 权限不足（需要 repo 权限）
    echo    3. 网络问题
    echo.
    echo  请检查后重新运行此脚本
    pause & exit /b 1
)

:: ─── 生成 git-push.bat ───────────────────────────────
(
echo @echo off
echo chcp 65001 ^>nul
echo cd /d "%TARGET_DIR%"
echo echo 正在推送到 GitHub...
echo git add .
echo git status
echo set /p MSG=请输入提交信息 ^(直接回车使用默认^): 
echo if "%%MSG%%"=="" set MSG=update: sync latest version
echo git commit -m "%%MSG%%"
echo git push origin main
echo if %%errorlevel%% equ 0 ^(
echo   echo ✓ 推送成功！
echo   echo   https://github.com/%GH_USER%/%REPO_NAME%
echo ^) else ^(
echo   echo ✗ 推送失败，请检查网络
echo ^)
echo pause
) > "%TARGET_DIR%\git-push.bat"

echo.
echo  ╔═══════════════════════════════════════════════════╗
echo  ║  ✓ GitHub 初始化完成！                            ║
echo  ║                                                   ║
echo  ║  仓库地址: https://github.com/%GH_USER%/%REPO_NAME%
echo  ║                                                   ║
echo  ║  后续更新只需双击:                                ║
echo  ║    git-push.bat  → 推送最新代码到 GitHub          ║
echo  ╚═══════════════════════════════════════════════════╝
echo.
start "" "https://github.com/%GH_USER%/%REPO_NAME%"
pause
