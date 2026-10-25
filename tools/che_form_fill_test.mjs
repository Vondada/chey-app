// End-to-end tests for CHE's form fill engine (assets/browser/che_form_fill.js)
// in headless Chromium via Playwright, against local fixtures in
// test/fixtures/forms/. Two local origins are served so a cross-origin iframe
// (like a Stripe card field) is real.
//
// Run: node --test tools/che_form_fill_test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = readFileSync(join(root, 'assets/browser/che_form_fill.js'), 'utf8');
const FIXTURES = join(root, 'test/fixtures/forms');

// The owner's approved profile values for the tests (fake data).
const PERSONAL = {
  'given-name': 'Jordan', 'family-name': 'Rivera', 'name': 'Jordan Rivera', 'email': 'jordan.rivera@example.com',
  'tel': '+1 (602) 555-0147', 'street-address': '100 Main Street', 'address-line2': 'Apt 4', 'address-level2': 'Phoenix',
  'address-level1': 'AZ', 'postal-code': '85004', 'country': 'US', 'bday': '1990-05-14', 'username': 'jrivera',
};
const OFFICE = {
  'organization': 'CHE Office LLC', 'x-ein': '12-3456789', 'email': 'office@cheoffice.example', 'tel': '602-555-0199',
  'url': 'https://cheoffice.example', 'organization-title': 'Owner', 'address-level1': 'Arizona',
  'given-name': 'Jordan', 'family-name': 'Rivera',
};
const PASSWORD = 'Vault-Only_Secret-9xQ2!kLmZ7';

