#!/usr/bin/env node
// CHE's live probe suite: one copy, run by the production deploy (che-worker-deploy.yml, one step
// per probe) and by the pre-merge staging gate (che-worker-staging.yml, the whole suite at once).
//
//   node .github/scripts/che_live_probes.mjs <probe> [<probe> ...]
//   node .github/scripts/che_live_probes.mjs --suite        every probe, in the production order
//
// Environment:
//   CHE_LIVE_BASE          the Worker to probe (https://chey-app... or https://chey-app-staging...)
//   CHE_LIVE_TARGET        "production" (default) or "staging". On staging, probes that need the
//                          owner's own data or a production-only secret are SKIPPED with the reason
//                          printed; they never pass silently.
//   CHE_VOICE_PROBE_TOKEN  this run's random probe token (also set as the target Worker's secret)
//   EXPECTED_TAG           the commit the target should be running (health probe)
// Plus the settings each probe already read in the deploy job (CHE_ELEVENLABS_PREFERRED, FISH_*,
// CHE_GITHUB_TOKEN for the opt-in video check, REA_* for the opt-in REA check).
//
// Each probe ends as pass, warn (reported, never fails the run, exactly as the deploy job treated
// it before), skip (with a reason) or fail. The run exits 1 when any probe failed.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = String(process.env.CHE_LIVE_BASE || '').replace(/\/+$/, '');
const TARGET = String(process.env.CHE_LIVE_TARGET || 'production').toLowerCase() === 'staging' ? 'staging' : 'production';
const STAGING = TARGET === 'staging';
// Memory-probe steps that read GitHub with CHE_GITHUB_TOKEN; staging never holds that secret.
const STAGING_GITHUB_STEPS = new Set(['GitHub truth and execution receipts', 'Pinned live handoff receipt']);
const TOKEN = process.env.CHE_VOICE_PROBE_TOKEN || '';
const WHERE = STAGING ? 'staging Worker' : 'live Worker';
const on = (name) => ['1', 'true', 'yes'].includes(String(process.env[name] || '').toLowerCase());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const summary = (line) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };
const bearer = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, ...extra });

const pass = (detail = '') => ({ status: 'pass', detail });
const warn = (detail) => ({ status: 'warn', detail });
const fail = (detail) => ({ status: 'fail', detail });
const skip = (detail) => ({ status: 'skip', detail });
// External verification that could not run because the outside service was down (for example Wikipedia HTTP 503).
// Visible and separate from pass and fail; the run is not failed for it, and nothing is claimed as verified.
const pending = (detail) => ({ status: 'pending', detail });

// POST a probe route with retries; returns { body, error }.
async function postProbe(path, { attempts = 5, timeoutMs = 90000, waitMs = 4000, headers = bearer(), body } = {}) {
  let lastError = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${BASE}${path}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return { body: await response.json(), error: '' };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'network error';
    }
    if (attempt < attempts - 1) await sleep(waitMs);
  }
  return { body: null, error: lastError };
}

