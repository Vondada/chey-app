import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyDestination,
  guardOutbound,
  isPrivate,
  redact,
  sensitiveKinds,
} from './egress_guard.js';

// Fake values only. They match the shapes the guard must catch.
const FAKE_OPENAI_KEY = 'sk-TESTFAKEKEY0000000000000000';
const FAKE_ANTHROPIC_KEY = 'sk-ant-api03-TESTFAKEKEY000000000000';
const FAKE_GITHUB_TOKEN = 'ghp_TESTFAKETOKEN00000000000000000000';
const FAKE_GITHUB_PAT = 'github_pat_TESTFAKE_TOKEN_000000000000';
const FAKE_SLACK = 'xoxb-1234567890-TESTFAKE';
const FAKE_AWS = 'AKIATESTFAKE0000000A';
const FAKE_GROQ = 'gsk_TESTFAKEKEY000000000000';
const FAKE_GOOGLE = 'AIzaTESTFAKE0000000000000000000000000';
const FAKE_CARD = '4111 1111 1111 1111';
const FAKE_EMAIL = 'owner@example.com';
const FAKE_PHONE = '+1 (415) 555-0132';
const PRIVATE_SPAN = 'The bank PIN is 9911 and the vault code is alpha';

const AI_DESTINATIONS = [
  'github',
  'openai',
  'groq',
  'gemini',
  'grok',
  'mistral',
  'openrouter',
  'https://api.anthropic.com/v1/messages',
  'https://api.x.ai/v1/chat/completions',
  'https://api.deepseek.com/chat',
  'https://api.github.com/repos/vondada/chey-app/issues',
  'https://api.cohere.example/v1/generate',
];

// ---- isPrivate -------------------------------------------------------------

test('isPrivate is false for ordinary text', () => {
  assert.equal(isPrivate('Plan the lesson for Tuesday.'), false);
  assert.equal(isPrivate(''), false);
  assert.equal(isPrivate(null), false);
  assert.equal(isPrivate(undefined), false);
});

test('isPrivate is true for a private, sensitive, secret or private-memory span', () => {
  assert.equal(isPrivate(`<private>${PRIVATE_SPAN}</private>`), true);
  assert.equal(isPrivate(`<sensitive>x</sensitive>`), true);
  assert.equal(isPrivate(`<secret>x</secret>`), true);
  assert.equal(isPrivate(`<private-memory>x</private-memory>`), true);
  assert.equal(isPrivate(`<PRIVATE>x</PRIVATE>`), true);
});

test('isPrivate is true for an unclosed private span', () => {
  assert.equal(isPrivate(`hello <private>the rest is private`), true);
});

test('isPrivate is true for emails, phone numbers, cards and keys', () => {
  assert.equal(isPrivate(`mail ${FAKE_EMAIL}`), true);
  assert.equal(isPrivate(`call ${FAKE_PHONE}`), true);
  assert.equal(isPrivate(`card ${FAKE_CARD}`), true);
  assert.equal(isPrivate(`key ${FAKE_OPENAI_KEY}`), true);
});

test('isPrivate is false for a date and time', () => {
  assert.equal(isPrivate('Meeting on 2026-10-22 09:20'), false);
});

// ---- sensitiveKinds --------------------------------------------------------

test('sensitiveKinds reports each kind found once', () => {
  const kinds = sensitiveKinds(`${FAKE_EMAIL} ${FAKE_EMAIL} ${FAKE_CARD} ${FAKE_OPENAI_KEY}`).sort();
  assert.deepEqual(kinds, ['card', 'email', 'secret']);
  assert.deepEqual(sensitiveKinds('plain words'), []);
});

// ---- redact ----------------------------------------------------------------

test('redact replaces emails', () => {
  assert.equal(redact(`write to ${FAKE_EMAIL} today`), 'write to [EMAIL] today');
  assert.ok(!redact(FAKE_EMAIL).includes('@'));
});