let servers = [], browser, base, port;
function serve() {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const file = join(FIXTURES, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
before(async () => {
  // Second origin on port+1 for the cross-origin card frame.
  for (let tries = 0; tries < 20 && servers.length < 2; tries++) {
    const a = await serve();
    const p = a.address().port;
    const b = createServer((req, res) => {
      const file = join(FIXTURES, new URL(req.url, 'http://x').pathname);
      if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(readFileSync(file));
    });
    const ok = await new Promise((r) => { b.once('error', () => r(false)); b.listen(p + 1, '127.0.0.1', () => r(true)); });
    if (ok) { servers = [a, b]; port = p; } else a.close();
  }
  base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); servers.forEach((s) => s.close()); });

async function open(name) {
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  await page.goto(`${base}/${name}`);
  await page.evaluate(ENGINE);
  return { page, consoleLines };
}
const call = async (page, fn, ...args) => JSON.parse(await page.evaluate(([f, a]) => window.CheFormFill[f](...a), [fn, args]));

// What CHE's Dart side does, minus the profile choice: key → value plan.
async function fillWith(page, profile, { skip = [] } = {}) {
  const scan = await call(page, 'scan');
  const values = {};
  for (const f of scan.fields) {
    if (skip.includes(f.key)) continue;
    let v = profile[f.key];
    if (v === undefined && f.key.startsWith('bday-') && profile.bday) {
      const [y, m, d] = profile.bday.split('-');
      v = f.key === 'bday-year' ? y : f.key === 'bday-month' ? String(Number(m)) : String(Number(d));
    }
    if (v !== undefined) values[f.id] = v;
  }
  await call(page, 'start', JSON.stringify({ values }));
  let report;
  for (let i = 0; i < 100; i++) {
    report = await call(page, 'poll');
    if (!report.pending) break;
    await page.waitForTimeout(50);
  }
  return { scan, report, values };
}
const statusOf = (scan, report, key) => {
  const f = scan.fields.find((x) => x.key === key);
  return f && report.results.find((r) => r.id === f.id)?.status;
};

test('multi-page sign-up: fills page by page, clicks only Next/Continue, never Create account; missing answers stay empty', async () => {
  const { page } = await open('signup_multipage.html');
  let { scan, report } = await fillWith(page, PERSONAL);
  assert.equal(scan.next, 'next');
  assert.equal(statusOf(scan, report, 'given-name'), 'filled');
  assert.equal(await page.inputValue('#fn'), 'Jordan');
  assert.equal(await page.inputValue('#ln'), 'Rivera');
  assert.equal(await page.inputValue('#mn'), '', 'no approved middle name → left empty');
  assert.ok(scan.fields.find((f) => f.key === 'additional-name'), 'middle name is identified so it can be reported');
  assert.equal((await call(page, 'next')).clicked, 'next');
  assert.equal(await page.evaluate(() => window.__step), 2);

  await page.evaluate(ENGINE);
  ({ scan, report } = await fillWith(page, PERSONAL));
  assert.equal(await page.inputValue('[name=addr1]'), '100 Main Street');
  assert.equal(await page.inputValue('[name=state]'), 'AZ');
  assert.equal(await page.inputValue('[name=country]'), 'US');
  assert.equal(await page.inputValue('[name=zip]'), '85004');
  assert.equal(await page.inputValue('[name=referral]'), '', 'custom question with no remembered answer stays empty');
  assert.equal(scan.fields.find((f) => f.label.startsWith('How did you hear')).key, 'custom');
  assert.equal(scan.next, 'continue');
  await call(page, 'next');

  ({ scan, report } = await fillWith(page, PERSONAL));
  assert.equal(scan.next, null, 'Create account is not a Next button');
  assert.equal(scan.submit, 'create account');
  const pw = scan.fields.filter((f) => f.control === 'password');
  assert.deepEqual(pw.map((f) => f.key), ['new-password', 'new-password']);
  assert.equal(pw[0].passwordrules.includes('minlength: 20'), true, 'site rules are passed to the generator');
  assert.equal(await page.isChecked('[name=terms]'), false, 'consent boxes are never ticked');
  assert.equal(statusOf(scan, report, 'new-password'), undefined, 'fill() never touches passwords');
  assert.equal(await page.evaluate(() => window.__submitted || 0), 0, 'nothing submitted');
  await page.close();
});

test('shipping/billing: autocomplete tokens, state/country names↔codes, split DOB selects, MM/DD/YYYY text, same-origin iframe; card fields and cross-origin frame untouched', async () => {
  const { page } = await open('shipping_billing.html');
  const { scan, report } = await fillWith(page, PERSONAL);
  const val = (sel) => page.inputValue(sel);
  assert.equal(await val('[aria-label="Full name"]'), 'Jordan Rivera');
  assert.equal(await val('[aria-label="State"]'), 'Arizona', 'AZ → Arizona option');
  assert.equal(await val('[aria-label="Country"]'), 'USA', 'US → "United States of America" (USA)');
  assert.equal(await val('[aria-label="Phone"]'), '6025550147', 'maxlength 10 phone gets 10 digits');
  assert.equal(await val('[name=dob_month]'), '5');
  assert.equal(await val('[name=dob_day]'), '14');
  assert.equal(await val('[name=dob_year]'), '1990');
  assert.equal(await val('[name=delivery_date]'), '', 'a delivery date is not the birthday: no answer, left empty');
  const inner = page.frameLocator('#inner').locator('[name=receipt_email]');
  assert.equal(await inner.inputValue(), 'jordan.rivera@example.com', 'same-origin iframe field filled');
  assert.equal(await val('[name=cardnumber]'), '', 'card number never filled');
  assert.equal(scan.fields.find((f) => f.label === 'Card number').key, 'cc');
  assert.ok(scan.crossOriginFrames.some((h) => h.startsWith('127.0.0.1:')), 'cross-origin card frame is listed as unsupported');
  assert.equal(scan.payment, true, 'a checkout is recognised as a payment form');
  assert.equal(scan.submit, 'place order');
  assert.equal(scan.next, null);
  assert.ok(report.results.every((r) => r.status !== 'failed'), JSON.stringify(report.results));
  assert.equal(await page.evaluate(() => window.__submitted || 0), 0);
  await page.close();
});

test('business registration: business signals, EIN, work email/phone, radio with no answer left alone, async ARIA combobox, file upload and canvas unsupported', async () => {
  const { page } = await open('business_registration.html');
  const { scan, report } = await fillWith(page, OFFICE);
  assert.ok(scan.businessSignals >= 3, `business signals ${scan.businessSignals}`);
  assert.equal(await page.inputValue('[name=company]'), 'CHE Office LLC');
  assert.equal(await page.inputValue('[name=ein]'), '12-3456789');
  assert.equal(await page.inputValue('[name=work_email]'), 'office@cheoffice.example');
  assert.equal(scan.fields.find((f) => f.id && f.label === 'Business email').hint, 'work');
  assert.equal(await page.inputValue('[name=site]'), 'https://cheoffice.example');
  assert.equal(await page.inputValue('[name=jobtitle]'), 'Owner');
  assert.equal(await page.inputValue('[name=contact_first]'), 'Jordan');
  const combo = scan.fields.find((f) => f.control === 'combobox');
  assert.equal(combo.key, 'address-level1');
  assert.equal(report.results.find((r) => r.id === combo.id).status, 'filled');
  assert.equal(await page.evaluate(() => window.__stateChosen), 'Arizona');
  const entity = scan.fields.find((f) => f.control === 'radio');
  assert.equal(entity.label, 'Entity type');
  assert.equal(entity.options.length, 3);
  assert.equal(await page.evaluate(() => !!document.querySelector('[name=entity]:checked')), false, 'no approved answer → no radio picked');
  assert.equal(scan.fields.find((f) => f.control === 'file').key, 'file');
  assert.equal(await page.evaluate(() => window.__submitted || 0), 0);
  await page.close();
});

test('a remembered radio answer is applied; readBack returns non-secret answers for "remember my answers"', async () => {
  const { page } = await open('business_registration.html');
  const scan = await call(page, 'scan');
  const entity = scan.fields.find((f) => f.control === 'radio');
  await call(page, 'start', JSON.stringify({ values: { [entity.id]: 'LLC' } }));
  await page.waitForTimeout(50);
  const report = await call(page, 'poll');
  assert.equal(report.results[0].status, 'filled');
  assert.equal(await page.evaluate(() => document.querySelector('[name=entity]:checked').value), 'llc');
  const back = await call(page, 'readBack', JSON.stringify([entity.id]));
  assert.equal(back[entity.id], 'LLC');
  await page.close();
});

test('CAPTCHA: detected and reported, never touched; values survive while the owner solves it; resume refills only what was lost', async () => {
  const { page } = await open('captcha.html');
  const { scan, values } = await fillWith(page, PERSONAL);
  assert.deepEqual(scan.captcha, { present: true, solved: false, kind: 'reCAPTCHA' });
  assert.equal(await page.inputValue('[name=g-recaptcha-response]'), '', 'CHE never writes the CAPTCHA response');
  assert.ok(!scan.fields.some((f) => /recaptcha/.test(f.label)), 'the response field is not a form field to fill');
  assert.equal(await page.inputValue('[name=email]'), 'jordan.rivera@example.com');
  // The owner solves it (the harness plays the owner) and, meanwhile, one field was cleared by the site.
  await page.evaluate(() => { document.getElementById('g-recaptcha-response').value = 'owner-solved-token'; document.querySelector('[name=phone]').value = ''; });
  assert.equal((await call(page, 'captchaState')).solved, true);
  // Resume: the same plan again; filled fields are kept, the lost one is refilled.
  await call(page, 'start', JSON.stringify({ values }));
  await page.waitForTimeout(50);
  const report = await call(page, 'poll');
  const statuses = Object.fromEntries(report.results.map((r) => [scan.fields.find((f) => f.id === r.id).key, r.status]));
  assert.equal(statuses.email, 'kept');
  assert.equal(statuses.tel, 'filled');
  assert.equal(await page.inputValue('[name=phone]'), '+1 (602) 555-0147');
  assert.equal(await page.evaluate(() => window.__submitted || 0), 0);
  await page.close();
});

test('2FA page: a verification step is reported for the owner; the code field is never filled', async () => {
  const { page } = await open('twofa.html');
  const scan = await call(page, 'scan');
  assert.equal(scan.verification.kind, 'code');
  const otp = scan.fields.find((f) => f.key === 'one-time-code');
  assert.ok(otp);
  await call(page, 'start', JSON.stringify({ values: { [otp.id]: '123456' } }));
  await page.waitForTimeout(30);
  assert.equal((await call(page, 'poll')).results[0].status, 'refused');
  assert.equal(await page.inputValue('[name=otp]'), '');
  await page.close();
});

test('React-style controlled inputs: the native setter + events reach component state and survive re-render; the password never appears in any report or console line', async () => {
  const { page, consoleLines } = await open('react_controlled.html');
  const { scan, report } = await fillWith(page, PERSONAL);
  assert.equal(await page.evaluate(() => window.__state.first), 'Jordan', 'component state updated');
  assert.equal(await page.inputValue('#first'), 'Jordan', 'value survives the blur re-render');
  const pw = scan.fields.find((f) => f.key === 'current-password');
  const secret = await call(page, 'setSecret', pw.id, PASSWORD);
  assert.deepEqual(secret, { ok: true });
  assert.equal(await page.evaluate(() => window.__state.password), PASSWORD, 'password reached state (in the page only)');
  // Nothing CHE gets back carries a value.
  const everything = JSON.stringify([scan, report, secret, await call(page, 'scan'), await call(page, 'captchaState')]);
  assert.ok(!everything.includes(PASSWORD), 'password not in any engine result');
  assert.ok(!everything.includes('Jordan') && !everything.includes('jordan.rivera'), 'no profile value in any engine result');
  assert.ok(!consoleLines.join('\n').includes(PASSWORD), 'password not in console');
  assert.equal(consoleLines.length, 0, 'the engine logs nothing');
  // readBack refuses password fields.
  assert.deepEqual(await call(page, 'readBack', JSON.stringify([pw.id])), {});
  // A malformed plan returns a generic error that does not quote its input.
  const bad = await page.evaluate(() => window.CheFormFill.start('{"values": {"x": "Vault-Only_Secret'));
  assert.ok(!bad.includes('Vault-Only'), bad);
  await page.close();
});
