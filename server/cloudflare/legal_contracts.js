// CHE contract intelligence (owner, 2026-10-22): reads an uploaded contract's own text and returns its key terms and
// review flags. Every term and flag quotes the sentence it came from; a term that is not in the text is reported as
// "not found", never filled in. Flags are review prompts for the owner and his attorney, not legal conclusions.

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const FLAG = Object.freeze({ good: 'GOOD', watch: 'WATCH', high: 'HIGH RISK', question: 'QUESTION' });

/// Sentences, keeping numbered clause headings attached to their text.
export function sentences(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.;])\s+(?=[A-Z0-9(“"])|\n{2,}|\n(?=\s*(?:\d+(?:\.\d+)*[.)]|[A-Z][A-Z ]{3,}:?)\s)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 3);
}

// Each term: the words that identify it. The first matching sentence is quoted.
const TERMS = [
  ['parties', /\b(?:by and between|between)\b.+\band\b/i],
  ['effective_date', /\beffective (?:as of|date|on)\b/i],
  ['term', /\b(?:term of this agreement|the term|shall (?:commence|continue|remain in effect)|for a period of|in perpetuity|perpetual)\b/i],
  ['payment', /\b(?:shall pay|will pay|payment|fee of|advance|royalt(?:y|ies)|compensation|\$\s?\d)/i],
  ['commission', /\bcommission\b/i],
  ['ownership', /\b(?:own(?:s|ership)?|right, title and interest|work made for hire|work for hire|assigns?|assignment)\b/i],
  ['license', /\b(?:licen[cs]e[sd]?|grants? to)\b/i],
  ['exclusivity', /\bexclusiv\w*\b/i],
  ['territory', /\b(?:territory|worldwide|throughout the (?:world|universe))\b/i],
  ['renewal', /\b(?:renew\w*|extend\w* automatically|option to extend)\b/i],
  ['termination', /\bterminat\w*\b/i],
  ['indemnification', /\bindemnif\w*\b/i],
  ['dispute_resolution', /\b(?:arbitrat\w*|mediat\w*|dispute|venue|jurisdiction of the courts)\b/i],
  ['governing_law', /\b(?:governed by|governing law|construed in accordance with) .*\blaws? of\b/i],
  ['confidentiality', /\bconfidential\w*\b/i],
];

export const TERM_LABELS = Object.freeze({
  parties: 'Parties', effective_date: 'Effective date', term: 'Term', payment: 'Payment', commission: 'Commission',
  ownership: 'Ownership', license: 'Licence', exclusivity: 'Exclusivity', territory: 'Territory', renewal: 'Renewal',
  termination: 'Termination', indemnification: 'Indemnification', dispute_resolution: 'Disputes', governing_law: 'Governing law',
  confidentiality: 'Confidentiality',
});

/// The contract's key terms, each with the sentence it came from, or null when the text does not contain it.
export function extractTerms(text) {
  const all = sentences(text);
  const out = {};
  for (const [key, re] of TERMS) {
    const hit = all.filter((s) => re.test(s));
    out[key] = hit.length ? { quote: clip(hit[0], 500), also: hit.slice(1, 3).map((s) => clip(s, 300)) } : null;
  }
  const law = out.governing_law?.quote.match(/laws? of (?:the )?(?:State of |Commonwealth of )?([A-Z][A-Za-z ]+?)(?:[,.;]| without| and\b|$)/);
  if (out.governing_law && law) out.governing_law.place = law[1].trim();
  const pct = out.commission?.quote.match(/(\d{1,2}(?:\.\d+)?)\s?(?:%|percent)/i);
  if (out.commission && pct) out.commission.percent = Number(pct[1]);
  return out;
}

/// Review flags, each tied to the quoted sentence that raised it. `home` is the owner's state or country name.
export function reviewFlags(terms, { home = null } = {}) {
  const flags = [];
  const add = (level, term, text) => flags.push({ level, term, text, quote: terms[term]?.quote || null });
  const q = (k) => terms[k]?.quote || '';
  const everything = Object.values(terms).filter(Boolean).flatMap((t) => [t.quote, ...(t.also || [])]).join(' ');
  if (/\bwork (?:made )?for hire\b/i.test(everything)) add(FLAG.high, 'ownership', 'Work made for hire: the other side would own what is created from the start.');
  else if (/\b(?:assigns?|transfers?)\b[^.]*\ball right, title and interest\b|\ball right, title and interest\b[^.]*\b(?:assign|transfer)/i.test(everything)) add(FLAG.high, 'ownership', 'Assignment of all right, title and interest: ownership would transfer, not be licensed.');
  else if (terms.ownership) add(FLAG.watch, 'ownership', 'Ownership language: confirm who owns what you create during and after the term.');
  if (/\b(?:in perpetuity|perpetual)\b/i.test(everything)) add(terms.exclusivity ? FLAG.high : FLAG.watch, 'term', `Perpetual${terms.exclusivity ? ' and exclusive' : ''}: it never ends on its own.`);
  if (terms.exclusivity) add(FLAG.watch, 'exclusivity', 'Exclusive: check what it covers and whether it stops you working with others.');
  if (/\bautomatically renew|renew automatically|extend\w* automatically/i.test(everything)) add(FLAG.watch, 'renewal', 'Automatic renewal: note the date and how to give notice before it renews.');
  if (!terms.termination) add(FLAG.question, 'termination', 'No termination clause found: how does either side end this?');
  else add(FLAG.good, 'termination', 'Termination terms are stated.');
  if (!terms.payment && !terms.commission) add(FLAG.question, 'payment', 'No payment terms found.');
  else if (terms.payment) add(FLAG.good, 'payment', 'Payment terms are stated.');
  if (terms.commission) {
    add(FLAG.watch, 'commission', `${terms.commission.percent ? `${terms.commission.percent}% commission` : 'Commission'}: confirm whether it is on gross or net income, which income it covers, and whether it continues after the term.`);
    if (/\b(?:after (?:the )?(?:term|termination|expiration)|post[- ]term|sunset)\b/i.test(q('commission') + ' ' + (terms.commission.also || []).join(' '))) add(FLAG.high, 'commission', 'Commission continues after the agreement ends: check how long and on what.');
  }
  if (terms.indemnification && !/\bmutual|each party\b/i.test(q('indemnification'))) add(FLAG.watch, 'indemnification', 'One-sided indemnity: one party covers the other\'s losses. Check who.');
  if (/\barbitrat/i.test(q('dispute_resolution'))) add(FLAG.watch, 'dispute_resolution', 'Disputes go to arbitration, not court: check where, who pays, and any class-action waiver.');
  if (terms.governing_law?.place && home && !new RegExp(home, 'i').test(terms.governing_law.place)) add(FLAG.watch, 'governing_law', `Governed by ${terms.governing_law.place} law, not ${home}.`);
  if (!terms.parties) add(FLAG.question, 'parties', 'The parties are not named in a form I could find.');
  if (/\b(?:worldwide|throughout the (?:world|universe))\b/i.test(everything) && terms.exclusivity) add(FLAG.watch, 'territory', 'Worldwide and exclusive.');
  return flags;
}

/// One contract's analysis: terms with quotes, flags, and a short spoken summary. The full text is not kept;
/// only the quoted sentences are stored with the analysis.
export function analyzeContract(text, { name = 'Contract', home = null, now = new Date().toISOString() } = {}) {
  const body = String(text || '');
  if (body.replace(/\s+/g, '').length < 80) return { ok: false, why: 'I could not read enough text from that contract. A text or text-based PDF export works best.' };
  const terms = extractTerms(body);
  const flags = reviewFlags(terms, { home });
  const found = Object.entries(terms).filter(([, v]) => v).map(([k]) => TERM_LABELS[k]);
  const missing = Object.entries(terms).filter(([, v]) => !v).map(([k]) => TERM_LABELS[k]);
  const order = [FLAG.high, FLAG.watch, FLAG.question, FLAG.good];
  const top = [...flags].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const highs = flags.filter((f) => f.level === FLAG.high).length;
  const spoken = [
    `${name}: ${highs ? `${highs} high-risk item${highs === 1 ? '' : 's'}` : 'no high-risk items found'}, ${flags.filter((f) => f.level === FLAG.watch).length} to watch, ${flags.filter((f) => f.level === FLAG.question).length} question${flags.filter((f) => f.level === FLAG.question).length === 1 ? '' : 's'}.`,
    ...top.slice(0, 3).map((f) => `${f.level}: ${f.text}`),
    missing.length ? `Not found in the text: ${missing.join(', ')}.` : '',
    highs ? 'This is worth an attorney\'s review before you sign.' : '',
  ].filter(Boolean).join(' ');
  return { ok: true, name: clip(name, 120), analyzed_at: now, terms, flags, found, missing, attorney: highs > 0, spoken };
}