// Prints each step of a probe report the way the deploy job always has.
function printSteps(report) {
  for (const step of report.steps || []) {
    console.log(`${step.pass ? 'PASS' : step.optional ? 'WARN' : 'FAIL'} ${step.name} [${step.route || '-'} | model_calls=${step.model_calls ?? '?'} | ${step.ms} ms] ${String(step.reply || '').replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

// Probes that only the production deploy job runs as their own workflow steps (they need tools,
// a browser or production-only secrets). Listed here so the staging report names them as skips.
const PRODUCTION_STEPS = {
  'creation-viewport': 'Opens the Creation Engine GLB in Live Studio; it needs the opt-in creation check, which staging skips.',
  'character-accept': 'Opt-in character acceptance (tools/creation_accept.mjs) starts the owner\'s free cloud worker with CHE_GITHUB_TOKEN and publishes samples to che-character-samples; production only.',
  'fish-measure': 'Calls Fish Audio directly with the owner\'s FISH_API_KEY (paid voice credit); staging receives no paid voice key.',
};

const PROBES = {
  async health() {
    const expected = String(process.env.EXPECTED_TAG || '').slice(0, 12);
    if (!expected) return fail('EXPECTED_TAG is not set.');
    const attempts = Number(process.env.CHE_HEALTH_ATTEMPTS || 6);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) });
        const health = await response.json();
        if (response.ok && health.ok && health.version_tag === expected) {
          console.log(`Verified ${TARGET} CHE commit ${expected}, version ${health.version_id}`);
          console.log(`::notice title=${STAGING ? 'Staging' : 'Live'} CHE commit::${expected} is live on the ${WHERE} (Worker version ${health.version_id})`);
          return pass(`${expected} running (version ${health.version_id})`);
        }
      } catch { /* retry propagation or a transient health error */ }
      await sleep(3000);
    }
    return fail(`${TARGET} CHE did not confirm commit ${expected}`);
  },

  // Which text engines the target can use (public, secret-free /health/engines). On staging it is
  // the zero-spend guard: a paid engine, or any engine outside the free allowlist, fails the run.
  async engines() {
    let report = null;
    for (let attempt = 0; attempt < 4 && !report; attempt++) {
      try {
        const response = await fetch(`${BASE}/health/engines`, { signal: AbortSignal.timeout(15000) });
        if (response.ok) report = await response.json();
      } catch { /* retry */ }
      if (!report) await sleep(3000);
    }
    if (!report) return STAGING ? fail('The staging Worker did not report its engines, so zero paid spend cannot be shown.') : warn('The live Worker did not report its engines.');
    const configured = (report.engines || []).filter((e) => e.configured).map((e) => e.id);
    const line = `Workers AI ${report.cloudflare?.bound ? 'bound' : 'not bound'}; keyed engines configured: ${configured.join(', ') || 'none'}`;
    console.log(`::notice title=Engines (${WHERE})::${line}`);
    summary(`**Engines (${WHERE}):** ${line}.`);
    if (!STAGING) return pass(line);
    const allowed = new Set(String(process.env.CHE_STAGING_FREE_ENGINES || '').split(/[\s,]+/).filter(Boolean));
    const bad = configured.filter((id) => ['openai', 'xai', 'anthropic'].includes(id.split(':')[0]) || !allowed.has(id.split(':')[0]));
    if (bad.length) return fail(`Staging has engines outside the free allowlist: ${bad.join(', ')}`);
    return pass(line);
  },

  async sidestore() {
    // SideStore names the app from the IPA URL's last path segment. The live link must end in the
    // real bundle ID, and both download paths must deliver the published bytes.
    if (STAGING) return skip('Reads the owner\'s published iPhone releases from GitHub with CHE_GITHUB_TOKEN, a production-only secret; without it staging reports "no release" and the check would pass without testing anything.');
    const bundleId = 'com.cheyapp.chey';
    const read = async (url, timeoutMs = 20000) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        try { return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); } catch { /* retry a transient error */ }
        await sleep(3000);
      }
      throw new Error(`Could not reach ${url}`);
    };
    const latest = await (await read(`${BASE}/api/update/latest`)).json();
    if (!latest.ok) {
      console.log('No verified CHE iPhone release is published yet; nothing to check.');
      return skip('No verified CHE iPhone release is published yet.');
    }
    const installUrl = new URL(new URL(latest.sidestore_install_url).searchParams.get('url'));
    const lastSegment = installUrl.pathname.split('/').pop();
    if (lastSegment !== `${bundleId}.ipa`) return fail(`Install link ends in ${lastSegment}, not ${bundleId}.ipa`);
    const source = await (await read(`${BASE}/api/update/source`)).json();
    if (source.apps?.[0]?.bundleIdentifier !== bundleId) return fail('Update source names a different bundle ID');
    const verifyIpa = async (url, label) => {
      const response = await read(url, 240000);
      if (!response.ok) throw new Error(`${label} returned ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== Number(latest.size)) throw new Error(`${label} is ${bytes.length} bytes, published ${latest.size}`);
      if (createHash('sha256').update(bytes).digest('hex') !== latest.sha256) throw new Error(`${label} SHA-256 differs from the published release`);
      if (bytes.subarray(0, 4).toString('hex') !== '504b0304') throw new Error(`${label} is not a ZIP archive`);
      console.log(`${label}: verified ${bytes.length} bytes`);
    };
    await verifyIpa(installUrl.href, 'SideStore install download');
    await verifyIpa(`${BASE}/api/update/download/${encodeURIComponent(latest.id)}/${bundleId}.ipa`, 'Worker relay download');
    const line = `Verified live install link for ${bundleId} ${latest.version} (${latest.build_number}), ${latest.size} bytes`;
    console.log(line);
    return pass(line);
  },

  async 'mary-settings'() {
    // Public probe: booleans and status words only, never a key or a voice ID. No speech is
    // generated, so no ElevenLabs credits are spent.
    const enabled = on('CHE_ELEVENLABS_PREFERRED');
    let probe = null;
    for (let attempt = 0; attempt < 6 && !probe; attempt++) {
      try {
        const response = await fetch(`${BASE}/api/voice/status`, { signal: AbortSignal.timeout(10000) });
        const body = await response.json();
        if (response.ok && body.ok) probe = body;
      } catch { /* retry a transient error */ }
      if (!probe) await sleep(3000);
    }
    if (!probe) return fail('Voice status did not answer');
    console.log(`Voice settings (${WHERE}): ${JSON.stringify({ top_level: probe.top_level, live: probe.live, captured: probe.captured })}`);
    if (STAGING && probe.live?.key_present) return fail('Staging holds an ElevenLabs key; staging must have no paid voice key.');
    if (!enabled) {
      if (probe.live.preferred) return fail(`Mary is on in the ${WHERE}, but the owner setting is off.`);
      console.log('Mary is off by the owner setting; the free voice is used.');
      return pass('Mary off as set; free voice in use.');
    }
    if (!probe.top_level.ready || !probe.live.ready) {
      return fail(`Mary is enabled, but the ${WHERE} reports not ready (key present: ${probe.live.key_present}, voice ID format ok: ${probe.live.voice_id_format_ok}).`);
    }
    if (!probe.captured.ready) console.log('::notice::The Durable Object had an older env; the live Mary settings were passed in for this request.');
    console.log(`Mary live: ready, last status "${probe.live.status}".`);
    return pass(`Mary ready, last status "${probe.live.status}".`);
  },

  async 'fish-settings'() {
    // Public probe: booleans, model names and status words only.
    const enabled = on('CHE_FISH_PREFERRED');
    const configured = Boolean(process.env.FISH_API_KEY) && /^[A-Za-z0-9_-]{8,80}$/.test(process.env.CHE_FISH_VOICE_ID || '');
    let probe = null;
    for (let attempt = 0; attempt < 6 && !probe; attempt++) {
      try {
        const response = await fetch(`${BASE}/api/voice/status`, { signal: AbortSignal.timeout(10000) });
        const body = await response.json();
        if (response.ok && body.ok && body.fish) probe = body.fish;
      } catch { /* retry a transient error */ }
      if (!probe) await sleep(3000);
    }
    if (!probe) return fail('Voice status did not report Fish');
    console.log(`Fish settings (${WHERE}): ${JSON.stringify(probe)}`);
    if (STAGING) {
      if (probe.live?.key_present) return fail('Staging holds a Fish Audio key; staging must have no paid voice key.');
      return skip('Fish Audio is a paid voice; staging receives no FISH_API_KEY. Checked only that staging reports Fish and holds no key.');
    }
    if (!configured) {
      console.log('::notice::Fish Audio is not set up: add the FISH_API_KEY and CHE_FISH_VOICE_ID secrets. CHE keeps her existing voices.');
      return skip('Fish Audio is not set up.');
    }
    if (enabled && (!probe.top_level.ready || !probe.live.ready)) {
      return fail(`Fish is configured, but the live Worker reports not ready (key present: ${probe.live.key_present}, voice ID format ok: ${probe.live.voice_id_format_ok}).`);
    }
    const line = enabled ? `Fish live: ready, everyday ${probe.live.everyday_model}, expressive ${probe.live.expressive_model}.` : 'Fish is switched off by CHE_FISH_PREFERRED.';
    console.log(line);
    return pass(line);
  },

  async voice() {
    // One real ElevenLabs call made by the deployed Worker with its live settings, the same code the
    // phone's replies use. About 60 characters of ElevenLabs credit.
    if (STAGING) return skip('Makes one real ElevenLabs call (paid credit); staging receives no ElevenLabs key.');
    if (!on('CHE_ELEVENLABS_PREFERRED')) {
      console.log('ElevenLabs is off by the owner setting (CHE_ELEVENLABS_PREFERRED); no call made.');
      return skip('ElevenLabs is off by the owner setting; no call made.');
    }
    // A 404 or no answer means no call was made yet (the new secret can take a moment to reach
    // every edge); retry those only.
    const { body: result, error } = await postProbe('/api/voice/probe', { attempts: 5, timeoutMs: 30000 });
    if (!result) {
      console.log(`::error title=ElevenLabs voice check did not run::The live Worker did not answer the voice check (${error}).`);
      summary(`**ElevenLabs voice check did not run:** the live Worker did not answer (${error}).`);
      return warn(`did not run (${error})`);
    }
    const audio = Buffer.from(result.audio_base64 || '', 'base64');
    const validMp3 = audio.length > 3 && ((audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0));
    const { audio_base64, voice_log: log = [], ...row } = result;
    console.log(`ElevenLabs through the live Worker: ${JSON.stringify({ ...row, valid_mp3: validMp3 })}`);
    console.log(`Recent voice attempts, oldest first (${log.length}):`);
    for (const entry of log) console.log(`  ${JSON.stringify(entry)}`);
    if (result.ok && validMp3) {
      mkdirSync('che-voice-check', { recursive: true });
      writeFileSync('che-voice-check/elevenlabs.mp3', audio);
      console.log(`ElevenLabs spoke: ${audio.length} bytes in ${result.ms} ms (model ${result.model}).`);
      console.log(`::notice title=CHE voice::ElevenLabs spoke through the live Worker: ${audio.length} bytes in ${result.ms} ms`);
      summary(`**ElevenLabs voice works through the live Worker:** ${audio.length} bytes in ${result.ms} ms. The clip is in the \`che-voice-check\` artifact.`);
      return pass(`${audio.length} bytes in ${result.ms} ms`);
    }
    const why = `${result.status || 'no status'}${result.http ? ` (HTTP ${result.http})` : ''}${result.reason ? `: ${String(result.reason).replace(/[.\s]+$/, '')}` : ''}`;
    console.log(`::error title=ElevenLabs gave no audio::ElevenLabs gave no audio through the live Worker: ${why}. CHE speaks with Fish until this is fixed.`);
    summary(`**ElevenLabs gave no audio through the live Worker:** ${why}. CHE speaks with Fish (backup) until this is fixed.`);
    return warn(`no audio: ${why}`);
  },

  async trading() {
    // Paper only. Arms the minute alarm, runs one forward-paper pass, and prints what the records
    // hold. On staging these are staging's own paper records, never the owner's.
    const { body: report, error } = await postProbe('/api/trading/probe', { attempts: 3, timeoutMs: 60000 });
    if (!report) { console.log(`::warning title=Trading check did not run::${error}`); return warn(`did not run (${error})`); }
    console.log(JSON.stringify(report, null, 2));
    const f = report.feed || {};
    const line = `Paper trading ${report.state?.enabled ? 'ON' : 'OFF'} (${report.account}); feed ${f.status || 'none'} ${f.symbol || ''} ${report.contract || ''}, last bar ${f.last_bar || '-'}${f.error ? `, error: ${f.error}` : ''}; market ${report.session?.state}; signals ${report.counts?.signals ?? 0}, entries ${report.counts?.filled ?? 0}, closed ${report.totals?.trades ?? 0} (${report.totals?.wins ?? 0} won, ${report.totals?.losses ?? 0} lost, net ${report.totals?.net_pnl ?? 0}), open ${(report.positions || []).length}`;
    console.log(`::notice title=Forward paper trading::${line}`);
    summary(`**Forward paper trading (${WHERE}):** ${line}.`);
    const cx = report.crypto;
    if (cx) {
      const feeds = (cx.series || []).map((x) => `${x.coin} ${x.tf} ${x.status || 'not read'}${x.last_bar ? ` last bar ${x.last_bar} close ${x.last_close}` : ''}${x.reason ? ` (${x.reason})` : ''}`).join('; ');
      const check = cx.cross_check ? (cx.cross_check.diff_pct != null ? `Kraken cross-check ${cx.cross_check.coin} ${cx.cross_check.diff_pct}%` : `Kraken cross-check: ${cx.cross_check.error}`) : 'no Kraken cross-check';
      const cline = `Orion crypto ${cx.enabled ? 'ON' : 'PAUSED'}; this pass ${cx.ok ? 'read the exchange' : `failed${cx.error ? `: ${cx.error}` : ''}`} with ${cx.requests} requests: ${feeds || 'no series due'}; ${check}; scheduled passes recorded ${cx.passes_recorded} (last ${cx.last_scheduled_run || 'none'}); simulated trades closed ${cx.closed_trades}, open ${cx.open_positions}; requests today ${cx.budget?.requests ?? '?'} of ${cx.budget?.limit ?? '?'}`;
      console.log(`::notice title=Orion crypto desk (paper)::${cline}`);
      summary(`**Orion crypto desk (${WHERE}, paper):** ${cline}.`);
    }
    const bt = report.backtest;
    if (bt?.ok) {
      const rows = bt.rows || [];
      const fmt = (r) => `${r.strategy}/${r.filter}/${r.target_r}R: ${r.trades} trades, win ${r.win_rate ?? '-'}%, ${r.expectancy_r} R, net ${r.net} (out of sample ${r.oos_trades} trades, ${r.oos_expectancy_r ?? '-'} R, folds ${r.folds_positive}/${r.folds})`;
      console.log(`::notice title=Historical baseline (backtest, not forward evidence)::${bt.data}`);
      for (const r of rows.slice(0, 5)) console.log(`BEST  ${fmt(r)}`);
      for (const r of rows.slice(-3)) console.log(`WORST ${fmt(r)}`);
      summary(`**Historical baseline:** ${bt.data}. Best: ${rows[0] ? fmt(rows[0]) : 'none'}. Worst: ${rows.at(-1) ? fmt(rows.at(-1)) : 'none'}.`);
    } else if (bt) console.log(`::warning title=Historical baseline::${bt.error || 'not run'}`);
    return pass(line);
  },

  async 'trading-audit'() {
    // Read only (trading_audit.js): recomputes the stored records and prints counts, never record
    // contents. On staging it audits staging's own paper records from the trading probe.
    const { body: out, error } = await postProbe('/api/trading/audit/probe', { attempts: 3, timeoutMs: 60000 });
    if (!out) { console.log(`::warning title=Trading audit did not run::${error}`); return warn(`did not run (${error})`); }
    console.log(`::notice title=Trading audit::${out.summary}`);
    // The journal's cost arithmetic and the owner's loss answers, from the owner's own records (trading_audit.js).
    console.log(`Trading audit cost examples (journal, real records): ${JSON.stringify(out.cost_examples || [], null, 1)}`);
    console.log(`Trading audit loss answers (journal): ${JSON.stringify(out.loss_answers || {}, null, 1)}`);
    summary(`**Trading audit (${WHERE}, read only${STAGING ? ', staging records' : ''}):** ${out.summary}`);
    return pass(out.summary);
  },

  async memory() {
    // A real, authenticated chat test of the deployed /api/chat route, against a separate, isolated
    // CHE (never the owner's memory). A memory step that fails fails this probe.
    const { body: report, error } = await postProbe('/api/memory/probe', { attempts: 5, timeoutMs: 90000 });
    if (!report) {
      console.log(`::error title=Memory truth check did not run::The ${WHERE} did not answer the memory check (${error}).`);
      summary(`**Memory truth check did not run:** the ${WHERE} did not answer (${error}).`);
      return fail(`did not run (${error})`);
    }
    summary(`**CHE memory truth (${WHERE}, isolated test CHE):** ${report.passed}/${report.total} steps passed; memory answers used ${report.memory_route_model_calls} model calls; slowest memory answer ${report.slowest_memory_ms} ms.`);
    console.log(`::notice title=Memory truth::${report.passed}/${report.total} steps passed; memory answers used ${report.memory_route_model_calls} model calls; slowest ${report.slowest_memory_ms} ms`);
    const read = report.storage_read;
    console.log(read
      ? `::notice title=Memory truth storage read::The isolated test CHE read ${read.stores_read.join(', ')} with no model and named only the record ids it read: ${read.record_ids.join(', ')}`
      : '::warning title=Memory truth storage read::No memory store read was recorded in this check.');
    summary('');
    summary('| Step | Result | Route | Model calls | ms |');
    summary('|---|---|---|---|---|');
    for (const step of report.steps || []) {
      console.log(`${step.pass ? 'PASS' : 'FAIL'} ${step.name} [${step.route || 'model'} | model_calls=${step.model_calls ?? '?'} | ${step.ms} ms]`);
      console.log(`     ${String(step.reply || '').replace(/\s+/g, ' ')}`);
      summary(`| ${step.name} | ${step.pass ? 'pass' : '**FAIL**'} | ${step.route || 'model'} | ${step.model_calls ?? '?'} | ${step.ms} |`);
    }
    // Staging holds no CHE_GITHUB_TOKEN (production-only), so the two GitHub receipt steps can only answer
    // "not connected". They are skipped with that reason, and only when the reply says exactly that; any
    // other failure of those steps (an invented PR state, say) still fails the probe.
    const githubOnly = (step) => STAGING && STAGING_GITHUB_STEPS.has(step.name)
      && /not connected to GitHub|GitHub credentials or repository are unavailable/.test(String(step.reply || ''))
      && !/\b(merged|is open|was closed)\b/i.test(String(step.reply || ''));
    for (const step of (report.steps || []).filter((st) => !st.pass && githubOnly(st))) {
      console.log(`::notice title=Memory step skipped on staging::${step.name}: needs CHE_GITHUB_TOKEN, a production-only secret; CHE answered that GitHub is not connected.`);
      summary(`SKIPPED on staging: ${step.name} (needs CHE_GITHUB_TOKEN, production only; CHE said GitHub is not connected).`);
    }
    // Only the step the Worker marks optional (a live model's own words) may warn instead of fail.
    const failedMemory = (report.steps || []).filter((step) => !step.pass && step.optional !== true && !githubOnly(step));
    const failedModel = (report.steps || []).filter((step) => !step.pass && step.optional === true);
    for (const step of failedModel) console.log(`::warning title=Model answer check::${step.name}: ${String(step.reply).slice(0, 200)}`);
    const skippedGithub = (report.steps || []).filter((st) => !st.pass && githubOnly(st)).length;
    // A report that is not ok with no failing step is an error of the check itself: never a pass.
    if (failedMemory.length || (!report.ok && !(report.steps || []).some((st) => !st.pass))) {
      const what = failedMemory.map((step) => step.name).join('; ') || report.error || 'see log';
      console.log(`::error title=Memory truth check failed::${what}`);
      return fail(what);
    }
    const skippedNote = skippedGithub ? `; ${skippedGithub} GitHub step${skippedGithub === 1 ? '' : 's'} skipped on staging (no CHE_GITHUB_TOKEN)` : '';
    return failedModel.length ? warn(`${report.passed}/${report.total} steps passed${skippedNote}; model answer not checked: ${failedModel.map((s) => s.name).join('; ')}`) : pass(`${report.passed}/${report.total} steps passed${skippedNote}`);
  },

  async creation() {
    // The same Generate the app's button calls, on the owner's one test project. CHE then starts the
    // free GitHub CPU worker herself; this only watches the job and checks the GLB the Worker stored.
    if (STAGING) return skip('Opt-in in production (creation_check). It starts the free GitHub CPU worker with CHE_GITHUB_TOKEN, a production-only secret, and uses the owner\'s test project.');
    mkdirSync('che-creation-check', { recursive: true });
    const base = `${BASE}/api/creations/probe`;
    const headers = { 'X-CHE-Memory-Probe': TOKEN };
    const stop = (title, msg) => { console.log(`::error title=${title}::${msg}`); summary(`**${title}:** ${msg}`); return fail(`${title}: ${msg}`); };
    const start = await (await fetch(`${base}/start`, { method: 'POST', headers, signal: AbortSignal.timeout(60000) })).json().catch((e) => ({ ok: false, detail: String(e) }));
    console.log(JSON.stringify(start));
    if (!start.ok) return stop('Creation Engine check did not start', start.detail || 'no answer');
    if (!start.engine?.automatic) return stop('Creation Engine cannot start a cloud worker', start.engine?.waiting_reason || 'automatic cloud workers are not usable');
    // Leave all phone/browser clients absent while the server worker starts.
    await sleep(60000);
    const t0 = Date.now(); let last = ''; let job = null; let status = null;
    while (Date.now() - t0 < 50 * 60_000) {
      status = await (await fetch(`${base}/status?job=${start.job_id}`, { headers, signal: AbortSignal.timeout(30000) })).json().catch(() => null);
      job = status?.job;
      const line = job ? `${job.display_state}: ${job.status_line}` : 'no answer';
      if (line !== last) { console.log(`${new Date().toISOString()} ${line}`); last = line; }
      if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) break;
      await sleep(20000);
    }
    writeFileSync('che-creation-check/status.json', JSON.stringify(status, null, 2));
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    if (job?.state !== 'completed') return stop('Creation Engine check did not complete', `job ${start.job_id} ended ${job?.state || 'unknown'} after ${mins} min: ${job?.status_line || ''}`);
    const res = await fetch(`${base}/model.glb?job=${start.job_id}`, { headers, signal: AbortSignal.timeout(60000) });
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const isGlb = bytes.length > 20 && dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2 && dv.getUint32(8, true) === bytes.length;
    if (!res.ok || !isGlb) return stop('Creation Engine GLB is not valid', `HTTP ${res.status}, ${bytes.length} bytes`);
    if (sha !== job.model?.sha256) return stop('Creation Engine GLB does not match its receipt', `downloaded ${sha}, receipt ${job.model?.sha256}`);
    writeFileSync('che-creation-check/model.glb', bytes);
    const r = job.receipt || {};
    const rig = job.rig ? `${job.rig.bones} bones, clips ${job.rig.clips.join('/')}, rig ${job.rig.ok ? 'verified' : 'NOT verified'}` : 'no rig';
    // The Worker names the real worker (gpu_queue.js workerName); unknown is said in words, never "?".
    const worker = job.worker_name || 'unknown worker';
    const line = `job ${start.job_id} completed in ${mins} min on ${worker} (${r.device || 'device not recorded'}${r.cores ? `, ${r.cores} cores` : ''}, ${r.blender_version || 'Blender version not recorded'}); GLB ${bytes.length} bytes sha256 ${sha.slice(0, 16)}… (matches the receipt); ${r.model?.mode || 'unrecorded'} model, ${rig}; previews ${job.previews.join(', ') || 'none'}; project ${start.project_id}`;
    console.log(`::notice title=Creation Engine end to end::${line}`);
    summary(`**Creation Engine end to end (live Worker, real cloud worker):** ${line}.`);
    return pass(line);
  },

  async history() {
    // Long-term memory on the isolated test CHE (conversation_history.js historyProbe): a spoken conversation on a
    // random 2025 day, posted to /api/logs as the phone does, is retrieved by its date; CHE's wrong answer that day is
    // found with the owner's pushback as evidence; a correction is saved and linked; a day with no conversation is
    // said to have none. Every answer must come from the records, with 0 model calls.
    const { body: report, error } = await postProbe('/api/history/probe', { attempts: 3, timeoutMs: 120000 });
    if (!report) {
      console.log(`::error title=Conversation history check did not run::The ${WHERE} did not answer (${error}).`);
      return fail(`did not run (${error})`);
    }
    printSteps(report);
    console.log(`::notice title=Conversation history::${report.passed}/${report.total} live checks passed`);
    summary(`**Conversation history and mistakes (${WHERE}):** ${report.passed}/${report.total} live checks passed on the isolated test CHE.`);
    if (!report.ok) {
      const what = (report.steps || []).filter((s) => !s.pass).map((s) => s.name).join('; ') || report.error || 'see log';
      console.log(`::error title=Conversation history check failed::${what}`);
      return fail(what);
    }
    return pass(`${report.passed}/${report.total} live checks passed`);
  },

  async commands() {
    // Live checks on the isolated test CHE (never the owner's): the catalog, an unknown command, a
    // slash command reaching its handler, an approval hold, and a suggestion card. Then which
    // commands the target's own CHE can run now (connector states only).
    const { body: report, error } = await postProbe('/api/commands/probe', { attempts: 5, timeoutMs: 90000 });
    if (!report) {
      console.log(`::error title=Command Center check did not run::The ${WHERE} did not answer (${error}).`);
      return fail(`did not run (${error})`);
    }
    printSteps(report);
    const r = report.readiness || {};
    const setup = (r.setup_required || []).map((c) => `/${c.id} (${c.missing.join(', ')})`);
    const whose = STAGING ? 'staging CHE (no owner connectors)' : 'owner CHE';
    console.log(`::notice title=Command Center::${report.passed}/${report.total} live checks passed; ${whose}: ${r.available ?? '?'} commands ready, ${setup.length} need setup, ${(r.unsupported || []).length} unsupported, ${(r.temporarily_unavailable || []).length} temporarily unavailable`);
    if (setup.length) console.log(`Needs setup: ${setup.join('; ')}`);
    summary(`**Command Center (${WHERE}):** ${report.passed}/${report.total} live checks passed; ${r.available ?? '?'} commands ready on the ${whose}; needs setup: ${setup.join('; ') || 'none'}.`);
    for (const step of (report.steps || []).filter((s) => !s.pass && s.optional)) console.log(`::warning title=Command Center check::${step.name}: ${String(step.reply).slice(0, 200)}`);
    if (!report.ok) {
      const what = (report.steps || []).filter((s) => !s.pass && !s.optional).map((s) => s.name).join('; ') || (report.readiness && report.readiness.error) || report.error || 'see log';
      console.log(`::error title=Command Center check failed::${what}`);
      return fail(what);
    }
    const optionalFailed = (report.steps || []).filter((s) => !s.pass && s.optional).map((s) => s.name);
    return optionalFailed.length ? warn(`${report.passed}/${report.total} live checks passed; optional not passed: ${optionalFailed.join('; ')}`) : pass(`${report.passed}/${report.total} live checks passed`);
  },

  async atlas() {
    // Live checks on the isolated test CHE: two lessons, two risk calculations, a quiz answer graded
    // from the card's formula, real progress counts, an honest strategy verdict with no journal,
    // and two counter-cases that keep their routes.
    const { body: report, error } = await postProbe('/api/atlas/probe', { attempts: 5, timeoutMs: 90000 });
    if (!report) {
      console.log(`::error title=Knowledge Atlas check did not run::The ${WHERE} did not answer (${error}).`);
      return fail(`did not run (${error})`);
    }
    printSteps(report);
    console.log(`::notice title=Knowledge Atlas::${report.passed}/${report.total} live checks passed`);
    summary(`**Knowledge Atlas (${WHERE}):** ${report.passed}/${report.total} live checks passed on the isolated test CHE.`);
    for (const step of (report.steps || []).filter((s) => !s.pass && s.optional)) console.log(`::warning title=Knowledge Atlas check::${step.name}: ${String(step.reply).slice(0, 200)}`);
    if (!report.ok) {
      const what = (report.steps || []).filter((s) => !s.pass && !s.optional).map((s) => s.name).join('; ') || report.error || 'see log';
      console.log(`::error title=Knowledge Atlas check failed::${what}`);
      return fail(what);
    }
    const optionalFailed = (report.steps || []).filter((s) => !s.pass && s.optional).map((s) => s.name);
    return optionalFailed.length ? warn(`${report.passed}/${report.total} live checks passed; optional not passed: ${optionalFailed.join('; ')}`) : pass(`${report.passed}/${report.total} live checks passed`);
  },

  async privacy() {
    // Private Mode on the isolated test CHE with the target's real model (privacy_mode.js privacyProbe): on by
    // default, a chat turn with a canary memory reaches no outside AI or voice company (Knox's fetch-layer
    // ledger shows nothing sent), live voice refuses OpenAI, and Knox answers from records with no model call.
    const { body: report, error } = await postProbe('/api/privacy/probe', { attempts: 3, timeoutMs: 180000 });
    if (!report) {
      console.log(`::error title=Private Mode check did not run::The ${WHERE} did not answer (${error}).`);
      return fail(`did not run (${error})`);
    }
    for (const step of report.steps || []) console.log(`${step.pass ? 'PASS' : 'FAIL'} ${step.name} [${step.route || '-'} | model calls ${step.model_calls ?? '-'} | ${step.ms} ms] ${String(step.reply || '').replace(/\s+/g, ' ').slice(0, 240)}`);
    console.log(`::notice title=Private Mode::${report.passed}/${report.total} live checks passed`);
    summary(`**Private Mode (${WHERE}, real model):** ${report.passed}/${report.total} live checks passed on the isolated test CHE.`);
    if (!report.ok) {
      const what = (report.steps || []).filter((s) => !s.pass).map((s) => s.name).join('; ') || report.error || 'see log';
      console.log(`::error title=Private Mode check failed::${what}`);
      return fail(what);
    }
    return pass(`${report.passed}/${report.total} live checks passed`);
  },

  async arithmetic() {
    // Live checks on the isolated test CHE through the real /api/chat route: a typed sum is computed with a receipt,
    // school precedence holds, an undefined sum is an error with a receipt, and a sentence about maths is not computed.
    const { body: report, error } = await postProbe('/api/arithmetic/probe', { attempts: 3, timeoutMs: 120000 });
    if (!report) {
      console.log(`::error title=Arithmetic check did not run::The ${WHERE} did not answer (${error}).`);
      return fail(`did not run (${error})`);
    }
    printSteps(report);
    summary(`**Arithmetic route (${WHERE}, /api/chat):** ${report.passed}/${report.total} live checks passed.`);
    if (!report.ok) {
      const what = (report.steps || []).filter((s) => !s.pass && !s.optional).map((s) => s.name).join('; ') || report.error || 'see log';
      console.log(`::error title=Arithmetic check failed::${what}`);
      return fail(what);
    }
    return pass(`${report.passed}/${report.total} live checks passed`);
  },

  async study() {
    // A study assignment on the isolated test CHE with the target's real network and model (comedy_study.js
    // studyProbe): "go study Martin and The Fresh Prince of Bel-Air ... what makes them funny" is planned, a few
    // background passes search Wikipedia, read the episode guides and derive lessons, then status, lessons and a
    // joke are asked in chat. Coverage is reported by method: episode summaries read, never episodes watched.
    const { body: report, error } = await postProbe('/api/study/probe', { attempts: 2, timeoutMs: 300000 });
    if (!report) {
      console.log(`::error title=Study check did not run::The ${WHERE} did not answer (${error}).`);
      return fail(`did not run (${error})`);
    }
    const label = (s) => ({ pass: 'PASS', warn: 'WARN', fail: 'FAIL', upstream_unavailable: 'PENDING' })[s.status] || (s.pass ? 'PASS' : s.optional ? 'WARN' : 'FAIL');
    for (const step of report.steps || []) {
      const evidence = step.upstream ? ` | upstream HTTP ${step.upstream.http_status} after ${step.upstream.attempts} attempts (${step.upstream.at})` : '';
      console.log(`${label(step)} ${step.name} [${step.route || '-'} | ${step.ms} ms]${evidence} ${String(step.reply || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    for (const c of report.coverage || []) console.log(`Coverage: ${c.show}: ${c.covered} of ${c.episodes} episodes (${Object.entries(c.methods || {}).map(([k, v]) => `${v} ${k}`).join(', ')}); watched 0`);
    console.log(`::notice title=Study::${report.passed}/${report.total} live checks passed`);
    summary(`**Study assignment (${WHERE}, real network and model):** ${report.passed}/${report.total} live checks passed. ${(report.coverage || []).map((c) => `${c.show}: ${c.covered}/${c.episodes} episode summaries read`).join('; ')}.`);
    if (!report.ok) {
      const what = (report.steps || []).filter((s) => s.status === 'fail').map((s) => s.name).join('; ') || report.error || 'see log';
      console.log(`::error title=Study check failed::${what}`);
      return fail(what);
    }
    if (report.pending?.length) {
      // Wikipedia was down (HTTP 429/5xx), so these checks could not run against it. Reported as pending, never as passed.
      const what = report.pending.join('; ');
      console.log(`::warning title=Study checks pending: Wikipedia unavailable::${what} not verified; Wikipedia answered HTTP 429 or 5xx, which is an outside outage, not a CHE fault. Re-run when Wikipedia answers.`);
      summary(`**PENDING (external):** ${what} — Wikipedia returned HTTP 429/5xx, so these were not verified. Not counted as passed.`);
      return pending(`${report.passed}/${report.total} live checks passed; PENDING external verification: ${what}`);
    }
    return pass(`${report.passed}/${report.total} live checks passed`);
  },

  async social() {
    // Conversational code-switching on the isolated test CHE with the target's real model
    // (social_corrections.js socialProbe): "Chill, chill, I'm by my mama" turns clean language on, it
    // holds for five turns, "you can talk normal again" lifts it, "I'm around kids right now" and a
    // bare "chill chill" after a reply that swore turn it on. Each step checks the stored state and
    // that the reply has no profanity and announces no mode.
    const { body: report, error } = await postProbe('/api/social/probe', { attempts: 3, timeoutMs: 240000 });
    if (!report) {
      console.log(`::error title=Code-switching check did not run::The ${WHERE} did not answer (${error}).`);
      return fail(`did not run (${error})`);
    }
    for (const step of report.steps || []) {
      console.log(`${step.pass ? 'PASS' : step.optional ? 'WARN' : 'FAIL'} ${step.name} [${step.route || '-'} | register=${step.register} | ${step.ms} ms] ${String(step.reply || '').replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    console.log(`::notice title=Code-switching::${report.passed}/${report.total} live checks passed`);
    summary(`**Code-switching (${WHERE}, real model):** ${report.passed}/${report.total} live checks passed on the isolated test CHE.`);
    if (!report.ok) {
      const what = (report.steps || []).filter((s) => !s.pass && !s.optional).map((s) => s.name).join('; ') || report.error || 'see log';
      console.log(`::error title=Code-switching check failed::${what}`);
      return fail(what);
    }
    return pass(`${report.passed}/${report.total} live checks passed`);
  },

  async 'projects-audit'() {
    // Read-only (project_library.js projectAudit): counts only, no title, brief or script.
    if (STAGING) return skip('Counts the owner\'s stored projects; staging has its own empty storage, so the counts would be zeros that prove nothing about the owner\'s data.');
    const res = await fetch(`${BASE}/api/projects/probe/audit`, {
      headers: { 'X-CHE-Memory-Probe': TOKEN }, signal: AbortSignal.timeout(60000),
    }).catch((e) => ({ ok: false, status: String(e) }));
    const a = res.ok ? await res.json() : null;
    if (!a) { console.log(`::warning title=Projects audit::The live Worker did not answer (${res.status}).`); return warn(`no answer (${res.status})`); }
    const r = a.roblox;
    const line = `${a.stored_projects} stored projects as ${a.cards} cards (${a.duplicate_groups} duplicate groups, every copy kept); creative active ${a.creative.active}, paused ${a.creative.paused}, completed ${a.creative.completed}, archived ${a.creative.archived}; AI/code/research ${Object.values(a.ai_code_research).reduce((x, y) => x + y, 0)}. Roblox: ${r.cards} projects from ${r.stored_copies} copies, ${r.with_scripts} with Luau (${r.scripts} scripts), ${r.crew_results}/${r.crew_tasks} crew tasks with results, ${r.playtested} playtested`;
    console.log(`::notice title=Projects audit::${line}`);
    summary(`**Projects audit (owner CHE, counts only):** ${line}.`);
    return pass(line);
  },

  async video() {
    // The live Worker queues a render on the free GitHub renderer with its own token, then checks the
    // finished files itself. Free narration; nothing uploaded.
    if (STAGING) return skip('Opt-in in production (video_check). The Worker dispatches the GitHub renderer with CHE_GITHUB_TOKEN, a production-only secret.');
    const ask = async (body) => {
      const response = await fetch(`${BASE}/api/video/probe`, {
        method: 'POST', headers: bearer({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    // 1. The same secret, from GitHub Actions: statuses, messages and permission headers only.
    const gh = async (url) => {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.CHE_GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CHE-Deploy-Check' } });
      const body = await r.json().catch(() => ({}));
      return { http: r.status, message: String(body.message || '').slice(0, 160), login: body.login, state: body.state,
        accepted: r.headers.get('x-accepted-github-permissions') || '', expires: r.headers.get('github-authentication-token-expiration') || '' };
    };
    const actionsSide = {
      repository: await gh('https://api.github.com/repos/Vondada/chey-app'),
      user: await gh('https://api.github.com/user'),
      workflow: await gh('https://api.github.com/repos/Vondada/chey-app/actions/workflows/che-video-render.yml'),
    };
    console.log(`actions side: ${JSON.stringify(actionsSide)}`);
    // 2. The live Worker's own view of its credential (read-only).
    const workerSide = await ask({ diagnose: true });
    console.log(`worker side: ${JSON.stringify(workerSide)}`);
    const workerExpires = workerSide.token_expires || '';
    const actionsExpires = actionsSide.repository.expires || actionsSide.user.expires || '';
    const same = workerExpires && actionsExpires ? workerExpires === actionsExpires : null;
    console.log(`same credential on both sides (by GitHub's expiry date): ${same === null ? 'unknown' : same}`);
    summary(`**Video credential:** Actions repo HTTP ${actionsSide.repository.http}, workflow ${actionsSide.workflow.state || actionsSide.workflow.http}; Worker: ${workerSide.verdict}${same === false ? ' (the Worker has a DIFFERENT token than the Actions secret)' : ''}.`);
    // 3. The owner's own request, through the live Worker.
    const message = 'Create a 15-second faceless YouTube Short about black holes, including narration, attractive thumbnail, title, and real MP4.';
    const started = await ask({ message });
    console.log(`start: ${JSON.stringify(started)}`);
    if (started.stage !== 'queued' || !started.task_id) {
      console.log(`::error title=Video check: not queued::${started.detail || started.code || 'no task'}`);
      return fail(`not queued: ${started.detail || started.code || 'no task'}`);
    }
    if (started.topic !== 'black holes' || started.seconds !== 15) {
      console.log(`::error title=Video check: wrong request::topic "${started.topic}", ${started.seconds} s`);
      return fail(`wrong request: topic "${started.topic}", ${started.seconds} s`);
    }
    // 4. Asking again is the same job, never a second render.
    const again = await ask({ message, reuse: true });
    if (again.task_id !== started.task_id) {
      console.log(`::error title=Video check: duplicate job::${again.task_id} after ${started.task_id}`);
      return fail(`duplicate job ${again.task_id} after ${started.task_id}`);
    }
    let last = started;
    const until = Date.now() + 20 * 60_000;
    while (Date.now() < until) {
      await sleep(20000);
      try { last = await ask({ task_id: started.task_id }); } catch (error) { console.log(`poll: ${error.message}`); continue; }
      console.log(`poll: ${last.stage}${last.run_id ? ` (run ${last.run_id})` : ''}`);
      if (!['queued', 'running', 'checking'].includes(last.stage)) break;
    }
    console.log(`result: ${JSON.stringify(last)}`);
    if (last.stage !== 'complete') {
      console.log(`::error title=Video check: ${last.stage}::${last.detail || 'no verified video'}`);
      return fail(`${last.stage}: ${last.detail || 'no verified video'}`);
    }
    // 5. The files as the phone gets them: a playable MP4 with sound, the thumbnail and a title.
    const problems = [
      !(last.retrieved && last.retrieved.playable) && 'the stored MP4 could not be read back as playable',
      !(last.retrieved && last.retrieved.thumbnail_bytes > 0) && 'the thumbnail could not be read back',
      last.audio_codec !== 'aac' && 'no narration audio track',
      !String(last.title || '').trim() && 'no title',
      last.paid_media !== false && 'paid media was used',
      last.youtube_uploaded !== false && 'something was uploaded',
    ].filter(Boolean);
    if (problems.length) {
      console.log(`::error title=Video check: files::${problems.join('; ')}`);
      return fail(problems.join('; '));
    }
    const line = `task ${last.task_id}, run ${last.github_run_id}, "${last.title}", ${last.duration_seconds} s, ${last.video_bytes} bytes ${last.video_codec}/${last.audio_codec}, ${last.width}x${last.height}, read back ${last.retrieved.video_bytes} bytes (${last.retrieved.seconds} s) + thumbnail ${last.retrieved.thumbnail_bytes} bytes, voice ${last.voice_provider}, paid ${last.paid_media}, uploaded ${last.youtube_uploaded}`;
    console.log(`::notice title=Video check passed::${line}`);
    summary(`**Free video (live Worker):** ${line}.`);
    return pass(line);
  },

  async rea() {
    // Real investigations on the live Worker, recorded in the owner's REA log. Read-only, except the
    // one owner-authorized build test (draft PR, never merged).
    if (STAGING) return skip('Opt-in in production (rea_check). It records investigations in the owner\'s REA log and compares against CHE\'s repository with CHE_GITHUB_TOKEN, a production-only secret.');
    const ask = async (message, extra = {}) => {
      const response = await fetch(`${BASE}/api/rea/probe`, {
        method: 'POST', headers: bearer({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message, ...extra }), signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    const failures = [];
    const check = (ok, what) => { summary(`- ${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
    // Replies quote the target's own text, so "::" is broken up: no line can act as a workflow command.
    const plain = (text) => String(text).replace(/::/g, ': :');
    const show = (title, text) => { summary(`\n<details><summary>${title}</summary>\n\n\`\`\`\n${String(text).slice(0, 6000)}\n\`\`\`\n</details>\n`); console.log(`::group::${plain(title)}\n${plain(String(text).slice(0, 4000))}\n::endgroup::`); };
    const repo = String(process.env.REA_REPO || '').trim();
    const site = String(process.env.REA_SITE || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^https:\/\/[^\s]+$/.test(site)) return fail('rea_repo must be owner/name and rea_site an https link.');
    const feature = String(process.env.REA_FEATURE || '').replace(/[^\w -]/g, '').slice(0, 30);
    summary('### REA acceptance (live Worker)');

    const caps = await ask('REA capabilities');
    check(/Public GitHub repositories[^\n]*: available/.test(caps.text) && /Native binaries \(Ghidra\): not available/.test(caps.text), 'capabilities state what REA can and cannot analyze');

    // B. Public source investigation with real citations at the exact commit.
    const b = await ask(`CHE, investigate https://github.com/${repo} and how its ${feature} feature works.`);
    show(`B. ${repo}`, b.text);
    const inv = b.investigation || {};
    const sha = String(inv.target?.version || '');
    console.log(plain(`B features (${(inv.features || []).length}): ${(inv.features || []).map((f) => f.name).join(', ')}`));
    check(b.ok && /^[0-9a-f]{40}$/.test(sha), `B: ${repo} read at an exact commit (${sha.slice(0, 12)})`);
    const cites = (inv.features || []).flatMap((f) => f.evidence || []).filter((e) => e.url);
    check((inv.features || []).length >= 3 && cites.length >= 3 && cites.every((e) => e.url.startsWith(`https://github.com/${repo}/blob/${sha}/`) || !e.url.includes('github.com')), `B: ${(inv.features || []).length} features, every source citation pinned to that commit`);
    check((inv.features || []).some((f) => (f.evidence || []).some((e) => /#L\d+$/.test(e.url) && new RegExp(feature, 'i').test(`${f.name} ${e.label}`))), `B: the ${feature} feature is cited by file and line`);
    check((inv.architecture || []).some((a) => a.label === 'Licence') && (inv.architecture || []).some((a) => a.label === 'Navigation'), 'B: licence and navigation reported (observed or unknown)');

    // D. Comparison against CHE's live repository.
    const d = await ask(`REA compare: ${b.investigation_id}`);
    show('D. Compared with CHE', d.text);
    const c = d.investigation?.comparison || {};
    check(c.ok === true && /^[0-9a-f]{40}$/.test(String(c.sha || '')), `D: compared with CHE's repository at ${String(c.sha || '').slice(0, 12)}`);
    const total = (c.has || 0) + (c.partial || 0) + (c.missing || 0) + (c.unknown || 0);
    check(total === (d.investigation?.features || []).length, `D: every feature classified (has ${c.has}, partial ${c.partial}, missing ${c.missing}, unknown ${c.unknown})`);
    check((d.investigation?.features || []).filter((f) => f.che?.status === 'has').every((f) => (f.che.evidence || []).some((e) => e.url.includes(`Vondada/chey-app/blob/${c.sha}/`))), 'D: every "CHE has it" names a CHE file at that commit');

    // C. A public web page, plus the isolated browser run.
    const cw = await ask(`Investigate ${site} and tell me how its interface and features work.`);
    show(`C. ${site}`, cw.text);
    const web = cw.investigation || {};
    check((cw.ok && (web.features || []).length >= 2) || web.state === 'limited', `C: ${site} ${web.state === 'limited' ? 'refused honestly' : `mapped with ${(web.features || []).length} features`}`);
    let shots = web.screenshots || [];
    console.log(plain(`C state: ${web.state}; browser: ${JSON.stringify(web.browser || null)}; limitations: ${(web.limitations || []).join(' | ')}`));
    // Wait for screenshots only while a browser run was really started.
    for (let i = 0; i < 16 && cw.ok && web.browser?.state === 'queued' && !shots.length; i++) {
      await sleep(30000);
      const again = await ask(`REA features: ${cw.investigation_id}`);
      shots = again.investigation?.screenshots || [];
      if (/Browser run: /.test((again.investigation?.limitations || []).join(' '))) break;
    }
    check(!cw.ok || shots.length >= 1, `C: isolated browser run published ${shots.length} real screenshots`);

    // G. An app CHE cannot reach.
    const g = await ask('CHE, analyze the private iOS app Chase Mobile internals and tell me how it works.');
    show('G. Private iOS app', g.text);
    check(g.investigation?.state === 'limited' && /does not decrypt/.test(g.text) && /I did not claim anything about its internals/.test(g.text), 'G: honest limits, no claimed internals, alternatives offered');

    // E. Only when the owner named a feature for the one authorized test build.
    const pick = String(process.env.REA_BUILD_FEATURE || '').trim();
    if (/^f\d{1,2}$/.test(pick)) {
      const e = await ask(`REA build: ${b.investigation_id} ${pick}`, { allow_build: true });
      show('E. Build (draft PR, not merged)', e.text);
      check(Boolean(e.build_job_id) && /draft pull request/.test(e.text), `E: coding job ${String(e.build_job_id).slice(0, 8)} started for ${pick}`);
    }
    const v = await ask(`REA verify: ${b.investigation_id}`);
    show('Verify', v.text);
    if (failures.length) { console.log(failures.join('\n')); return fail(failures.join('; ')); }
    return pass('all REA checks passed');
  },
};

// The production deploy's order. The staging gate runs all of it; production runs one per step.
export const SUITE = ['health', 'engines', 'sidestore', 'mary-settings', 'fish-settings', 'voice', 'trading', 'trading-audit',
  'memory', 'history', 'creation', 'creation-viewport', 'character-accept', 'commands', 'atlas', 'arithmetic', 'privacy', 'social', 'study', 'projects-audit', 'video', 'rea', 'fish-measure'];

async function runOne(name) {
  if (PRODUCTION_STEPS[name]) {
    return STAGING ? skip(PRODUCTION_STEPS[name]) : fail(`${name} runs as its own step in che-worker-deploy.yml, not through this script.`);
  }
  const probe = PROBES[name];
  if (!probe) return fail(`Unknown probe "${name}". Known: ${SUITE.join(', ')}`);
  try {
    return await probe();
  } catch (error) {
    return fail(`threw: ${String(error?.message || error).slice(0, 300)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const names = args.includes('--suite') ? SUITE : args;
  if (!names.length) { console.error(`usage: che_live_probes.mjs <probe>... | --suite\nprobes: ${SUITE.join(', ')}`); process.exit(2); }
  // An https Worker origin, or a local `wrangler dev` for trying the probes on a laptop.
  if (!/^(https:\/\/[\w.-]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(BASE)) { console.error('CHE_LIVE_BASE must be an https origin.'); process.exit(2); }
  if (TOKEN) console.log(`::add-mask::${TOKEN}`);
  const results = [];
  for (const name of names) {
    if (names.length > 1) console.log(`::group::${name}`);
    const result = await runOne(name);
    if (names.length > 1) console.log('::endgroup::');
    results.push({ name, ...result });
    const line = `${result.status.toUpperCase()} ${name}${result.detail ? `: ${result.detail}` : ''}`;
    console.log(line);
    if (result.status === 'skip') console.log(`::notice title=Skipped on ${TARGET}: ${name}::${result.detail}`);
    if (result.status === 'fail') console.log(`::error title=Live probe failed: ${name}::${String(result.detail).slice(0, 400)}`);
  }
  if (names.length > 1) {
    const count = (s) => results.filter((r) => r.status === s).length;
    summary('');
    summary(`### Live probes on the ${WHERE} (${BASE})`);
    summary(`${count('pass')} passed, ${count('warn')} warned, ${count('pending')} pending external, ${count('skip')} skipped, ${count('fail')} failed.`);
    summary('');
    summary('| Probe | Result | Detail |');
    summary('|---|---|---|');
    for (const r of results) summary(`| ${r.name} | ${r.status === 'fail' ? '**FAIL**' : r.status === 'pending' ? 'PENDING (external)' : r.status} | ${String(r.detail || '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 300)} |`);
  }
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}

main();
