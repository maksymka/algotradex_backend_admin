/**
 * Backfill of PAST daily balances into balance_daily from the exchanges' own history.
 *  - Bybit  : transaction-log gives the wallet balance after every entry (cashBalance) → last entry of the day.
 *  - Binance: income history is walked BACKWARDS from the current wallet balance (Binance keeps ~3 months).
 * Only days that are not in balance_daily yet are inserted (tracked days are never overwritten).
 * Balance only — equity / intraday min-max are unknown for past days.
 */
import { supabase } from './supabase.js';
import { getStrategy, listStrategiesPublic } from './store.js';
import * as binance from './binance.js';
import * as bybit from './bybit.js';

const TZ = () => process.env.DAY_TZ || 'Europe/Kyiv';
const dayOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ() });
const DEFAULT_FROM = { alpha: '2026-06-01', beta: '2026-06-01', gamma: '2026-10-08', delta: '2026-10-26' };

function* daysBetween(fromDay, toDayExclusive) {
  let d = new Date(fromDay + 'T12:00:00Z');
  const end = new Date(toDayExclusive + 'T12:00:00Z');
  while (d < end) { yield d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000); }
}

async function trackedDays(id) {
  const { data, error } = await supabase.from('balance_daily').select('day').eq('strategy', id).limit(5000);
  if (error) throw new Error('balance_daily: ' + error.message);
  return new Set((data || []).map(r => String(r.day)));
}

async function bybitDaily(s, fromDay) {
  const since = Date.parse(fromDay + 'T00:00:00Z') - 86400000;       // 1 extra day so the first day has a "previous" balance
  const rows = await bybit.fetchBalanceHistory(s.apiKey, s.apiSecret, since);
  const last = new Map();                                              // day -> { ts, cash }
  for (const r of rows) {
    const d = dayOf(r.ts);
    const p = last.get(d);
    if (!p || r.ts > p.ts) last.set(d, r);
  }
  return d => (last.has(d) ? last.get(d).cash : null);                 // null = no entries that day (caller carries forward)
}

async function binanceDaily(s, fromDay) {
  const limitMs = Date.now() - binance.INCOME_HISTORY_DAYS * 86400000;
  const since = Math.max(Date.parse(fromDay + 'T00:00:00Z') - 86400000, limitMs);
  const [acc, rows] = await Promise.all([
    binance.fetchAccount(s.apiKey, s.apiSecret),
    binance.fetchAllIncome(s.apiKey, s.apiSecret, since),
  ]);
  const byDay = new Map();
  for (const r of rows) byDay.set(dayOf(r.ts), (byDay.get(dayOf(r.ts)) || 0) + r.amount);
  const today = dayOf(Date.now());
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const first = dayOf(since + 86400000);
  // closing(D) = current balance − everything that happened AFTER day D (quiet days included)
  const closing = new Map();
  let after = 0;
  for (const d of [...daysBetween(first, tomorrow)].reverse()) {
    closing.set(d, acc.balance - after);
    after += byDay.get(d) || 0;
  }
  const earliest = dayOf(since + 86400000);
  return { get: d => closing.get(d) ?? null, earliest, limitedBy3m: since === limitMs };
}

/** Fill missing past days for one strategy (or all). opts: { from: 'YYYY-MM-DD', force: bool } */
export async function backfillBalances(onlyId, opts = {}) {
  const out = {};
  const today = dayOf(Date.now());
  for (const info of listStrategiesPublic()) {
    const id = info.id;
    if (onlyId && id !== onlyId) continue;
    const s = getStrategy(id);
    if (!s || !s.enabled || !s.apiKey || !s.apiSecret) { out[id] = { skipped: 'not configured' }; continue; }
    const res = (out[id] = { inserted: 0 });
    try {
      const from = opts.from || DEFAULT_FROM[id] || '2026-06-01';
      const have = await trackedDays(id);
      const wanted = [...daysBetween(from, today)];
      const missing = wanted.filter(d => !have.has(d));
      res.from = from; res.missing = missing.length;
      if (!missing.length || (!opts.force && missing.length <= 1)) { res.note = 'nothing to fill'; continue; }

      let pick, binanceInfo = null;
      if (s.exchange === 'bybit') {
        const get = await bybitDaily(s, from);
        let carry = null;
        // carry forward over quiet days; days before the first known entry stay empty
        const map = new Map();
        for (const d of wanted) { const v = get(d); if (v != null) carry = v; map.set(d, carry); }
        pick = d => map.get(d);
      } else {
        binanceInfo = await binanceDaily(s, from);
        pick = d => (d >= binanceInfo.earliest ? binanceInfo.get(d) : null);
        if (binanceInfo.limitedBy3m) res.note = `Binance income history covers ~${binance.INCOME_HISTORY_DAYS} days; earlier days are not available`;
      }

      const rows = missing
        .map(d => ({ d, v: pick(d) }))
        .filter(x => x.v != null && isFinite(x.v) && x.v > 0)
        .map(x => ({ strategy: id, day: x.d, balance: Math.round(x.v * 100) / 100, updated_at: new Date().toISOString() }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase.from('balance_daily')
          .upsert(rows.slice(i, i + 500), { onConflict: 'strategy,day', ignoreDuplicates: true });
        if (error) throw new Error('upsert: ' + error.message);
      }
      res.inserted = rows.length;
      res.range = rows.length ? `${rows[0].day} … ${rows[rows.length - 1].day}` : null;
    } catch (e) { res.error = e.message; console.warn('[backfill]', id, e.message); }
    await new Promise(r => setTimeout(r, 1500));
  }
  return out;
}
