import fetch from 'node-fetch';
import { supabase } from './supabase.js';

export async function syncAllFunding() {
  console.log(`[Funding] Sync started at ${new Date().toISOString()}`);
  const rows = [];

  // Binance
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
    const data = await res.json();
    if (Array.isArray(data)) {
      data.forEach(item => rows.push({
        exchange: 'binance',
        symbol: item.symbol,
        funding_rate: parseFloat(item.lastFundingRate),
        mark_price: parseFloat(item.markPrice),
        next_funding_time: new Date(Number(item.nextFundingTime)).toISOString(),
      }));
    }
  } catch (e) { console.error('[Funding] Binance error:', e.message); }

  // Bybit
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
    const json = await res.json();
    if (json.result?.list) {
      json.result.list.forEach(item => rows.push({
        exchange: 'bybit',
        symbol: item.symbol,
        funding_rate: parseFloat(item.fundingRate || 0),
        mark_price: parseFloat(item.markPrice),
        next_funding_time: item.nextFundingTime ? new Date(Number(item.nextFundingTime)).toISOString() : null,
      }));
    }
  } catch (e) { console.error('[Funding] Bybit error:', e.message); }

  // Запис частинами по 500
  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('global_funding').insert(rows.slice(i, i + 500));
      if (error) console.error('[Funding] DB error:', error.message);
    }
    console.log(`[Funding] Saved ${rows.length} rows.`);
  }
}