test('redact replaces phone numbers in several shapes', () => {
  assert.equal(redact(`call ${FAKE_PHONE} now`), 'call [PHONE] now');
  assert.equal(redact('dial 4155550132 please'), 'dial [PHONE] please');
  assert.ok(!redact('+44 20 7946 0958').includes('7946'));
});

test('redact replaces card-like digit runs with and without separators', () => {
  assert.equal(redact(`card ${FAKE_CARD}`), 'card [CARD]');
  assert.equal(redact('4111-1111-1111-1111'), '[CARD]');
  assert.equal(redact('4111111111111111'), '[CARD]');
});

test('redact keeps short numbers and dates readable', () => {
  assert.equal(redact('Room 12 at 5 people'), 'Room 12 at 5 people');
  assert.equal(redact('Meeting on 2026-10-22 09:20'), 'Meeting on 2026-10-22 09:20');
});

test('redact replaces API keys and tokens by prefix', () => {
  const samples = [
    FAKE_OPENAI_KEY,
    FAKE_ANTHROPIC_KEY,
    FAKE_GITHUB_TOKEN,
    FAKE_GITHUB_PAT,
    FAKE_SLACK,
    FAKE_AWS,
    FAKE_GROQ,
    FAKE_GOOGLE,
  ];
  for (const key of samples) {
    const out = redact(`token: ${key} end`);
    assert.equal(out, 'token: [SECRET] end', `key shape not redacted: ${key.slice(0, 6)}`);
  }
});

test('redact does not treat ordinary words that contain sk- as keys', () => {
  assert.equal(redact('the task-manager and desk-lamp and risk-assessment'), 'the task-manager and desk-lamp and risk-assessment');
});

test('redact removes a private span with its content, keeping the surrounding text', () => {
  const out = redact(`before <private>${PRIVATE_SPAN}</private> after`);
  assert.equal(out, 'before [PRIVATE] after');
  assert.ok(!out.includes('9911'));
  assert.ok(!out.includes('alpha'));
});

test('redact removes an unclosed private span to the end of the text', () => {
  const out = redact(`keep this <private>${PRIVATE_SPAN}`);
  assert.equal(out, 'keep this [PRIVATE]');
  assert.ok(!out.includes('9911'));
});

test('redact removes several private spans and leaves the text between them', () => {
  const out = redact('<private>one</private> middle <sensitive>two</sensitive>');
  assert.equal(out, '[PRIVATE] middle [PRIVATE]');
});

test('redact handles a mismatched closing tag by not removing the wrong span', () => {
  const out = redact('<private>secret words</sensitive> visible');
  assert.ok(!out.includes('secret words'));
});

