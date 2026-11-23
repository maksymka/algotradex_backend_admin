/**
 * Minimal Telegram bot for the AlgoTradeX Mini App (Node 18+, no dependencies).
 *
 *   BOT_TOKEN          token from @BotFather
 *   APP_URL            https://algotradex.ai
 *   API_URL            https://<your-backend>
 *   ALLOWED_CHAT_IDS   comma-separated chat ids
 */
const TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || 'https://algotradex.ai';
const API_URL = (process.env.API_URL || '').replace(/\/$/, '');
const ALLOWED = new Set((process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean));

if (!TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(r => r.json());

const send = (chat_id, text, extra) =>
  api('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });

const openApp = {
  reply_markup: {
    inline_keyboard: [[{ text: '📈 Open terminal', web_app: { url: APP_URL } }]],
  },
};

const money = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);

async function snapshot() {
  const r = await fetch(`${API_URL}/api/account?bot=all`);
  const j = await r.json();
  return j.data || j;
}

async function pnlText() {
  const snap = await snapshot();
  const rows = ['alpha', 'beta', 'gamma', 'delta']
    .filter(id => snap[id] && !snap[id].error)
    .map(id => {
      const s = snap[id];
      return `<b>${id[0].toUpperCase() + id.slice(1)}</b>${s.status === 'liquidated' ? ' ⛔ LIQUIDATED' : ''}\n  balance ${Number(s.balance).toFixed(2)} · uPnL ${money(Number(s.unrealizedPnl || 0))} · positions ${(s.positions || []).length}`;
    });
  return rows.join('\n\n') || 'No data';
}

async function handle(m) {
  const chat = m.chat.id;
  const text = (m.text || '').trim();

  if (text.startsWith('/start') || text.startsWith('/app')) {
    return send(chat, 'AlgoTradeX terminal', openApp);
  }

  if (text.startsWith('/pnl')) {
    if (!ALLOWED.has(String(chat))) {
      return send(chat, 'Not allowed. Your chat id: <code>' + chat + '</code>');
    }
    return send(chat, await pnlText().catch(e => 'Error: ' + e.message));
  }
}

const seen = {};
async function alerts() {
  if (!API_URL || !ALLOWED.size) return;
  try {
    const snap = await snapshot();
    for (const id of ['alpha', 'beta', 'gamma', 'delta']) {
      const s = snap[id];
      if (!s || s.error) continue;
      if (s.status === 'liquidated' && seen[id] !== 'liquidated') {
        if (seen[id] !== undefined) {
          for (const c of ALLOWED) {
            await send(c, `⛔ <b>Strategy ${id}</b> was liquidated`, openApp);
          }
        }
      }
      seen[id] = s.status;
    }
  } catch (e) {
    console.warn('alerts', e.message);
  }
}
setInterval(alerts, 60_000);
alerts();

(async () => {
  const menu = await api('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Terminal',
      web_app: { url: APP_URL },
    },
  });
  console.log('setChatMenuButton:', menu.ok ? 'ok' : menu);

  let offset = 0;
  console.log('bot started');

  for (;;) {
    try {
      const r = await api('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message'],
      });

      if (!r.ok) {
        console.error('getUpdates error:', r.error_code, r.description);
        await new Promise(resolve => setTimeout(resolve, r.error_code === 409 ? 10000 : 3000));
        continue;
      }

      for (const u of r.result || []) {
        offset = u.update_id + 1;
        if (u.message) await handle(u.message);
      }
    } catch (e) {
      console.warn('poll exception:', e.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
})();
