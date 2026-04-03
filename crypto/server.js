'use strict';
/**
 * Crypto Terminal v4.0
 * 实时行情 + 模拟交易 + 实盘交易
 * 代理方案：通过 HTTPS_PROXY 环境变量 + global-agent 实现全局代理
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const net    = require('net');
const tls    = require('tls');
const fs     = require('fs');
const path   = require('path');
const { EventEmitter } = require('events');

const PORT          = 3000;
const DATA_DIR      = path.join(__dirname, 'data');
const PAPER_FILE    = path.join(DATA_DIR, 'paper_trading.json');
const LIVE_CFG_FILE = path.join(DATA_DIR, 'live_config.json');

// ═══════════════════════════════════════════════════════
//  配置
// ═══════════════════════════════════════════════════════
const SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT',
  'MATICUSDT','UNIUSDT','LTCUSDT','ATOMUSDT','NEARUSDT',
];

const QUOTE_REST = ['api.binance.vision','api1.binance.com','api2.binance.com','api.binance.com'];
const QUOTE_WS   = ['data-stream.binance.vision','stream.binance.com'];
const TRADE_REST = ['api.binance.com','api1.binance.com','api2.binance.com','api3.binance.com'];

// 合约节点（与现货使用相同域名列表）
const FUTURE_REST = [...TRADE_REST];

const INITIAL_USDT = 100000;
const TAKER_FEE    = 0.001;
const MAKER_FEE    = 0.001;

// ═══════════════════════════════════════════════════════
//  全局代理管理（核心：替换 https.globalAgent）
// ═══════════════════════════════════════════════════════
let proxyAgent = null;  // 当前代理 Agent

function parseProxy(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: parseInt(u.port) || 8080 };
  } catch(e) { return null; }
}

/**
 * 创建一个通过 HTTP CONNECT 隧道的 HTTPS Agent
 * 每次请求时建立新的 TCP → TLS 连接
 */
class ProxyAgent extends https.Agent {
  constructor(proxyHost, proxyPort) {
    super({ keepAlive: false });
    this.proxyHost = proxyHost;
    this.proxyPort = proxyPort;
  }

  createConnection(options, callback) {
    // 先 TCP 连代理
    const sock = net.connect(this.proxyPort, this.proxyHost, () => {
      // 发 CONNECT 请求建立隧道
      const connect = `CONNECT ${options.host}:${options.port || 443} HTTP/1.1\r\nHost: ${options.host}:${options.port || 443}\r\n\r\n`;
      sock.write(connect);

      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const str = buf.toString();
        if (!str.includes('\r\n\r\n')) return; // 头还没收完
        sock.removeListener('data', onData);

        if (!str.startsWith('HTTP/1.1 200') && !str.startsWith('HTTP/1.0 200')) {
          const msg = str.split('\r\n')[0];
          return callback(new Error('代理拒绝: ' + msg));
        }

        // 升级为 TLS
        const tlsSock = tls.connect({
          socket: sock,
          host: options.host,
          servername: options.host,
          rejectUnauthorized: false,
        }, () => callback(null, tlsSock));
        tlsSock.on('error', callback);
      };
      sock.on('data', onData);
    });
    sock.on('error', (e) => callback(new Error('代理连接失败: ' + (e.code || e.message))));
    sock.setTimeout(10000, () => { sock.destroy(); callback(new Error('代理连接超时')); });
  }
}

function setProxy(proxyUrl) {
  if (!proxyUrl) {
    proxyAgent = null;
    console.log('[代理] 已关闭');
    return;
  }
  const p = parseProxy(proxyUrl);
  if (!p) { console.warn('[代理] 地址无效:', proxyUrl); return; }
  proxyAgent = new ProxyAgent(p.host, p.port);
  console.log(`[代理] 已设置: ${proxyUrl}`);
}

// ═══════════════════════════════════════════════════════
//  实盘配置（持久化）
// ═══════════════════════════════════════════════════════
const SALT = crypto.createHash('md5').update(require('os').hostname() + 'cryptex').digest('hex');

function encryptSecret(s) {
  const iv  = crypto.randomBytes(16);
  const key = crypto.scryptSync(SALT, 'salt', 32);
  const c   = crypto.createCipheriv('aes-256-cbc', key, iv);
  return iv.toString('hex') + ':' + c.update(s, 'utf8', 'hex') + c.final('hex');
}
function decryptSecret(enc) {
  try {
    const [ivHex, data] = enc.split(':');
    const key = crypto.scryptSync(SALT, 'salt', 32);
    const d   = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return d.update(data, 'hex', 'utf8') + d.final('utf8');
  } catch(e) { return ''; }
}

let liveConfig = { hasKey: false, apiKey: '', encSecret: '', proxy: '' };

function saveLiveConfig() {
  try { fs.writeFileSync(LIVE_CFG_FILE, JSON.stringify(liveConfig, null, 2)); } catch(e) {}
}
function loadLiveConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LIVE_CFG_FILE))
      liveConfig = JSON.parse(fs.readFileSync(LIVE_CFG_FILE, 'utf8'));
    // 如果配置里包含明文 apiSecret，自动加密并保存以便重启后可用
    if (liveConfig.apiSecret && !liveConfig.encSecret) {
      try {
        liveConfig.encSecret = encryptSecret(liveConfig.apiSecret);
        delete liveConfig.apiSecret;
        liveConfig.hasKey = true;
        saveLiveConfig();
        console.log('[实盘] 检测到明文 apiSecret，已加密并保存');
      } catch(e) { /* ignore */ }
    }
    if (liveConfig.proxy) setProxy(liveConfig.proxy);
    if (liveConfig.encSecret && !liveConfig.hasKey) liveConfig.hasKey = true;
    if (liveConfig.hasKey) console.log('[实盘] 已加载 API Key');
  } catch(e) {}
}

function getApiKey()    { return liveConfig.apiKey || ''; }
function getApiSecret() { return liveConfig.encSecret ? decryptSecret(liveConfig.encSecret) : ''; }

// ═══════════════════════════════════════════════════════
//  模拟账户
// ═══════════════════════════════════════════════════════
let paper = { balances: { USDT: INITIAL_USDT }, orders: [], openOrders: [], trades: [], createdAt: Date.now() };

