import crypto from 'crypto';
import fetch from 'node-fetch';

const BASE = process.env.BINANCE_FAPI || 'https://fapi.binance.com';

function sign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function signedGet(path, params, apiKey, apiSecret) {
  const q = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 });
  const qs = q.toString();
  const signature = sign(qs, apiSecret);
  const url = `${BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.msg || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export async function testKeys(apiKey, apiSecret) {
  await signedGet('/fapi/v2/account', {}, apiKey, apiSecret);
  return { ok: true };
}

function liqRisk(pct) {
  if (pct == null || !isFinite(pct)) return 'unknown';
  if (pct >= 20) return 'low';
  if (pct >= 10) return 'medium';
  if (pct >= 5) return 'high';
  return 'critical';
}

export async function fetchAccount(apiKey, apiSecret) {
  const acc = await signedGet('/fapi/v2/account', {}, apiKey, apiSecret);
  const positionsRaw = await signedGet('/fapi/v2/positionRisk', {}, apiKey, apiSecret);

  const balance = parseFloat(acc.totalWalletBalance || 0);
  const availableBalance = parseFloat(acc.availableBalance || 0);
  const unrealizedPnl = parseFloat(acc.totalUnrealizedProfit || 0);
  const totalMarginBalance = parseFloat(acc.totalMarginBalance || balance);
  const usedMargin = parseFloat(acc.totalInitialMargin || 0);
  const maintMargin = parseFloat(acc.totalMaintMargin || 0);
  const freeMargin = availableBalance;

  // per-position initial margin from /account (keyed symbol|positionSide)
  const imMap = {};
  for (const ap of acc.positions || []) {
    imMap[`${ap.symbol}|${ap.positionSide || 'BOTH'}`] = parseFloat(ap.initialMargin || ap.positionInitialMargin || 0);
  }

  const positions = (positionsRaw || [])
    .filter(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0)
    .map(p => {
      const amt = parseFloat(p.positionAmt);
      const mark = parseFloat(p.markPrice);
      const entry = parseFloat(p.entryPrice);
      const liq = parseFloat(p.liquidationPrice || 0);
      const upnl = parseFloat(p.unRealizedProfit || 0);
      const notional = Math.abs(amt * mark);
      const liqDistancePct = liq > 0 && mark > 0 ? (Math.abs(mark - liq) / mark * 100) : null;
      return {
        symbol: p.symbol,
        side: amt > 0 ? 'LONG' : 'SHORT',
        positionAmt: amt,
        contracts: Math.abs(amt),
        entryPrice: entry,
        markPrice: mark,
        liquidationPrice: liq,
        liqDistancePct,
        liqRisk: liqRisk(liqDistancePct),
        unRealizedProfit: upnl,
        notional,
        leverage: parseFloat(p.leverage || 0),
        marginType: p.marginType || 'cross',
        isolatedWallet: parseFloat(p.isolatedWallet || 0),
        initialMargin: imMap[`${p.symbol}|${p.positionSide || 'BOTH'}`]
          || (parseFloat(p.leverage || 0) > 0 ? notional / parseFloat(p.leverage) : 0),
      };
    });

  return {
    balance,
    equity: totalMarginBalance,          // wallet + unrealized PnL
    availableBalance,
    freeMargin,
    usedMargin,
    totalMarginBalance,
    maintMargin,
    unrealizedPnl,
    positions,
    updatedAt: new Date().toISOString(),
  };
}

export async function fetchFundingIncome(apiKey, apiSecret, { limit = 50 } = {}) {
  const rows = await signedGet('/fapi/v1/income', { incomeType: 'FUNDING_FEE', limit }, apiKey, apiSecret);
  return rows || [];
}

let premiumCache = { ts: 0, data: null };
export async function publicPremium(symbols = []) {
  const now = Date.now();
  if (!premiumCache.data || now - premiumCache.ts > 60_000) {
    const res = await fetch(`${BASE}/fapi/v1/premiumIndex`);
    const data = await res.json();
    if (Array.isArray(data)) {
      premiumCache = { ts: now, data };
    }
  }
  const data = premiumCache.data || [];
  if (!symbols.length) return data;
  const set = new Set(symbols);
  return data.filter(x => set.has(x.symbol));
}

let intervalCache = { ts: 0, map: {} };
/** { SYMBOL: hours } for symbols whose funding interval differs from 8h (cached 1h) */
export async function fundingIntervals() {
  const now = Date.now();
  if (now - intervalCache.ts < 3_600_000 && Object.keys(intervalCache.map).length) return intervalCache.map;
  try {
    const res = await fetch(`${BASE}/fapi/v1/fundingInfo`);
    const arr = await res.json();
    const map = {};
    if (Array.isArray(arr)) for (const x of arr) map[x.symbol] = Number(x.fundingIntervalHours) || 8;
    intervalCache = { ts: now, map };
  } catch (_) { /* keep old cache */ }
  return intervalCache.map;
}

const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD']);
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

/** All /fapi/v1/income rows of one type since sinceMs (Binance keeps ~3 months of income history) */
async function incomeAll(apiKey, apiSecret, incomeType, sinceMs) {
  const out = [];
  let start = Math.max(sinceMs, Date.now() - 89 * 86400000);
  for (let page = 0; page < 100; page++) {
    const rows = await signedGet('/fapi/v1/income',
      { incomeType, startTime: start, endTime: Date.now(), limit: 1000 }, apiKey, apiSecret);
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < 1000) break;
    start = Number(rows[rows.length - 1].time) + 1;
    await sleepMs(300);
  }
  return out;
}

/** Deposits (+) / withdrawals (−) of the futures wallet: [{ ref, ts, amount, asset }] */
export async function fetchTransfers(apiKey, apiSecret, sinceMs) {
  const rows = await incomeAll(apiKey, apiSecret, 'TRANSFER', sinceMs);
  return rows
    .filter(r => STABLE.has(String(r.asset || '').toUpperCase()))
    .map(r => ({ ref: `tr:${r.tranId || r.time}`, ts: Number(r.time), amount: parseFloat(r.income), asset: r.asset }))
    .filter(r => isFinite(r.amount) && r.amount !== 0);
}

/** Realized PnL fills: [{ ref, ts, symbol, pnl }] (events are grouped per symbol+minute when aggregated) */
export async function fetchRealizedPnl(apiKey, apiSecret, sinceMs) {
  const rows = await incomeAll(apiKey, apiSecret, 'REALIZED_PNL', sinceMs);
  return rows
    .filter(r => STABLE.has(String(r.asset || '').toUpperCase()))
    .map(r => ({ ref: `rp:${r.tradeId || r.tranId || r.time}:${r.symbol}`, ts: Number(r.time), symbol: r.symbol, pnl: parseFloat(r.income) }))
    .filter(r => isFinite(r.pnl) && Math.abs(r.pnl) > 1e-9);
}
