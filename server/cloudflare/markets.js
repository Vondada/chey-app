// Markets desk data. Real quotes only; anything unavailable says so.
//   - Owner connector (CHE_MARKET_DATA_URL) wins when configured.
//   - Otherwise keyless public sources: Stooq daily data for indices
//     (delayed, end-of-day style) and CoinGecko for crypto.
// Responses are cached briefly so the ticker doesn't hammer the sources.

const INDICES = [
  { symbol: '^spx', name: 'S&P 500' },
  { symbol: '^ndq', name: 'Nasdaq' },
  { symbol: '^dji', name: 'Dow' },
];
const CRYPTO = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
];

const cache = new Map();

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchText(url, fetcher, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, headers: { 'User-Agent': 'CHE-markets/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function parseStooqCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date,open,high,low,close/i.test(lines[0])) return [];
  return lines.slice(1).map((line) => {
    const [date, open, high, low, close] = line.split(',');
    return { date, open: Number(open), high: Number(high), low: Number(low), close: Number(close) };
  }).filter((row) => row.date && [row.open, row.high, row.low, row.close].every(Number.isFinite));
}

export async function candles(symbol, fetcher = fetch) {
  const clean = String(symbol || '').toLowerCase();
  if (!/^\^?[a-z0-9.]{1,12}$/.test(clean)) return { error: 'Unknown symbol.' };
  return cached(`candles:${clean}`, 10 * 60_000, async () => {
    try {
      const text = await fetchText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(clean)}&i=d`, fetcher);
      const rows = parseStooqCsv(text).slice(-40);
      if (!rows.length) return { symbol: clean, candles: [], error: 'No data from the delayed index source.' };
      return { symbol: clean, candles: rows, source: 'Stooq (delayed)' };
    } catch (_) {
      return { symbol: clean, candles: [], error: 'Delayed index source unavailable.' };
    }
  });
}

async function connectorSnapshot(env, fetcher) {
  const response = await fetcher(env.CHE_MARKET_DATA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.CHE_MARKET_DATA_TOKEN ? { Authorization: `Bearer ${env.CHE_MARKET_DATA_TOKEN}` } : {}),
    },
    body: JSON.stringify({ tool: 'snapshot', mode: 'read_only' }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.quotes)) throw new Error('bad shape');
  return { quotes: data.quotes.slice(0, 20), source: 'Your market data connector', live: true };
}

export async function snapshot(env, fetcher = fetch) {
  return cached('snapshot', 60_000, async () => {
    if (env.CHE_MARKET_DATA_URL) {
      try {
        return await connectorSnapshot(env, fetcher);
      } catch (_) { /* fall back to public sources, labeled */ }
    }
    const indexQuotes = await Promise.all(INDICES.map(async (item) => {
      const data = await candles(item.symbol, fetcher);
      const rows = data.candles || [];
      if (rows.length < 2) return { symbol: item.symbol, name: item.name, status: 'unavailable', note: data.error || 'No data' };
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      return {
        symbol: item.symbol,
        name: item.name,
        price: last.close,
        change_pct: prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0,
        as_of: last.date,
        status: 'delayed',
      };
    }));
    let cryptoQuotes;
    try {
      const text = await fetchText(
        `https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&include_24hr_change=true&ids=${CRYPTO.map((c) => c.id).join(',')}`,
        fetcher,
      );
      const data = JSON.parse(text);
      cryptoQuotes = CRYPTO.map((coin) => (data?.[coin.id]?.usd
        ? {
            symbol: coin.symbol,
            name: coin.name,
            price: data[coin.id].usd,
            change_pct: Number(data[coin.id].usd_24h_change || 0),
            status: 'live',
          }
        : { symbol: coin.symbol, name: coin.name, status: 'unavailable', note: 'No price returned' }));
    } catch (_) {
      cryptoQuotes = CRYPTO.map((coin) => ({ symbol: coin.symbol, name: coin.name, status: 'unavailable', note: 'Crypto source unavailable' }));
    }
    return {
      quotes: [...indexQuotes, ...cryptoQuotes],
      source: 'Public sources: Stooq (delayed indices), CoinGecko (crypto)',
      live: false,
    };
  });
}


function moneyNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstMoney(data, keys) {
  for (const key of keys) {
    const value = moneyNumber(data?.[key]);
    if (value != null) return value;
  }
  return null;
}

// Read-only live trading account summary. CHE never scrapes or invents an
// account balance: the number must come from the owner's authorized broker
// connector. A normal web login alone is not treated as broker API access.
export async function accountSnapshot(env, fetcher = fetch) {
  if (!env.CHE_BROKER_URL) {
    return {
      connected: false,
      live: false,
      source: 'Broker connector not connected',
      detail: 'Sign-in can stay inside CHE, but live balance/equity requires an authorized broker connector.',
    };
  }
  return cached('broker-account', 5000, async () => {
    try {
      const response = await fetcher(env.CHE_BROKER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.CHE_BROKER_TOKEN ? { Authorization: `Bearer ${env.CHE_BROKER_TOKEN}` } : {}),
        },
        body: JSON.stringify({ tool: 'account_snapshot', mode: 'read_only' }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.json();
      const data = raw?.account && typeof raw.account === 'object' ? raw.account : raw;
      const balance = firstMoney(data, ['balance', 'cash_balance', 'account_balance', 'net_liquidation', 'net_liq']);
      const equity = firstMoney(data, ['equity', 'net_liquidation', 'net_liq', 'account_value']);
      const buyingPower = firstMoney(data, ['buying_power', 'buyingPower', 'available_funds', 'available']);
      if (balance == null && equity == null && buyingPower == null) throw new Error('connector returned no account amounts');
      return {
        connected: true,
        live: true,
        account_name: String(data?.account_name || data?.name || data?.account || data?.account_id || '').slice(0, 100),
        currency: String(data?.currency || 'USD').slice(0, 8),
        balance,
        equity,
        buying_power: buyingPower,
        as_of: String(data?.as_of || data?.timestamp || new Date().toISOString()),
        source: 'Your authorized broker connector',
      };
    } catch (error) {
      return {
        connected: true,
        live: false,
        source: 'Broker connector',
        detail: `Live account unavailable: ${String(error?.message || error).slice(0, 180)}`,
      };
    }
  });
}
