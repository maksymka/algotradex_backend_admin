/** In-memory latest snapshots + funding ring log (persisted every sync) */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStrategy, listStrategiesPublic } from './store.js';
import * as binance from './binance.js';
import * as bybit from './bybit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FUNDING_FILE = path.join(DATA_DIR, 'funding.jsonl');

const latest = {};
const fundingLog = [];
const MAX_LOG = 5000;

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function appendFunding(rows) {
  if (!rows.length) return;
  ensureDataDir();
  const lines = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  try { fs.appendFileSync(FUNDING_FILE, lines); } catch (e) { console.warn('funding write', e.message); }
}

export function getLatest(id) {
  if (id === 'all') return { ...latest };
  return latest[id] || null;
}

export function getFundingLog(limit = 200) {
  return fundingLog.slice(-limit);
}

async function pullOne(id) {
  const s = getStrategy(id);
  if (!s || !s.enabled || !s.apiKey || !s.apiSecret) {
    latest[id] = { error: 'not configured', strategy: id, updatedAt: new Date().toISOString() };
    return latest[id];
  }
  try {
    let data;
    if (s.exchange === 'bybit') data = await bybit.fetchAccount(s.apiKey, s.apiSecret);
    else data = await binance.fetchAccount(s.apiKey, s.apiSecret);

    data.strategy = id;
    data.exchange = s.exchange;
    data.label = s.label;

    // public funding rates for open symbols (Binance premiumIndex works for USDT-M symbols)
    const fundRows = [];
    try {
      const syms = [...new Set((data.positions || []).map(p => p.symbol))];
      if (syms.length) {
        const prem = await binance.publicPremium(syms);
        const map = Object.fromEntries(prem.map(x => [x.symbol, x]));
        for (const p of data.positions) {
          const m = map[p.symbol];
          if (!m) continue;
          const rate = parseFloat(m.lastFundingRate || 0);
          p.lastFundingRate = rate;
          p.nextFundingTime = m.nextFundingTime ? new Date(Number(m.nextFundingTime)).toISOString() : null;
          fundRows.push({
            ts: new Date().toISOString(),
            strategy: id,
            symbol: p.symbol,
            side: p.side,
            rate,
            ratePct: rate * 100,
            notional: p.notional,
            contracts: p.contracts ?? Math.abs(p.positionAmt),
            markPrice: p.markPrice,
            liqDistancePct: p.liqDistancePct,
            liqRisk: p.liqRisk,
          });
        }
      }
    } catch (e) {
      console.warn('funding attach', id, e.message);
    }

    latest[id] = data;
    for (const r of fundRows) {
      fundingLog.push(r);
      if (fundingLog.length > MAX_LOG) fundingLog.shift();
    }
    appendFunding(fundRows);
    return data;
  } catch (e) {
    latest[id] = {
      error: e.message,
      strategy: id,
      updatedAt: new Date().toISOString(),
    };
    return latest[id];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function syncAll() {
  const ids = listStrategiesPublic().map(s => s.id);
  const results = {};
  for (const id of ids) {
    results[id] = await pullOne(id);
    // Binance bans aggressive REST — pause between strategies
    await sleep(2500);
  }
  return results;
}

export function startCron(ms = 60000) {
  const run = () => syncAll().catch(e => console.error('cron sync', e.message));
  run();
  setInterval(run, ms);
  console.log(`Sync cron every ${ms}ms → funding log ${FUNDING_FILE}`);
}
