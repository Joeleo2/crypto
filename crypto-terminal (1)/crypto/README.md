# CRYPTO TERMINAL v2.0

实时行情 + 模拟交易终端，零 npm 依赖，纯 Node.js 内置模块。

## 快速启动

```bash
node server.js
# 浏览器打开 http://localhost:3000
```

## 部署 & 更新工作流

### 首次部署（解压方式）
1. 将 `crypto-terminal.zip` 和 `deploy.bat` 放同一目录
2. 双击 `deploy.bat` → 自动解压到 `D:\workspace\币安交易` 并启动

### 绑定 GitHub（一次性）
1. 在 [github.com/new](https://github.com/new) 创建**空仓库**（不要加 README）
2. 双击 `github-init.bat` → 按提示输入用户名和仓库名
3. 完成后 `D:\workspace\币安交易` 就是一个 Git 仓库

### 绑定后的更新流程

| 场景 | 操作 |
|------|------|
| Claude 生成了新版本 | Claude 直接 `git push` 推送到你的仓库 |
| 你本地想同步最新版 | 双击 `deploy.bat` → 自动 `git pull` + 重启 |
| 你本地改了代码想保存 | 双击 `git-push.bat` → 输入说明，自动推送 |

## 脚本说明

| 脚本 | 用途 |
|------|------|
| `deploy.bat` | 智能部署：有 Git 仓库就 pull，没有就解压 zip |
| `github-init.bat` | 首次绑定 GitHub（只需运行一次） |
| `git-push.bat` | 推送本地修改到 GitHub |
| `start.bat` | 仅启动服务（不更新代码） |
| `stop.bat` | 停止服务 |

## API

| 路径 | 说明 |
|------|------|
| `GET /` | 前端页面 |
| `WS /ws` | 实时数据推送 |
| `GET /api/klines` | K线数据 |
| `POST /api/order` | 下单 |
| `DELETE /api/order` | 撤单 |
| `GET /api/account` | 账户信息 |
| `POST /api/account/reset` | 重置账户 |
