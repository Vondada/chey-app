// CHE AI layer service: the owner-facing surface of the universal provider
// layer — overview for the app, voice intents, routing snapshot, and the
// Model Watcher hook. Every consequential permission change is confirmed
// aloud before it happens and reported honestly after.

import { callSpecificModel } from './ai_router.js';
import { providerLabel } from './capability_router.js';
import {
  applyEvaluation, evaluateCandidate, newestModel, runModelWatcher,
} from './model_discovery.js';
import {
  createProviderEmployee, providerFrom, specialtyFrom, startPairedJob,
} from './office_workforce.js';
import { handoffAgentTask } from './agent_runtime.js';
import { DATA_CLASSES, allowedDataClasses, setProviderPermission } from './privacy_policy.js';
import {
  accountsView, ensureAiState, healthSummary, manifestById, providerConnection, registryView,
} from './provider_registry.js';

async function stored(storage, key) {
  if (!storage?.get) return null;
  try { return await storage.get(key); } catch (_) { return null; }
}

// Router snapshot: owner policy + promoted models only. Stored beside usage
// data so the router can read it without the full owner record.
export async function syncRoutingSnapshot(storage, data) {
  if (!storage?.put) return;
  const ai = ensureAiState(data);
  const catalog = {};
  for (const [provider, entry] of Object.entries(ai.catalog)) {
    const promoted = (entry.models || []).filter((m) => m.status === 'active' && m.promoted_at);
    if (promoted.length) catalog[provider] = promoted.slice(-12);
  }
  await storage.put('ai_routing', {
    policy: {
      local_only: Boolean(ai.policy.local_only),
      prefer_strongest: Boolean(ai.policy.prefer_strongest),
      max_cost_class: ai.policy.max_cost_class,
      preferred_provider: ai.policy.preferred_provider || '',
    },
    catalog,
    updated_at: new Date().toISOString(),
  });
}

export function privacyPermissionsMap(data) {
  const ai = ensureAiState(data);
  return Object.fromEntries(Object.entries(ai.privacy).map(([id, value]) => [id, value?.allowed || []]));
}

export async function aiOverview(env, data, storage) {
  const ai = ensureAiState(data);
  const health = (await stored(storage, 'ai_health')) || {};
  ai.health = health;
  const audit = (await stored(storage, 'ai_audit')) || [];
  const providers = registryView(env, data);
  const models = Object.entries(ai.catalog).flatMap(([provider, entry]) => (entry.models || [])
    .filter((m) => m.status === 'active')
    .map((m) => ({ provider, model: m.model, capabilities: m.capabilities, promoted: Boolean(m.promoted_at), trial: Boolean(m.trial_until && m.trial_until > Date.now()) })))
    .slice(0, 150);
  return {
    providers,
    accounts: accountsView(env, data),
    models,
    candidates: ai.candidates.slice(0, 30),
    evaluations: ai.evaluations.slice(0, 20),
    pending_provider_plugins: ai.pending_provider_plugins.map((p) => ({ id: p.id, provider: p.manifest.id, name: p.manifest.name, review: p.review })),
    office_workers: (data.team || []).filter((a) => !a.retired).map((a) => ({
      id: a.id, name: a.name, role: a.role, provider: a.provider_preference || 'auto', model: a.model_preference || 'auto', temporary: Boolean(a.temporary), status: a.runtime_status || 'idle',
    })),
    health: Object.fromEntries(Object.entries(health).map(([id, h]) => [id, healthSummary(h)])),
    policy: ai.policy,
    privacy: Object.fromEntries(providers.map((p) => [p.id, allowedDataClasses(data, p.id)])),
    data_classes: DATA_CLASSES,
    last_calls: audit.slice(0, 10),
    notices: ai.notices.slice(0, 10),
    watcher: { last_run_at: ai.watcher.last_run_at || null, last_result: ai.watcher.last_result || null },
    memory_candidates: (data.memory_candidates || []).slice(0, 10).map((m) => ({ id: m.id, text: m.text, data_class: m.data_class, source_provider: m.source_provider })),
    secrets_exposed: false,
  };
}

// Runs the watcher and evaluates candidates by calling them directly.
export async function watchModels(env, data, storage, { force = false, fetcher = fetch } = {}) {
  const ask = async (candidate, prompt) => {
    const out = await callSpecificModel(env, candidate.provider, candidate.model,
      [{ role: 'user', content: prompt }], { maxTokens: 120, fetcher });
    return out.response;
  };
  const result = await runModelWatcher(env, data, { fetcher, ask, force });
  await syncRoutingSnapshot(storage, data);
  return result;
}

