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

import { attachTargets } from './targets.js';

/** Open orders (reduce-only limits and conditional take-profits), normalized. Never throws. */
async function openOrdersNorm(apiKey, apiSecret) {
  const out = [];
  try {
    const r = await signedGet('/v5/order/realtime', { category: 'linear', settleCoin: 'USDT', limit: '50' }, apiKey, apiSecret);
    for (const o of r?.list || []) out.push({
      symbol: o.symbol, side: String(o.side).toUpperCase(),
      positionSide: o.positionIdx === 1 || o.positionIdx === '1' ? 'LONG' : o.positionIdx === 2 || o.positionIdx === '2' ? 'SHORT' : undefined,
      type: /TakeProfit/i.test(o.stopOrderType || '') ? 'TAKE_PROFIT' : o.orderType,
      price: parseFloat(o.price) || 0, trigger: parseFloat(o.triggerPrice) || 0,
      qty: parseFloat(o.leavesQty) || parseFloat(o.qty) || 0,
      reduceOnly: o.reduceOnly === true || o.reduceOnly === 'true', closePosition: o.closeOnTrigger === true || o.closeOnTrigger === 'true',
    });
  } catch (e) { console.warn('[bybit] open orders', e.message); }
  return out;
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
        takeProfitPx: parseFloat(p.takeProfit || 0),      // position-level TP set on the exchange
        leverage: parseFloat(p.leverage || 0),
        initialMargin: parseFloat(p.positionIM || 0) || (parseFloat(p.leverage || 0) > 0 ? notional / parseFloat(p.leverage) : 0),
      };
    });

  // take-profit targets: position-level TP + open closing orders
  if (positions.length) {
    const orders = await openOrdersNorm(apiKey, apiSecret);
    for (const p of positions) {
      if (p.takeProfitPx > 0) orders.push({ symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', positionSide: p.side, type: 'TAKE_PROFIT', trigger: p.takeProfitPx, closePosition: true });
    }
    for (const p of positions) p.contracts = Math.abs(p.positionAmt);
    attachTargets(positions, orders);
    for (const p of positions) delete p.takeProfitPx;
  }

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

/** USDT wallet balance after every transaction-log entry: [{ ts, cash }] (any order) */
export async function fetchBalanceHistory(apiKey, apiSecret, sinceMs) {
  const out = [];
  await eachWeek(sinceMs, async (a, b) => {
    let cursor = '';
    for (let i = 0; i < 400; i++) {
      const params = { accountType: 'UNIFIED', currency: 'USDT', startTime: String(a), endTime: String(b), limit: '50' };
      if (cursor) params.cursor = cursor;
      const r = await signedGet('/v5/account/transaction-log', params, apiKey, apiSecret);
      for (const x of r.list || []) {
        const cash = parseFloat(x.cashBalance);
        if (isFinite(cash)) out.push({ ts: Number(x.transactionTime), cash });
      }
      cursor = r.nextPageCursor;
      if (!cursor) break;
      await sleepMs(120);
    }
  });
  return out;
}

/** Executions (fills + funding settlements) since sinceMs → { fills, funding } for the trade history. */
export async function fetchTradeHistory(apiKey, apiSecret, sinceMs) {
  const fills = [], funding = [];
  await eachWeek(sinceMs, async (a, b) => {
    let cursor = '';
    for (let i = 0; i < 200; i++) {
      const params = { category: 'linear', startTime: String(a), endTime: String(b), limit: '100' };
      if (cursor) params.cursor = cursor;
      const r = await signedGet('/v5/execution/list', params, apiKey, apiSecret);
      for (const x of r.list || []) {
        const ts = Number(x.execTime);
        if (x.execType === 'Funding') {                                  // execFee > 0 = paid, < 0 = received
          const f = -parseFloat(x.execFee);
          if (isFinite(f)) funding.push({ ref: `fu:${x.symbol}:${x.execId}`, ts, symbol: x.symbol, funding: f });
          continue;
        }
        if (x.execType && !['Trade', 'AdlTrade', 'BustTrade'].includes(x.execType)) continue;
        const qty = parseFloat(x.execQty), price = parseFloat(x.execPrice), fee = parseFloat(x.execFee) || 0;
        const closed = Math.min(qty, parseFloat(x.closedSize) || 0), side = String(x.side).toUpperCase();
        const parts = [];
        if (closed > 0) parts.push({ q: closed, action: 'close', leg: side === 'SELL' ? 'LONG' : 'SHORT' });
        if (qty - closed > 1e-12) parts.push({ q: qty - closed, action: 'open', leg: side === 'BUY' ? 'LONG' : 'SHORT' });
        parts.forEach((p, i) => fills.push({ ref: `f:${x.symbol}:${x.execId}:${i}`, ts, symbol: x.symbol, side, leg: p.leg, action: p.action,
          qty: p.q, price, quote: p.q * price, fee: fee * (p.q / qty) }));
      }
      cursor = r.nextPageCursor;
      if (!cursor) break;
      await sleepMs(120);
    }
  });
  return { fills, funding };
}
