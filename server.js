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

// ---------- Public API (dashboard) ----------
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

// ---------- Admin ----------
app.get('/admin/api/strategies', requireAdmin, (_, res) => {
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

app.post('/admin/api/sync', requireAdmin, async (_, res) => {
  const results = await syncAll();
  res.json({ ok: true, results });
});

// SPA admin
app.get('/admin', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`AlgoTradeX admin API on :${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/admin`);
  const ms = Number(process.env.SYNC_INTERVAL_MS || 300000); // default 5 min — avoid Binance IP ban
  startCron(ms);
});
