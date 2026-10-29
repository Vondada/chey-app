// The owner-authorised blue cube render, run through the Worker's own ledger and the Modal picture path. The deploy's probe
// token (voiceProbeAuthorized) is the only way in, and each call is checked here, before anything is sent:
//   - the render needs the exact confirm phrase, so a stray request can never start a paid job;
//   - no earlier GPU job may still be reserved, and no earlier cube job may exist (a duplicate is refused);
//   - the $5 test budget must cover the worst case of one 256 px render.
// Nothing here raises a cap. A refused start sends nothing to Modal.
import { MODAL_IMAGE_KEY, finishModalImage, startModalImage } from './media.js';
import { modalPictureReply } from './chat_image_provider.js';
import { testBudgetReport, TXT2IMG_WORST_CASE_USD } from './gpu_test_budget.js';

export const CUBE_CONFIRM = 'one-blue-cube-256';
export const CUBE_PROMPT = 'a glowing blue cube';
const CUBE_LABEL = /glowing blue cube/i;

/** The first reason the cube render must not start, or null when it may. Pure apart from reading the ledger. */
export function cubeRefusal(report, body) {
  if (body?.confirm !== CUBE_CONFIRM) return `Send confirm "${CUBE_CONFIRM}" to make the one authorised render.`;
  if (report.reserved_usd > 0) return `An earlier GPU job still holds $${report.reserved_usd.toFixed(6)} in reserve, so nothing new was sent.`;
  if (report.jobs.some((j) => CUBE_LABEL.test(String(j.label || '')) && j.state !== 'released')) return 'A blue cube render was already made or started, so this one is refused as a duplicate.';
  if (report.remaining_usd < TXT2IMG_WORST_CASE_USD) return `The $5 test budget has $${report.remaining_usd.toFixed(6)} left, less than the $${TXT2IMG_WORST_CASE_USD.toFixed(6)} one render may cost, so nothing was sent.`;
  return null;
}

/** Starts the one cube render, or says why it was refused. The Modal answer (or refusal reason) comes back as recorded. */
export async function modalCubeProbe(env, storage, body = {}, fetcher = fetch) {
  const report = await testBudgetReport(storage);
  const refusal = cubeRefusal(report, body);
  if (refusal) return { ok: false, sent: false, refusal, budget: report };
  const started = await startModalImage(env, storage, { prompt: CUBE_PROMPT, width: 256, title: 'Glowing blue cube' }, fetcher);
  return {
    ok: started.status === 202,
    sent: true,
    call_id: started.call_id ?? null,
    status: started.status,
    detail: started.detail ?? null,
    modal_http_status: started.http_status ?? null,
    modal_reason: started.modal_reason ?? null,
    budget_state: started.budget_state ?? null,
    reply: modalPictureReply(started),
    budget: await testBudgetReport(storage),
  };
}

/** Reads the result of one started cube render. A finished picture is saved to the Gallery only after its checks pass. */
export async function modalCubeResult(env, storage, body = {}, fetcher = fetch) {
  const callId = String(body?.call_id || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(callId)) return { status: 400, detail: 'A call id is required.' };
  const records = (await storage.get(MODAL_IMAGE_KEY)) || [];
  if (!records.some((r) => r.call_id === callId && CUBE_LABEL.test(String(r.title || r.prompt || '')))) return { status: 404, detail: 'That call id is not a blue cube render.' };
  const { status, ...rest } = await finishModalImage(env, storage, callId, fetcher);
  return { status, ...rest, budget: await testBudgetReport(storage) };
}
