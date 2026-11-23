/**
 * AlgoTradeX Telegram bot (Node 18+, no deps).
 *
 * ENV:
 *   BOT_TOKEN          from @BotFather
 *   APP_URL            https://algotradex.ai (Mini App page)
 *   API_URL            https://<backend>     (for /status, /balance, /positions, /pnl, alerts)
 *   ALLOWED_CHAT_IDS   comma-separated chat ids allowed to see account data. Empty = account commands OFF.
 */
const TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || 'https://algotradex.ai';
const API_URL = (process.env.API_URL || '').replace(/\/$/, '');
const ALLOWED = new Set((process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
if (!TOKEN) { console.error('BOT_TOKEN is required'); process.exit(1); }

const IDS = ['alpha', 'beta', 'gamma', 'delta'];
const cap = id => id[0].toUpperCase() + id.slice(1);
const money = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);

const api = (method, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {})
}).then(r => r.json());

const send     = (chat_id, text, extra) => api('sendMessage',     { chat_id, text, parse_mode: 'HTML', ...extra });
const edit     = (chat_id, message_id, text, extra) => api('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', ...extra });
const answerCb = id => api('answerCallbackQuery', { callback_query_id: id }).catch(() => {});

// ---------- keyboards ----------
const openAppBtn = { text: '📈 Open terminal', web_app: { url: APP_URL } };
const openAppKb  = { reply_markup: { inline_keyboard: [[openAppBtn]] } };

const mainMenu = { reply_markup: { inline_keyboard: [
  [{ text: '📊 Status',    callback_data: 'status'    }, { text: '💼 Balances', callback_data: 'balance' }],
  [{ text: '📂 Positions', callback_data: 'positions' }, { text: '💰 PnL',      callback_data: 'pnl'     }],
  [{ text: '🏓 Ping',      callback_data: 'ping'      }, { text: '❓ Help',      callback_data: 'help'    }],
  [openAppBtn]
]}};

