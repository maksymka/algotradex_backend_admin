/**
 * Trade cycles from raw fills + funding payments.
 * A cycle = from the first opening fill on a symbol (all legs flat) until every leg is flat again (a long+short pair is ONE cycle).
 * fills:   [{ ts, symbol, side:'BUY'|'SELL', leg:'LONG'|'SHORT'|'BOTH', action?:'open'|'close', qty, price, fee, realized? }]
 * funding: [{ ts, symbol, funding }]   (funding > 0 = received, < 0 = paid)
 * Output (newest first): { symbol, openTs, closeTs|null, status, qtyLong, qtySell... } see below.
 */
const EPS = 1e-9;

function expand(f, nets) {                               // one fill → [{ leg, action, qty, price, fee, realized }]
  let leg = f.leg, action = f.action;
  if (leg === 'LONG' || leg === 'SHORT') {
    if (!action) action = (leg === 'LONG') === (f.side === 'BUY') ? 'open' : 'close';
    return [{ ...f, leg, action }];
  }
  // one-way mode: track the signed net position to split closing / opening parts
  const net = nets[f.symbol] || 0;
  const signed = f.side === 'BUY' ? f.qty : -f.qty;
  const out = [];
  const closes = f.side === 'BUY' ? Math.min(f.qty, Math.max(0, -net)) : Math.min(f.qty, Math.max(0, net));
  const part = q => q / f.qty;
  if (closes > EPS) out.push({ ...f, leg: f.side === 'BUY' ? 'SHORT' : 'LONG', action: 'close', qty: closes, fee: f.fee * part(closes), realized: f.realized == null ? undefined : f.realized * part(closes) });
  const opens = f.qty - closes;
  if (opens > EPS) out.push({ ...f, leg: f.side === 'BUY' ? 'LONG' : 'SHORT', action: 'open', qty: opens, fee: f.fee * part(opens), realized: undefined });
  nets[f.symbol] = net + signed;
  return out;
}

export function buildCycles(fills, funding, now = Date.now()) {
  const bySym = new Map();
  const push = (s, e) => { if (!bySym.has(s)) bySym.set(s, []); bySym.get(s).push(e); };
  const nets = {};
  [...fills].sort((a, b) => a.ts - b.ts).forEach(f => expand(f, nets).forEach(x => push(x.symbol, { t: 'fill', ts: f.ts, ...x })));
  funding.forEach(fu => push(fu.symbol, { t: 'fund', ts: fu.ts, funding: fu.funding }));

  const cycles = [];
  for (const [symbol, evs] of bySym) {
    evs.sort((a, b) => a.ts - b.ts || (a.t === 'fill' ? -1 : 1));
    let cur = null;
    const fresh = ts => ({ symbol, openTs: ts, closeTs: null, legs: { LONG: { qty: 0, cost: 0, peak: 0, opened: 0 }, SHORT: { qty: 0, cost: 0, peak: 0, opened: 0 } }, fee: 0, income: 0, funding: 0, fills: 0, preexisting: false });
    const flat = c => c.legs.LONG.qty < EPS && c.legs.SHORT.qty < EPS;
    for (const e of evs) {
      if (e.t === 'fund') { if (cur) cur.funding += e.funding; continue; }          // funding while flat belongs to no cycle
      if (!cur) { cur = fresh(e.ts); if (e.action === 'close') cur.preexisting = true; }
      const L = cur.legs[e.leg];
      cur.fee += e.fee || 0; cur.fills++;
      if (e.action === 'open') { L.qty += e.qty; L.cost += e.qty * e.price; L.opened += e.qty * e.price; L.peak += e.qty; }
      else {
        const avg = L.qty > EPS ? L.cost / L.qty : e.price;
        const calc = (e.leg === 'LONG' ? e.price - avg : avg - e.price) * e.qty;
        cur.income += e.realized != null && isFinite(e.realized) ? e.realized : (L.qty > EPS ? calc : 0);
        const q = Math.min(e.qty, L.qty);
        L.qty -= q; L.cost -= avg * q;
        if (L.qty < EPS) { L.qty = 0; L.cost = 0; }
      }
      if (flat(cur)) { cur.closeTs = e.ts; cycles.push(cur); cur = null; }
    }
    if (cur) cycles.push(cur);                                                        // still active
  }
  const r2 = v => Math.round(v * 100) / 100;
  return cycles.map(c => {
    const act = c.closeTs == null;
    const L = c.legs.LONG, S = c.legs.SHORT;
    return {
      symbol: c.symbol, openTs: c.openTs, closeTs: c.closeTs, status: act ? 'active' : 'closed', preexisting: c.preexisting,
      qtyLong: L.peak, qtyShort: S.peak, usdLong: r2(L.opened), usdShort: r2(S.opened),
      avgLong: L.peak > 0 ? L.opened / L.peak : null, avgShort: S.peak > 0 ? S.opened / S.peak : null,
      fee: r2(c.fee), funding: r2(c.funding), income: r2(c.income), profit: r2(c.income - c.fee + c.funding), fills: c.fills,
    };
  }).sort((a, b) => (b.closeTs || now) - (a.closeTs || now) || b.openTs - a.openTs);
}
