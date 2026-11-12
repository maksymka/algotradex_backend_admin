import crypto from 'crypto';
import fetch from 'node-fetch';

const BASE = process.env.BYBIT_API || 'https://api.bybit.com';

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function signedGet(path, params, apiKey, apiSecret) {
  const ts = Date.now().toString();
  const recv = '5000';
  const q = new URLSearchParams(params).toString();
  const prehash = ts + apiKey + recv + q;
  const signature = sign(prehash, apiSecret);
  const url = `${BASE}${path}?${q}`;
  const res = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv,
    },
  });
  const data = await res.json();
  if (data.retCode !== 0) {
    const err = new Error(data.retMsg || 'Bybit error');
    err.body = data;
    throw err;
  }
  return data.result;
}

let tickerCache = { ts: 0, map: {} };
/** Public Bybit linear tickers → { SYMBOL: { rate, intervalH, nextFundingTime } } (cached 60s) */
export async function publicFunding() {
  const now = Date.now();
  if (now - tickerCache.ts < 60_000 && Object.keys(tickerCache.map).length) return tickerCache.map;
  const res = await fetch(`${BASE}/v5/market/tickers?category=linear`);
  const json = await res.json();
  const map = {};
  for (const t of json?.result?.list || []) {
    map[t.symbol] = {
      rate: parseFloat(t.fundingRate || 0),
      intervalH: Number(t.fundingIntervalHour) || 8,
      nextFundingTime: t.nextFundingTime ? new Date(Number(t.nextFundingTime)).toISOString() : null,
    };
  }
  tickerCache = { ts: now, map };
  return map;
}

export async function testKeys(apiKey, apiSecret) {
  await signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, apiKey, apiSecret);
  return { ok: true };
}

export async function fetchAccount(apiKey, apiSecret) {
  const wallet = await signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, apiKey, apiSecret);
  const list = wallet?.list?.[0];
  const coin = (list?.coin || []).find(c => c.coin === 'USDT') || {};
  const balance = parseFloat(coin.walletBalance || list?.totalEquity || 0);
  const unrealizedPnl = parseFloat(coin.unrealisedPnl || 0);

  const posRes = await signedGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }, apiKey, apiSecret);
  const positions = (posRes?.list || [])
    .filter(p => Math.abs(parseFloat(p.size || 0)) > 0)
    .map(p => {
      const size = parseFloat(p.size);
      const side = p.side === 'Buy' ? 'LONG' : 'SHORT';
      const mark = parseFloat(p.markPrice);
      const entry = parseFloat(p.avgPrice);
      const liq = parseFloat(p.liqPrice || 0);
      const upnl = parseFloat(p.unrealisedPnl || 0);
      const notional = Math.abs(size * mark);
      const liqDistancePct = liq > 0 && mark > 0 ? Math.abs(mark - liq) / mark * 100 : null;
      return {
        symbol: p.symbol,
        side,
        positionAmt: side === 'LONG' ? size : -size,
        entryPrice: entry,
        markPrice: mark,
        liquidationPrice: liq,
        liqDistancePct,
        unRealizedProfit: upnl,
        notional,
        leverage: parseFloat(p.leverage || 0),
        initialMargin: parseFloat(p.positionIM || 0) || (parseFloat(p.leverage || 0) > 0 ? notional / parseFloat(p.leverage) : 0),
      };
    });

  // Bybit's OWN funding rate / interval for the symbols that are really open
  try {
    const f = await publicFunding();
    for (const p of positions) {
      const m = f[p.symbol];
      if (!m) continue;
      p.lastFundingRate = m.rate;
      p.fundingIntervalHours = m.intervalH;
      p.nextFundingTime = m.nextFundingTime;
    }
  } catch (e) { console.warn('[bybit] funding attach', e.message); }

  const availableBalance = parseFloat(coin.availableToWithdraw || coin.equity || balance);
  const usedMargin = parseFloat(list?.totalInitialMargin || list?.totalPositionIM || 0);
  const equity = parseFloat(coin.equity || 0) || (balance + unrealizedPnl);   // wallet + unrealized PnL
  return {
    balance,
    equity,
    availableBalance,
    freeMargin: availableBalance,
    usedMargin,
    unrealizedPnl,
    positions: positions.map(p => ({
      ...p,
      contracts: Math.abs(p.positionAmt),
      liqRisk: (p.liqDistancePct == null ? 'unknown'
        : p.liqDistancePct >= 20 ? 'low'
        : p.liqDistancePct >= 10 ? 'medium'
        : p.liqDistancePct >= 5 ? 'high' : 'critical'),
    })),
    updatedAt: new Date().toISOString(),
  };
}

const STABLE = new Set(['USDT', 'USDC']);
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const WEEK = 7 * 86400000;

/** Bybit limits start→end to 7 days: walk [since, now] in weekly windows */
async function eachWeek(sinceMs, fn) {
  const now = Date.now();
  for (let a = sinceMs; a < now; a += WEEK) {
    await fn(a, Math.min(a + WEEK - 1000, now));
    await sleepMs(150);
  }
}

/** Deposits (+) / withdrawals (−) of the unified account via transaction-log TRANSFER_IN / TRANSFER_OUT */
export async function fetchTransfers(apiKey, apiSecret, sinceMs) {
  const out = [];
  for (const type of ['TRANSFER_IN', 'TRANSFER_OUT']) {
    await eachWeek(sinceMs, async (a, b) => {
      let cursor = '';
      for (let i = 0; i < 50; i++) {
        const params = { accountType: 'UNIFIED', type, startTime: String(a), endTime: String(b), limit: '50' };
        if (cursor) params.cursor = cursor;
        const r = await signedGet('/v5/account/transaction-log', params, apiKey, apiSecret);
        for (const x of r.list || []) {
          if (!STABLE.has(String(x.currency || '').toUpperCase())) continue;
          const mag = Math.abs(parseFloat(x.change || x.cashFlow || 0));
          if (!mag) continue;
          out.push({ ref: `${type}:${x.id || x.transactionTime}`, ts: Number(x.transactionTime),
                     amount: type === 'TRANSFER_IN' ? mag : -mag, asset: x.currency });
        }
        cursor = r.nextPageCursor;
        if (!cursor) break;
      }
    });
  }
  return out;
}

/** Closed positions with their PnL (net of fees): [{ ref, ts, symbol, pnl }] */
export async function fetchClosedPnl(apiKey, apiSecret, sinceMs) {
  const out = [];
  await eachWeek(sinceMs, async (a, b) => {
    let cursor = '';
    for (let i = 0; i < 50; i++) {
      const params = { category: 'linear', startTime: String(a), endTime: String(b), limit: '100' };
      if (cursor) params.cursor = cursor;
      const r = await signedGet('/v5/position/closed-pnl', params, apiKey, apiSecret);
      for (const x of r.list || []) {
        const pnl = parseFloat(x.closedPnl);
        if (!isFinite(pnl) || Math.abs(pnl) < 1e-9) continue;
        out.push({ ref: `cp:${x.orderId}`, ts: Number(x.updatedTime || x.createdTime), symbol: x.symbol, pnl });
      }
      cursor = r.nextPageCursor;
      if (!cursor) break;
    }
  });
  return out;
}
