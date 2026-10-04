import assert from 'node:assert/strict';
import test from 'node:test';
import { checkHtml, extractHtml, lastSite, saveSite, serveSite, siteBuildIntent, siteEditIntent, writeSite } from './site_builder.js';

const GOOD = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fade Kings Barbershop</title><style>body{margin:0}</style></head><body><header><h1>Fade Kings</h1></header><main><section><p>Walk-ins welcome.</p><img src="data:image/png;base64,AA" alt="Shop chair"></section></main><footer>Open daily</footer><script>document.body.dataset.ok="1"</script></body></html>';

const memory = () => {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); } };
};

test('owner phrases for building and changing a site', () => {
  assert.equal(siteBuildIntent('Build me a website for my barbershop called Fade Kings').brief, 'my barbershop called Fade Kings');
  assert.ok(siteBuildIntent('Che, make a landing page about my podcast'));
  assert.ok(siteBuildIntent('create a web app that tracks my water intake'));
  assert.ok(siteBuildIntent('can you code a simple one-page website: bakery, pink theme'));
  assert.equal(siteBuildIntent('what is a website'), null);
  assert.equal(siteBuildIntent('update your code: make the banner bigger'), null);
  assert.equal(siteEditIntent('change the website: make it dark').change, 'make it dark');
  assert.equal(siteEditIntent('change the page to dark mode'), null, 'bare "page" means CHE\'s own screen, not a site');
});

test('HTML is extracted from fenced or wrapped answers and checked', () => {
  assert.equal(extractHtml(`Here you go:\n\`\`\`html\n${GOOD}\n\`\`\`\nEnjoy!`), GOOD);
  assert.deepEqual(checkHtml(GOOD), []);
  assert.deepEqual(checkHtml(''), ['No complete HTML document (missing <!DOCTYPE html> … </html>).']);
  const bad = GOOD.replace('<script>', '<script src="https://evil.example/x.js"></script><script>').replace(' alt="Shop chair"', '');
  const problems = checkHtml(bad);
  assert.ok(problems.some((p) => /External scripts/.test(p)));
  assert.ok(problems.some((p) => /alt text/.test(p)));
  assert.deepEqual(checkHtml(GOOD.replace('Walk-ins welcome.', 'My TODO list app')), [], 'a to-do app is not placeholder text');
});

test('a page that fails the check is repaired once with the exact problems', async () => {
  const prompts = [];
  const env = { AI: { run: async (_m, input) => {
    prompts.push(input.messages[1].content);
    return { response: prompts.length === 1 ? GOOD.replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '') : GOOD };
  } } };
  const out = await writeSite(env, { brief: 'barbershop' }, 'm');
  assert.deepEqual(out.problems, []);
  assert.equal(out.html, GOOD);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /viewport meta tag/);
});

test('sites are stored, versioned on edit, and served sandboxed with no network access', async () => {
  const storage = memory();
  const first = await saveSite(storage, { brief: 'barbershop', html: GOOD });
  assert.equal(first.title, 'Fade Kings Barbershop');
  const edited = await saveSite(storage, { id: first.id, html: GOOD.replace('Open daily', 'Open late'), change: 'open late' });
  assert.equal(edited.versions, 2);
  assert.equal((await lastSite(storage)).id, first.id);
  const res = await serveSite(new Request(`https://che.example/site/${first.id}`), storage);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Open late/);
  const csp = res.headers.get('Content-Security-Policy');
  assert.match(csp, /^sandbox allow-scripts/);
  assert.match(csp, /connect-src 'none'/);
  assert.equal((await serveSite(new Request('https://che.example/site/0000000000000000'), storage)).status, 404);
  assert.equal(await serveSite(new Request('https://che.example/api/chat'), storage), null);
});


test('accessibility checks reject unnamed controls and buttons', () => {
  const unlabeled = GOOD.replace('<p>Walk-ins welcome.</p>', '<input id="name"><button><span></span></button>');
  const problems = checkHtml(unlabeled);
  assert.ok(problems.some((p) => /form control.*accessible label/i.test(p)));
  assert.ok(problems.some((p) => /button.*accessible name/i.test(p)));
  const labeled = GOOD.replace('<p>Walk-ins welcome.</p>', '<label for="name">Name</label><input id="name"><button>Save</button>');
  assert.deepEqual(checkHtml(labeled), []);
});

test('large stored pages are never truncated during edit', async () => {
  const huge = GOOD.replace('Walk-ins welcome.', 'x'.repeat(61_000));
  let calls = 0;
  const env = { AI: { run: async () => { calls += 1; return { response: GOOD }; } } };
  const out = await writeSite(env, { previousHtml: huge, change: 'make it dark' }, 'm');
  assert.equal(out.html, huge);
  assert.equal(calls, 0);
  assert.match(out.problems[0], /too large.*No changes were saved/i);
});

test('hosted sites cannot open popups or navigate away', async () => {
  const storage = memory();
  const first = await saveSite(storage, { brief: 'barbershop', html: GOOD });
  const res = await serveSite(new Request(`https://che.example/site/${first.id}`), storage);
  const csp = res.headers.get('Content-Security-Policy');
  assert.doesNotMatch(csp, /allow-popups/);
  assert.match(csp, /navigate-to 'none'/);
});
