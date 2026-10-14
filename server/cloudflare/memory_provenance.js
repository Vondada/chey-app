// What CHE may say the owner said, confirmed or did (owner, 2026-10-14).
//
// A live iPhone test asked "tell me something I've personally confirmed".
// The question missed #298's one exact phrase, reached the chat model, and the
// model invented a detailed personal event ("you tested the office security
// protocol last Tuesday"). A later admission did not undo it.
//
// This module is the gate between CHE's EXISTING memory stores and the owner:
// it adds no store, router or planner of its own.
//   1. A question about what the owner confirmed/said/told CHE is answered
//      from owner-attested memory records only, with no model.
//   2. Every model reply passes a final check: a sentence that says the owner
//      said, confirmed, tested, approved or experienced something must be
//      backed by an owner-attested record or the owner's own words in this
//      conversation, or it is removed and CHE says so.
//   3. ```che-remember lines (facts the phone saves to CHE's brain) must come
//      from the owner's own words, so a model guess never becomes a memory.
//   4. Each answer gets its own evidence receipt, so "how do you know that?"
//      explains THAT answer, not whichever receipt an unrelated turn wrote.
//   5. Stored records are audited once: anything that did not come from the
//      owner stops counting as an owner confirmation. Nothing is deleted.

// Sources that record the owner's own words or the owner's explicit approval.
// 'owner' is only trusted when a caller passes it explicitly (legacy records
// are checked by auditMemoryProvenance).
export const OWNER_MEMORY_SOURCES = new Set(['owner', 'owner_chat', 'explicit_memory', 'owner_approved']);
const UNTRUSTED_STATUSES = new Set(['unverified_reference', 'unverified_research_lead', 'disputed', 'invalidated', 'disproven', 'needs_owner_confirmation', 'che_generated']);

