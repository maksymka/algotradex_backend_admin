/**
 * Minimal Telegram bot for the AlgoTradeX Mini App (Node 18+, no dependencies).
 *
 *   BOT_TOKEN          token from @BotFather
 *   APP_URL            https://algotradex.ai            (the page is the Mini App)
 *   API_URL            https://<your-backend>           (for /pnl and alerts)
 *   ALLOWED_CHAT_IDS   comma-separated Telegram chat ids allowed to see balances (/pnl, alerts). Empty = /pnl and alerts are OFF.
 *
 *   node bot.mjs
 *
 * In @BotFather also run /newapp (or /setmenubutton) so the Mini App has a short name; this bot sets the menu button itself.
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

async function 
