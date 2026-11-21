/**
 * Strategy state: status (active | liquidated) and the LAST KNOWN open positions.
 * - last positions are remembered while the strategy is alive (throttled writes to strategy_state);
 * - when the account is wiped (positions gone + equity < 5% of last equity) the strategy is flagged "liquidated" automatically;
 * - a liquidated strategy keeps showing its last known positions (flagged frozen) in the snapshot.
 * Admin can set / reset the state manually (see POST /admin/api/state/:id).
 */
import { supabase } from './supabase.js';

const mem = {};
const lastWrite = {};
const KEEP = ['symbol', 'side', 'entryPrice', 'markPrice', 'liquidationPrice', 'liqDistancePct', 'liqRisk', 'contracts', 'positionAmt',
  'notional', 'unRealizedProfit', 'leverage', 'initialMargin', 'lastFundingRate', 'fundingIntervalHours', 'nextFundingTime', 'takeProfits'];
const pick = p => Object.fromEntries(KEEP.filter(k => p[k] !== undefined).map(k => [k, p[k]]));
const sigOf = ps => JSON.stringify((ps || []).map(p => [p.symbol, p.side, p.contracts]));

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
  data.status = st.status === 'liquidated' ? 'liquidated' : 'active';
  if (data.status === 'liquidated') {
    data.liquidatedAt = st.liquidated_at;
    data.lastEquity = st.last_equity;
    if (!data.positions.length) { data.positions = (st.last_positions || []).map(p => ({ ...p, frozen: true })); data.frozen = true; }
  }
  return data;
}