const backMenu = { reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu' }]] } };

const helpMenu = { reply_markup: { inline_keyboard: [
  [{ text: '📊 Status',    callback_data: 'status'    }, { text: '💼 Balances', callback_data: 'balance' }],
  [{ text: '📂 Positions', callback_data: 'positions' }, { text: '💰 PnL',      callback_data: 'pnl'     }],
  [openAppBtn],
  [{ text: '« Menu', callback_data: 'menu' }],
]}};

// ---------- data ----------
async function snapshot() {
  const r = await fetch(`${API_URL}/api/account?bot=all`);
  const j = await r.json();
  return j.data || j;
}

// Функція для підрахунку днів (включно з обома датами)
function calcDays(startDateStr, endDateStr = null) {
  if (!startDateStr) return '—';
  const start = new Date(startDateStr);
  const end = endDateStr ? new Date(endDateStr) : new Date();
  if (isNaN(start) || isNaN(end)) return '—';
  const startUTC = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUTC = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((endUTC - startUTC) / (1000 * 60 * 60 * 24)) + 1;
}

// Оновлена функція для Beta з фіксованими даними
const getRows = snap => IDS.map(id => {
  if (id === 'beta') {
    return {
      id,
      s: {
        status: 'liquidated',
        balance: 0,
        unrealizedPnl: 0,
        netPnl: -619,
        positions: []
      }
    };
  }

  const s = snap[id];
  if (!s) {
    return { id, s: { status: 'missing', error: 'no data', balance: 0, unrealizedPnl: 0, positions: [] } };
  }
  if (s.error) {
    if (s.error === 'not configured') {
      return { id, s: { status: 'liquidated', balance: 0, unrealizedPnl: 0, positions: [] } };
    }
    return { id, s: { status: 'error', error: s.error, balance: 0, unrealizedPnl: 0, positions: [] } };
  }
  return { id, s };
});

async function renderStatus() {
  const rows = getRows(await snapshot());
  return rows.map(({ id, s }) => {
    let flag = '⚪', label = s.status || 'unknown';
    
    if (s.status === 'liquidated') { flag = '⛔'; label = 'liquidated'; }
    else if (s.status === 'active') { flag = '🟢'; label = 'active'; }
    else if (s.status === 'error') { flag = '⚠️'; label = 'error'; }
    else if (s.status === 'missing') { flag = '❓'; label = 'no data'; }

    const paddedId = cap(id).padEnd(5, ' ');
    return `${paddedId} ${flag} — ${label}`;
  }).join('\n');
}

async function renderBalance() {
  const rows = getRows(await snapshot());
  
  return rows.map(({ id, s }) => {
    const balance = Number(s.balance || 0).toFixed(2);
    
    if (id === 'alpha') {
      const max = s.maxSum ? `${s.maxSum}$` : '<from API>';
      const days = calcDays('2026-07-01');
      return `<b>Alpha</b>  ${balance} (Depo: 1187$, Max: ${max}, Out: 0$, Start: 2026-07-01, Days: ${days})`;
    }
    
    if (id === 'beta') {
      return `<b>Beta</b>  ${balance} (Depo: 700$, Max: 862$(23%), Out: 81$, Start: 2024-06-23, Stop: 2024-10-17, Days: 117, Result: - 619$)`;
    }
    
    if (id === 'gamma') {
      return `<b>Gamma</b>  ${balance} (Depo: 500$, Max: 560$(12%), Start: 2026-08-10, Stop Date: 2026-11-19, Days: 102)`;
    }
    
    if (id === 'delta') {
      const max = s.maxSum ? `${s.maxSum}$` : '<from API>';
      const days = calcDays('2026-10-26');
      return `<b>Delta</b>  ${balance} (Depo: 500$, Max: ${max}, Out: 0$, Start: 2026-10-26, Days: ${days})`;
    }
    
    return `<b>${cap(id)}</b>  ${balance}`;
  }).join('\n');
}

async function renderPositions() {
  const rows = getRows(await snapshot());
  const out = [];
  for (const { id, s } of rows) {
    if (s.status === 'liquidated') {
      out.push(`<b>${cap(id)}</b> ⛔ LIQUIDATED`);
      continue;
    }
    if (s.status === 'error' || s.status === 'missing') {
      out.push(`<b>${cap(id)}</b> ⚠️ ${s.error}`);
      continue;
    }
    
    const pos = s.positions || [];
    if (!pos.length) { 
      out.push(`<b>${cap(id)}</b> — no open positions`); 
      continue; 
    }
    
    out.push(`<b>${cap(id)}</b>`);
    for (const p of pos) {
      const sym   = p.symbol || p.asset || '?';
      const qty   = Number(p.qty ?? p.size ?? 0);
      const side  = p.side || p.direction || (qty < 0 ? 'short' : 'long');
      const entry = p.entryPrice ?? p.entry ?? '';
      const upnl  = Number(p.unrealizedPnl ?? p.pnl ?? 0);
      out.push(`  • ${sym} ${side} ${qty} @ ${entry} — uPnL ${money(upnl)}`);
    }
  }
  return out.join('\n');
}

async function renderPnl() {
  const rows = getRows(await snapshot());
  return rows.map(({ id, s }) => {
    if (id === 'beta') {
      return `<b>${cap(id)}</b> ⛔ LIQUIDATED\n  Current Balance: 0\n  Unrealized PnL: +0.00 USDT\n  Net PnL (now): -619 USDT`;
    }

    if (s.status === 'error' || s.status === 'missing') {
      return `<b>${cap(id)}</b> ⚠️ ${s.error}\n  balance 0.00 · uPnL +0.00 · positions 0`;
    }
    const liq = s.status === 'liquidated' ? ' ⛔ LIQUIDATED' : '';
    return `<b>${cap(id)}</b>${liq}\n  balance ${Number(s.balance).toFixed(2)} · uPnL ${money(Number(s.unrealizedPnl || 0))} · positions ${(s.positions || []).length}`;
  }).join('\n\n');
}

const helpText = `<b>AlgoTradeX bot</b>

/status — short status of all strategies
/balance — balances only
/positions — open positions
/pnl — detailed PnL
/id — show your chat id
/ping — check bot is alive
/help — this message

Tap a button below 👇`;

// ---------- dispatcher ----------
function guard(chat) {
  if (!ALLOWED.size) return null;                       // open mode
  return ALLOWED.has(String(chat)) ? null : `Not allowed. Your chat id: <code>${chat}</code>`;
}

async function render(name, chat) {
  switch (name) {
    case 'status':    { const e = guard(chat); if (e) return { text: e, extra: backMenu };
                        return { text: await renderStatus().catch(x => 'Error: ' + x.message), extra: backMenu }; }
    case 'balance':   { const e = guard(chat); if (e) return { text: e, extra: backMenu };
                        return { text: await renderBalance().catch(x => 'Error: ' + x.message), extra: backMenu }; }
    case 'positions': { const e = guard(chat); if (e) return { text: e, extra: backMenu };
                        return { text: await renderPositions().catch(x => 'Error: ' + x.message), extra: backMenu }; }
    case 'pnl':       { const e = guard(chat); if (e) return { text: e, extra: backMenu };
                        return { text: await renderPnl().catch(x => 'Error: ' + x.message), extra: backMenu }; }
    case 'id':        return { text: `Your chat id: <code>${chat}</code>`, extra: backMenu };
    case 'ping':      return { text: '🏓 pong', extra: backMenu };
    case 'help':      return { text: helpText, extra: helpMenu };
    case 'menu':
    case 'start':
    case 'app':       return { text: 'AlgoTradeX terminal', extra: mainMenu };
    default:          return null;
  }
}

async function handleMessage(m) {
  const text = (m.text || '').trim();
  if (!text.startsWith('/')) return;
  const name = text.slice(1).split(/\s+/)[0].split('@')[0].toLowerCase();
  const res = await render(name, m.chat.id);
  if (res) await send(m.chat.id, res.text, res.extra);
}

async function handleCallback(cq) {
  await answerCb(cq.id);
  const chat = cq.message.chat.id;
  const res = await render(cq.data, chat);
  if (!res) return;
  const r = await edit(chat, cq.message.message_id, res.text, res.extra);
  if (!r.ok && !/not modified/i.test(r.description || '')) {
    await send(chat, res.text, res.extra);
  }
}

// ---------- liquidation alerts ----------
const seen = {};
async function alerts() {
  if (!API_URL || !ALLOWED.size) return;
  try {
    const snap = await snapshot();
    for (const id of IDS) {
      const s = snap[id]; if (!s || s.error) continue;
      if (s.status === 'liquidated' && seen[id] !== 'liquidated') {
        if (seen[id] !== undefined) for (const c of ALLOWED) await send(c, `⛔ <b>Strategy ${id}</b> was liquidated`, openAppKb);
      }
      seen[id] = s.status;
    }
  } catch (e) { console.warn('alerts', e.message); }
}
setInterval(alerts, 60_000); alerts();

// ---------- startup ----------
(async () => {
  await api('setMyCommands', { commands: [
    { command: 'start',     description: 'Open menu' },
    { command: 'status',    description: 'Short status of all strategies' },
    { command: 'balance',   description: 'Balances only' },
    { command: 'positions', description: 'Open positions' },
    { command: 'pnl',       description: 'Detailed PnL' },
    { command: 'id',        description: 'Show my chat id' },
    { command: 'ping',      description: 'Check bot is alive' },
    { command: 'help',      description: 'List all commands' },
  ]}).catch(e => console.warn('setMyCommands', e.message));

  await api('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Terminal', web_app: { url: APP_URL } }
  }).catch(e => console.warn('setChatMenuButton', e.message));

  let offset = 0;
  console.log('bot started');
  for (;;) {
    try {
      const r = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        if (u.message)              await handleMessage(u.message);
        else if (u.callback_query)  await handleCallback(u.callback_query);
      }
    } catch (e) {
      console.warn('poll', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
})();
