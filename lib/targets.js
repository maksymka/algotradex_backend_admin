/**
 * Take-profit targets of open positions.
 * Orders are normalized to: { symbol, side:'BUY'|'SELL', positionSide?:'LONG'|'SHORT'|'BOTH', type, price, trigger, qty, reduceOnly, closePosition }
 * A target = a closing order on the PROFIT side of the entry price (take-profit trigger or reduce-only limit).
 * Result: position.takeProfits = [{ price, qty, profit }] — profit = qty × (price − entry) × direction (USDT, before fees).
 */
export const bool = v => v === true || v === 'true' || v === 1 || v === '1';

export function attachTargets(positions, orders) {
  for (const p of positions) {
    const dir = p.side === 'LONG' ? 1 : -1;
    const closeSide = p.side === 'LONG' ? 'SELL' : 'BUY';
    const seen = new Set();
    const tps = [];
    for (const o of orders) {
      if (o.symbol !== p.symbol) continue;
      const mine = o.positionSide && o.positionSide !== 'BOTH' ? o.positionSide === p.side : o.side === closeSide;
      if (!mine || o.side !== closeSide) continue;
      const isTp = /TAKE_?PROFIT/i.test(String(o.type || ''));
      if (!isTp && !(o.reduceOnly || o.closePosition) ) continue;
      const price = isTp ? (o.trigger || o.price) : (o.price || 0);
      if (!(price > 0) || (price - p.entryPrice) * dir <= 0) continue;     // only on the profit side
      const size = Math.abs(p.contracts ?? p.positionAmt);
      const qty = o.closePosition || !(o.qty > 0) ? size : Math.min(o.qty, size);
      const key = String(price);
      if (seen.has(key)) continue;
      seen.add(key);
      tps.push({ price, qty, profit: Math.round(qty * (price - p.entryPrice) * dir * 100) / 100 });
    }
    tps.sort((a, b) => Math.abs(a.price - p.markPrice) - Math.abs(b.price - p.markPrice));
    p.takeProfits = tps;
  }
  return positions;
}
