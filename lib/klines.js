/** Public candles for the dashboard chart (no API keys). Exchange is taken from the strategy config. */
import { getStrategy } from './store.js';

const BINANCE = process.env.BINANCE_FAPI || 'https://fapi.binance.com';
const BYBIT = process.env.BYBIT_API || 'https://api.bybit.com';
const TF = { '15m': { b: '15m', y: '15' }, '1h': { b: '1h', y: '60' }, '4h': { b: '4h', y: '240' }, '1d': { b: '1d', y: 'D' } };
const cache = new Map();

export async function klines(strategyId, symbol, tf, limit = 300) {
  const s = getStrategy(strategyId);
  if (!s) throw new Error('unknown strategy');
  if (!/^[A-Z0-9]{3,24}$/.test(symbol)) throw new Error('bad symbol');
  const t = TF[tf];
  if (!t) throw new Error('bad interval');
  limit = Math.min(Math.max(parseInt(limit, 10) || 300, 20), 500);
  const bybitEx = s.exchange === 'bybit';
  const key = `${bybitEx ? 'y' : 'b'}|${symbol}|${tf}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.v;

  let rows, precision = 2;
  const dec = v => { const t = String(v); const i = t.indexOf('.'); return i < 0 ? 0 : t.length - i - 1; };
  if (bybitEx) {
    const r = await fetch(`${BYBIT}/v5/market/kline?category=linear&symbol=${symbol}&interval=${t.y}&limit=${limit}`);
    const j = await r.json();
    if (j.retCode !== 0) throw new Error(j.retMsg || 'bybit kline error');
    precision = Math.max(2, ...(j.result.list || []).map(k => dec(k[4])));
    rows = (j.result.list || []).map(k => ({ time: Math.floor(Number(k[0]) / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] })).reverse();
  } else {
    const r = await fetch(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${t.b}&limit=${limit}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(j.msg || 'binance kline error');
    precision = Math.max(2, ...j.map(k => dec(k[4])));
    rows = j.map(k => ({ time: Math.floor(Number(k[0]) / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
  }
  const out = { exchange: bybitEx ? 'BYBIT' : 'BINANCE', precision, candles: rows };
  cache.set(key, { at: Date.now(), v: out });
  return out;
}
