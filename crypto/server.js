'use strict';
/**
 * Crypto Terminal v2.0 - 实时行情 + 模拟交易
 * 零依赖：仅使用 Node.js 内置模块
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { EventEmitter } = require('events');

const PORT      = 3000;
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'paper_trading.json');

const SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT',
  'MATICUSDT','UNIUSDT','LTCUSDT','ATOMUSDT','NEARUSDT',
];
const REST_HOSTS = ['api.binance.vision','api1.binance.com','api2.binance.com','api.binance.com'];
const WS_HOSTS   = ['data-stream.binance.vision','stream.binance.com'];
const INITIAL_USDT = 100000;
const TAKER_FEE    = 0.001;
const MAKER_FEE    = 0.001;

// ── 运行时 ──────────────────────────────────────────────
const state = { tickers:{}, klineCache:{}, restNode:0, wsNode:0 };

// ── 模拟账户 ────────────────────────────────────────────
let account = {
  balances:  { USDT: INITIAL_USDT },
  orders:    [],
  openOrders:[],
  trades:    [],
  createdAt: Date.now(),
};

function loadAccount() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive:true });
    if (fs.existsSync(DATA_FILE))
      account = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    console.log('[账户] 加载完成，USDT余额:', account.balances.USDT?.toFixed(2));
  } catch(e) { console.warn('[账户] 使用默认账户'); }
}
function saveAccount() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(account,null,2)); } catch(e){}
}
setInterval(saveAccount, 10000);

function getBalance(a) { return account.balances[a] || 0; }
function addBalance(a, n) {
  account.balances[a] = (account.balances[a]||0) + n;
  if (account.balances[a] < 1e-10) account.balances[a] = 0;
}
function baseAsset(sym) { return sym.endsWith('USDT') ? sym.slice(0,-4) : sym.slice(0,-3); }

function calcEquity() {
  let t = getBalance('USDT');
  for (const [a,q] of Object.entries(account.balances)) {
    if (a==='USDT'||a.endsWith('_FROZEN')||q<=0) continue;
    t += q * (state.tickers[a+'USDT']?.price||0);
  }
  return t;
}
function calcPositions() {
  const pos = [];
  for (const [a,q] of Object.entries(account.balances)) {
    if (a==='USDT'||a.endsWith('_FROZEN')||q<=0) continue;
    const sym = a+'USDT', price = state.tickers[sym]?.price||0;
    const buys = account.trades.filter(t=>t.symbol===sym&&t.side==='BUY');
    let tc=0,tq=0; buys.forEach(t=>{tc+=t.price*t.qty;tq+=t.qty;});
    const avg = tq>0?tc/tq:price;
    pos.push({ asset:a,symbol:sym,qty:q,avgCost:avg,currentPrice:price,
      marketValue:q*price,pnl:(price-avg)*q,pnlPct:avg>0?(price-avg)/avg*100:0 });
  }
  return pos;
}

// ── 交易引擎 ─────────────────────────────────────────────
function genId() { return 'SIM'+Date.now()+Math.random().toString(36).slice(2,6).toUpperCase(); }

function placeOrder({symbol,side,type,qty,price,quoteQty}) {
  const mp = state.tickers[symbol]?.price;
  if (!mp) throw new Error(`${symbol} 行情未就绪`);
  const asset = baseAsset(symbol);
  const id    = genId();
  const now   = Date.now();

  if (type === 'MARKET') {
    const ep = mp;
    if (side === 'BUY') {
      const spend = quoteQty ? +quoteQty : (+qty)*ep;
      const cost  = spend*(1+TAKER_FEE);
      if (getBalance('USDT')<cost) throw new Error(`USDT不足(需${cost.toFixed(2)},有${getBalance('USDT').toFixed(2)})`);
      const eq = spend/ep;
      addBalance('USDT',-cost); addBalance(asset,eq);
      const t={tradeId:genId(),orderId:id,symbol,side,type,price:ep,qty:eq,
        fee:spend*TAKER_FEE,feeCoin:'USDT',time:now,status:'FILLED'};
      account.orders.push(t); account.trades.push(t);
      saveAccount(); return t;
    } else {
      const eq = +qty;
      if (getBalance(asset)<eq) throw new Error(`${asset}不足(需${eq},有${getBalance(asset).toFixed(8)})`);
      const recv = eq*ep*(1-TAKER_FEE);
      addBalance(asset,-eq); addBalance('USDT',recv);
      const t={tradeId:genId(),orderId:id,symbol,side,type,price:ep,qty:eq,
        fee:eq*ep*TAKER_FEE,feeCoin:'USDT',time:now,status:'FILLED'};
      account.orders.push(t); account.trades.push(t);
      saveAccount(); return t;
    }
  }

  if (type === 'LIMIT') {
    if (!price||+price<=0) throw new Error('限价单需指定价格');
    if (!qty||+qty<=0)     throw new Error('数量须大于0');
    const p = +price, q = +qty;
    if (side === 'BUY') {
      const frozen = q*p*(1+MAKER_FEE);
      if (getBalance('USDT')<frozen) throw new Error(`USDT不足(需${frozen.toFixed(2)})`);
      addBalance('USDT',-frozen); addBalance('USDT_FROZEN',frozen);
    } else {
      if (getBalance(asset)<q) throw new Error(`${asset}不足`);
      addBalance(asset,-q); addBalance(asset+'_FROZEN',q);
    }
    const o={orderId:id,symbol,side,type,qty:q,price:p,status:'NEW',time:now,execQty:0};
    account.openOrders.push(o); account.orders.push(o);
    saveAccount(); return o;
  }
  throw new Error('不支持的订单类型:'+type);
}

function cancelOrder(orderId) {
  const idx = account.openOrders.findIndex(o=>o.orderId===orderId);
  if (idx===-1) throw new Error('订单不存在');
  const o = account.openOrders[idx];
  const asset = baseAsset(o.symbol);
  if (o.side==='BUY') {
    const f=o.qty*o.price*(1+MAKER_FEE);
    addBalance('USDT_FROZEN',-f); addBalance('USDT',f);
  } else {
    addBalance(asset+'_FROZEN',-o.qty); addBalance(asset,o.qty);
  }
  o.status='CANCELED';
  account.openOrders.splice(idx,1);
  const h=account.orders.find(x=>x.orderId===orderId);
  if(h)h.status='CANCELED';
  saveAccount(); return o;
}

function matchOpenOrders(symbol, mp) {
  account.openOrders.filter(o=>o.symbol===symbol&&o.status==='NEW').forEach(o=>{
    if (!((o.side==='BUY'&&mp<=o.price)||(o.side==='SELL'&&mp>=o.price))) return;
    const asset=baseAsset(symbol), ep=o.price, eq=o.qty;
    if (o.side==='BUY') {
      addBalance('USDT_FROZEN',-(eq*ep*(1+MAKER_FEE)));
      addBalance(asset,eq);
    } else {
      addBalance(asset+'_FROZEN',-eq);
      addBalance('USDT',eq*ep*(1-MAKER_FEE));
    }
    o.status='FILLED'; o.execQty=eq; o.execPrice=ep; o.fillTime=Date.now();
    const t={tradeId:genId(),orderId:o.orderId,symbol,side:o.side,type:'LIMIT',
      price:ep,qty:eq,fee:eq*ep*MAKER_FEE,feeCoin:'USDT',time:o.fillTime,status:'FILLED'};
    account.trades.push(t);
    const i=account.openOrders.findIndex(x=>x.orderId===o.orderId);
    if(i!==-1)account.openOrders.splice(i,1);
    broadcast({type:'order_filled',order:o,trade:t,balances:account.balances,
      equity:calcEquity(),positions:calcPositions()});
  });
}

function resetAccount() {
  account={balances:{USDT:INITIAL_USDT},orders:[],openOrders:[],trades:[],createdAt:Date.now()};
  saveAccount();
  broadcast({type:'account_reset',balances:account.balances,equity:INITIAL_USDT,positions:[]});
}

// ── REST ────────────────────────────────────────────────
function restGet(apiPath,ms=15000) {
  return new Promise((resolve,reject)=>{
    const go=idx=>{
      if(idx>=REST_HOSTS.length)return reject(new Error('所有节点不可用'));
      const host=REST_HOSTS[idx];
      let done=false;
      const fin=f=>{if(!done){done=true;clearTimeout(timer);f();}};
      const req=https.request({hostname:host,port:443,path:apiPath,method:'GET',
        headers:{'User-Agent':'CryptoTerminal/2.0','Accept':'application/json'}},res=>{
        const chunks=[];
        res.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
        res.on('end',()=>fin(()=>{
          if(res.statusCode!==200){console.warn('[REST]',host,res.statusCode);return go(idx+1);}
          try{state.restNode=idx;resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
          catch(e){go(idx+1);}
        }));
        res.on('error',()=>fin(()=>go(idx+1)));
      });
      const timer=setTimeout(()=>{req.destroy();if(!done){done=true;go(idx+1);}},ms);
      req.on('error',()=>fin(()=>go(idx+1)));
      req.end();
    };
    go(state.restNode);
  });
}

// ── WebSocket 客户端 ─────────────────────────────────────
class BinanceWS extends EventEmitter {
  constructor(host,p){super();this.host=host;this.p=p;this.socket=null;this.dead=false;this.buf=Buffer.alloc(0);this._go();}
  _go(){
    if(this.dead)return;
    const key=crypto.randomBytes(16).toString('base64');
    const req=https.request({hostname:this.host,port:443,path:this.p,method:'GET',
      headers:{Host:this.host,Upgrade:'websocket',Connection:'Upgrade',
               'Sec-WebSocket-Key':key,'Sec-WebSocket-Version':'13'}});
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

// ── 浏览器WS ─────────────────────────────────────────────
const clients=new Set();
function handleBWS(req,socket){
  const key=req.headers['sec-websocket-key'];if(!key){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const c={socket,alive:true};clients.add(c);
  send(c,{type:'snapshot',tickers:state.tickers});
  send(c,{type:'account_snapshot',balances:account.balances,openOrders:account.openOrders,
    trades:account.trades.slice(-100),equity:calcEquity(),positions:calcPositions()});
  socket.on('close',()=>{c.alive=false;clients.delete(c);});
  socket.on('error',()=>{c.alive=false;clients.delete(c);});
  setInterval(()=>{if(c.alive&&!socket.destroyed)wsWrite(socket,JSON.stringify({type:'ping'}));},25000);
}
function wsWrite(s,txt){
  if(!s||s.destroyed)return;
  const p=Buffer.from(txt,'utf8'),n=p.length;
  let h;
  if(n<126)h=Buffer.from([0x81,n]);
  else if(n<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(n,2);}
  else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(n),2);}
  try{s.write(Buffer.concat([h,p]));}catch(e){}
}
function send(c,d){wsWrite(c.socket,JSON.stringify(d));}
function broadcast(d,one=null){
  const t=JSON.stringify(d);
  if(one){wsWrite(one.socket,t);return;}
  clients.forEach(c=>{if(c.alive&&!c.socket.destroyed)wsWrite(c.socket,t);});
}

// ── 币安数据流 ───────────────────────────────────────────
let mainWS=null;const symStreams={};const klStreams={};

function connectMain(){
  const host=WS_HOSTS[state.wsNode%WS_HOSTS.length];
  const streams=SYMBOLS.map(s=>s.toLowerCase()+'@miniTicker').join('/');
  mainWS=new BinanceWS(host,'/stream?streams='+streams);
  mainWS.on('open',()=>{
    console.log('[Binance] ✅ miniTicker connected',host);
    broadcast({type:'conn',status:'live',node:host});
  });
  mainWS.on('message',msg=>{
    const d=msg.data;if(!d?.s)return;
    const price=parseFloat(d.c),open=parseFloat(d.o);
    state.tickers[d.s]={price,chg:((price-open)/open*100).toFixed(2),
      high:parseFloat(d.h),low:parseFloat(d.l),vol:parseFloat(d.v),qvol:parseFloat(d.q),time:d.E};
    broadcast({type:'ticker',symbol:d.s,data:state.tickers[d.s]});
    matchOpenOrders(d.s,price);
  });
  mainWS.on('close',()=>{state.wsNode++;broadcast({type:'conn',status:'reconnecting'});setTimeout(connectMain,3000);});
}

function subSym(sym,tf='1m'){
  const old=symStreams[sym];if(old){old.depth?.close();old.trade?.close();}
  const host=WS_HOSTS[state.wsNode%WS_HOSTS.length],s=sym.toLowerCase();
  const depth=new BinanceWS(host,`/ws/${s}@depth20@100ms`);
  depth.on('message',msg=>broadcast({type:'depth',symbol:sym,asks:msg.asks||[],bids:msg.bids||[]}));
  const trade=new BinanceWS(host,`/ws/${s}@aggTrade`);
  trade.on('message',msg=>broadcast({type:'trade',symbol:sym,price:msg.p,qty:msg.q,isBuy:!msg.m,time:msg.T}));
  symStreams[sym]={depth,trade};
  subKline(sym,tf);
}

function subKline(sym,tf){
  const key=sym+'_'+tf;klStreams[key]?.close();
  const host=WS_HOSTS[state.wsNode%WS_HOSTS.length];
  const ws=new BinanceWS(host,`/ws/${sym.toLowerCase()}@kline_${tf}`);
  ws.on('message',msg=>{
    if(!msg.k)return;const k=msg.k;
    const c={t:k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v};
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

// ── API 路由 ─────────────────────────────────────────────
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
  const ok=d=>res.end(JSON.stringify({ok:true,...d}));
  const fail=(e,code=400)=>{res.statusCode=code;res.end(JSON.stringify({ok:false,error:String(e?.message||e)}));};
  try{
    const u=new URL(req.url,'http://localhost');

    if(pn==='/api/klines'&&req.method==='GET'){
      const sym=(u.searchParams.get('symbol')||'BTCUSDT').toUpperCase();
      const itv=u.searchParams.get('interval')||'1m';
      const ck=sym+'_'+itv;
      const cached=state.klineCache[ck];
      if(cached&&Date.now()-cached.ts<60000)return ok({data:cached.data,node:'cache',cached:true});
      const lim=u.searchParams.get('limit')||'500';
      const data=await restGet(`/api/v3/klines?symbol=${sym}&interval=${itv}&limit=${lim}`);
      if(!Array.isArray(data)||!data.length)throw new Error('空数据');
      const kl=data.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
      state.klineCache[ck]={data:kl,ts:Date.now()};
      return ok({data:kl,node:REST_HOSTS[state.restNode]});

    } else if(pn==='/api/subscribe'){
      const sym=(u.searchParams.get('symbol')||'BTCUSDT').toUpperCase();
      const tf=u.searchParams.get('tf')||'1m';
      subSym(sym,tf);return ok({symbol:sym,tf});

    } else if(pn==='/api/tickers'){
      return ok({data:state.tickers});

    } else if(pn==='/api/account'&&req.method==='GET'){
      const eq=calcEquity(),pos=calcPositions();
      return ok({balances:account.balances,openOrders:account.openOrders,
        trades:account.trades.slice(-200),orders:account.orders.slice(-200),
        equity:eq,positions:pos,totalPnl:eq-INITIAL_USDT,
        totalPnlPct:(eq-INITIAL_USDT)/INITIAL_USDT*100,initialUsdt:INITIAL_USDT});

    } else if(pn==='/api/order'&&req.method==='POST'){
      const body=await readBody(req);
      const order=placeOrder(body);
      broadcast({type:'account_update',balances:account.balances,
        equity:calcEquity(),positions:calcPositions(),openOrders:account.openOrders});
      return ok({order});

    } else if(pn==='/api/order'&&req.method==='DELETE'){
      const body=await readBody(req);
      const oid=body.orderId||u.searchParams.get('orderId');
      if(!oid)throw new Error('缺少orderId');
      const order=cancelOrder(oid);
      broadcast({type:'account_update',balances:account.balances,
        equity:calcEquity(),positions:calcPositions(),openOrders:account.openOrders});
      return ok({order});

    } else if(pn==='/api/account/reset'&&req.method==='POST'){
      resetAccount();return ok({message:'账户已重置',initialUsdt:INITIAL_USDT});

    } else if(pn==='/api/status'){
      return ok({restNode:REST_HOSTS[state.restNode],wsNode:WS_HOSTS[state.wsNode%WS_HOSTS.length],
        clients:clients.size,tickers:Object.keys(state.tickers).length});

    } else {res.statusCode=404;res.end(JSON.stringify({ok:false,error:'Not found'}));}
  }catch(e){console.error('[API]',e.message);fail(e);}
}

// ── 静态文件 ─────────────────────────────────────────────
const MIME={'.html':'text/html;charset=utf-8','.js':'application/javascript',
  '.css':'text/css','.json':'application/json','.png':'image/png'};
function serveStatic(req,res,pn){
  const fp=path.join(__dirname,'public',pn==='/'?'index.html':pn);
  const mime=MIME[path.extname(fp)]||'text/plain';
  fs.readFile(fp,(e,d)=>{
    if(e){res.statusCode=404;res.end('Not found');return;}
    res.setHeader('Content-Type',mime);res.end(d);
  });
}

// ── HTTP 服务器 ───────────────────────────────────────────
const server=http.createServer((req,res)=>{
  const pn=new URL(req.url,'http://localhost').pathname;
  pn.startsWith('/api/')?handleAPI(req,res,pn):serveStatic(req,res,pn);
});
server.on('upgrade',(req,socket)=>{req.url==='/ws'?handleBWS(req,socket):socket.destroy();});
server.listen(PORT,()=>{
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  CRYPTO TERMINAL v2.0                 ║`);
  console.log(`║  http://localhost:${PORT}                ║`);
  console.log(`║  模拟交易 · 实时行情 · 零依赖          ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
  loadAccount();
  connectMain();
  subSym('BTCUSDT','1m');
});
process.on('SIGINT',()=>{saveAccount();server.close(()=>process.exit(0));});