function loadPaper() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(PAPER_FILE)) paper = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8'));
    console.log('[模拟] USDT:', (paper.balances.USDT||0).toFixed(2));
  } catch(e) {}
}
function savePaper() { try { fs.writeFileSync(PAPER_FILE, JSON.stringify(paper, null, 2)); } catch(e) {} }
setInterval(savePaper, 10000);

function pb(a)      { return paper.balances[a] || 0; }
function addPb(a,n) { paper.balances[a] = (paper.balances[a]||0)+n; if(paper.balances[a]<1e-10) paper.balances[a]=0; }
function base(sym)  { return sym.endsWith('USDT') ? sym.slice(0,-4) : sym.slice(0,-3); }

function paperEquity() {
  let t = pb('USDT');
  for (const [a,q] of Object.entries(paper.balances)) {
    if (a==='USDT'||a.endsWith('_FROZEN')||q<=0) continue;
    t += q * (state.tickers[a+'USDT']?.price||0);
  }
  return t;
}
function paperPositions() {
  const pos = [];
  for (const [a,q] of Object.entries(paper.balances)) {
    if (a==='USDT'||a.endsWith('_FROZEN')||q<=0) continue;
    const sym = a+'USDT', price = state.tickers[sym]?.price||0;
    const buys = paper.trades.filter(t=>t.symbol===sym&&t.side==='BUY');
    let tc=0,tq=0; buys.forEach(t=>{tc+=t.price*t.qty;tq+=t.qty;});
    const avg = tq>0?tc/tq:price;
    pos.push({ asset:a,symbol:sym,qty:q,avgCost:avg,currentPrice:price,
      marketValue:q*price,pnl:(price-avg)*q,pnlPct:avg>0?(price-avg)/avg*100:0 });
  }
  return pos;
}

function genId() { return 'SIM'+Date.now()+Math.random().toString(36).slice(2,6).toUpperCase(); }

function paperPlaceOrder({symbol,side,type,qty,price,quoteQty}) {
  const mp = state.tickers[symbol]?.price; if(!mp) throw new Error(`${symbol} 行情未就绪`);
  const asset=base(symbol), id=genId(), now=Date.now();
  if (type==='MARKET') {
    if (side==='BUY') {
      const spend=quoteQty?+quoteQty:(+qty)*mp, cost=spend*(1+TAKER_FEE);
      if(pb('USDT')<cost) throw new Error(`USDT不足(需${cost.toFixed(2)},有${pb('USDT').toFixed(2)})`);
      const eq=spend/mp; addPb('USDT',-cost); addPb(asset,eq);
      const t={tradeId:genId(),orderId:id,symbol,side,type,price:mp,qty:eq,fee:spend*TAKER_FEE,feeCoin:'USDT',time:now,status:'FILLED'};
      paper.orders.push(t); paper.trades.push(t); savePaper(); return t;
    } else {
      const eq=+qty; if(pb(asset)<eq) throw new Error(`${asset}不足`);
      const recv=eq*mp*(1-TAKER_FEE); addPb(asset,-eq); addPb('USDT',recv);
      const t={tradeId:genId(),orderId:id,symbol,side,type,price:mp,qty:eq,fee:eq*mp*TAKER_FEE,feeCoin:'USDT',time:now,status:'FILLED'};
      paper.orders.push(t); paper.trades.push(t); savePaper(); return t;
    }
  }
  if (type==='LIMIT') {
    if(!price||+price<=0) throw new Error('限价单需价格'); if(!qty||+qty<=0) throw new Error('数量须>0');
    const p=+price,q=+qty;
    if(side==='BUY'){const f=q*p*(1+MAKER_FEE);if(pb('USDT')<f)throw new Error(`USDT不足`);addPb('USDT',-f);addPb('USDT_FROZEN',f);}
    else {if(pb(asset)<q)throw new Error(`${asset}不足`);addPb(asset,-q);addPb(asset+'_FROZEN',q);}
    const o={orderId:id,symbol,side,type,qty:q,price:p,status:'NEW',time:now,execQty:0};
    paper.openOrders.push(o); paper.orders.push(o); savePaper(); return o;
  }
  throw new Error('不支持的类型');
}

function paperCancelOrder(orderId) {
  const idx=paper.openOrders.findIndex(o=>o.orderId===orderId); if(idx===-1) throw new Error('订单不存在');
  const o=paper.openOrders[idx], asset=base(o.symbol);
  if(o.side==='BUY'){const f=o.qty*o.price*(1+MAKER_FEE);addPb('USDT_FROZEN',-f);addPb('USDT',f);}
  else{addPb(asset+'_FROZEN',-o.qty);addPb(asset,o.qty);}
  o.status='CANCELED'; paper.openOrders.splice(idx,1);
  const h=paper.orders.find(x=>x.orderId===orderId); if(h) h.status='CANCELED';
  savePaper(); return o;
}

function matchPaper(symbol, mp) {
  paper.openOrders.filter(o=>o.symbol===symbol&&o.status==='NEW').forEach(o=>{
    if(!((o.side==='BUY'&&mp<=o.price)||(o.side==='SELL'&&mp>=o.price))) return;
    const asset=base(symbol),ep=o.price,eq=o.qty;
    if(o.side==='BUY'){addPb('USDT_FROZEN',-(eq*ep*(1+MAKER_FEE)));addPb(asset,eq);}
    else{addPb(asset+'_FROZEN',-eq);addPb('USDT',eq*ep*(1-MAKER_FEE));}
    o.status='FILLED'; o.execQty=eq; o.execPrice=ep; o.fillTime=Date.now();
    const t={tradeId:genId(),orderId:o.orderId,symbol,side:o.side,type:'LIMIT',
      price:ep,qty:eq,fee:eq*ep*MAKER_FEE,feeCoin:'USDT',time:o.fillTime,status:'FILLED'};
    paper.trades.push(t);
    const i=paper.openOrders.findIndex(x=>x.orderId===o.orderId); if(i!==-1) paper.openOrders.splice(i,1);
    broadcast({type:'order_filled',order:o,trade:t,mode:'paper',
      balances:paper.balances,equity:paperEquity(),positions:paperPositions()});
  });
}

function resetPaper() {
  paper={balances:{USDT:INITIAL_USDT},orders:[],openOrders:[],trades:[],createdAt:Date.now()};
  savePaper(); broadcast({type:'account_reset',mode:'paper',balances:paper.balances,equity:INITIAL_USDT,positions:[]});
}