export async function evaluateOne(env, data, storage, key, fetcher = fetch) {
  const ai = ensureAiState(data);
  const candidate = ai.candidates.find((c) => c.key === key);
  if (!candidate) return { error: 'Candidate not found.' };
  const evaluation = await evaluateCandidate(candidate, async (c, prompt) => (
    await callSpecificModel(env, c.provider, c.model, [{ role: 'user', content: prompt }], { maxTokens: 120, fetcher })
  ).response);
  const applied = applyEvaluation(env, data, evaluation);
  await syncRoutingSnapshot(storage, data);
  return { evaluation, ...applied };
}

// ─── Voice intents ─────────────────────────────────────────────────────────

const CLASS_WORDS = [
  ['personal', /personal|memor|about me|my info/],
  ['private', /private/],
  ['financial', /financ|money|bank/],
  ['messages', /messages|texts/],
  ['email', /email/],
  ['photos', /photo|picture/],
  ['location', /location|where i live|address/],
  ['device_data', /device/],
];

function classesIn(text) {
  const found = CLASS_WORDS.filter(([, re]) => re.test(text)).map(([cls]) => cls);
  return found.length ? found : ['personal'];
}

function lastUserText(history = []) {
  const prior = [...history].reverse().find((item) => item?.role === 'user' && String(item.content || item.text || '').trim());
  return String(prior?.content || prior?.text || '').trim();
}

