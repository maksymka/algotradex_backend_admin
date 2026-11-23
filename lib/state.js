/**
 * Strategy state: status (active | liquidated) and the LAST KNOWN open positions.
 * - last positions are remembered while the strategy is alive (throttled writes to strategy_state);
 * - when the account is wiped (positions gone + equity < 5% of last equity) the strategy is flagged "liquidated" automatically;
 * - a liquidated strategy keeps showing its last known positions (flagged frozen) in the snapshot.
 * Admin can set / reset the state manually (see POST /admin/api/state/:id).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from './supabase.js';

const FUNDING_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'funding.jsonl');

const mem = {};
const lastWrite = {};
const KEEP = ['symbol', 'side', 'entryPrice', 'markPrice', 'liquidationPrice', 'liqDistancePct', 'liqRisk', 'contracts', 'positionAmt',
  'notional', 'unRealizedProfit', 'leverage', 'initialMargin', 'lastFundingRate', 'fundingIntervalHours', 'nextFundingTime', 'takeProfits'];
const pick = p => Object.fromEntries(KEEP.filter(k => p[k] !== undefined).map(k => [k, p[k]]));
const sigOf = ps => JSON.stringify((ps || []).map(p => [p.symbol, p.side, p.contracts]));

/** Last known positions of a strategy from the server's funding log (symbol, side, size, notional, mark, funding) — entry price is not in it. */
export function recoverPositions(id) {
  try {
    const size = fs.statSync(FUNDING_FILE).size, len = Math.min(size, 6 * 1024 * 1024);
    const fd = fs.openSync(FUNDING_FILE, 'r'), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const rows = buf.toString('utf8').split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(r => r && r.strategy === id);
    if (!rows.length) return [];
    const lastTs = rows[rows.length - 1].ts;
    return rows.filter(r => r.ts === lastTs).map(r => ({
      symbol: r.symbol, side: r.side, contracts: r.contracts, notional: r.notional, markPrice: r.markPrice,
      lastFundingRate: r.rate, fundingIntervalHours: r.intervalH, liqDistancePct: r.liqDistancePct, liqRisk: r.liqRisk, recovered: true,
    }));
  } catch (_) { return []; }
}

/** Peak equity over the last 45 days and the first day after it when the balance fell below 5% of it. */
async function peakFromHistory(id) {
  const since = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('balance_daily').select('day, balance, equity').eq('strategy', id).gte('day', since).order('day', { ascending: true });
  if (error || !data || !data.length) return null;
  let peak = 0, peakDay = null;
  for (const r of data) { const v = Number(r.equity ?? r.balance); if (v > peak) { peak = v; peakDay = r.day; } }
  const fall = data.find(r => r.day > peakDay && Number(r.balance) < 0.05 * peak);
  return { peak, fallDay: fall ? fall.day : null };
}

export const getState = id => mem[id] || (mem[id] = { strategy: id, status: 'active', last_positions: [] });

export async function loadStates() {
  const { data, error } = await supabase.from('strategy_state').select('*');
  if (error) { console.warn('[state] load:', error.message); return; }
  for (const r of data || []) mem[r.strategy] = { ...r, last_positions: r.last_positions || [] };
}

export async function saveState(id, patch = {}, force = false) {
  const st = Object.assign(getState(id), patch);
  if (!force && Date.now() - (lastWrite[id] || 0) < 5 * 60_000) return st;
  lastWrite[id] = Date.now();
  const { error } = await supabase.from('strategy_state').upsert({
    strategy: id, status: st.status, liquidated_at: st.liquidated_at || null, last_positions: st.last_positions || [],
    last_balance: st.last_balance ?? null, last_equity: st.last_equity ?? null, note: st.note || null, auto: !!st.auto,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'strategy' });
  if (error) console.warn('[state] save:', error.message);
  return st;
}

/** Called on every sync, right before the snapshot is published. Mutates and returns `data`. */
export async function trackState(id, data) {
  const st = getState(id);
  const eq = Number.isFinite(data.equity) ? data.equity : data.balance;
  if (st.status !== 'liquidated') {
    if (data.positions.length) {
      const snap = data.positions.map(pick);
      const changed = sigOf(snap) !== sigOf(st.last_positions);
      Object.assign(st, { last_positions: snap, last_balance: data.balance, last_equity: eq });
      await saveState(id, {}, changed);
    } else if ((st.last_positions || []).length && st.last_equity > 0 && eq < 0.05 * st.last_equity) {
      console.warn(`[state] ${id} looks liquidated (equity ${eq} vs ${st.last_equity}) — flagged`);
      await saveState(id, { status: 'liquidated', liquidated_at: new Date().toISOString(), auto: true }, true);
    }
  }
  if (st.status !== 'liquidated' && !data.positions.length && Date.now() - (st.checkedAt || 0) > 10 * 60_000) {
    st.checkedAt = Date.now();                                  // account is empty: was it wiped out? (works even if the wipe happened before this code ran)
    const h = await peakFromHistory(id);
    if (h && h.peak >= 50 && eq < 0.05 * h.peak) {
      console.warn(`[state] ${id} looks liquidated by history (equity ${eq}, 45d peak ${h.peak}) — flagged`);
      const patch = { status: 'liquidated', liquidated_at: h.fallDay ? h.fallDay + 'T12:00:00Z' : new Date().toISOString(), auto: true, last_equity: h.peak, note: 'auto-detected from balance history' };
      if (!(st.last_positions || []).length) patch.last_positions = recoverPositions(id);
      await saveState(id, patch, true);
    }
  }
  data.status = st.status === 'liquidated' ? 'liquidated' : 'active';
  if (data.status === 'liquidated') {
    data.liquidatedAt = st.liquidated_at;
    data.lastEquity = st.last_equity;
    if (!data.positions.length) { data.positions = (st.last_positions || []).map(p => ({ ...p, frozen: true })); data.frozen = true; }
  }
  return data;
}