// ═══════════════════════════════════════════════════════
//  行情 REST（带 agent 参数，自动走代理）
// ═══════════════════════════════════════════════════════
const state = { tickers:{}, klineCache:{}, quoteNode:0, wsNode:0, tradeNode:0, mode:'paper', timeOffset:0 };

// 同步币安服务器时间，用于修正本地时间戳偏差（返回的偏移为 serverTime - Date.now()）
async function syncServerTime() {
  for (let i = 0; i < TRADE_REST.length; i++) {
    const host = TRADE_REST[i];
    try {
      const r = await httpsGet(host, '/api/v3/time', {}, 5000);
      if (r && r.status === 200 && r.body && typeof r.body.serverTime === 'number') {
        state.timeOffset = r.body.serverTime - Date.now();
        state.tradeNode = i;
        console.log('[时间] 已同步币安服务器时间，偏移(ms):', state.timeOffset);
        return;
      }
    } catch (e) {
      // 尝试下一个节点
    }
  }
  console.warn('[时间] 无法同步币安服务器时间，保持本地时间');
}

function httpsGet(hostname, apiPath, headers={}, timeoutMs=15000) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, port:443, path:apiPath, method:'GET', headers,
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    };
    let done=false;
    const fin=f=>{if(!done){done=true;clearTimeout(timer);f();}};
    const req = https.request(opts, res => {
      const chunks=[];
      res.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
      res.on('end',()=>fin(()=>{
        const raw = Buffer.concat(chunks).toString('utf8');
        try{ resolve({status:res.statusCode, body:JSON.parse(raw)}); }
        catch(e){ reject(new Error('JSON解析失败: '+raw.slice(0,300))); }
      }));
      res.on('error',e=>fin(()=>reject(e)));
    });
    const timer=setTimeout(()=>{req.destroy();if(!done){done=true;reject(new Error('超时'));}},timeoutMs);
    req.on('error',e=>fin(()=>reject(e)));
    req.end();
  });
}

function httpsPost(hostname, apiPath, body, headers={}, timeoutMs=15000) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const opts = {
      hostname, port:443, path:apiPath, method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':buf.length, ...headers },
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    };
    let done=false;
    const fin=f=>{if(!done){done=true;clearTimeout(timer);f();}};
    const req = https.request(opts, res => {
      const chunks=[];
      res.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
      res.on('end',()=>fin(()=>{
        const raw = Buffer.concat(chunks).toString('utf8');
        try{ resolve({status:res.statusCode, body:JSON.parse(raw)}); }
        catch(e){ reject(new Error('JSON解析失败: '+raw.slice(0,300))); }
      }));
      res.on('error',e=>fin(()=>reject(e)));
    });
    const timer=setTimeout(()=>{req.destroy();if(!done){done=true;reject(new Error('超时'));}},timeoutMs);
    req.on('error',e=>fin(()=>reject(e)));
    req.write(buf); req.end();
  });
}

function httpsDelete(hostname, apiPath, body, headers={}, timeoutMs=15000) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const opts = {
      hostname, port:443, path:apiPath, method:'DELETE',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':buf.length, ...headers },
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    };
    let done=false;
    const fin=f=>{if(!done){done=true;clearTimeout(timer);f();}};
    const req = https.request(opts, res => {
      const chunks=[];
      res.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
      res.on('end',()=>fin(()=>{
        const raw = Buffer.concat(chunks).toString('utf8');
        try{ resolve({status:res.statusCode, body:JSON.parse(raw)}); }
        catch(e){ reject(new Error('JSON解析失败: '+raw.slice(0,300))); }
      }));
      res.on('error',e=>fin(()=>reject(e)));
    });
    const timer=setTimeout(()=>{req.destroy();if(!done){done=true;reject(new Error('超时'));}},timeoutMs);
    req.on('error',e=>fin(()=>reject(e)));
    req.write(buf); req.end();
  });
}

// 行情公开接口（多节点重试）
function quoteGet(apiPath, ms=15000) {
  const tryNode = async (idx) => {
    if (idx>=QUOTE_REST.length) throw new Error('所有行情节点不可用');
    try {
      const r = await httpsGet(QUOTE_REST[idx], apiPath, {
        'User-Agent':'CryptoTerminal/4.0','Accept':'application/json'
      }, ms);
      if (r.status!==200) { console.warn('[行情]',QUOTE_REST[idx],r.status); return tryNode(idx+1); }
      state.quoteNode=idx; return r.body;
    } catch(e) { console.warn('[行情]',QUOTE_REST[idx],e.message); return tryNode(idx+1); }
  };
  return tryNode(state.quoteNode);
}

