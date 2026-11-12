import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listStrategiesPublic,
  upsertStrategyKeys,
  getStrategy,
} from './lib/store.js';
import * as binance from './lib/binance.js';
import * as bybit from './lib/bybit.js';
import { getLatest, getFundingLog, syncAll, startCron } from './lib/tracker.js';
import { syncAllFunding } from './lib/globalfunding.js';
import { supabase } from './lib/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8787;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-admin-token';

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-admin-token'] || req.query.token || '');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/account', (req, res) => {
  const bot = (req.query.bot || 'all').toLowerCase();
  const data = getLatest(bot);
  if (!data) return res.status(404).json({ error: 'no data yet — wait for sync or configure keys' });
  res.json(data);
});

app.get('/api/funding', (req, res) => {
  const bot = (req.query.bot || '').toLowerCase();
  let rows = getFundingLog(200);
  if (bot) rows = rows.filter(r => r.strategy === bot);
  res.json({ rows });
});

/** All coins · Binance + Bybit · latest rate per symbol */
app.get('/api/funding/summary', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('global_funding')
      .select('*')
      .order('fetched_at', { ascending: false })
      .limit(8000);
    if (error) throw error;

    const seen = new Set();
    const latest = [];
    for (const row of data || []) {
      const key = `${row.exchange || ''}|${row.symbol || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(row);
    }

    const formattedData = latest.map(row => {
      const rate = parseFloat(row.funding_rate || 0);
      const dailyRate = rate * 3;
      return {
        symbol: row.symbol,
        exchange: row.exchange,
        rate,
        mark_price: parseFloat(row.mark_price || 0),
        next_time: row.next_funding_time,
        pnl_2h: rate * 0.25,
        pnl_4h: rate * 0.5,
        pnl_8h: rate,
        pnl_30d: dailyRate * 30,
        pnl_90d: dailyRate * 90,
        pnl_180d: dailyRate * 180,
        pnl_360d: dailyRate * 360,
      };
    });

    res.json({
      success: true,
      data: formattedData,
      meta: {
        binance: formattedData.filter(r => (r.exchange || '').toLowerCase() === 'binance').length,
        bybit: formattedData.filter(r => (r.exchange || '').toLowerCase() === 'bybit').length,
        total: formattedData.length,
      },
    });
  } catch (e) {
    console.error('funding summary', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/funding/sync', async (_req, res) => {
  try {
    await syncAllFunding();
    res.json({ success: true, message: 'Funding data synced' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/risk', (req, res) => {
  const bot = (req.query.bot || 'all').toLowerCase();
  const snap = getLatest(bot === 'all' ? 'all' : bot);
  if (!snap) return res.json({ positions: [] });
  if (bot === 'all') {
    const positions = [];
    for (const [id, s] of Object.entries(snap)) {
      if (s?.positions) positions.push(...s.positions.map(p => ({ ...p, strategy: id })));
    }
    return res.json({ positions });
  }
  res.json({ positions: snap.positions || [], error: snap.error });
});

/**
 * Daily closing balance per strategy → [{strategy, balance, recorded_at}]
 * Primary: balance_daily (1 row / strategy / day). Fallback: paginated balance_history
 * (Supabase returns max 1000 rows per request, so a plain select silently drops the NEWEST days).
 */
app.get('/api/history', async (_req, res) => {
  try {
    const daily = await supabase
      .from('balance_daily')
      .select('strategy, day, balance')
      .order('day', { ascending: true })
      .limit(5000);
    if (!daily.error && daily.data && daily.data.length) {
      return res.json(daily.data.map(r => ({
        strategy: r.strategy,
        balance: r.balance,
        recorded_at: `${r.day}T12:00:00Z`,   // noon UTC → same calendar day in any timezone
      })));
    }
    if (daily.error) console.warn('[history] balance_daily unavailable → fallback:', daily.error.message);

    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const byKey = new Map();
    for (let from = 0; from < 200000; from += 1000) {
      const { data, error } = await supabase
        .from('balance_history')
        .select('strategy, balance, recorded_at')
        .gte('recorded_at', since)
        .order('recorded_at', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      if (!data || !data.length) break;
      for (const r of data) {
        const day = new Date(r.recorded_at).toLocaleDateString('en-CA', { timeZone: process.env.DAY_TZ || 'Europe/Kyiv' });
        byKey.set(`${r.strategy}|${day}`, r);       // ascending → last write wins = closing balance
      }
      if (data.length < 1000) break;
    }
    res.json([...byKey.values()]);
  } catch (e) {
    console.error('history error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/api/strategies', requireAdmin, (_req, res) => {
  res.json({ strategies: listStrategiesPublic() });
});

app.put('/admin/api/strategies/:id/keys', requireAdmin, (req, res) => {
  try {
    const row = upsertStrategyKeys(req.params.id, req.body || {});
    res.json({ ok: true, strategy: row });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/admin/api/strategies/:id/test', requireAdmin, async (req, res) => {
  const s = getStrategy(req.params.id);
  if (!s) return res.status(404).json({ error: 'unknown' });
  const key = (req.body?.apiKey || s.apiKey || '').trim();
  const secret = (req.body?.apiSecret || s.apiSecret || '').trim();
  if (!key || !secret) return res.status(400).json({ error: 'missing key/secret' });
  try {
    if (s.exchange === 'bybit') await bybit.testKeys(key, secret);
    else await binance.testKeys(key, secret);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, body: e.body });
  }
});

app.post('/admin/api/sync', requireAdmin, async (_req, res) => {
  const results = await syncAll();
  res.json({ ok: true, results });
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (_req, res) => {
  res.json({
    service: 'AlgoTradeX admin API',
    health: '/api/health',
    account: '/api/account?bot=all',
    funding: '/api/funding/summary',
    admin: '/admin',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AlgoTradeX admin API on :${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/admin`);
  const ms = Number(process.env.SYNC_INTERVAL_MS || 300000);
  startCron(ms);
  function scheduleHourlyFunding() {
    const now = new Date();
    const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
    const msUntilNext = nextHour.getTime() - now.getTime();
    console.log(`[Cron] Next funding sync in ${Math.round(msUntilNext / 1000 / 60)} min.`);
    setTimeout(() => {
      syncAllFunding().catch(e => console.error('funding cron error', e.message));
      scheduleHourlyFunding();
    }, msUntilNext);
  }
  syncAllFunding().catch(e => console.error('funding initial error', e.message));
  scheduleHourlyFunding();
});
