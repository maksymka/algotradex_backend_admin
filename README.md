# AlgoTradeX · Admin API + key panel

## Local

```bash
cd backend-admin
npm install
export ADMIN_TOKEN='your-secret-admin-token'
export MASTER_KEY='long-random-string-for-encryption'
npm start
# open http://localhost:8787/admin
```

## Railway

1. New project → Deploy from GitHub (this folder) or CLI
2. Variables:
   - `ADMIN_TOKEN` — пароль адмінки
   - `MASTER_KEY` — 32+ chars for encrypting keys at rest
   - `SYNC_INTERVAL_MS` — default `60000`
   - optional: `KEY_ALPHA`, `SECRET_ALPHA`, `KEY_DELTA`, `SECRET_DELTA`, `BYBIT_KEY_GAMMA`, `BYBIT_SECRET_GAMMA`
   - optional: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (write snapshots)
3. Public URL example: `https://algotradex-admin.up.railway.app`
4. Admin: `https://….up.railway.app/admin`

## Dashboard

In browser console on algotradex.ai:

```js
localStorage.setItem('atx-binance-proxy', 'https://YOUR.up.railway.app');
location.reload();
```

Dashboard already calls `/api/account?bot=all`.

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/account?bot=alpha\|gamma\|delta\|all` | no |
| GET | `/api/funding?bot=` | no |
| GET | `/api/risk?bot=` | no |
| GET | `/admin` | UI |
| GET | `/admin/api/strategies` | Bearer ADMIN_TOKEN |
| PUT | `/admin/api/strategies/:id/keys` | Bearer |
| POST | `/admin/api/strategies/:id/test` | Bearer |
| POST | `/admin/api/sync` | Bearer |

## Security

- Never commit real API secrets
- Restrict Railway URL / use strong ADMIN_TOKEN
- Binance/Bybit keys: **read-only futures** permissions only
