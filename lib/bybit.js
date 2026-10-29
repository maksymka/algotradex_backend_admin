import crypto from 'crypto';
import fetch from 'node-fetch';

const BASE = process.env.BYBIT_API || 'https://api.bybit.com';

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function signedGet(path, params, apiKey, apiSecret) {
  const ts = Date.now().toString();
  const recv = '5000';
  const q = new URLSearchParams(params).toString();
  const prehash = ts + apiKey + recv + q;
  const signature = sign(prehash, apiSecret);
  const url = `${BASE}${path}?${q}`;
  const res = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv,
    },
  });
  const data = await res.json();
  if (data.retCode !== 0) {
    const err = new Error(data.retMsg || 'Bybit error');
    err.body = data;
    throw err;
  }
  return data.result;
}

export async function testKeys(apiKey, apiSecret) {
  await signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, apiKey, apiSecret);
  return { ok: true };
}

export async function fetchAccount(apiKey, apiSecret) {
  const wallet = await signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, apiKey, apiSecret);
  const list = wallet?.list?.[0];
  const coin = (list?.coin || []).find(c => c.coin === 'USDT') || {};
  const balance = parseFloat(coin.walletBalance || list?.totalEquity || 0);
  const unrealizedPnl = parseFloat(coin.unrealisedPnl || 0);

  const posRes = await signedGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }, apiKey, apiSecret);
  const positions = (posRes?.list || [])
    .filter(p => Math.abs(parseFloat(p.size || 0)) > 0)
    .map(p => {
      const size = parseFloat(p.size);
      const side = p.side === 'Buy' ? 'LONG' : 'SHORT';
      const mark = parseFloat(p.markPrice);
      const entry = parseFloat(p.avgPrice);
      const liq = parseFloat(p.liqPrice || 0);
      const upnl = parseFloat(p.unrealisedPnl || 0);
      const notional = Math.abs(size * mark);
      const liqDistancePct = liq > 0 && mark > 0 ? Math.abs(mark - liq) / mark * 100 : null;
      return {
        symbol: p.symbol,
        side,
        positionAmt: side === 'LONG' ? size : -size,
        entryPrice: entry,
        markPrice: mark,
        liquidationPrice: liq,
        liqDistancePct,
        unRealizedProfit: upnl,
        notional,
        leverage: parseFloat(p.leverage || 0),
      };
    });

  const availableBalance = parseFloat(coin.availableToWithdraw || coin.equity || balance);
  const usedMargin = parseFloat(list?.totalInitialMargin || list?.totalPositionIM || 0);
  return {
    balance,
    availableBalance,
    freeMargin: availableBalance,
    usedMargin,
    unrealizedPnl,
    positions: positions.map(p => ({
      ...p,
      contracts: Math.abs(p.positionAmt),
      liqRisk: (p.liqDistancePct == null ? 'unknown'
        : p.liqDistancePct >= 20 ? 'low'
        : p.liqDistancePct >= 10 ? 'medium'
        : p.liqDistancePct >= 5 ? 'high' : 'critical'),
    })),
    updatedAt: new Date().toISOString(),
  };
}
