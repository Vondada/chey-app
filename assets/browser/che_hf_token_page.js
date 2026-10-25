// CHE service onboarding: Hugging Face token page driver (injected into CHE's
// own WebView by lib/connect/che_service_onboarding.dart; tested in headless
// Chromium by tools/che_hf_token_page_test.mjs).
//
// Defines window.__cheHf with four steps, each returning a JSON string:
//   detect()            what page this is: token_form | owner_auth | captcha | signup | unknown, and the signed-in user if visible
//   fill(name, perms)   token name, the fine-grained tab, exactly these permissions (others unticked)
//   submit()            presses "Create token"
//   readToken()         reads the new token ONCE from the page; the caller posts it straight to CHE's server
//
// It never types a password, never solves a captcha and never submits a
// sign-in form: those are the owner's. It reads no other page content.
(function () {
  if (window.__cheHf) return;
  const TOKEN = /\bhf_[A-Za-z0-9]{30,64}\b/;
  const text = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const out = (o) => JSON.stringify(o);

  function setValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function controlOf(label) {
    if (label.control) return label.control;
    const inner = label.querySelector('input[type=checkbox]');
    if (inner) return inner;
    const id = label.getAttribute('for');
    return id ? document.getElementById(id) : null;
  }

  function user() {
    if (window.__cheHfWho) return window.__cheHfWho;
    // The header avatar links to the signed-in user's own profile: /<username>.
    for (const img of all('header img[alt], nav img[alt]')) {
      const a = img.closest('a[href]');
      const name = String(img.getAttribute('alt') || '').trim();
      if (a && name && /^[A-Za-z0-9][\w.-]{0,60}$/.test(name) && new URL(a.href, location.href).pathname === '/' + name) return name;
    }
    return '';
  }

  function detect() {
    const path = location.pathname;
    if (all('iframe').some((f) => /captcha|recaptcha|turnstile|challenge/i.test((f.title || '') + ' ' + (f.src || ''))) || all('.h-captcha, .g-recaptcha, .cf-turnstile, [data-sitekey]').length) {
      return out({ page: 'captcha', step: 'captcha', user: '' });
    }
    if (all('input[autocomplete="one-time-code"]').some(visible) || /two-factor|authentication code|2fa code/i.test(text(document.body).slice(0, 4000))) {
      return out({ page: 'owner_auth', step: 'two_factor', user: '' });
    }
    if (/^\/join\b/.test(path)) return out({ page: 'signup', step: 'sign_up', user: '' });
    if (/^\/login\b/.test(path) || all('input[type=password]').some(visible)) return out({ page: 'owner_auth', step: 'sign_in', user: '' });
    const create = all('button').find((b) => /^create token$/i.test(text(b)));
    if (/^\/settings\/tokens\/new\b/.test(path) && create) return out({ page: 'token_form', step: 'token_form', user: user() });
    return out({ page: 'unknown', step: 'unknown', user: user(), path });
  }

  function nameInput() {
    for (const label of all('label')) {
      if (/token name/i.test(text(label))) {
        const c = label.control || label.querySelector('input') || (label.getAttribute('for') && document.getElementById(label.getAttribute('for')));
        if (c) return c;
      }
    }
    return all('input[type=text], input:not([type])').find((i) => /name/i.test((i.name || '') + ' ' + (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || ''))) || null;
  }

  function fill(name, perms) {
    const wanted = (perms || []).map((p) => String(p).toLowerCase());
    const tab = all('button, [role=tab], label').find((b) => /^fine-?grained$/i.test(text(b)));
    if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
    const input = nameInput();
    if (input) setValue(input, String(name || ''));
    const checked = [];
    const unticked = [];
    const found = new Set();
    for (const label of all('label')) {
      const box = controlOf(label);
      if (!box || box.type !== 'checkbox') continue;
      const words = text(label).toLowerCase();
      const want = wanted.find((w) => words === w || words.includes(w));
      if (want) {
        found.add(want);
        if (!box.checked) box.click();
        if (box.checked) checked.push(text(label));
      } else if (box.checked) {
        box.click();
        unticked.push(text(label));
      }
    }
    const missing = (perms || []).filter((p) => !found.has(String(p).toLowerCase()));
    return out({ ok: Boolean(input) && missing.length === 0, name_set: Boolean(input) && input.value === String(name || ''), checked, unticked, missing });
  }

  function submit() {
    const create = all('button').find((b) => /^create token$/i.test(text(b)));
    if (!create || create.disabled) return out({ clicked: false });
    create.click();
    return out({ clicked: true });
  }

  // Read once. The value is returned to CHE's driver and nothing else here keeps it.
  function readToken() {
    for (const el of all('input[readonly], input[type=text], textarea, code, pre, [data-token]')) {
      const value = 'value' in el && el.value ? el.value : text(el);
      const m = TOKEN.exec(value);
      if (m) return out({ found: true, token: m[0] });
    }
    const err = all('[role=alert], .error').map(text).find(Boolean) || '';
    return out({ found: false, error: err.slice(0, 160) });
  }

  window.__cheHf = { detect, fill, submit, readToken };
})();
