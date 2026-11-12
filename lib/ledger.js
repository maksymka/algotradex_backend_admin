/**
 * Ledger: deposits/withdrawals (balance_flows) and closed-trade PnL (closed_pnl),
 * pulled from the exchanges every ~30 min and exposed as DAILY aggregates.
 */
import { supabase } from './supabase.js';
import { getStrategy, listStrategiesPublic } from './store.js';
import * as binance from './binance.js';
import * as bybit from './bybit.js';

const FIRST_MS = Date.parse(process.env.LEDGER_FROM || '2026-06-01T00:00:00Z');
const TZ = () => process.env.DAY_TZ || 'Europe/Kyiv';
const dayOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ() });

async function lastApiTs(table, id) {
  const { data, error } = await supabase.from(table).select('ts')
    .eq('strategy', id).eq('source', 'api').order('ts', { ascending: false }).limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
  return data && data[0] ? Date.parse(data[0].ts) : null;
}

async function upsertRows(table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict: 'strategy,ref' });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return rows.length;
}

let running = false;

/** Pull new flows + closed PnL for every configured strategy (or one id). Safe to call repeatedly. */
export async function syncLedger(onlyId) {
  if (running) return { skipped: 'already running' };
  running = true;
  const out = {};
  try {
    for (const info of listStrategiesPublic()) {
      const id = info.id;
      if (onlyId && id !== onlyId) continue;
      const s = getStrategy(id);
      if (!s || !s.enabled || !s.apiKey || !s.apiSecret) { out[id] = { skipped: 'not configured' }; continue; }
      const res = (out[id] = { flows: 0, trades: 0, errors: [] });
      const bybitEx = s.exchange === 'bybit';
      const ex = bybitEx ? bybit : binance;

      try {
        const last = await lastApiTs('balance_flows', id);
        const since = last ? Math.max(FIRST_MS, last - 2 * 86400000) : FIRST_MS;
        const flows = await ex.fetchTransfers(s.apiKey, s.apiSecret, since);
        res.flows = await upsertRows('balance_flows', flows.map(f => ({
          strategy: id, ref: f.ref, ts: new Date(f.ts).toISOString(), amount: f.amount, asset: f.asset || null, source: 'api',
        })));
      } catch (e) { res.errors.push('flows: ' + e.message); console.warn('[ledger] flows', id, e.message); }

      try {
        const last = await lastApiTs('closed_pnl', id);
        const since = last ? Math.max(FIRST_MS, last - 2 * 86400000) : FIRST_MS;
        const rows = bybitEx ? await bybit.fetchClosedPnl(s.apiKey, s.apiSecret, since)
                             : await binance.fetchRealizedPnl(s.apiKey, s.apiSecret, since);
        res.trades = await upsertRows('closed_pnl', rows.map(r => ({
          strategy: id, ref: r.ref, ts: new Date(r.ts).toISOString(), symbol: r.symbol, pnl: r.pnl, source: 'api',
        })));
      } catch (e) { res.errors.push('trades: ' + e.message); console.warn('[ledger] trades', id, e.message); }

      await new Promise(r => setTimeout(r, 1500));
    }
  } finally { running = false; }
  cache = {};
  return out;
}

async function fetchAll(table, cols) {
  const rows = [];
  for (let from = 0; from < 200000; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols)
      .order('ts', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

let cache = {};
async function cached(key, fn) {
  const c = cache[key];
  if (c && Date.now() - c.at < 60_000) return c.v;
  const v = await fn();
  cache[key] = { at: Date.now(), v };
  return v;
}

/** [{ strategy, day, amount }] net deposits(+)/withdrawals(−) per strategy and day */
export const flowsDaily = () => cached('flows', async () => {
  const rows = await fetchAll('balance_flows', 'strategy, ts, amount');
  const m = new Map();
  for (const r of rows) {
    const k = `${r.strategy}|${dayOf(r.ts)}`;
    m.set(k, (m.get(k) || 0) + Number(r.amount));
  }
  return [...m.entries()].map(([k, amount]) => {
    const [strategy, day] = k.split('|');
    return { strategy, day, amount: Math.round(amount * 100) / 100 };
  });
});

/** [{ strategy, day, wins, losses, gross_win, gross_loss }] — a "trade" = realized PnL of one symbol within one minute */
export const tradesDaily = () => cached('trades', async () => {
  const rows = await fetchAll('closed_pnl', 'strategy, ts, symbol, pnl');
  const ev = new Map();
  for (const r of rows) {
    const t = Date.parse(r.ts);
    const k = `${r.strategy}|${r.symbol}|${Math.floor(t / 60000)}`;
    const e = ev.get(k) || { strategy: r.strategy, t, pnl: 0 };
    e.pnl += Number(r.pnl);
    ev.set(k, e);
  }
  const days = new Map();
  for (const e of ev.values()) {
    if (Math.abs(e.pnl) < 1e-9) continue;
    const k = `${e.strategy}|${dayOf(e.t)}`;
    const d = days.get(k) || { wins: 0, losses: 0, gross_win: 0, gross_loss: 0 };
    if (e.pnl > 0) { d.wins++; d.gross_win += e.pnl; } else { d.losses++; d.gross_loss += -e.pnl; }
    days.set(k, d);
  }
  return [...days.entries()].map(([k, d]) => {
    const [strategy, day] = k.split('|');
    return { strategy, day, wins: d.wins, losses: d.losses,
             gross_win: Math.round(d.gross_win * 100) / 100, gross_loss: Math.round(d.gross_loss * 100) / 100 };
  });
});
