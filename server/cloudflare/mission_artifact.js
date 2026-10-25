// The verified result of a finished mission (a Command Center workflow run on the objective graph).
//
// When every step of a `command_workflow` objective is complete, CHE writes one Markdown report built only from
// the steps' recorded outputs, stores it in her own blob store (che_blob_store.js, Durable Object storage), reads it
// back, and keeps its SHA-256 on the objective and in the receipt log. Nothing here calls a model, the network or a
// paid service, and nothing is deleted.
//
// The report is deterministic: it holds the mission's id, name, start time and each step's command, input, verifier
// and output, never the time it was sealed. So a crash between writing the file and saving the objective re-seals
// the same bytes with the same hash on the next pass (the receipt is keyed by mission id, so it is written once).

import { getBlob, putBlob } from './che_blob_store.js';
import { recordReceipt } from './truth_layer.js';

export const MISSION_ARTIFACT_TYPE = 'text/markdown; charset=utf-8';
const MAX_STEP_OUTPUT = 30000;

export const missionArtifactKey = (objectiveId) => `mission:${String(objectiveId || '').replace(/[^\w.-]/g, '_').slice(0, 80)}.md`;

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when this objective is a finished Command Center run that has no sealed result yet. */
export function needsMissionArtifact(objective) {
  return objective?.source === 'command_workflow' && objective.status === 'complete' && !objective.artifact?.sha256;
}

/** The report text, from the recorded step outputs only. */
export function buildMissionReport(objective) {
  const live = (objective.nodes || []).filter((n) => n.status !== 'cancelled');
  const lines = [
    `# ${objective.workflow_name || objective.objective}`,
    '',
    `Mission ${objective.id}, started ${objective.created_at}. ${live.length} step${live.length === 1 ? '' : 's'}, all completed.`,
    'Every section below is the step\'s own recorded result; nothing was added after the run.',
  ];
  live.forEach((node, i) => {
    lines.push(
      '',
      `## Step ${i + 1}: ${node.command ? `/${node.command}` : node.title}${node.input ? ` (${node.input})` : ''}`,
      '',
      `Verified by: ${node.verification?.by || 'job_runtime'}`,
      '',
      String(node.output || '').slice(0, MAX_STEP_OUTPUT).trim() || '(no output recorded)',
    );
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Seals one finished mission: stores the report, reads it back, checks its hash, records the receipt and sets
 * `objective.artifact`. The caller saves the objective. Returns the artifact or { ok: false, error }.
 */
export async function sealMissionArtifact(storage, objective, now = new Date().toISOString()) {
  if (!needsMissionArtifact(objective)) return objective?.artifact || { ok: false, error: 'Mission is not finished.' };
  const bytes = new TextEncoder().encode(buildMissionReport(objective));
  const sha256 = await sha256Hex(bytes);
  const key = missionArtifactKey(objective.id);
  // A report already stored by an interrupted earlier pass is reused when it is the same bytes, never rewritten.
  const earlier = await getBlob(storage, key);
  if (!earlier || (await sha256Hex(earlier.body)) !== sha256) {
    const stored = await putBlob(storage, key, bytes, { contentType: MISSION_ARTIFACT_TYPE });
    if (!stored.ok) return { ok: false, error: stored.error };
  }
  // The file counts only when what storage gives back has the same hash.
  const back = await getBlob(storage, key);
  const readBack = back ? await sha256Hex(back.body) : '';
  if (readBack !== sha256) return { ok: false, error: 'The stored report did not read back with the same SHA-256.' };
  const receipt = await recordReceipt(storage, {
    kind: 'mission_artifact', key: `mission_artifact:${objective.id}`, objective_id: objective.id,
    name: String(objective.workflow_name || objective.objective).slice(0, 100), blob_key: key, sha256, bytes: bytes.length,
    steps: (objective.nodes || []).filter((n) => n.status === 'complete').map((n) => n.id), at: now,
  });
  objective.artifact = {
    key, sha256, bytes: bytes.length, content_type: MISSION_ARTIFACT_TYPE, created_at: receipt?.at || now,
    verified: true, receipt: `mission_artifact:${objective.id}`,
  };
  return objective.artifact;
}

/** Seals every finished mission in `data` that has none yet. Returns how many were sealed. */
export async function sealFinishedMissions(storage, data, now = new Date().toISOString()) {
  let sealed = 0;
  for (const objective of Array.isArray(data?.objectives) ? data.objectives : []) {
    if (!needsMissionArtifact(objective)) continue;
    const out = await sealMissionArtifact(storage, objective, now).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    if (out?.sha256) sealed += 1;
    else console.error('Mission artifact not sealed:', objective.id, out?.error || 'unknown');
  }
  return sealed;
}

/**
 * Reads a sealed result back and checks it against the recorded hash. `verified` is true only when the bytes in
 * storage hash to the recorded SHA-256 right now.
 */
export async function readMissionArtifact(storage, objective) {
  const artifact = objective?.artifact;
  if (!artifact?.key) return { ok: false, error: 'This mission has no saved result yet.' };
  const blob = await getBlob(storage, artifact.key);
  if (!blob) return { ok: false, error: 'The saved result is missing from storage.', artifact };
  const sha256 = await sha256Hex(blob.body);
  return {
    ok: true, verified: sha256 === artifact.sha256, sha256, recorded_sha256: artifact.sha256, bytes: blob.body.length,
    content_type: blob.contentType || MISSION_ARTIFACT_TYPE, text: new TextDecoder().decode(blob.body), artifact,
  };
}

/** One quiet line for the phone (shown, never spoken automatically). */
export function speakMissionArtifact(artifact) {
  if (!artifact?.sha256) return '';
  return `Result saved and verified: ${artifact.bytes} bytes, SHA-256 ${artifact.sha256.slice(0, 12)}.`;
}
