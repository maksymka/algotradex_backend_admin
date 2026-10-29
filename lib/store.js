/**
 * Strategy key store — memory + encrypted data/keys.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encrypt, decrypt } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.KEYS_FILE || path.join(__dirname, '..', 'data', 'keys.json');

const DEFAULTS = {
  alpha: { id: 'alpha', name: 'Strategy Alpha', exchange: 'binance', label: 'k-bot_0512', enabled: true, apiKey: '', apiSecret: '' },
  beta:  { id: 'beta',  name: 'Strategy Beta',  exchange: 'binance', label: 'liquidated', enabled: false, apiKey: '', apiSecret: '' },
  gamma: { id: 'gamma', name: 'Strategy Gamma', exchange: 'bybit',   label: 'Robot #451', enabled: true, apiKey: '', apiSecret: '' },
  delta: { id: 'delta', name: 'Strategy Delta', exchange: 'binance', label: 'APR bot', enabled: true, apiKey: '', apiSecret: '' },
};

function loadFromEnv() {
  const out = structuredClone(DEFAULTS);
  for (const id of Object.keys(out)) {
    const k = process.env[`KEY_${id.toUpperCase()}`] || process.env[`BINANCE_KEY_${id.toUpperCase()}`] || '';
    const s = process.env[`SECRET_${id.toUpperCase()}`] || process.env[`BINANCE_SECRET_${id.toUpperCase()}`] || '';
    if (k) out[id].apiKey = k;
    if (s) out[id].apiSecret = s;
  }
  if (process.env.BYBIT_KEY_GAMMA) out.gamma.apiKey = process.env.BYBIT_KEY_GAMMA;
  if (process.env.BYBIT_SECRET_GAMMA) out.gamma.apiSecret = process.env.BYBIT_SECRET_GAMMA;
  return out;
}

function loadFromFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.warn('[keys] no file yet:', DATA_FILE);
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const base = loadFromEnv();
    let loaded = 0;
    for (const [id, row] of Object.entries(raw)) {
      if (!base[id]) continue;
      try {
        if (row.apiKeyEnc) {
          base[id].apiKey = decrypt(row.apiKeyEnc);
          loaded++;
        }
        if (row.apiSecretEnc) base[id].apiSecret = decrypt(row.apiSecretEnc);
      } catch (e) {
        console.error(`[keys] decrypt failed for ${id} — is MASTER_KEY the same as when saved?`, e.message);
      }
      if (typeof row.enabled === 'boolean') base[id].enabled = row.enabled;
      if (row.label) base[id].label = row.label;
      if (row.exchange) base[id].exchange = row.exchange;
    }
    console.log(`[keys] loaded ${loaded} key(s) from`, DATA_FILE);
    return base;
  } catch (e) {
    console.warn('[keys] file load failed', e.message);
    return null;
  }
}

let cache = loadFromFile() || loadFromEnv();
console.log('[keys] store ready · file=', DATA_FILE, '· has=',
  Object.values(cache).filter(s => s.apiKey && s.apiSecret).map(s => s.id).join(',') || '(none)');

export function listStrategiesPublic() {
  return Object.values(cache).map(s => ({
    id: s.id,
    name: s.name,
    exchange: s.exchange,
    label: s.label,
    enabled: s.enabled,
    hasKey: Boolean(s.apiKey && s.apiSecret),
    keyHint: s.apiKey ? s.apiKey.slice(0, 4) + '…' + s.apiKey.slice(-4) : null,
  }));
}

export function getStrategy(id) {
  return cache[id] || null;
}

export function upsertStrategyKeys(id, { apiKey, apiSecret, enabled, label, exchange }) {
  if (!cache[id]) throw new Error('unknown strategy');
  if (apiKey != null && String(apiKey).trim() !== '') cache[id].apiKey = String(apiKey).trim();
  if (apiSecret != null && String(apiSecret).trim() !== '') cache[id].apiSecret = String(apiSecret).trim();
  if (typeof enabled === 'boolean') cache[id].enabled = enabled;
  if (label) cache[id].label = label;
  if (exchange) cache[id].exchange = exchange;
  persist();
  return listStrategiesPublic().find(s => s.id === id);
}

function persist() {
  try {
    const dir = path.dirname(DATA_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {};
    for (const [id, s] of Object.entries(cache)) {
      payload[id] = {
        enabled: s.enabled,
        label: s.label,
        exchange: s.exchange,
        apiKeyEnc: s.apiKey ? encrypt(s.apiKey) : '',
        apiSecretEnc: s.apiSecret ? encrypt(s.apiSecret) : '',
      };
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    console.log('[keys] saved →', DATA_FILE,
      Object.values(cache).filter(s => s.apiKey).map(s => s.id).join(','));
  } catch (e) {
    console.error('[keys] persist FAILED:', e.message);
  }
}

export function reload() {
  cache = loadFromFile() || loadFromEnv();
}