test('redact output contains none of the sensitive values', () => {
  const text = [
    `mail ${FAKE_EMAIL}`,
    `phone ${FAKE_PHONE}`,
    `card ${FAKE_CARD}`,
    `key ${FAKE_OPENAI_KEY}`,
    `<private>${PRIVATE_SPAN}</private>`,
  ].join(' | ');
  const out = redact(text);
  for (const leaked of [FAKE_EMAIL, '555-0132', '4111', FAKE_OPENAI_KEY, '9911']) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}`);
  }
});

test('redact is idempotent and leaves clean text unchanged', () => {
  const text = `mail ${FAKE_EMAIL} and <private>x</private> and ${FAKE_OPENAI_KEY}`;
  const once = redact(text);
  assert.equal(redact(once), once);
  assert.equal(redact('clean text'), 'clean text');
});

test('redact turns non-string input into text', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact({ note: FAKE_EMAIL }), '{"note":"[EMAIL]"}');
});

// ---- classifyDestination ---------------------------------------------------

test('classifyDestination names cloudflare-model, AI hosts and other destinations', () => {
  assert.equal(classifyDestination('cloudflare-model').kind, 'cloudflare-model');
  assert.equal(classifyDestination('  Cloudflare-Model ').kind, 'cloudflare-model');
  for (const dest of AI_DESTINATIONS) {
    assert.equal(classifyDestination(dest).kind, 'ai', dest);
  }
  assert.equal(classifyDestination('owner-email-relay').kind, 'external');
  assert.equal(classifyDestination('https://hooks.example.org/x').kind, 'external');
});

test('classifyDestination fails closed on missing destinations', () => {
  assert.equal(classifyDestination(undefined).kind, 'unknown');
  assert.equal(classifyDestination('').kind, 'unknown');
  assert.equal(classifyDestination(42).kind, 'unknown');
});

// ---- guardOutbound: rule (a), AI providers and code hosts ------------------

test('rule (a): every AI or code-host destination blocks private-tagged text', () => {
  for (const dest of AI_DESTINATIONS) {
    const r = guardOutbound({
      destination: dest,
      payload: `<private>${PRIVATE_SPAN}</private>`,
    });
    assert.equal(r.allowed, false, dest);
    assert.ok(!r.redacted.includes('9911'), dest);
  }
});

test('rule (a): AI destinations block text carrying sensitiveTags', () => {
  for (const dest of AI_DESTINATIONS) {
    const r = guardOutbound({
      destination: dest,
      payload: 'a plain sentence',
      sensitiveTags: ['private-memory'],
    });
    assert.equal(r.allowed, false, dest);
  }
});

test('rule (a): AI destinations block emails, keys and card numbers', () => {
  for (const dest of AI_DESTINATIONS) {
    for (const payload of [FAKE_EMAIL, FAKE_OPENAI_KEY, FAKE_CARD]) {
      assert.equal(guardOutbound({ destination: dest, payload }).allowed, false, `${dest} ${payload}`);
    }
  }
});

test('rule (a): an owner grant never overrides the AI rule', () => {
  const r = guardOutbound({
    destination: 'openai',
    payload: `<private>${PRIVATE_SPAN}</private>`,
    ownerGrant: { owner: true, destination: 'openai' },
  });
  assert.equal(r.allowed, false);
});

test('AI destinations may receive plain text that has no sensitive data', () => {
  const r = guardOutbound({ destination: 'openai', payload: 'Explain moving averages.' });
  assert.equal(r.allowed, true);
  assert.equal(r.redacted, 'Explain moving averages.');
});

test('a public tag does not make text sensitive', () => {
  const r = guardOutbound({ destination: 'github', payload: 'release notes', sensitiveTags: ['public'] });
  assert.equal(r.allowed, true);
});

// ---- guardOutbound: rule (b), cloudflare-model -----------------------------

test('rule (b): cloudflare-model receives redacted text, never the raw values', () => {
  const r = guardOutbound({
    destination: 'cloudflare-model',
    payload: `mail ${FAKE_EMAIL}, key ${FAKE_OPENAI_KEY}, card ${FAKE_CARD}`,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.redacted, 'mail [EMAIL], key [SECRET], card [CARD]');
  assert.equal(r.reason, 'sent to cloudflare-model only after redaction');
});

test('rule (b): cloudflare-model redacts private spans inside the text', () => {
  const r = guardOutbound({
    destination: 'cloudflare-model',
    payload: `Summary: <private>${PRIVATE_SPAN}</private> done`,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.redacted, 'Summary: [PRIVATE] done');
});

test('rule (b): a payload tagged private as a whole is fully redacted for cloudflare-model', () => {
  const r = guardOutbound({
    destination: 'cloudflare-model',
    payload: PRIVATE_SPAN,
    sensitiveTags: ['private-memory'],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.redacted, '[PRIVATE]');
  assert.ok(!r.redacted.includes('9911'));
});

test('rule (b): plain text to cloudflare-model passes unchanged', () => {
  const r = guardOutbound({ destination: 'cloudflare-model', payload: 'What is CHE?' });
  assert.equal(r.allowed, true);
  assert.equal(r.redacted, 'What is CHE?');
  assert.equal(r.reason, 'no sensitive data');
});

// ---- guardOutbound: rule (c), other destinations ---------------------------

test('rule (c): sensitive data to an unknown external destination is blocked without a grant', () => {
  const r = guardOutbound({
    destination: 'owner-email-relay',
    payload: `mail ${FAKE_EMAIL}`,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.redacted, 'mail [EMAIL]');
  assert.match(r.reason, /owner grant/);
});

test('rule (c): tagged private memory to an external destination is blocked without a grant', () => {
  const r = guardOutbound({
    destination: 'https://hooks.example.org/in',
    payload: 'memory text',
    sensitiveTags: ['private-memory'],
  });
  assert.equal(r.allowed, false);
});

test('rule (c): an owner grant for the same destination allows the redacted send', () => {
  const r = guardOutbound({
    destination: 'owner-email-relay',
    payload: `mail ${FAKE_EMAIL}`,
    ownerGrant: { owner: true, destination: 'Owner-Email-Relay' },
  });
  assert.equal(r.allowed, true);
  assert.equal(r.redacted, 'mail [EMAIL]');
  assert.match(r.reason, /owner grant/);
});

test('rule (c): a grant for a different destination does not apply', () => {
  const r = guardOutbound({
    destination: 'owner-email-relay',
    payload: `mail ${FAKE_EMAIL}`,
    ownerGrant: { owner: true, destination: 'another-relay' },
  });
  assert.equal(r.allowed, false);
});

test('rule (c): a grant without owner: true does not apply', () => {
  const r = guardOutbound({
    destination: 'owner-email-relay',
    payload: `mail ${FAKE_EMAIL}`,
    ownerGrant: { destination: 'owner-email-relay' },
  });
  assert.equal(r.allowed, false);
});

test('rule (c): a grant restricted to tags must cover every tag on the payload', () => {
  const base = { destination: 'owner-email-relay', payload: 'memory', sensitiveTags: ['private-memory', 'finance'] };
  assert.equal(
    guardOutbound({ ...base, ownerGrant: { owner: true, destination: 'owner-email-relay', tags: ['private-memory'] } }).allowed,
    false,
  );
  assert.equal(
    guardOutbound({
      ...base,
      ownerGrant: { owner: true, destination: 'owner-email-relay', tags: ['Private-Memory', 'finance'] },
    }).allowed,
    true,
  );
});

test('rule (c): plain text to an external destination is allowed with no grant', () => {
  const r = guardOutbound({ destination: 'owner-email-relay', payload: 'Hello there.' });
  assert.equal(r.allowed, true);
  assert.equal(r.redacted, 'Hello there.');
});

// ---- guardOutbound: fail-closed inputs -------------------------------------

test('a missing or unknown destination is blocked by default', () => {
  assert.equal(guardOutbound({ payload: 'hello' }).allowed, false);
  assert.equal(guardOutbound({ destination: '', payload: 'hello' }).allowed, false);
  assert.equal(guardOutbound({ destination: 7, payload: 'hello' }).allowed, false);
  assert.equal(guardOutbound().allowed, false);
});

test('guardOutbound accepts an object payload and redacts its JSON form', () => {
  const r = guardOutbound({ destination: 'cloudflare-model', payload: { email: FAKE_EMAIL } });
  assert.equal(r.allowed, true);
  assert.equal(r.redacted, '{"email":"[EMAIL]"}');
});

test('guardOutbound never puts raw sensitive values in the reason or the redacted text', () => {
  const payloads = [`mail ${FAKE_EMAIL}`, `key ${FAKE_OPENAI_KEY}`, `card ${FAKE_CARD}`];
  for (const dest of ['openai', 'owner-email-relay', 'cloudflare-model']) {
    for (const payload of payloads) {
      const r = guardOutbound({ destination: dest, payload });
      for (const raw of [FAKE_EMAIL, FAKE_OPENAI_KEY, '4111']) {
        assert.ok(!r.redacted.includes(raw), `${dest} leaked in redacted`);
        assert.ok(!r.reason.includes(raw), `${dest} leaked in reason`);
      }
    }
  }
});
