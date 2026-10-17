// Network and crawl rules for observe.mjs. Pure, so the tests check them without a browser.
//
//   blockedHost(host)       true for a private, loopback, link-local or reserved IP literal,
//                           or a local name; the browser never sends a request there
//   privateAddress(ip)      the address half of that rule, also used on DNS answers
//   robotsVerdict(text, p)  RFC 9309 matching for the '*' group: longest rule wins, Allow on a tie

import { isIP } from 'node:net';

const v4 = (ip) => {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
};

function private4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function hextets(ip) {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const q = v4(dotted[2]);
    if (!q) return null;
    text = `${dotted[1]}${(q[0] * 256 + q[1]).toString(16)}:${(q[2] * 256 + q[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const all = [...left, ...Array(fill).fill('0'), ...right].map((h) => parseInt(h, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

function private6(h) {
  if (h.slice(0, 7).every((n) => n === 0) && h[7] <= 1) return true;
  if ((h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xff00) === 0xff00) return true;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  // IPv4-mapped, IPv4-compatible and NAT64 addresses carry an IPv4 address in the last 32 bits.
  const mapped = h.slice(0, 5).every((n) => n === 0) && (h[5] === 0xffff || h[5] === 0);
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((n) => n === 0);
  return (mapped || nat64) && private4([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255]);
}

export function privateAddress(ip) {
  const text = String(ip ?? '').replace(/^\[|\]$/g, '');
  const kind = isIP(text.replace(/%.*$/, ''));
  if (kind === 4) return private4(v4(text));
  if (kind === 6) {
    const h = hextets(text);
    return !h || private6(h);
  }
  return false;
}

export function localName(host) {
  const name = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return !name.includes('.') || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|arpa)$/.test(name);
}

export function blockedHost(host) {
  const name = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!name) return true;
  if (isIP(name.replace(/%.*$/, ''))) return privateAddress(name);
  return localName(name);
}

// '*' matches any run of characters; a final '$' anchors the end. Greedy and linear, so a
// hostile robots.txt cannot make the match slow.
function ruleMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!path.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (anchored && i === parts.length - 1) return path.length - part.length >= at && path.endsWith(part);
    const found = path.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return anchored ? at === path.length : true;
}

export function robotsRules(text) {
  const groups = [];
  let current = null;
  let inAgents = false;
  for (const raw of String(text ?? '').slice(0, 512 * 1024).split(/\r\n|\r|\n/)) {
    const found = raw.replace(/#.*$/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!found) continue;
    const key = found[1].toLowerCase();
    const value = found[2].trim();
    if (key === 'user-agent') {
      if (!inAgents) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      inAgents = true;
    } else {
      inAgents = false;
      if ((key === 'allow' || key === 'disallow') && current) current.rules.push({ allow: key === 'allow', path: value.slice(0, 500) });
    }
  }
  return groups.filter((group) => group.agents.includes('*')).flatMap((group) => group.rules);
}

export function robotsVerdict(text, path) {
  const target = String(path || '/');
  if (target === '/robots.txt') return { allowed: true, rule: '' };
  let best = null;
  for (const rule of robotsRules(text)) {
    if (!rule.path || !ruleMatches(rule.path, target)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  if (!best) return { allowed: true, rule: '' };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` };
}
