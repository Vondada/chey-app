// CHE on any device: a self-contained web app served by the Worker at /app.
//
// For when the phone is lost or another device is closer: open the link in
// any browser, sign in with the pairing code (owner) or a family invite link,
// then talk or type. Replies are large text and read aloud; the mic uses the
// browser's speech recognition where it exists. The owner can also list and
// remove devices, add or remove AI keys, and invite family or friends
// (Personal or Parental Guidance profiles) from here.
//
// The page only talks to CHE's own API with the device token it was given;
// all text is rendered with textContent, never as HTML.

const PAGE = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>CHE</title>
<style>
:root{--bg:#08131e;--panel:#0f2130;--line:#24485a;--text:#edfafa;--dim:#9fc3c8;--accent:#32d9bf;--danger:#ff7a7a}
@media (prefers-color-scheme: light){:root{--bg:#f4fbfb;--panel:#ffffff;--line:#b9d6da;--text:#0b1d26;--dim:#3d5c63;--accent:#0b8f7c}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:19px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:16px 16px 140px}
h1{font-size:28px;margin:8px 0}h2{font-size:22px;margin:18px 0 8px}
button,input,select{font:inherit;color:inherit}
button{background:var(--accent);color:#03221d;border:0;border-radius:14px;padding:12px 18px;font-weight:700;min-height:48px;cursor:pointer}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
button.danger{background:transparent;color:var(--danger);border:1px solid var(--danger)}
button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
input,select{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;min-height:48px;width:100%}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 12px}
.msg{padding:14px 16px;border-radius:18px;margin:10px 0;max-width:92%;white-space:pre-wrap;word-wrap:break-word;font-size:21px}
.me{background:var(--accent);color:#03221d;margin-left:auto}.che{background:var(--panel);border:1px solid var(--line)}
.row{display:flex;gap:8px;align-items:center}.row>input{flex:1}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px;margin:10px 0}
.dim{color:var(--dim)}.hidden{display:none}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
footer .row{max-width:760px;margin:0 auto}
#banner{min-height:1.5em}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}
</style></head>
<body><main>
<h1>CHE</h1>
<p id="banner" class="dim" role="status" aria-live="polite"></p>

<section id="signin" class="hidden" aria-labelledby="signin-h">
  <h2 id="signin-h">Sign in to CHE on this device</h2>
  <p class="dim" id="signin-help">Enter your CHE pairing code. Family members use the invite link the owner sent them.</p>
  <label for="code">Pairing code</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code">
  <label for="devname">Name for this device</label>
  <input id="devname" placeholder="For example: Work laptop">
  <p><button id="signin-btn">Sign in</button></p>
</section>

<section id="app" class="hidden">
  <nav aria-label="CHE sections">
    <button class="ghost" data-tab="chat">1. Talk</button>
    <button class="ghost owner" data-tab="devices">2. Devices</button>
    <button class="ghost owner" data-tab="keys">3. Keys</button>
    <button class="ghost owner" data-tab="family">4. Family and friends</button>
  </nav>
  <section id="tab-chat" aria-label="Conversation"><div id="log" role="log" aria-live="polite"></div></section>
  <section id="tab-devices" class="hidden" aria-labelledby="dev-h"><h2 id="dev-h">Devices signed in to CHE</h2><div id="devices"></div>
    <p><button class="danger" id="signout">Sign this browser out</button></p></section>
  <section id="tab-keys" class="hidden" aria-labelledby="keys-h"><h2 id="keys-h">AI keys</h2>
    <p class="dim">Paste a key and CHE tests it before saving. Keys stay on CHE's server and are never shown again.</p><div id="keys"></div></section>
  <section id="tab-family" class="hidden" aria-labelledby="fam-h"><h2 id="fam-h">Share CHE with family and friends</h2>
    <p class="dim">Each person gets their own private CHE profile. Their memories stay separate from yours.</p>
    <label for="fam-name">Their name</label><input id="fam-name">
    <label for="fam-role">Profile type</label>
    <select id="fam-role"><option value="parental_guidance">Parental Guidance (child or teen)</option><option value="personal">Personal (adult)</option></select>
    <p><button id="fam-invite">Create invite link</button></p><div id="fam-out"></div></section>
</section>
</main>
<footer id="composer" class="hidden"><div class="row">
  <button class="ghost" id="mic" aria-label="Talk to CHE">🎤</button>
  <label for="say" class="hidden">Message CHE</label>
  <input id="say" placeholder="Type or press the mic" autocomplete="off">
  <button id="send">Send</button>
</div><p class="row dim" style="max-width:760px;margin:6px auto 0"><label><input type="checkbox" id="speak" checked style="width:auto;min-height:auto"> Read replies aloud</label></p></footer>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } }, set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (_) {} } };
  let token = store.get('che_token');
  const invite = new URLSearchParams(location.search).get('invite') || '';
  const turns = [];
  // Status haptics: a short double pulse for success, a long buzz for failure.
  const buzz = (ok) => { try { if (navigator.vibrate) navigator.vibrate(ok ? [40, 60, 40] : [300]); } catch (_) {} };
  const say = (text, ok) => { if (ok !== undefined) buzz(ok); $('banner').textContent = text; if ($('speak').checked && 'speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } };
  const api = async (path, body, method) => {
    const res = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { store.set('che_token', ''); token = ''; show(); throw new Error('This device is signed out. Sign in again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || ('CHE answered ' + res.status));
    return data;
  };
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };

  function show() {
    const signedIn = Boolean(token);
    $('signin').classList.toggle('hidden', signedIn);
    $('app').classList.toggle('hidden', !signedIn);
    $('composer').classList.toggle('hidden', !signedIn);
    if (!signedIn) {
      $('signin-help').textContent = invite ? 'You were invited to CHE. Name this device and sign in.' : 'Enter your CHE pairing code. Family members use the invite link the owner sent them.';
      $('code').style.display = invite ? 'none' : '';
      document.querySelector('label[for=code]').style.display = invite ? 'none' : '';
      (invite ? $('devname') : $('code')).focus();
    } else { $('say').focus(); loadRole(); }
  }

  async function loadRole() {
    try {
      const p = await api('/api/platform');
      const owner = p.tenant && p.tenant.role === 'owner';
      document.querySelectorAll('.owner').forEach((b) => b.classList.toggle('hidden', !owner));
      say(owner ? 'CHE is ready. Type or press the mic.' : 'Hi ' + (p.tenant && p.tenant.name || '') + '. CHE is ready.');
    } catch (e) { say(e.message); }
  }

  $('signin-btn').onclick = async () => {
    const name = $('devname').value.trim() || (navigator.userAgent.includes('Mac') ? 'Mac browser' : 'Web browser');
    try {
      const out = invite ? await api('/api/enroll', { enrollment_token: invite, device_name: name }) : await api('/api/pair', { code: $('code').value.trim(), device_name: name });
      token = out.device_token; store.set('che_token', token);
      turns.length = 0;
      if (invite) window.history.replaceState(null, '', '/app');
      show();
    } catch (e) { say(e.message); }
  };

  async function send(text) {
    text = String(text || '').trim(); if (!text) return;
    $('say').value = '';
    $('log').append(el('div', text, 'msg me'));
    const bubble = el('div', '…', 'msg che'); $('log').append(bubble); bubble.scrollIntoView({ block: 'end' });
    say('CHE is thinking.');
    let reply = '';
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ message: text, history: turns.slice(-12), client: { platform: 'web' } }) });
      if (res.status === 401) { store.set('che_token', ''); token = ''; show(); return; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
          let m; try { m = JSON.parse(line); } catch (_) { continue; }
          if (m.type === 'delta') { reply += m.delta || ''; bubble.textContent = reply; }
          if (m.type === 'done' && /^https:\/\//.test(m.media_url || '')) { const a = el('a', 'Open ' + (m.media_type === 'page' ? 'the page' : 'the result')); a.href = m.media_url; a.target = '_blank'; a.rel = 'noopener'; bubble.append(document.createElement('br'), a); }
        }
      }
    } catch (e) { reply = reply || 'I could not reach CHE. Check the connection and try again.'; bubble.textContent = reply; }
    turns.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    say(reply || 'CHE did not answer.');
  }
  $('send').onclick = () => send($('say').value);
  $('say').addEventListener('keydown', (e) => { if (e.key === 'Enter') send($('say').value); });

  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) { $('mic').disabled = true; $('mic').setAttribute('aria-label', 'Voice input is not available in this browser. Type instead.'); }
  else {
    let rec = null;
    $('mic').onclick = () => {
      if (rec) { rec.stop(); return; }
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      rec = new Rec(); rec.lang = navigator.language || 'en-US'; rec.interimResults = false;
      rec.onresult = (e) => send(e.results[0][0].transcript);
      rec.onend = () => { rec = null; $('mic').setAttribute('aria-label', 'Talk to CHE'); };
      rec.onerror = (e) => say('I could not hear that (' + e.error + '). Try again or type.');
      $('mic').setAttribute('aria-label', 'Listening. Press again to stop.'); say('Listening.');
      rec.start();
    };
  }

  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    document.querySelectorAll('[id^=tab-]').forEach((s) => s.classList.add('hidden'));
    $('tab-' + b.dataset.tab).classList.remove('hidden');
    $('composer').classList.toggle('hidden', b.dataset.tab !== 'chat');
    ({ devices: loadDevices, keys: loadKeys }[b.dataset.tab] || (() => {}))();
    say(b.textContent.replace(/^\d+\.\s*/, '') + ' open.');
  });

  async function loadDevices() {
    const box = $('devices'); box.textContent = 'Loading…';
    try {
      const p = await api('/api/platform'); box.textContent = '';
      const live = (p.devices || []).filter((d) => !d.revoked_at);
      live.forEach((d, i) => {
        const card = el('div', null, 'card');
        card.append(el('div', (i + 1) + '. ' + d.name + (p.device && p.device.name === d.name && p.device.created_at === d.created_at ? ' (this browser)' : '')), el('div', (d.profile || '') + ' · last used ' + String(d.last_seen_at || '').slice(0, 10), 'dim'));
        const btn = el('button', 'Remove ' + d.name, 'danger');
        btn.onclick = async () => { if (!confirm('Sign out ' + d.name + '? It will no longer reach CHE.')) return; try { await api('/api/platform/devices/revoke', { id: d.id }); say(d.name + ' is signed out.'); loadDevices(); } catch (e) { say(e.message); } };
        card.append(btn); box.append(card);
      });
      say(live.length + ' devices signed in.');
    } catch (e) { box.textContent = ''; say(e.message); }
  }
  $('signout').onclick = async () => { try { await api('/api/security/revoke_self', {}); } catch (_) {} store.set('che_token', ''); token = ''; show(); say('This browser is signed out.'); };

  async function loadKeys() {
    const box = $('keys'); box.textContent = 'Loading…';
    try {
      const k = await api('/api/keys'); box.textContent = '';
      (k.providers || []).forEach((p) => {
        const card = el('div', null, 'card');
        card.append(el('div', p.name + ': ' + p.status + (p.last4 ? ' (ends ' + p.last4 + ')' : '')));
        const id = 'key-' + p.id; const label = el('label', 'New ' + p.name + ' key'); label.htmlFor = id;
        const input = el('input'); input.id = id; input.type = 'password'; input.autocomplete = 'off';
        const save = el('button', 'Save and test ' + p.name + ' key');
        save.onclick = async () => { try { const r = await api('/api/keys', { provider: p.id, key: input.value }); input.value = ''; say(p.name + ' key saved, ending ' + r.last4 + '. Status ' + r.status + '.'); loadKeys(); } catch (e) { say(e.message); } };
        card.append(label, input, el('p'), save);
        if (p.last4) { const rm = el('button', 'Remove ' + p.name + ' key', 'danger'); rm.onclick = async () => { if (!confirm('Remove the ' + p.name + ' key?')) return; try { await api('/api/keys', { provider: p.id, remove: true }); say(p.name + ' key removed.'); loadKeys(); } catch (e) { say(e.message); } }; card.append(' ', rm); }
        box.append(card);
      });
      if (k.memory) {
        const m = k.memory; const card = el('div', null, 'card');
        card.append(el('div', m.name + ': ' + m.status + (m.last4 ? ' (key ends ' + m.last4 + ')' : '')), el('p', 'Long-term memory. Say "set up the memory database" to hear the steps.', 'dim'));
        const u = el('input'); u.id = 'mem-url'; u.type = 'url'; u.autocomplete = 'off'; const ul = el('label', 'Project URL (Supabase, Settings, API)'); ul.htmlFor = 'mem-url';
        const t = el('input'); t.id = 'mem-token'; t.type = 'password'; t.autocomplete = 'off'; const tl = el('label', 'service_role key'); tl.htmlFor = 'mem-token';
        const save = el('button', 'Connect and test the memory database');
        save.onclick = async () => { try { const r = await api('/api/keys/memory', { url: u.value, token: t.value }); t.value = ''; say('Memory database connected, key ending ' + r.last4 + '. Long-term memory is on.', true); loadKeys(); } catch (e) { say(e.message, false); } };
        card.append(ul, u, tl, t, el('p'), save);
        if (m.stored) { const rm = el('button', 'Disconnect the memory database', 'danger'); rm.onclick = async () => { if (!confirm('Disconnect the memory database? Saved memories stay in it.')) return; try { await api('/api/keys/memory', { remove: true }); say('Memory database disconnected.', true); loadKeys(); } catch (e) { say(e.message, false); } }; card.append(' ', rm); }
        box.append(card);
      }
    } catch (e) { box.textContent = ''; say(e.message); }
  }

  $('fam-invite').onclick = async () => {
    const name = $('fam-name').value.trim(); if (!name) { say('Type their name first.'); return; }
    try {
      const t = await api('/api/platform/tenants', { name, role: $('fam-role').value });
      const inv = await api('/api/platform/enrollments', { tenant_id: t.tenant.id, access: 'private', ttl_minutes: 60 });
      const link = location.origin + '/app?invite=' + encodeURIComponent(inv.enrollment.token);
      const out = $('fam-out'); out.textContent = '';
      const field = el('input'); field.value = link; field.readOnly = true; field.setAttribute('aria-label', 'Invite link for ' + name);
      out.append(el('p', 'Send this link to ' + name + '. It works once, within the next hour.'), field);
      if (navigator.share) { const sh = el('button', 'Share the link'); sh.onclick = () => navigator.share({ title: 'CHE invite', url: link }).catch(() => {}); out.append(el('p'), sh); }
      say('Invite link for ' + name + ' is ready.');
    } catch (e) { say(e.message); }
  };

  show();
})();
</script></body></html>`;

export function webAppPage() {
  return new Response(PAGE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      // The browser may use the mic only for this page, after the user allows it.
      'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    },
  });
}
