// Shop price lookups ("Look up the price of coffee in three shops and compare them"). Certification run 24
// (41491194768), ter-32: no tool read a shop's price, and the model answered with invented prices for three named
// chains. CHE has no tool that reads shop or menu prices, so the honest answer says that and quotes no figure.
// Market prices (stocks, futures, crypto) are not shop prices and go to their own routes. Wired in worker.js after the
// multi-tool turn.
import { ndjsonReply } from './ndjson_reply.js';

const SHOPS = String.raw`(?:shops?|stores?|caf(?:e|é)s?|coffee\s+shops?|restaurants?|supermarkets?|grocers?|grocery\s+stores?|retailers?|chains?|outlets?|places|bakeries|pharmacies|gas\s+stations?|petrol\s+stations?)`;
const MANY = String.raw`(?:two|three|four|five|six|several|a\s+few|a\s+couple\s+of|different|local|nearby|\d+)`;
const LOOKUP = /\b(?:look\s*up|find|check|get|pull\s+up|search(?:\s+for)?|compare|what(?:'s|\s+is|\s+are)|how\s+much\s+(?:is|are|does|do))\b/i;
const PRICE = /\b(?:prices?|cost(?:s)?|how\s+much)\b/i;
const AT_SHOPS = new RegExp(String.raw`\b(?:at|in|across|from|between|among)\s+(?:the\s+)?${MANY}\s+(?:different\s+|local\s+|nearby\s+)?${SHOPS}\b`, 'i');
const NOT_NOW = /\b(?:don['’]t|do\s+not|never|no\s+need\s+to|stop)\s+(?:look|find|check|search|compare|get)\b/i;
const MARKET = /\b(?:stocks?|shares?|futures?|crypto|bitcoin|btc|eth|etf|index|ticker|options?|MNQ|NQ|MES|ES|SPY|QQQ)\b/;

/** The item whose shop price the owner asked for, or null when this is not a shop price lookup. */
export function retailPriceRequest(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 400 || NOT_NOW.test(text) || MARKET.test(text)) return null;
  if (!LOOKUP.test(text) || !PRICE.test(text) || !AT_SHOPS.test(text)) return null;
  const item = text.match(/\b(?:price|cost)s?\s+of\s+(?:an?\s+|the\s+)?([a-z][a-z\s'-]{1,40}?)\s+(?:at|in|across|from|between|among)\b/i)?.[1]
    || text.match(/\b(?:compare|check)\s+(?:the\s+)?([a-z][a-z\s'-]{1,40}?)\s+prices?\b/i)?.[1]
    || '';
  return { item: item.trim().toLowerCase() };
}

/** The honest reply: no shop price tool ran, so no price is quoted. */
export function retailPriceReply({ item } = {}) {
  const what = item ? `${item} prices` : 'shop prices';
  return `I can't look up ${what} at shops, sir: I don't have a tool that reads a shop's or a menu's prices, so I looked nothing up and I won't guess figures. Prices also differ by location. If you tell me the shops and your area, I can search the web for prices they publish, and I'll only quote ones I can show you a source for.`;
}

/** The whole turn for /api/chat, or null when the message is not a shop price lookup. */
export function retailPriceTurn(message) {
  const ask = retailPriceRequest(message);
  return ask ? ndjsonReply(retailPriceReply(ask), { source: 'che_retail_prices', ok: false, capability: 'missing', model_calls: 0 }) : null;
}