// ═══════════════════════════════════════════════════════
//  实盘 API（带签名）
// ═══════════════════════════════════════════════════════
function sign(params, secret) {
  const qs = new URLSearchParams(params).toString();
  return qs + '&signature=' + crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

async function liveRequest(method, apiPath, params={}, ms=15000, allowRetry=true) {
  const apiKey = getApiKey(), apiSecret = getApiSecret();
  if (!apiKey||!apiSecret) throw new Error('未配置 API Key');

  // 使用与币安服务器同步后的时间戳，避免时间偏差错误
  const ts = Date.now() + (state.timeOffset || 0);
  const query = sign({ ...params, timestamp: ts, recvWindow:5000 }, apiSecret);
  const hdrs  = { 'X-MBX-APIKEY': apiKey, 'User-Agent':'CryptoTerminal/4.0' };
  const errors = [];

  for (let i=0; i<TRADE_REST.length; i++) {
    const host = TRADE_REST[i];
    try {
      let r;
      if (method==='GET')    r = await httpsGet(host, `${apiPath}?${query}`, hdrs, ms);
      else if(method==='POST')   r = await httpsPost(host, apiPath, query, hdrs, ms);
      else if(method==='DELETE') r = await httpsDelete(host, apiPath, query, hdrs, ms);

      const d = r.body;
      if (r.status >= 400) {
        const msg = d.msg || `HTTP ${r.status}`;
        // 业务错误直接抛，不重试
        if (d.code===-1021) throw new Error('时间戳偏差过大，请校准系统时间（误差需在±1秒内）');
        if (d.code===-2014) throw new Error('API Key 格式无效，请重新复制完整的 Key');
        if (d.code===-2015) throw new Error('API Key 无效 或 IP不在白名单，请去币安后台检查');
        if (d.code===-2011) throw new Error('订单不存在或已成交，无法撤单');
        if (d.code < 0) throw new Error(`[${d.code}] ${msg}`);
        errors.push(`${host}: HTTP${r.status}`); continue;
      }
      state.tradeNode = i;
      return d;
    } catch(e) {
      // 如果是时间戳偏差错误，尝试同步服务器时间后重试一次
      if (e.message && e.message.includes('时间戳') && allowRetry) {
        console.warn('[实盘] 检测到时间戳偏差，尝试同步服务器时间并重试...');
        try { await syncServerTime(); } catch (_) {}
        return liveRequest(method, apiPath, params, ms, false);
      }
      // 业务错误直接上抛
      if (e.message && (e.message.includes('API Key')||e.message.includes('白名单')||e.message.includes('订单不存在'))) throw e;
      errors.push(`${host}: ${e.code||e.message}`);
      console.warn(`[实盘] ${host} 失败:`, e.message);
    }
  }
  throw new Error('所有节点不可用 → ' + errors.join(' | '));
}

// ═══════════════════════════════════════════════════════
//  合约(Futures) API（USDT-M）
// ═══════════════════════════════════════════════════════
async function futuresRequest(method, apiPath, params={}, ms=15000, allowRetry=true) {
  const apiKey = getApiKey(), apiSecret = getApiSecret();
  if (!apiKey||!apiSecret) throw new Error('未配置 API Key');
  const ts = Date.now() + (state.timeOffset || 0);
  const query = sign({ ...params, timestamp: ts, recvWindow:5000 }, apiSecret);
  const hdrs  = { 'X-MBX-APIKEY': apiKey, 'User-Agent':'CryptoTerminal/4.0' };
  const errors = [];

  for (let i=0; i<FUTURE_REST.length; i++) {
    const host = FUTURE_REST[i];
    try {
      let r;
      if (method==='GET')    r = await httpsGet(host, `${apiPath}?${query}`, hdrs, ms);
      else if(method==='POST')   r = await httpsPost(host, apiPath, query, hdrs, ms);
      else if(method==='DELETE') r = await httpsDelete(host, apiPath, query, hdrs, ms);

      const d = r.body;
      if (r.status >= 400) {
        const msg = d.msg || `HTTP ${r.status}`;
        if (d.code < 0) throw new Error(`[${d.code}] ${msg}`);
        errors.push(`${host}: HTTP${r.status}`); continue;
      }
      return d;
    } catch(e) {
      if (e.message && e.message.includes('时间戳') && allowRetry) {
        console.warn('[合约] 检测到时间戳偏差，尝试同步服务器时间并重试...');
        try { await syncServerTime(); } catch (_) {}
        return futuresRequest(method, apiPath, params, ms, false);
      }
      errors.push(`${host}: ${e.code||e.message}`);
      console.warn(`[合约] ${host} 失败:`, e.message);
    }
  }
  throw new Error('所有合约节点不可用 → ' + errors.join(' | '));
}

async function testFuturesConn() {
  // 使用 USDT-M 账户信息接口做连通性测试
  const d = await futuresRequest('GET', '/fapi/v2/account');
  return { canTrade: !!d.canTrade, positions: d.positions?.filter(p=>parseFloat(p.positionAmt)!==0)||[] };
}

async function getFuturesAccount() {
  const acct = await futuresRequest('GET','/fapi/v2/account');
  const bals = {};
  // futures 返回的 balances 字段结构可能不同，这里尽量映射可用信息
  if (Array.isArray(acct.assets)) acct.assets.forEach(a=>{ bals[a.asset]={walletBalance:parseFloat(a.walletBalance),unrealizedPnL:parseFloat(a.unrealizedPnL)}; });
  const positions = (acct.positions||[]).filter(p=>parseFloat(p.positionAmt)!==0).map(p=>({symbol:p.symbol,positionAmt:parseFloat(p.positionAmt),entryPrice:parseFloat(p.entryPrice),unrealizedPnL:parseFloat(p.unrealizedProfit)}));
  return {balances:bals,positions,totalMaintMargin:acct.totalMaintMargin||0};
}

async function futuresPlaceOrder(opts){
  const {symbol,side,type,qty,price,quoteQty,reduceOnly,leverage,marginType,...rest} = opts || {};
  // 先获取并校验交易对规则（避免面值/最小下单量/步长错误）
  try {
    const info = await httpsGet('api.binance.com', `/fapi/v1/exchangeInfo?symbol=${symbol}`);
    if (info && info.status===200 && info.body && info.body.symbols && info.body.symbols.length){
      const s = info.body.symbols[0];
      const f = {};
      (s.filters||[]).forEach(x=>{ f[x.filterType]=x; });
      const minNotional = f.MIN_NOTIONAL ? parseFloat(f.MIN_NOTIONAL.minNotional) : (f.NOTIONAL?parseFloat(f.NOTIONAL.minNotional||f.NOTIONAL.minNotional):null);
      if (minNotional) {
        if (type==='MARKET' && side==='BUY'){
          const q = parseFloat(quoteQty||qty||0);
          if (q>0 && q < minNotional) throw new Error(`下单金额不足最小面值 (minNotional=${minNotional})`);
          if (!q){
            const p = state.tickers[symbol]?.price || 0;
            const estNotional = p * (parseFloat(qty)||0);
            if (estNotional && estNotional < minNotional) throw new Error(`估算下单面值 ${estNotional.toFixed(8)} 小于最小面值 ${minNotional}`);
          }
        } else {
          const p = (type==='LIMIT' && price)?parseFloat(price):(state.tickers[symbol]?.price||0);
          const estNotional = p * (parseFloat(qty)||0);
          if (estNotional && estNotional < minNotional) throw new Error(`下单面值 ${estNotional.toFixed(8)} 小于最小面值 ${minNotional}`);
        }
      }
      // LOT_SIZE 校验最小数量与步长
      if (f.LOT_SIZE){
        const minQty = parseFloat(f.LOT_SIZE.minQty);
        const stepSize = parseFloat(f.LOT_SIZE.stepSize);
        const qnum = parseFloat(type==='MARKET' && side==='BUY' ? (quoteQty||0) : qty) || 0;
        if (qnum>0 && minQty && qnum < minQty) throw new Error(`下单数量 ${qnum} 小于最小数量 ${minQty}`);
        if (qnum>0 && stepSize){
          // 强制按 stepSize 对齐（向下取整）
          const steps = Math.floor(qnum / stepSize);
          const adj = +(steps * stepSize).toFixed(8);
          if (adj<=0) throw new Error(`下单数量 ${qnum} 无法被步长 ${stepSize} 对齐`);
        }
      }
    }
  } catch(e){
    console.warn('[合约] 交易规则获取失败，跳过校验:', e.message);
  }

  // 应用用户指定的 marginType（先）和 leverage（后），忽略错误仅记录日志
  if (marginType){
    try{ await futuresRequest('POST','/fapi/v1/marginType',{symbol,marginType});
    }catch(e){ console.warn('[合约] 设置 marginType 失败:', e.message); }
  }
  if (typeof leverage!=='undefined' && leverage!==null && String(leverage)!==''){
    try{ await futuresRequest('POST','/fapi/v1/leverage',{symbol,leverage});
    }catch(e){ console.warn('[合约] 设置 leverage 失败:', e.message); }
  }

  const params = { symbol, side, type };
  if (type==='MARKET'){
    if (side==='BUY'){ params.quoteOrderQty = (quoteQty||qty||rest.quoteOrderQty); }
    else params.quantity = qty || rest.quantity;
  } else if (type==='LIMIT'){
    params.quantity = qty || rest.quantity; params.price = price || rest.price; params.timeInForce = rest.timeInForce || 'GTC';
  }
  if (typeof reduceOnly!=='undefined') params.reduceOnly = reduceOnly;

  // Forward commonly-used conditional/order params from client when present
  const allowed = ['stopPrice','activationPrice','workingType','positionSide','closePosition','callbackRate','newClientOrderId','origClientOrderId','timeInForce','priceProtect'];
  for (const k of allowed){ if (rest[k]!==undefined) params[k]=rest[k]; }

  return futuresRequest('POST','/fapi/v1/order',params);
}

async function futuresCancelOrder(symbol,orderId){
  return futuresRequest('DELETE','/fapi/v1/order',{symbol,orderId});
}

async function testLiveConn() {
  const d = await liveRequest('GET', '/api/v3/account');
  return {
    canTrade:    d.canTrade,
    canWithdraw: d.canWithdraw,
    accountType: d.accountType,
    balances:    d.balances.filter(b=>parseFloat(b.free)>0||parseFloat(b.locked)>0).slice(0,20),
  };
}

async function getLiveAccount() {
  const [acct, openOrders] = await Promise.all([
    liveRequest('GET', '/api/v3/account'),
    liveRequest('GET', '/api/v3/openOrders'),
  ]);
  const bals={};
  acct.balances.forEach(b=>{
    const f=parseFloat(b.free),l=parseFloat(b.locked);
    if(f>0||l>0) bals[b.asset]={free:f,locked:l,total:f+l};
  });
  let equity=bals['USDT']?.free||0;
  for(const [a,b] of Object.entries(bals)){
    if(a==='USDT') continue;
    equity += b.total*(state.tickers[a+'USDT']?.price||0);
  }
  const positions=Object.entries(bals).filter(([a])=>a!=='USDT').map(([a,b])=>({
    asset:a,symbol:a+'USDT',qty:b.total,currentPrice:state.tickers[a+'USDT']?.price||0,
    marketValue:b.total*(state.tickers[a+'USDT']?.price||0),
    free:b.free,locked:b.locked,avgCost:0,pnl:0,pnlPct:0,
  })).filter(p=>p.qty>0);
  return {balances:bals,openOrders,equity,positions};
}

async function livePlaceOrder({symbol,side,type,qty,price,quoteQty,quoteOrderQty}) {
  const params={symbol,side,type};
  // 先校验交易对最小面值（防止 [-1013] NOTIONAL 错误）
  try {
    const info = await httpsGet('api.binance.com', `/api/v3/exchangeInfo?symbol=${symbol}`);
    if (info && info.status===200 && info.body && info.body.symbols && info.body.symbols.length){
      const s = info.body.symbols[0];
      const f = {};
      (s.filters||[]).forEach(x=>{ f[x.filterType]=x; });
      const minNotional = f.MIN_NOTIONAL ? parseFloat(f.MIN_NOTIONAL.minNotional) : null;
      // 计算不论是以数量下单还是以报价下单，买单的面值
      if (minNotional) {
        if (type==='MARKET' && side==='BUY') {
          const q = parseFloat(quoteOrderQty||quoteQty||0);
          if (q>0 && q < minNotional) throw new Error(`下单金额不足最小面值 (minNotional=${minNotional})`);
          // 如果没有以金额下单，尝试用估算价格计算面值
          if (!q) {
            const p = state.tickers[symbol]?.price || 0;
            const estNotional = p * (parseFloat(qty)||0);
            if (estNotional && estNotional < minNotional) throw new Error(`估算下单面值 ${estNotional.toFixed(8)} 小于最小面值 ${minNotional}`);
          }
        } else {
          // SELL 或 LIMIT 等按数量/价格计算
          const p = (type==='LIMIT' && price)?parseFloat(price):(state.tickers[symbol]?.price||0);
          const estNotional = p * (parseFloat(qty)||0);
          if (estNotional && estNotional < minNotional) throw new Error(`下单面值 ${estNotional.toFixed(8)} 小于最小面值 ${minNotional}`);
        }
      }
    }
  } catch(e) {
    // 如果获取交易规则失败，不阻止下单，记录警告
    console.warn('[实盘] 无法获取交易对规则，跳过最小面值校验:', e.message);
  }
  if(type==='MARKET'){
    if(side==='BUY'){params.quoteOrderQty=(quoteOrderQty||quoteQty||qty);}
    else params.quantity=qty;
  } else if(type==='LIMIT'){
    params.quantity=qty; params.price=price; params.timeInForce='GTC';
  }
  return liveRequest('POST','/api/v3/order',params);
}

async function liveCancelOrder(symbol,orderId) {
  return liveRequest('DELETE','/api/v3/order',{symbol,orderId});
}

// ═══════════════════════════════════════════════════════
//  WebSocket 客户端（RFC 6455）
// ═══════════════════════════════════════════════════════
class BinanceWS extends EventEmitter {
  constructor(host,p){super();this.host=host;this.p=p;this.socket=null;this.dead=false;this.buf=Buffer.alloc(0);this._go();}
  _go(){
    if(this.dead)return;
    const key=crypto.randomBytes(16).toString('base64');
    const opts={hostname:this.host,port:443,path:this.p,method:'GET',
      headers:{Host:this.host,Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':key,'Sec-WebSocket-Version':'13'}};
    // WS 暂不走代理（行情 WS 走 binance.vision 已可用）
    const req=https.request(opts);
    req.on('upgrade',(r,s)=>{
      this.socket=s;this.buf=Buffer.alloc(0);
      s.on('data',d=>this._data(d));s.on('close',()=>this._close());s.on('error',e=>this._close(e));
      this.emit('open');
    });
    req.on('error',()=>this._retry());req.on('timeout',()=>{req.destroy();this._retry();});
    req.setTimeout(10000);req.end();
  }
  _data(chunk){
    this.buf=Buffer.concat([this.buf,chunk]);
    while(this.buf.length>=2){
      const b0=this.buf[0],b1=this.buf[1],op=b0&0xf,masked=(b1&0x80)!==0;
      let pl=b1&0x7f,off=2;
      if(pl===126){if(this.buf.length<4)break;pl=this.buf.readUInt16BE(2);off=4;}
      else if(pl===127){if(this.buf.length<10)break;pl=Number(this.buf.readBigUInt64BE(2));off=10;}
      const fl=off+(masked?4:0)+pl;if(this.buf.length<fl)break;
      let pay=this.buf.slice(off+(masked?4:0),fl);
      if(masked){const m=this.buf.slice(off,off+4);pay=Buffer.from(pay.map((b,i)=>b^m[i%4]));}
      this.buf=this.buf.slice(fl);
      if(op===0x8){this._close();break;}
      if(op===0x9){try{this.socket.write(Buffer.concat([Buffer.from([0x8a,pay.length]),pay]));}catch(e){}continue;}
      if(op===0x1||op===0x2){try{this.emit('message',JSON.parse(pay.toString('utf8')));}catch(e){}}
    }
  }
  _close(e){if(this.socket&&!this.socket.destroyed)this.socket.destroy();this.socket=null;if(!this.dead){this.emit('close');this._retry();}}
  _retry(){if(!this.dead)setTimeout(()=>this._go(),3000);}
  close(){this.dead=true;if(this.socket&&!this.socket.destroyed)this.socket.destroy();}
}

// ═══════════════════════════════════════════════════════
//  浏览器 WebSocket
// ═══════════════════════════════════════════════════════
const clients=new Set();

function handleBWS(req,socket){
  const key=req.headers['sec-websocket-key']; if(!key){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const c={socket,alive:true}; clients.add(c);
  wsend(c,{type:'snapshot',tickers:state.tickers});
  wsend(c,{type:'account_snapshot',mode:state.mode,
    balances:paper.balances,openOrders:paper.openOrders,
    trades:paper.trades.slice(-100),equity:paperEquity(),positions:paperPositions(),
    liveConfigured:liveConfig.hasKey, proxy:liveConfig.proxy||''});
  socket.on('close',()=>{c.alive=false;clients.delete(c);});
  socket.on('error',()=>{c.alive=false;clients.delete(c);});
  setInterval(()=>{if(c.alive&&!socket.destroyed)wwrite(socket,JSON.stringify({type:'ping'}));},25000);
}
function wwrite(s,txt){
  if(!s||s.destroyed)return;
  const p=Buffer.from(txt,'utf8'),n=p.length;
  let h;
  if(n<126)h=Buffer.from([0x81,n]);
  else if(n<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(n,2);}
  else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(n),2);}
  try{s.write(Buffer.concat([h,p]));}catch(e){}
}
function wsend(c,d){wwrite(c.socket,JSON.stringify(d));}
function broadcast(d,one=null){
  const t=JSON.stringify(d);
  if(one){wwrite(one.socket,t);return;}
  clients.forEach(c=>{if(c.alive&&!c.socket.destroyed)wwrite(c.socket,t);});
}

// ═══════════════════════════════════════════════════════
//  币安数据流
// ═══════════════════════════════════════════════════════
let mainWS=null; const symStreams={}; const klStreams={};

function connectMain(){
  const host=QUOTE_WS[state.wsNode%QUOTE_WS.length];
  const streams=SYMBOLS.map(s=>s.toLowerCase()+'@miniTicker').join('/');
  mainWS=new BinanceWS(host,'/stream?streams='+streams);
  mainWS.on('open',()=>{console.log('[行情] ✅',host);broadcast({type:'conn',status:'live',node:host});});
  mainWS.on('message',msg=>{
    const d=msg.data; if(!d?.s) return;
    const price=parseFloat(d.c),open=parseFloat(d.o);
    state.tickers[d.s]={price,chg:((price-open)/open*100).toFixed(2),
      high:parseFloat(d.h),low:parseFloat(d.l),vol:parseFloat(d.v),qvol:parseFloat(d.q),time:d.E};
    broadcast({type:'ticker',symbol:d.s,data:state.tickers[d.s]});
    matchPaper(d.s,price);
  });
  mainWS.on('close',()=>{state.wsNode++;broadcast({type:'conn',status:'reconnecting'});setTimeout(connectMain,3000);});
}

function subSym(sym,tf='1m'){
  const old=symStreams[sym]; if(old){old.depth?.close();old.trade?.close();}
  const host=QUOTE_WS[state.wsNode%QUOTE_WS.length],s=sym.toLowerCase();
  const depth=new BinanceWS(host,`/ws/${s}@depth20@100ms`);
  depth.on('message',msg=>broadcast({type:'depth',symbol:sym,asks:msg.asks||[],bids:msg.bids||[]}));
  const trade=new BinanceWS(host,`/ws/${s}@aggTrade`);
  trade.on('message',msg=>broadcast({type:'trade',symbol:sym,price:msg.p,qty:msg.q,isBuy:!msg.m,time:msg.T}));
  symStreams[sym]={depth,trade}; subKline(sym,tf);
}

function subKline(sym,tf){
  const key=sym+'_'+tf; klStreams[key]?.close();
  const ws=new BinanceWS(QUOTE_WS[state.wsNode%QUOTE_WS.length],`/ws/${sym.toLowerCase()}@kline_${tf}`);
  ws.on('message',msg=>{
    if(!msg.k)return; const k=msg.k,c={t:k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v};
    const cache=state.klineCache[key];
    if(cache?.data?.length){
      const last=cache.data[cache.data.length-1];
      if(last.t===c.t)cache.data[cache.data.length-1]=c;
      else if(k.x){cache.data.push(c);if(cache.data.length>300)cache.data.shift();}
    }
    broadcast({type:'kline',symbol:sym,tf,candle:c});
  });
  klStreams[key]=ws;
}

// ═══════════════════════════════════════════════════════
//  HTTP API
// ═══════════════════════════════════════════════════════
function readBody(req){
  return new Promise((res,rej)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>{try{res(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){res({});}});
    req.on('error',rej);
  });
}

async function handleAPI(req,res,pn){
  res.setHeader('Content-Type','application/json;charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const ok  =d=>{res.end(JSON.stringify({ok:true,...d}));};
  const fail=(e,code=400)=>{res.statusCode=code;res.end(JSON.stringify({ok:false,error:String(e?.message||e)}));};

  try {
    const u=new URL(req.url,'http://localhost');

    // ── 行情 ──
    if(pn==='/api/klines'&&req.method==='GET'){
      const sym=(u.searchParams.get('symbol')||'BTCUSDT').toUpperCase();
      const itv=u.searchParams.get('interval')||'1m';
      const lim=u.searchParams.get('limit')||'500';
      const ck=sym+'_'+itv;
      const cached=state.klineCache[ck];
      if(cached&&Date.now()-cached.ts<60000) return ok({data:cached.data,node:'cache',cached:true});
      const data=await quoteGet(`/api/v3/klines?symbol=${sym}&interval=${itv}&limit=${lim}`);
      if(!Array.isArray(data)||!data.length) throw new Error('空数据');
      const kl=data.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
      state.klineCache[ck]={data:kl,ts:Date.now()};
      return ok({data:kl,node:QUOTE_REST[state.quoteNode]});

    } else if(pn==='/api/subscribe'){
      const sym=(u.searchParams.get('symbol')||'BTCUSDT').toUpperCase();
      const tf=u.searchParams.get('tf')||'1m';
      subSym(sym,tf); return ok({symbol:sym,tf});

    } else if(pn==='/api/tickers'){
      return ok({data:state.tickers});

    // ── 代理配置 ──
    } else if(pn==='/api/live/proxy'&&req.method==='GET'){
      return ok({proxy:liveConfig.proxy||''});

    // ── 实盘 Key 配置（读取） ──
    } else if(pn==='/api/live/config'&&req.method==='GET'){
      // 返回已保存的 apiKey 与解密后的 secret（仅在本地 UI 使用）
      try {
        return ok({ apiKey: getApiKey(), apiSecret: getApiSecret(), hasKey: !!getApiKey() });
      } catch(e) { return ok({ apiKey:'', apiSecret:'', hasKey:false }); }

    } else if(pn==='/api/live/proxy'&&req.method==='POST'){
      const body=await readBody(req);
      const proxy=(body.proxy||'').trim();
      if(proxy&&!proxy.startsWith('http')) throw new Error('代理地址须以 http:// 开头');

      if(proxy){
        // 先测试代理端口 TCP 可达
        const p=parseProxy(proxy); if(!p) throw new Error('地址格式错误');
        await new Promise((res,rej)=>{
          const s=net.connect(p.port,p.host,()=>{s.destroy();res();});
          s.setTimeout(3000,()=>{s.destroy();rej(new Error(`代理端口 ${p.port} 无响应，请确认 Clash/V2Ray 已运行`));});
          s.on('error',e=>rej(new Error(`无法连接代理: ${e.code||e.message}`)));
        });
        // 设置代理 Agent 后测试访问币安
        setProxy(proxy);
        try {
          const r=await httpsGet('api.binance.com','/api/v3/ping',{},8000);
          if(r.status!==200) throw new Error(`币安返回 HTTP ${r.status}`);
        } catch(e) {
          setProxy(''); // 测试失败，回滚
          throw new Error(`代理端口可达，但访问币安失败: ${e.message}。请确认代理节点已选择且可用`);
        }
      } else {
        setProxy('');
      }

      liveConfig.proxy=proxy; saveLiveConfig();
      return ok({proxy, message:proxy?'✓ 代理验证通过并已保存':'代理已清除'});

    // ── 实盘 Key 配置 ──
    } else if(pn==='/api/live/config'&&req.method==='POST'){
      const body=await readBody(req);
      const {apiKey,apiSecret}=body;
      if(!apiKey||!apiSecret) throw new Error('apiKey 和 apiSecret 不能为空');
      liveConfig={...liveConfig,hasKey:true,apiKey,encSecret:encryptSecret(apiSecret)};
      saveLiveConfig(); return ok({message:'API Key 已保存',hasKey:true});

    } else if(pn==='/api/live/config'&&req.method==='DELETE'){
      liveConfig={...liveConfig,hasKey:false,apiKey:'',encSecret:''};
      saveLiveConfig(); state.mode='paper';
      return ok({message:'API Key 已清除'});

    // ── 测试连接 ──
    } else if(pn==='/api/live/test'&&req.method==='POST'){
      const body=await readBody(req);
      if(body.apiKey&&body.apiSecret){
        const orig={...liveConfig};
        liveConfig.apiKey=body.apiKey; liveConfig.encSecret=encryptSecret(body.apiSecret); liveConfig.hasKey=true;
        try{const info=await testLiveConn();saveLiveConfig();return ok({connected:true,...info});}
        catch(e){liveConfig=orig;throw e;}
      } else {
        return ok({connected:true,...(await testLiveConn())});
      }

    // ── 原始账户信息（调试用） ──
    } else if(pn==='/api/live/account_raw'&&req.method==='GET'){
      // 返回币安 /api/v3/account 的原始响应，便于诊断 canTrade 等字段
      try{
        const data = await liveRequest('GET','/api/v3/account');
        return ok({raw:data});
      }catch(e){ throw e; }

    // ── 诊断 ──
    } else if(pn==='/api/live/diagnose'&&req.method==='GET'){
      const dns=require('dns').promises;
      const results=[];
      for(const host of TRADE_REST){
        const r={host,dns:null,ping:null,proxy:liveConfig.proxy||null};
        try{
          const a=await dns.lookup(host); r.dns=a.address;
          // 直连 ping
          try{
            await new Promise((res,rej)=>{
              const req2=https.request({hostname:host,port:443,path:'/api/v3/ping',method:'GET',headers:{}},resp=>{
                resp.on('data',()=>{});resp.on('end',()=>{r.ping=resp.statusCode;res();});
              });
              req2.setTimeout(4000,()=>{req2.destroy();rej(new Error('ping超时'));});
              req2.on('error',rej);req2.end();
            });
          }catch(e){r.ping='FAIL:'+e.message;}
          // 如有代理再测一次
          if(liveConfig.proxy&&proxyAgent){
            try{
              const r2=await httpsGet(host,'/api/v3/ping',{},5000);
              r.proxyPing=r2.status;
            }catch(e){r.proxyPing='FAIL:'+e.message;}
          }
        }catch(e){
          if(!r.dns)r.dns='FAIL:'+e.message;
          else r.ping='FAIL:'+e.message;
        }
        results.push(r);
      }
      return ok({results,proxy:liveConfig.proxy||'',hasKey:!!getApiKey()});

    // ── 模式切换 ──
    } else if(pn==='/api/mode'&&req.method==='POST'){
      const body=await readBody(req);
      if((body.mode==='live' || body.mode==='futures') && !liveConfig.hasKey) throw new Error('请先配置 API Key');
      state.mode=body.mode;
      broadcast({type:'mode_change',mode:state.mode});
      return ok({mode:state.mode});

    // ── 账户 ──
    } else if(pn==='/api/account'&&req.method==='GET'){
      if(state.mode==='live'){
        const acct=await getLiveAccount();
        return ok({...acct,mode:'live',initialUsdt:0});
      } else if(state.mode==='futures'){
        const acct = await getFuturesAccount();
        return ok({...acct,mode:'futures'});
      } else {
        const eq=paperEquity(),pos=paperPositions();
        return ok({balances:paper.balances,openOrders:paper.openOrders,
          trades:paper.trades.slice(-200),orders:paper.orders.slice(-200),
          equity:eq,positions:pos,totalPnl:eq-INITIAL_USDT,
          totalPnlPct:(eq-INITIAL_USDT)/INITIAL_USDT*100,initialUsdt:INITIAL_USDT,mode:'paper'});
      }

    // ── 下单 ──
    } else if(pn==='/api/order'&&req.method==='POST'){
      const body=await readBody(req);
      let order;
      if(state.mode==='live'){
        order=await livePlaceOrder(body);
      } else if(state.mode==='futures'){
        order=await futuresPlaceOrder(body);
      } else {
        order=paperPlaceOrder(body);
        broadcast({type:'account_update',mode:'paper',balances:paper.balances,
          equity:paperEquity(),positions:paperPositions(),openOrders:paper.openOrders});
      }
      return ok({order,mode:state.mode});

    // ── 撤单 ──
    } else if(pn==='/api/order'&&req.method==='DELETE'){
      const body=await readBody(req);
      const oid=body.orderId||u.searchParams.get('orderId');
      if(!oid) throw new Error('缺少 orderId');
      let order;
      if(state.mode==='live'){
        const sym=body.symbol||activeSym;
        if(!sym) throw new Error('实盘撤单需提供 symbol');
        order=await liveCancelOrder(sym,oid);
      } else if(state.mode==='futures'){
        const sym=body.symbol||activeSym;
        if(!sym) throw new Error('合约撤单需提供 symbol');
        order=await futuresCancelOrder(sym,oid);
      } else {
        order=paperCancelOrder(oid);
        broadcast({type:'account_update',mode:'paper',balances:paper.balances,
          equity:paperEquity(),positions:paperPositions(),openOrders:paper.openOrders});
      }
      return ok({order,mode:state.mode});

    // ── 重置模拟 ──
    } else if(pn==='/api/account/reset'&&req.method==='POST'){
      resetPaper(); return ok({message:'模拟账户已重置',initialUsdt:INITIAL_USDT});

    // ── 状态 ──
    } else if(pn==='/api/status'){
      return ok({mode:state.mode,quoteNode:QUOTE_REST[state.quoteNode],
        wsNode:QUOTE_WS[state.wsNode%QUOTE_WS.length],
        clients:clients.size,tickers:Object.keys(state.tickers).length,
        liveReady:liveConfig.hasKey,proxy:liveConfig.proxy||''});

    } else {res.statusCode=404;res.end(JSON.stringify({ok:false,error:'Not found'}));}
  } catch(e) { console.error('[API]',pn,e.message); fail(e); }
}

// ── 静态文件 ──
const MIME={'.html':'text/html;charset=utf-8','.js':'application/javascript',
  '.css':'text/css','.json':'application/json','.png':'image/png'};
function serveStatic(req,res,pn){
  const fp=path.join(__dirname,'public',pn==='/'?'index.html':pn);
  const mime=MIME[path.extname(fp)]||'text/plain';
  fs.readFile(fp,(e,d)=>{if(e){res.statusCode=404;res.end('Not found');return;}res.setHeader('Content-Type',mime);res.end(d);});
}

// ── HTTP 服务器 ──
const server=http.createServer((req,res)=>{
  const pn=new URL(req.url,'http://localhost').pathname;
  pn.startsWith('/api/')?handleAPI(req,res,pn):serveStatic(req,res,pn);
});
server.on('upgrade',(req,socket)=>{req.url==='/ws'?handleBWS(req,socket):socket.destroy();});

server.listen(PORT,()=>{
  console.log(`
╔══════════════════════════════════════════╗
║  CRYPTO TERMINAL v4.0                    ║
║  http://localhost:${PORT}                   ║
║  模拟交易 · 实盘交易 · 实时行情           ║
╚══════════════════════════════════════════╝
`);
  loadPaper(); loadLiveConfig(); connectMain(); subSym('BTCUSDT','1m');
  // 启动时尝试同步币安服务器时间，减少时间偏差问题
  syncServerTime();
  // 如果配置文件已有 API Key，自动测试并报告连接状态
  if (liveConfig.hasKey) {
    (async ()=>{
      try {
        const info = await testLiveConn();
        console.log('[实盘] Spot 连接成功，可交易:', info.canTrade);
      } catch(e){ console.warn('[实盘] Spot 连接测试失败:', e.message); }
      try {
        const finfo = await testFuturesConn();
        console.log('[实盘] Futures 连接成功');
      } catch(e){ console.warn('[实盘] Futures 连接测试失败:', e.message); }
    })();
  }
});

process.on('SIGINT',()=>{savePaper();server.close(()=>process.exit(0));});
