# CRYPTO TERMINAL

实时加密货币行情终端，连接币安 API，**零 npm 依赖**，纯 Node.js 内置模块实现。

## 功能

- 📡 实时 WebSocket 行情（15 个主流交易对）
- 📊 K 线图（1m/5m/15m/1h/4h/1d）+ MA7/MA25 均线
- 📋 实时买卖盘口深度（20 档）
- 💹 实时成交记录流
- 🔄 自动节点切换（api.binance.vision / api1~3.binance.com）
- ⚡ 零依赖：仅用 Node.js 内置模块（http/https/crypto/fs）

## 快速启动

```bash
# 1. 进入目录
cd crypto-terminal

# 2. 启动服务（无需 npm install！）
node server.js

# 3. 浏览器打开
# http://localhost:3000
```

## 系统要求

- Node.js >= 16
- 能访问 api.binance.vision 的网络（国内可用的官方镜像）

## 架构

```
浏览器
  │  WebSocket (/ws)     ← 实时推送 ticker/depth/trade
  │  HTTP GET (/api/*)   ← 历史 K线
  ↓
server.js (Node.js)
  │  BinanceWS (手写 RFC6455 客户端)
  │    ├── miniTicker 全市场行情流
  │    ├── depth20 盘口深度流
  │    └── aggTrade 成交记录流
  │  HTTPS REST
  │    └── /api/v3/klines 历史K线
  ↓
Binance API
  ├── data-stream.binance.vision (WS 首选)
  └── api.binance.vision (REST 首选)
```

## API 路由

| 路径 | 说明 |
|------|------|
| `GET /` | 前端页面 |
| `WS /ws` | 实时数据推送 |
| `GET /api/klines?symbol=BTCUSDT&interval=1m&limit=200` | K线数据 |
| `GET /api/subscribe?symbol=ETHUSDT` | 订阅新品种深度+成交 |
| `GET /api/tickers` | 当前所有 ticker 快照 |
| `GET /api/status` | 服务状态 |