export const ANSWER_LEDGER_KEY = 'che_answer_ledger_v1';
export const RETRACTED_CLAIMS_KEY = 'che_retracted_claims_v1';
const LEDGER_MAX = 40;
const RETRACTED_MAX = 60;
export const PROVENANCE_AUDIT_VERSION = 1;

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Lower case, contractions spelled out, CHE's name and filler removed.
export function plainWords(text) {
  return String(text || '').toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\b(?:hey |ok |okay )?(?:che|chay|chey|shay)\b[,:]?/g, ' ')
    .replace(/\bi've\b|\bive\b/g, 'i have').replace(/\bi'd\b/g, 'i had').replace(/\bi'm\b|\bim\b/g, 'i am')
    .replace(/\byou've\b/g, 'you have').replace(/\byou're\b/g, 'you are').replace(/\bthat's\b|\bthats\b/g, 'that is')
    .replace(/\bwhat's\b|\bwhats\b/g, 'what is').replace(/\bdidn't\b/g, 'did not').replace(/\bit's\b/g, 'it is')
    .replace(/\bwhere's\b/g, 'where is').replace(/'s\b/g, ' s')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(('a an the and or but if then so of to in on at for with from by about into over after before as is are was were be been being '
  + 'i me my mine you your yours we our us he she it its they them their this that these those there here what which who whom whose '
  + 'do does did done have has had having will would can could should may might must shall not no yes very really just also too '
  + 'sir che chay something anything thing things some any all one ones more most much many once ever already previously personally '
  + 'actually recently earlier before now today yesterday last week weekend month year night monday tuesday wednesday thursday friday '
  + 'saturday sunday morning afternoon evening other day days ago remember remembered recall told tell telling said say saying mentioned '
  + 'mention confirmed confirm confirming verified verify stated state approved approve tested test witnessed experienced decided agreed '
  + 'shared share noted note reported explained let know knew taught owner owners user named name called yourself here own chat '
  + 'january february march april may june july august september october november december').split(' '));

function stem(word) {
  return word.replace(/(?:ing|ed|es|s)$/, '') || word;
}

/** Content words of a sentence, stemmed, without attribution verbs or time words. */
export function contentWords(text) {
  return [...new Set(plainWords(text).split(' ').filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem))];
}

/**
 * True when one evidence text says most of what the claim says. A claim with
 * no content words of its own ("as you said, sir") asserts nothing to check.
 */
export function supportedBy(claim, evidenceTexts = []) {
  const words = contentWords(claim);
  if (!words.length) return true;
  const need = words.length === 1 ? 1 : Math.max(2, Math.ceil(words.length * 0.6));
  return evidenceTexts.some((text) => {
    const have = new Set(contentWords(text));
    return words.filter((w) => have.has(w)).length >= need;
  });
}

// ─── Owner-attested evidence ───────────────────────────────────────────────

/** A record CHE may cite as the owner's own statement or approval. */
export function isOwnerAttested(record) {
  if (!record || record.active === false || record.superseded_at) return false;
  if (UNTRUSTED_STATUSES.has(String(record.verification_status || ''))) return false;
  if (record.verification_status !== 'owner_attested') return false;
  return OWNER_MEMORY_SOURCES.has(String(record.source || ''));
}

export function ownerAttestedRecords(data = {}) {
  return (Array.isArray(data.memory_records) ? data.memory_records : []).filter(isOwnerAttested);
}

/** What the owner actually said in this conversation: user turns plus this message. */
export function ownerWords(history = [], rawMessage = '') {
  const turns = (Array.isArray(history) ? history : []).slice(-40)
    .filter((turn) => turn?.role === 'user')
    .map((turn) => String(turn.content ?? turn.text ?? ''));
  return [...turns, String(rawMessage || '')].filter((text) => text.trim());
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function spokenDate(iso) {
  const at = new Date(String(iso || ''));
  if (!Number.isFinite(at.getTime())) return '';
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

function howRecorded(record) {
  switch (String(record.source || '')) {
    case 'explicit_memory': return 'you added it to my memory yourself';
    case 'owner_chat': return 'you told me in chat';
    case 'owner_approved': return 'you approved it';
    default: return 'it is in the memory list you keep';
  }
}

function quoteRecord(record) {
  const when = spokenDate(record.created_at);
  return `${when ? `On ${when}, ` : ''}${howRecorded(record)}: "${clip(record.text, 300).replace(/[.!]+$/, '')}."`;
}

// ─── 1. Questions about what the owner confirmed ───────────────────────────

const OWNER_ACT = '\\b(?:confirm(?:ed)?|verif(?:ied|y)|t(?:old|ell) you|sa(?:id|y)|mention(?:ed)?|stat(?:ed|e)|approv(?:ed|e)|test(?:ed)?|'
  + 'witness(?:ed)?|experienc(?:ed|e)|decid(?:ed|e)|agree(?:d)?|shar(?:ed|e)(?: with you)?|taught you|let you know|ask(?:ed)? you to remember)';
const OWNER_ADVERBS = '(?:(?:personally|previously|already|ever|just|once|actually|really|recently|myself|before|explicitly|directly) )*';
// "I confirmed", "I have personally verified": past forms only, so a request
// in the present tense ("a story where I test a lock") is not a memory question.
const OWNER_ACT_PAST = '\\b(?:confirmed|verified|told you|said|mentioned|stated|approved|tested|witnessed|experienced|decided|agreed|shared(?: with you)?|taught you|let you know|asked you to remember)';
const OWNER_SUBJECT_ACT = new RegExp(`\\bi (?:have |had )?${OWNER_ADVERBS}${OWNER_ACT_PAST}\\b|\\bi did ${OWNER_ADVERBS}${OWNER_ACT}\\b`);
const OWNER_INVERTED_ACT = new RegExp(`\\b(?:have|did|had) i ${OWNER_ADVERBS}${OWNER_ACT}\\b`);
const ASK_FORM = /^(?:(?:can|could|would|will) you (?:please )?)?(?:tell me|name|give me|share|list|remind me|what|which|(?:do )?you (?:remember|recall|know)|remember|recall|say|have i|did i|is there|are there|anything|something)\b/;

/**
 * A question about what the owner personally said, confirmed, approved or did.
 * Returns { topic } (topic '' for "anything") or null. Statements and commands
 * ("I confirmed the order", "confirm my booking") are not questions about memory.
 */
export function ownerMemoryQuestion(message) {
  const q = plainWords(message);
  if (!q || q.split(' ').length > 30 || FICTION_REQUEST.test(q)) return null;
  // The question itself must ask about memory: "I confirmed the order, what
  // is next?" is a statement followed by an unrelated question.
  if (!ASK_FORM.test(q) && !/^(?:anything|something|one thing)\b/.test(q)) return null;
  if (!OWNER_SUBJECT_ACT.test(q) && !OWNER_INVERTED_ACT.test(q)) return null;
  // "What did I just say?" asks for the owner's last words in this
  // conversation, not for his stored memories.
  if (/\b(?:just|a (?:moment|second|minute) ago|right now)\b/.test(q) && /\b(?:say|said|ask|asked|tell you|told you)\b/.test(q)) return { topic: '', recent: true };
  // "What did I tell you about my dog?" → "my dog". "Did I tell you I am moving?" → "i am moving".
  const about = /\babout (.+)$/.exec(q);
  let topic = about ? about[1] : '';
  if (!topic) {
    const tail = new RegExp(`${OWNER_ACT}\\b(?: (?:that|to you|me))? (.+)$`).exec(q);
    topic = tail ? tail[1] : '';
  }
  topic = topic.replace(/\b(?:to you|with you|before|already|so far|yet|ever|recently|lately|earlier)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!contentWords(topic).length) topic = '';
  return { topic };
}

function sameSlot(a, b) {
  const subject = (text) => {
    const m = /^(?:my )?(favorite [a-z ]{1,40}?|[a-z][a-z ]{1,50}?) (?:is|are) /.exec(plainWords(text));
    return m ? m[1].trim() : '';
  };
  const left = subject(a);
  return Boolean(left) && left === subject(b);
}

/**
 * The answer to a question about what the owner confirmed, from records only.
 * Returns { answer, records: [ids], kind }.
 */
export function answerOwnerMemoryQuestion(data = {}, question = {}, history = []) {
  if (question.recent) {
    const last = [...(Array.isArray(history) ? history : [])].reverse().find((turn) => turn?.role === 'user' && String(turn.content ?? turn.text ?? '').trim());
    return last
      ? { kind: 'owner_attested', records: [], answer: `You just said: "${clip(last.content ?? last.text, 400)}"` }
      : { kind: 'none', records: [], answer: "I don't have your previous message in this conversation, sir, so I can't repeat it." };
  }
  const records = Array.isArray(data.memory_records) ? data.memory_records : [];
  const attested = ownerAttestedRecords(data);
  const topic = String(question.topic || '');
  const unconfirmed = records.filter((r) => r && r.active !== false && !isOwnerAttested(r));
  if (!topic) {
    const pick = attested.slice(-3).reverse();
    if (!pick.length) {
      const notes = unconfirmed.length
        ? ` I do have ${unconfirmed.length} note${unconfirmed.length === 1 ? '' : 's'} from other sources, such as my own inferences or Office agents, but you never confirmed ${unconfirmed.length === 1 ? 'it' : 'them'}.`
        : '';
      return {
        kind: 'none',
        records: [],
        answer: `I cannot find a source-recorded owner confirmation, sir: no statement or approval from you that I can point to. I won't make one up.${notes} If you tell me something now and ask me to remember it, I'll keep it as your statement.`,
      };
    }
    const lines = pick.map(quoteRecord).join(' ');
    return {
      kind: 'owner_attested',
      records: pick.map((r) => r.id).filter(Boolean),
      answer: `Here ${pick.length === 1 ? 'is something' : 'are things'} you told me yourself, sir. ${lines} ${pick.length === 1 ? 'That is your own statement' : 'These are your own statements'}, recorded when you made ${pick.length === 1 ? 'it' : 'them'}. I haven't checked ${pick.length === 1 ? 'it' : 'them'} against any outside source.`,
    };
  }
  const matches = attested.filter((r) => supportedBy(topic, [r.text]));
  if (matches.length) {
    const current = matches[matches.length - 1];
    const history = records.filter((r) => r && r !== current && r.active === false && r.superseded_by &&
      OWNER_MEMORY_SOURCES.has(String(r.source || '')) && (supportedBy(topic, [r.text]) || sameSlot(r.text, current.text)));
    const earlier = history.length
      ? ` Before that, ${history.slice(-2).map((r) => `${spokenDate(r.created_at) ? `on ${spokenDate(r.created_at)} ` : ''}you said "${clip(r.text, 200).replace(/[.!]+$/, '')}"`).join(', and ')}; you corrected it${spokenDate(history[history.length - 1].superseded_at) ? ` on ${spokenDate(history[history.length - 1].superseded_at)}` : ''}, so I use your newer answer.`
      : '';
    return {
      kind: 'owner_attested',
      records: [current.id, ...history.map((r) => r.id)].filter(Boolean),
      answer: `${quoteRecord(current)}${earlier} That is your own statement; I haven't checked it against any outside source.`,
    };
  }
  const notes = unconfirmed.filter((r) => supportedBy(topic, [r.text]));
  if (notes.length) {
    const note = notes[notes.length - 1];
    return {
      kind: 'unverified',
      records: [],
      answer: `I don't have a record of you confirming anything about ${clip(topic, 80)}, sir. I do have a note about it, but it came from ${String(note.source || 'another source').replace(/_/g, ' ')}, not from you, so I can't call it your confirmation.`,
    };
  }
  return {
    kind: 'none',
    records: [],
    answer: `I don't have any record of you telling me about ${clip(topic, 80)}, sir, so I can't say you confirmed it. I won't guess.`,
  };
}

// ─── 2. Final check on what a reply says the owner said or did ─────────────

const ATTRIBUTION = new RegExp([
  `\\byou(?: have| had)? ${OWNER_ADVERBS}(?:also )?(?:confirmed|verified|told me|said|mentioned|stated|approved|tested|witnessed|experienced|decided|agreed|shared|reported|noted|explained|let me know|taught me|indicated|asked me to remember)\\b`,
  '\\bas you (?:said|mentioned|told me|confirmed|noted|explained|put it)\\b',
  '\\baccording to you\\b',
  '\\byour (?:confirmation|own words|earlier statement|approval)\\b',
  '\\bi remember (?:that )?you\\b',
].join('|'));
const HYPOTHETICAL = /^(?:if|when|whenever|once|unless|suppose|imagine|let s say|in case)\b/;
const FICTION_REQUEST = /\b(?:story|stories|fiction|fictional|pretend|role ?play|imagine|hypothetical(?:ly)?|make up|made up|brainstorm|poem|joke|scenario|example dialogue)\b/;

function sentences(text) {
  return String(text || '').match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) || [];
}

/**
 * Removes sentences that attribute an unrecorded statement, confirmation,
 * test or experience to the owner. Returns { text, removed: [sentences] }.
 */
export function guardOwnerAttributions(reply, { records = [], ownerTurns = [], message = '' } = {}) {
  const text = String(reply || '');
  if (!text.trim() || FICTION_REQUEST.test(plainWords(message))) return { text, removed: [] };
  const evidence = [...ownerTurns, ...records.filter(isOwnerAttested).map((r) => String(r.text || ''))];
  const removed = [];
  // Code blocks (including ```che-remember) are checked separately.
  const parts = text.split(/(```[\s\S]*?```)/g);
  const kept = parts.map((part) => {
    if (part.startsWith('```')) return part;
    return sentences(part).filter((sentence) => {
      const plain = plainWords(sentence);
      if (!ATTRIBUTION.test(plain)) return true;
      if (/\?\s*$/.test(sentence) || HYPOTHETICAL.test(plain)) return true;
      if (supportedBy(sentence, evidence)) return true;
      removed.push(clip(sentence, 300));
      return false;
    }).join('');
  }).join('').replace(/[ \t]+\n/g, '\n').replace(/\s{2,}/g, ' ').trim();
  if (!removed.length) return { text, removed };
  const correction = 'I can find no record of you saying or confirming that, sir, so I have left it out rather than present it as yours.';
  const body = kept.replace(/```[\s\S]*?```/g, '').trim();
  return { text: body.length >= 40 ? `${kept}\n\n${correction}` : `${correction} If you tell me now, I'll keep it as your own statement.${kept.includes('```') ? `\n\n${kept.match(/```[\s\S]*?```/g).join('\n')}` : ''}`, removed };
}

/**
 * Keeps only ```che-remember lines the owner actually said (in this message
 * or a recent turn of his). A fact the model inferred never reaches the brain.
 */
export function guardRememberBlock(reply, { ownerTurns = [], retracted = [] } = {}) {
  const text = String(reply || '');
  const dropped = [];
  const out = text.replace(/```che-remember[^\n]*\n([\s\S]*?)```/gi, (_block, body) => {
    const keep = body.split('\n').filter((line) => {
      const fact = line.replace(/^\s*[-*•]\s*/, '').replace(/^\[[^\]]{1,30}\]\s*/, '').trim();
      if (!fact) return false;
      const isRetracted = retracted.some((item) => supportedBy(fact, [item.snippet || '']));
      if (!isRetracted && supportedBy(fact, ownerTurns) && contentWords(fact).length) return true;
      dropped.push(clip(fact, 200));
      return false;
    });
    return keep.length ? `\`\`\`che-remember\n${keep.join('\n')}\n\`\`\`` : '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: dropped.length ? out : text, dropped };
}

// ─── 3. Evidence for one specific answer ───────────────────────────────────

/** Fingerprint of the start of an answer, unaffected by case, whitespace and punctuation. */
export function answerFingerprint(text) {
  const plain = plainWords(String(text || '').replace(/```[\s\S]*?```/g, ' ')).slice(0, 300);
  let hash = 0x811c9dc5;
  for (let i = 0; i < plain.length; i += 1) {
    hash ^= plain.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Saves the evidence behind one answer. The snippet lets CHE quote what she is explaining. */
export async function recordAnswerEvidence(storage, reply, receipt = {}, extra = {}) {
  if (!storage?.get || !storage?.put) return null;
  const entry = {
    fp: answerFingerprint(reply),
    snippet: clip(String(reply || '').replace(/```[\s\S]*?```/g, ' '), 200),
    at: Number.isFinite(receipt.at) ? receipt.at : Date.now(),
    kind: receipt.kind || 'unverified',
    sources: Array.isArray(receipt.sources) ? receipt.sources.slice(0, 5) : [],
    tools: Array.isArray(receipt.tools) ? receipt.tools.slice(0, 5) : [],
    records: Array.isArray(extra.records) ? extra.records.slice(0, 5) : [],
    meta: extra.meta === true,
    attributions_removed: Number(extra.attributions_removed || 0),
  };
  try {
    const ledger = (await storage.get(ANSWER_LEDGER_KEY)) || [];
    ledger.push(entry);
    await storage.put(ANSWER_LEDGER_KEY, ledger.slice(-LEDGER_MAX));
  } catch (_) { /* evidence must never break a reply */ }
  return entry;
}

export async function findAnswerEvidence(storage, answerText) {
  try {
    const ledger = (await storage?.get(ANSWER_LEDGER_KEY)) || [];
    const fp = answerFingerprint(answerText);
    const exact = [...ledger].reverse().find((entry) => entry.fp === fp);
    if (exact) return exact;
    // The phone may keep a trimmed copy; accept a clear overlap with the snippet.
    const words = contentWords(String(answerText || '').slice(0, 400));
    if (words.length < 3) return null;
    return [...ledger].reverse().find((entry) => {
      const have = new Set(contentWords(entry.snippet));
      return words.slice(0, 20).filter((w) => have.has(w)).length >= Math.ceil(Math.min(words.length, 20) * 0.8);
    }) || null;
  } catch (_) {
    return null;
  }
}

export async function latestAnswerEvidence(storage) {
  try {
    const ledger = (await storage?.get(ANSWER_LEDGER_KEY)) || [];
    return [...ledger].reverse().find((entry) => !entry.meta) || null;
  } catch (_) {
    return null;
  }
}

const EVIDENCE_ASK = [
  /\bhow (?:do|did|would|could|can) you (?:know|be sure|tell|be certain)(?: (?:that|this|it|so|for sure|for certain|whether|if)\b.*)?$/,
  /\bhow are you (?:sure|certain)\b/,
  /\bare you (?:sure|certain)(?: (?:about|of) (?:that|this|it))?$/,
  /\bwhat (?:evidence|proof|source|sources|receipt|receipts|record|records) (?:do you have|is there|did you use|supports? (?:that|this|it)|backs? (?:that|this|it) up|are you using)\b/,
  /\bwhat is (?:your|the) (?:evidence|proof|source|sources)\b/,
  /\bwhere did you (?:get|hear|find|learn|read) (?:that|this|it)\b/,
  /\bwho told you (?:that|this)\b/,
  /\b(?:is|was) (?:that|this|it) (?:verified|confirmed|true|correct|accurate|real|right|a fact)$/,
  /\bdid i (?:really |actually |ever )?(?:confirm|say|tell you|verify|approve|test) (?:that|this|it)\b/,
  /\bcan you (?:prove|back up|verify|cite|source|fact check|show me) (?:that|this|it)\b/,
  /\bshow me (?:the |your )?(?:evidence|proof|sources?|receipts?)\b/,
  /\bwhat makes you (?:think|say|so sure) (?:that|so|this)?\b/,
];
const REFERENT_ONLY = /^(?:the |that |your )?(?:last|previous|first|earlier) (?:one|answer|thing|claim|statement)(?: (?:we were|you were|i was) (?:just )?(?:talking|speaking) about| you (?:just )?(?:said|mentioned|told me))?$|^(?:the one|what) (?:we were|you were) (?:just )?(?:talking|speaking) about$|^what you (?:just )?said$/;

/** A question asking CHE for the evidence behind something she said. */
export function evidenceQuestion(message, history = []) {
  const clauses = String(message || '').split(/[.?!;]+/).map(plainWords).filter(Boolean);
  if (!clauses.length || clauses.join(' ').split(' ').length > 40) return false;
  const asks = clauses.some((clause) => EVIDENCE_ASK.some((re) => re.test(clause)));
  // Any other request in the same message ("…and book me a table") goes to
  // the normal path; only "sir", "okay" and the like may ride along.
  if (asks) return clauses.every((clause) => EVIDENCE_ASK.some((re) => re.test(clause)) || REFERENT_ONLY.test(clause) || clause.split(' ').length <= 2);
  // "The last one we were just talking about" right after an evidence question.
  if (!clauses.every((clause) => REFERENT_ONLY.test(clause))) return false;
  const lastUser = [...(Array.isArray(history) ? history : [])].reverse().find((turn) => turn?.role === 'user');
  return Boolean(lastUser && evidenceQuestion(String(lastUser.content ?? lastUser.text ?? ''), []));
}

/**
 * The earlier answer of CHE's that the owner is asking about: the most recent
 * assistant claim, skipping CHE's own replies to evidence questions and bare
 * questions back to the owner. Returns { text } or null.
 */
export function evidenceReferent(history = []) {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role !== 'assistant') continue;
    const text = String(turn.content ?? turn.text ?? '').trim();
    if (!text) continue;
    const before = turns.slice(0, i).reverse().find((t) => t?.role === 'user');
    if (before && evidenceQuestion(String(before.content ?? before.text ?? ''), [])) continue;
    if (/\?\s*$/.test(text) && text.length < 120) continue;
    return { text };
  }
  return null;
}

/** Plain explanation of one answer's evidence, quoting the answer it is about. */
export function explainEvidenceFor({ referent = null, entry = null, records = [], ownerTurns = [], now = Date.now() } = {}) {
  const quote = referent?.text ? `About my answer "${clip(referent.text.replace(/```[\s\S]*?```/g, ' '), 140)}": ` : '';
  // An answer CHE built from the owner's records already carries its
  // evidence; anything else that speaks for the owner is re-checked.
  const builtFromRecords = entry?.kind === 'owner_attested' && entry.records?.length;
  if (referent?.text && !builtFromRecords) {
    const claimed = sentences(referent.text.replace(/```[\s\S]*?```/g, ' ')).filter((s) => ATTRIBUTION.test(plainWords(s)) && !/\?\s*$/.test(s));
    const evidence = [...ownerTurns, ...records.filter(isOwnerAttested).map((r) => String(r.text || ''))];
    const unsupported = claimed.filter((s) => !supportedBy(s, evidence));
    if (unsupported.length) {
      return {
        retract: unsupported.map((s) => clip(s, 200)),
        text: `${quote}I have no record that you ever said or confirmed that, sir. It was not verified by anything, so that statement was wrong, and I am taking it back. I won't save it as a memory.`,
      };
    }
  }
  if (!entry) {
    return {
      retract: [],
      text: referent?.text
        ? `${quote}I do not have an evidence record for that answer, sir. It was not independently verified, so please treat it as unconfirmed.`
        : 'I do not have a recent evidence record for that, sir, and no earlier answer of mine in this conversation to check. I cannot honestly claim it was fact-checked.',
    };
  }
  if (now - entry.at > 86400000 || entry.at > now + 60000) {
    return { retract: [], text: `${quote}I do not have a recent evidence record for that answer, sir. I cannot honestly claim it was fact-checked.` };
  }
  if (entry.kind === 'owner_attested') {
    const cited = records.filter((r) => entry.records?.includes(r.id));
    return {
      retract: [],
      text: `${quote}That came from what you told me${cited.length ? `: ${cited.map(quoteRecord).join(' ')}` : '.'} It is your own statement, not an independently verified outside fact.`,
    };
  }
  if (entry.kind === 'source_backed' && entry.sources?.length) {
    return { retract: [], text: `${quote}The research tools returned these source links: ${entry.sources.join(', ')}. A link is not proof that every claim in my answer was independently fact-checked.` };
  }
  if (entry.kind === 'tool_result' && entry.tools?.length) {
    return { retract: [], text: `${quote}That answer used these successful tools: ${entry.tools.join(', ')}. I do not have a source link for independent confirmation, sir.` };
  }
  if (entry.kind === 'none') {
    return { retract: [], text: `${quote}That was me telling you I had no record to cite, sir. There is no evidence behind it because I did not claim anything.` };
  }
  return { retract: [], text: `${quote}That answer came from my language model alone. It was not independently verified, and I have no source, tool result or record of yours behind it.` };
}

export async function recordRetractions(storage, claims = [], now = Date.now()) {
  if (!claims.length || !storage?.put) return;
  try {
    const list = (await storage.get(RETRACTED_CLAIMS_KEY)) || [];
    for (const claim of claims) list.push({ snippet: clip(claim, 200), at: now });
    await storage.put(RETRACTED_CLAIMS_KEY, list.slice(-RETRACTED_MAX));
  } catch (_) { /* never break the reply */ }
}

export async function loadRetractions(storage) {
  try { return (await storage?.get(RETRACTED_CLAIMS_KEY)) || []; } catch (_) { return []; }
}

// ─── 4. One-time audit of stored records ───────────────────────────────────

// Notes CHE's own code wrote with the old default source ('owner').
const SYSTEM_NOTE = /^Roblox .{0,80} line queued tonight\b|Owner confirm before publish/i;

/**
 * Marks every stored record honestly. Nothing is deleted: a record that did
 * not come from the owner keeps its text and history but stops counting as an
 * owner confirmation. Returns the number of records changed.
 */
export function auditMemoryProvenance(data = {}, now = new Date().toISOString()) {
  const records = Array.isArray(data.memory_records) ? data.memory_records : [];
  let changed = 0;
  for (const record of records) {
    if (!record || record.provenance_audit === PROVENANCE_AUDIT_VERSION) continue;
    const source = String(record.source || '');
    const status = String(record.verification_status || '');
    let next = status;
    let reason = '';
    if (source === 'owner' && SYSTEM_NOTE.test(String(record.text || ''))) {
      next = 'che_generated';
      reason = 'written by CHE, not said by the owner';
    } else if (!OWNER_MEMORY_SOURCES.has(source)) {
      if (!status || status === 'owner_attested') {
        next = 'unverified_reference';
        reason = `came from ${source || 'an unknown source'}, not from the owner`;
      }
    } else if (!status) {
      // Records from before verification_status existed: the owner's own
      // memory paths (chat "remember", the Memory screen) are his statements.
      next = 'owner_attested';
      reason = 'older owner memory record';
    }
    if (next !== status) {
      record.verification_status = next;
      record.provenance_note = reason;
      record.audited_at = now;
      changed += 1;
    }
    record.provenance_audit = PROVENANCE_AUDIT_VERSION;
  }
  return changed;
}

// ─── Prompt context: say where each memory came from ───────────────────────

/** Memories for the chat model, split by who they came from. */
export function memoryPromptContext(data = {}) {
  const attested = ownerAttestedRecords(data);
  const attestedText = new Set(attested.map((r) => String(r.text || '').toLowerCase()));
  const other = (Array.isArray(data.memories) ? data.memories : []).map(String)
    .filter((text) => !attestedText.has(text.toLowerCase()));
  return [
    attested.length
      ? `OWNER-STATED MEMORIES (the owner said or approved these; only these may be described as something the owner told you, confirmed or did): ${JSON.stringify(attested.slice(-40).map((r) => ({ text: clip(r.text, 300), recorded: String(r.created_at || '').slice(0, 10) }))).slice(0, 4000)}`
      : 'OWNER-STATED MEMORIES: none recorded. Never say the owner told you, confirmed, tested or experienced anything that is not in the owner\'s own words in this conversation.',
    other.length
      ? `CHE NOTES AND INFERENCES (NOT confirmed by the owner; never present them as things the owner said, confirmed or did): ${JSON.stringify(other.slice(-40)).slice(0, 3000)}`
      : '',
    'MEMORY TRUTH RULE: never describe a personal experience, test, decision or statement of the owner unless it is in OWNER-STATED MEMORIES or the owner\'s own words in this conversation. If asked what the owner confirmed and nothing fits, say you have no record. Brain notes, research notes, Office reports and your earlier replies are not owner confirmations.',
  ].filter(Boolean).join('\n');
}

// ─── Owner corrections of his own stated facts ─────────────────────────────

/**
 * "Actually, my favorite food is sushi" corrects an owner-stated fact only
 * when an active owner-attested record holds the same subject. Returns the
 * corrected statement ("my favorite food is sushi") or null. A correction
 * never confirms anything else: other subjects and objective facts fall
 * through to the normal path.
 */
export function ownerFactCorrection(rawMessage, records = []) {
  const plain = String(rawMessage || '').trim()
    .replace(/^(?:(?:hey |ok |okay )?(?:che|chay|chey|shay)[,:]?\s+)/i, '');
  const m = /^(?:no|nope|actually|correction|update|wait)[,.:!]?\s+(?:that(?:'s| is) (?:wrong|not right)[,.]?\s+)?(?:now\s+)?(my\s+[a-z0-9][a-z0-9 '\-]{1,60}?\s+(?:is|are)\s+[^.?!]{1,200}?)(?:\s+now)?(?:,?\s+not\s+[^.?!]{1,80})?[.!]?$/i.exec(plain);
  if (!m) return null;
  const statement = m[1].trim();
  return (Array.isArray(records) ? records : []).some((r) => isOwnerAttested(r) && sameSlot(r.text, statement))
    ? statement
    : null;
}
