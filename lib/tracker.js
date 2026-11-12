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

    // funding rates for open symbols: Bybit positions already carry Bybit's own rate (see bybit.js);
    // Binance accounts get Binance premiumIndex + real funding interval
    const fundRows = [];
    try {
      const syms = [...new Set((data.positions || []).map(p => p.symbol))];
      if (syms.length && s.exchange !== 'bybit') {
        const [prem, intervals] = await Promise.all([binance.publicPremium(syms), binance.fundingIntervals()]);
        const map = Object.fromEntries(prem.map(x => [x.symbol, x]));
        for (const p of data.positions) {
          const m = map[p.symbol];
          if (!m) continue;
          p.lastFundingRate = parseFloat(m.lastFundingRate || 0);
          p.fundingIntervalHours = intervals[p.symbol] || 8;
          p.nextFundingTime = m.nextFundingTime ? new Date(Number(m.nextFundingTime)).toISOString() : null;
        }
      }
      for (const p of data.positions || []) {
        if (p.lastFundingRate == null) continue;
        fundRows.push({
          ts: new Date().toISOString(),
          strategy: id,
          symbol: p.symbol,
          side: p.side,
          rate: p.lastFundingRate,
          ratePct: p.lastFundingRate * 100,
          intervalH: p.fundingIntervalHours || 8,
          notional: p.notional,
          contracts: p.contracts ?? Math.abs(p.positionAmt),
          markPrice: p.markPrice,
          liqDistancePct: p.liqDistancePct,
          liqRisk: p.liqRisk,
        });
      }
    } catch (e) {
      console.warn('funding attach', id, e.message);
    }

    latest[id] = data;

        // Записуємо баланс в історію для автоматичного денного PnL
    try {
      const { supabase } = await import('./supabase.js');
      const { data: insertedData, error: insertError } = await supabase
        .from('balance_history')
        .insert({
          strategy: id,
          balance: data.balance,
          recorded_at: new Date().toISOString() // <-- ДОДАНО ДАТУ
        });

      if (insertError) {
        console.error('❌ Помилка запису balance_history:', insertError);
      } else {
        console.log('✅ Успішно записано balance_history:', insertedData);
      }
    } catch (err) {
      console.error('❌ Критична помилка при записі balance_history:', err);
    }
    
    // Одна «закриваюча» цифра на день → стабільні денні PnL-бари (див. supabase_balance_daily.sql)
    try {
      const { supabase } = await import('./supabase.js');
      const { error: dailyErr } = await supabase
        .from('balance_daily')
        .upsert(
          { strategy: id, day: dayKey(), balance: data.balance, updated_at: new Date().toISOString() },
          { onConflict: 'strategy,day' }
        );
      if (dailyErr) console.warn('[balance_daily] upsert:', dailyErr.message);
    } catch (err) {
      console.warn('[balance_daily] failed:', err.message);
    }

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

/** YYYY-MM-DD in the dashboard's timezone (default Europe/Kyiv) */
export function dayKey(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: process.env.DAY_TZ || 'Europe/Kyiv' });
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
