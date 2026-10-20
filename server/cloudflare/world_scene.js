// CHE Spatial World (owner, 2026-10-20; design: mailbox/briefs/SPATIAL-WORLD.md on che-mailbox).
// A scene is a read-only projection of real records into objects the phone draws: avatars, cards,
// the recommended path. Every object names the record it comes from (`source`) and carries a
// fact-check provenance label; an object with no record is never made. Pure: no writes, no model
// calls, the same input always gives the same scene, and `version` changes only when it does.

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function hash(value) {
  let h = 0x811c9dc5;
  const text = JSON.stringify(value);
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** The meeting's stage as the room shows it. */
export const MEETING_STAGES = Object.freeze({
  gathering: 'The team is gathering at the table.',
  drafting: 'Each agent is drafting their part.',
  cross_check: 'The agents are cross-checking each other.',
  synthesizing: 'CHE is combining the drafts into one plan.',
  complete: 'The meeting is done, with one recommended path.',
  failed: 'The meeting stopped before a plan.',
});

// A post's kind as a card, and what it is worth: every agent line is model output, never a fact.
const CARD = {
  brief: { kind: 'brief', provenance: 'owner_request', label: 'Brief' },
  draft: { kind: 'draft', provenance: 'model_output', label: 'Draft' },
  critique: { kind: 'critique', provenance: 'model_output', label: 'Cross-check' },
};

const PROVENANCE_SPOKEN = {
  owner_request: 'your request',
  model_output: 'an agent\'s output, not verified',
  che_synthesis_unverified: 'CHE\'s synthesis, not verified',
  live: 'live state',
};

/**
 * The Meeting Room for one War Room meeting (agent_runtime.js conveneMeeting). `agents` is the
 * runtime roster (agentView), for each avatar's live status. Returns the scene object.
 */
export function meetingScene(meeting, agents = []) {
  if (!meeting?.id) return null;
  const byId = new Map((agents || []).map((a) => [a.id, a]));
  const board = Array.isArray(meeting.board) ? meeting.board : [];
  const drafts = board.filter((p) => p.kind === 'draft');
  const stage = meeting.status === 'drafting' && !drafts.length ? 'gathering' : (MEETING_STAGES[meeting.status] ? meeting.status : 'drafting');
  const objects = [];
  const edges = [];

  (meeting.participants || []).forEach((p, i) => {
    const live = byId.get(p.agent_id);
    const status = live?.status || 'meeting';
    objects.push({
      id: `agent:${p.agent_id}`, kind: 'avatar', label: `${p.name}, ${p.role}`, name: p.name, role: p.role,
      status, zone: `seat:${i + 1}`, provenance: 'live',
      source: { store: 'agent_runtime.team', id: p.agent_id },
      spoken: `${p.name}, ${p.role}: ${live?.task ? clip(live.task, 80) : status}.`,
      detail: clip(p.responsibility, 300),
    });
  });

  const nameToAgent = new Map((meeting.participants || []).map((p) => [p.name, `agent:${p.agent_id}`]));
  const draftByAuthor = new Map();
  board.forEach((post, index) => {
    const card = CARD[post.kind];
    if (!card) return; // the synthesis is the recommended path below, not a card
    const id = `post:${index}`;
    const author = nameToAgent.get(post.from) || (post.from === 'CHE' ? 'che' : '');
    if (post.kind === 'draft') draftByAuthor.set(post.from, id);
    const target = post.kind === 'critique' && post.to ? draftByAuthor.get(post.to) : '';
    objects.push({
      id, kind: card.kind, label: post.kind === 'critique' && post.to ? `${post.from} → ${post.to}: ${card.label}` : `${post.from}: ${card.label}`,
      status: post.failed ? 'failed' : 'posted', zone: author ? `before:${author}` : 'table', provenance: card.provenance,
      source: { store: 'meeting.board', id: String(index) },
      text: String(post.text || ''), preview: clip(post.text, 140), author: post.from, at: post.at || '',
      spoken: `${post.from}'s ${card.label.toLowerCase()}${post.failed ? ', which failed' : ''}: ${clip(post.text, 160)}`,
    });
    if (author) edges.push({ from: id, to: author, type: 'by' });
    if (target) edges.push({ from: id, to: target, type: 'critiques' });
  });

  // Synthesis results exist only once CHE has written them; each points at the meeting record.
  for (const [field, kind, label] of [['recommendations', 'suggestion', 'Suggestion'], ['decisions', 'decision', 'Decision'], ['conflicts', 'conflict', 'Conflict']]) {
    (Array.isArray(meeting[field]) ? meeting[field] : []).forEach((text, i) => {
      objects.push({
        id: `${kind}:${i}`, kind, label: `${label} ${i + 1}`, status: 'proposed', zone: 'table', provenance: 'che_synthesis_unverified',
        source: { store: `meeting.${field}`, id: String(i) }, text: String(text), preview: clip(text, 140),
        spoken: `${label} ${i + 1}: ${clip(text, 200)}`,
      });
    });
  }
  if (String(meeting.final_plan || '').trim()) {
    objects.push({
      id: 'plan', kind: 'path', label: 'Recommended path', status: 'proposed', zone: 'center', provenance: 'che_synthesis_unverified',
      source: { store: 'meeting.final_plan', id: meeting.id }, text: String(meeting.final_plan), preview: clip(meeting.final_plan, 200),
      spoken: `The recommended path: ${clip(meeting.final_plan, 400)}`,
    });
  }

  const suggestions = objects.filter((o) => o.kind === 'suggestion').length;
  const posted = objects.filter((o) => o.kind === 'draft' || o.kind === 'critique').length;
  const names = (meeting.participants || []).map((p) => p.name);
  const spoken = [
    `${names.length} agent${names.length === 1 ? '' : 's'} at the table${names.length ? `: ${names.join(', ')}` : ''}.`,
    MEETING_STAGES[stage],
    posted ? `${posted} card${posted === 1 ? '' : 's'} on the table.` : '',
    suggestions ? `${suggestions} suggestion${suggestions === 1 ? '' : 's'}.` : '',
    meeting.final_plan ? 'One recommended path, CHE\'s synthesis, not verified.' : '',
    stage === 'failed' && meeting.error ? clip(meeting.error, 160) : '',
  ].filter(Boolean).join(' ');

  const scene = {
    scene: 'meeting', id: meeting.id, title: clip(meeting.objective, 160), objective: String(meeting.objective || ''),
    stage, progress: Number.isFinite(meeting.progress) ? meeting.progress : 0, spoken,
    objects: objects.map((o) => ({ ...o, provenance_spoken: PROVENANCE_SPOKEN[o.provenance] || o.provenance })),
    edges, updated_at: meeting.updated_at || '',
  };
  scene.version = hash([scene.stage, scene.progress, scene.objects.map((o) => [o.id, o.status, o.zone, o.text || ''])]);
  return scene;
}

// "Start a meeting with the team about X", "team meeting on X", "call a meeting about X".
// "War room" stays with the multi-AI panel it already opens.
const MEETING = /^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+|can you\s+|could you\s+|let's\s+|lets\s+)?(?:start|call|hold|have|open|begin|run)\s+(?:a\s+|the\s+)?(?:(?:team\s+)?meeting(?:\s+with\s+(?:the\s+|my\s+)?(?:team|agents|crew|office))?|team\s+meeting)(?:\s+(?:about|on|for|to discuss|to plan)\s+(.+?))?[.?!]*$/i;

/** Parses the spoken command; null when it is not one. `topic` is '' when none was named. */
export function meetingCommand(message) {
  const m = MEETING.exec(String(message || '').trim());
  if (!m) return null;
  return { topic: clip(m[1] || '', 1200) };
}