function spokenList(items) {
  if (!items.length) return '';
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

// Returns null when the message is not an AI-layer command. Otherwise
// { reply, changed, meta } where `changed` means `data` must be saved.
export async function handleAiVoiceIntent(env, data, storage, message, history = []) {
  const text = String(message || '').toLowerCase().replace(/^(?:chay|chey|che)[, ]+/, '').replace(/[.!?]+$/, '').trim();
  const ai = ensureAiState(data);

  // Confirmation of a pending consequential change.
  if (ai.pending_confirmation) {
    const pending = ai.pending_confirmation;
    const expired = Date.now() - Date.parse(pending.at) > 5 * 60 * 1000;
    if (!expired && /^(?:yes|yeah|yep|confirm|confirmed|do it|go ahead|approved?)\b/.test(text)) {
      ai.pending_confirmation = null;
      if (pending.kind === 'privacy') {
        const outcome = setProviderPermission(data, pending.provider, { allow: pending.allow || [], deny: pending.deny || [] }, true);
        if (outcome.error) return { reply: `That didn't go through, sir: ${outcome.error}`, changed: true };
        return {
          reply: `Done, sir. ${providerLabel(pending.provider)} can now receive: ${outcome.allowed.join(', ') || 'public context only'}. ${pending.deny?.length ? `It will no longer get ${pending.deny.join(', ')} data.` : ''}`.trim(),
          changed: true,
          meta: { source: 'ai_privacy', provider: pending.provider, allowed: outcome.allowed },
        };
      }
      if (pending.kind === 'local_only') {
        ai.policy.local_only = pending.value;
        await syncRoutingSnapshot(storage, data);
        return { reply: pending.value ? 'Local-only mode is on, sir. Nothing leaves your own machine until you turn it off.' : 'Local-only mode is off, sir. I\'m back to routing across your connected providers.', changed: true, meta: { source: 'ai_policy', local_only: pending.value } };
      }
    }
    if (!expired && /^(?:no|nope|cancel|never ?mind|don't)\b/.test(text)) {
      ai.pending_confirmation = null;
      return { reply: 'Cancelled, sir. Nothing changed.', changed: true };
    }
    if (expired) ai.pending_confirmation = null;
  }

  // "What AI models do you have?"
  if (/\b(?:what|which)\b[\s\S]{0,20}\b(?:ai|models?|engines?|providers?)\b[\s\S]{0,30}\b(?:do you have|have you got|are connected|can you use|available)\b/.test(text)) {
    const connected = registryView(env, data).filter((p) => p.state === 'connected');
    const waiting = registryView(env, data).filter((p) => p.state !== 'connected').map((p) => p.name);
    const lines = connected.map((p) => `${p.name}${p.models ? `, ${p.models} models` : ''}${p.locality === 'local' ? ', local' : ''}`);
    return {
      reply: connected.length
        ? `I have ${connected.length} AI providers connected, sir:\n${spokenList(lines)}${waiting.length ? `\nAvailable to connect: ${waiting.slice(0, 6).join(', ')}.` : ''}`
        : 'No AI providers are connected beyond my built-in engines yet, sir.',
      meta: { source: 'ai_registry' },
    };
  }

  // "Which one handled my last question?"
  if (/\b(?:which|what)\b[\s\S]{0,25}\b(?:model|ai|engine|provider|one)\b[\s\S]{0,20}\b(?:handled|answered|did|responded to)\b[\s\S]{0,20}\b(?:last|previous)\b/.test(text)) {
    const audit = (await stored(storage, 'ai_audit')) || [];
    const last = audit.find((entry) => entry.route === 'owner_chat');
    return {
      reply: last
        ? `${providerLabel(last.provider)} answered your last question, sir, using ${last.model}. ${last.memory_categories?.length ? `I shared ${last.memory_categories.join(', ')} context with it.` : 'No personal memory was shared with it.'}`
        : 'I don\'t have a record of the last question\'s engine yet, sir.',
      meta: { source: 'ai_audit' },
    };
  }

  // "What's the newest model you found?"
  if (/\b(?:newest|latest|new)\b[\s\S]{0,15}\bmodels?\b[\s\S]{0,20}\b(?:found|discover|detect|see|have)\b/.test(text)) {
    const newest = newestModel(data);
    const candidate = newest && ai.candidates.find((c) => c.key === `${newest.provider}:${newest.model}`);
    return {
      reply: newest
        ? `The newest model I've found is ${newest.model} from ${providerLabel(newest.provider)}, sir. ${candidate ? `Status: ${candidate.status.replace('_', ' ')}.` : 'It\'s in normal routing.'}`
        : 'I haven\'t scanned any provider catalogs yet, sir. Connected providers get checked twice a day.',
      meta: { source: 'model_watcher' },
    };
  }

  // "Don't send my personal memories to Gemini." (consequential → confirm)
  const deny = /\b(?:don'?t|do not|never|stop)\b[\s\S]{0,15}\b(?:send|share|give)\b([\s\S]{0,60})\bto\b\s+([a-z. ]{3,30})$/.exec(text);
  const allow = /\b(?:allow|let)\b\s+([a-z. ]{3,30}?)\s+(?:to\s+)?(?:see|receive|get|use)\b([\s\S]{0,60})$/.exec(text);
  if (deny || allow) {
    const provider = providerFrom(deny ? deny[2] : allow[1]);
    const manifest = provider && manifestById(data, provider);
    if (!manifest) return { reply: 'Which provider do you mean, sir? For example Gemini, GPT, Grok, Claude, Llama or local.', meta: { source: 'ai_privacy' } };
    const classes = classesIn(deny ? deny[1] : allow[2]);
    ai.pending_confirmation = {
      kind: 'privacy', provider, deny: deny ? classes : [], allow: allow ? classes : [], at: new Date().toISOString(),
    };
    return {
      reply: deny
        ? `To confirm, sir: stop sending your ${classes.join(' and ')} data to ${manifest.name}? Say yes to confirm or no to cancel.`
        : `To confirm, sir: allow ${manifest.name} to receive your ${classes.join(' and ')} data? Say yes to confirm or no to cancel.`,
      changed: true,
      meta: { source: 'ai_privacy', confirmation_required: true },
    };
  }

  // "Use only local AI for this" / "turn off local only"
  if (/\b(?:only|just)\b[\s\S]{0,10}\b(?:local|on[- ]device|offline)\b[\s\S]{0,10}\b(?:ai|models?)?\b|\blocal[- ]only\b/.test(text) && !/\b(?:off|stop|disable)\b/.test(text)) {
    const manifest = manifestById(data, 'ollama');
    if (providerConnection(env, data, manifest).state !== 'connected') {
      return { reply: `I can't switch to local-only yet, sir: no local model is connected. ${manifest.connect_hint}`, meta: { source: 'ai_policy', local_only: false } };
    }
    ai.pending_confirmation = { kind: 'local_only', value: true, at: new Date().toISOString() };
    return { reply: 'To confirm, sir: use only your local AI, so nothing goes to cloud providers? Say yes to confirm.', changed: true, meta: { source: 'ai_policy', confirmation_required: true } };
  }
  if (/\b(?:turn off|stop|disable|end)\b[\s\S]{0,10}\blocal[- ]only\b/.test(text)) {
    ai.pending_confirmation = { kind: 'local_only', value: false, at: new Date().toISOString() };
    return { reply: 'To confirm, sir: turn off local-only mode and use cloud providers again? Say yes to confirm.', changed: true, meta: { source: 'ai_policy', confirmation_required: true } };
  }

  // "Use the strongest model available"
  if (/\b(?:use|switch to)\b[\s\S]{0,10}\b(?:the )?(?:strongest|smartest|best|most powerful)\b[\s\S]{0,15}\b(?:model|ai|engine)\b/.test(text)) {
    ai.policy.prefer_strongest = true;
    await syncRoutingSnapshot(storage, data);
    return { reply: 'Done, sir. I\'ll route your questions to the strongest healthy model available. Say "use normal routing" to go back.', changed: true, meta: { source: 'ai_policy', prefer_strongest: true } };
  }
  if (/\b(?:use )?normal routing\b|\bstop using the strongest\b/.test(text)) {
    ai.policy.prefer_strongest = false;
    await syncRoutingSnapshot(storage, data);
    return { reply: 'Back to normal routing, sir: fast engines for quick things, strong ones for hard work.', changed: true, meta: { source: 'ai_policy', prefer_strongest: false } };
  }

  // "Make a Grok coding employee"
  const hire = /\b(?:make|create|hire|add|spin up|staff)\b\s+(?:me\s+)?(?:a|an)?\s*([a-z. ]{3,40}?)\s+(?:employee|worker|agent|specialist|researcher|coder|engineer)\b/.exec(text);
  if (hire && providerFrom(hire[1])) {
    const provider = providerFrom(hire[1]);
    const made = createProviderEmployee(env, data, { provider, specialty: specialtyFrom(`${hire[1]} ${text}`), temporary: /\btemporar/.test(text) });
    if (made.error) return { reply: `${made.error}`, meta: { source: 'office', provider } };
    return {
      reply: made.existing
        ? `${made.agent.name}, your ${made.agent.role}, is already on the Office team, sir.`
        : `Done, sir. ${made.agent.name} joined the Office as your ${made.agent.role}. They work for CHE, using ${providerLabel(provider)} as their engine.`,
      changed: !made.existing,
      meta: { source: 'office', agent_id: made.agent.id },
    };
  }

  // "Use Grok and GPT together on this."
  const together = /\buse\b\s+([a-z. ]{2,20})\s+and\s+([a-z. ]{2,20})\s+(?:together|both)\b/.exec(text);
  if (together) {
    const families = [providerFrom(together[1]), providerFrom(together[2])].filter(Boolean);
    const objective = /\bon (?:this|that|it)\b/.test(text) || text.split(' ').length < 9 ? lastUserText(history) : message;
    if (!objective) return { reply: 'What should they work on together, sir?', meta: { source: 'paired' } };
    const started = startPairedJob(env, data, { objective, families });
    if (started.error) {
      return { reply: `${started.error} ${started.missing?.length ? `Not connected: ${started.missing.map(providerLabel).join(', ')}.` : ''}`.trim(), meta: { source: 'paired' } };
    }
    return {
      reply: `On it, sir. ${families.map(providerLabel).join(' and ')} are working it independently in the War Room, they'll cross-check each other, and I'll give you one answer.`,
      changed: true,
      meta: { source: 'paired', meeting_id: started.meeting.id },
    };
  }

  // "Move this task from GPT to Grok."
  const move = /\b(?:move|hand|switch|transfer)\b\s+(?:this|that|the)?\s*(?:task|job|work)?\s*(?:from\s+([a-z. ]{2,20}?)\s+)?to\s+([a-z. ]{2,20})$/.exec(text);
  if (move && providerFrom(move[2])) {
    const target = providerFrom(move[2]);
    const from = move[1] ? providerFrom(move[1]) : '';
    const open = (data.team_tasks || []).filter((task) => ['queued', 'running', 'reviewing'].includes(task.status));
    const active = open.find((task) => from && data.team.find((a) => a.id === task.partner_id)?.provider_preference === from) || open[0];
    if (!active) return { reply: 'There\'s no active Office task to move right now, sir.', meta: { source: 'office' } };
    const current = data.team.find((a) => a.id === active.partner_id);
    const hired = createProviderEmployee(env, data, { provider: target, specialty: specialtyFrom(current?.role || active.task), temporary: true });
    if (hired.error) return { reply: hired.error, meta: { source: 'office' } };
    const outcome = handoffAgentTask(data, active.id, hired.agent.id, `Owner moved this task to ${providerLabel(target)}.`);
    if (outcome.error) return { reply: `I couldn't move it, sir: ${outcome.error}`, changed: true };
    return {
      reply: `Moved, sir. ${hired.agent.name}, a ${hired.agent.role}, now has "${active.task.slice(0, 60)}" with all the prior work, steering and context carried over.`,
      changed: true,
      meta: { source: 'office', task_id: active.id, to_agent_id: hired.agent.id },
    };
  }

  return null;
}
