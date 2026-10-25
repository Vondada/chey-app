// The Hugging Face token page driver (assets/browser/che_hf_token_page.js) in
// headless Chromium against the local reconstruction of the token page
// (tools/fixtures/hf_token_page.html served by tools/fake_huggingface.mjs).
// The real huggingface.co page is exercised only on the owner's iPhone.
//
// Run: node --test tools/che_hf_token_page_test.mjs
//   (needs the `playwright` package; CHE_CHROMIUM=/path/to/chrome to use a preinstalled browser)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { createRequire } from 'node:module';
import { fakeHuggingFace, serveFake } from './fake_huggingface.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const DRIVER = readFileSync(new URL('../assets/browser/che_hf_token_page.js', import.meta.url), 'utf8');
const INFERENCE = 'Make calls to Inference Providers';

let browser;
before(async () => { browser = await chromium.launch(process.env.CHE_CHROMIUM ? { executablePath: process.env.CHE_CHROMIUM } : {}); });
after(async () => { await browser?.close(); });

async function open(fakeOptions = {}) {
  const fake = fakeHuggingFace(fakeOptions);
  const served = await serveFake(fake);
  const page = await browser.newPage();
  await page.goto(`${served.base}/settings/tokens/new?tokenType=fineGrained`);
  const step = async (call) => JSON.parse(await page.evaluate(`${DRIVER}\n${call}`));
  return { fake, page, step, close: async () => { await page.close(); await served.close(); } };
}

test('the token form: detect the signed-in user, fill only the needed permission, create, read the token once', async () => {
  const s = await open({ user: 'vondada' });
  try {
    assert.deepEqual(await s.step('window.__cheHf.detect()'), { page: 'token_form', step: 'token_form', user: 'vondada' });
    const filled = await s.step(`window.__cheHf.fill('CHE inference 2026-10-25', ${JSON.stringify([INFERENCE])})`);
    assert.equal(filled.ok, true, JSON.stringify(filled));
    assert.equal(filled.name_set, true);
    assert.deepEqual(filled.checked, [INFERENCE]);
    assert.deepEqual(filled.unticked, ['Read access to contents of all repos under your personal namespace'], 'the default extra permission is removed: minimum scope');
    assert.equal(await s.page.getAttribute('#tab-fg', 'aria-selected'), 'true', 'fine-grained tab chosen');
    assert.deepEqual(await s.step('window.__cheHf.submit()'), { clicked: true });
    await s.page.waitForSelector('#modal:not([hidden])');
    const read = await s.step('window.__cheHf.readToken()');
    assert.equal(read.found, true);
    assert.match(read.token, /^hf_[A-Za-z0-9]{34}$/);
    // What Hugging Face (the fake) recorded: one token, exactly the requested permission.
    assert.deepEqual(s.fake.state.created, [{ name: 'CHE inference 2026-10-25', permissions: [INFERENCE] }]);
    assert.ok(s.fake.tokens.has(read.token));
  } finally { await s.close(); }
});

test('missing permissions on a changed page are reported, not guessed', async () => {
  const s = await open();
  try {
    const filled = await s.step(`window.__cheHf.fill('CHE x', ${JSON.stringify([INFERENCE, 'A permission Hugging Face removed'])})`);
    assert.equal(filled.ok, false);
    assert.deepEqual(filled.missing, ['A permission Hugging Face removed']);
    assert.deepEqual((await s.step('window.__cheHf.readToken()')).found, false, 'nothing to read before creating');
  } finally { await s.close(); }
});

test('sign-in and captcha are detected as the owner\'s steps; the driver fills nothing there', async () => {
  const out = await open({ signedIn: false });
  try {
    assert.deepEqual(await out.step('window.__cheHf.detect()'), { page: 'owner_auth', step: 'sign_in', user: '' });
    assert.equal(await out.page.inputValue('input[type=password]'), '');
  } finally { await out.close(); }
  const cap = await open({ captcha: true });
  try {
    assert.deepEqual(await cap.step('window.__cheHf.detect()'), { page: 'captcha', step: 'captcha', user: '' });
  } finally { await cap.close(); }
});
