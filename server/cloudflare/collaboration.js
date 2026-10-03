// Owner → CHE engineering coordination intents and peer collaboration
// packets. Everything here is deterministic: phrases map to real actions
// (mailbox sends, jobs), never to model narration.

import { idempotencyKey } from './recovery_policy.js';
import { normalizePeerName } from './truth_layer.js';

const PEER_WORDS = '(claude|chat\\s?gpt|codex|gemini|grok|copilot|cursor)';

// "Work with Claude", "coordinate with ChatGPT and Claude", "use the other
// AIs", "all of y'all work together".
export function collaborationIntent(message) {
  const text = String(message || '');
  const named = [...text.matchAll(new RegExp(`\\b${PEER_WORDS}\\b`, 'gi'))].map((m) => normalizePeerName(m[1]));
  const withPeer = new RegExp(`\\b(?:work|collaborate|coordinate|team up|pair|partner|sync|check in)\\b[^.?!]{0,30}\\bwith\\b[^.?!]{0,20}\\b${PEER_WORDS}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:get|have|bring in|loop in|include)\\s+${PEER_WORDS}\\b[^.?!]{0,30}\\b(?:help|work|review|involved|on (?:it|this))\\b`, 'i').test(text);
  const everyone = /\b(?:use|ask|bring in|get)\s+(?:the\s+|all\s+(?:the\s+)?)?other\s+ais?\b|\ball\s+of\s+(?:y'?all|you(?:\s+all)?)\s+work\s+together\b|\b(?:y'?all|you all|everyone)\s+work\s+together\b/i.test(text);
  if (!withPeer && !everyone) return null;
  const peers = [...new Set(named.length ? named : ['claude', 'chatgpt'])];
  if (everyone) for (const peer of ['claude', 'chatgpt']) if (!peers.includes(peer)) peers.push(peer);
  return { peers };
}

// "batch this", "do it fast", "work in parallel", "split the work".
export function parallelPreference(message) {
  return /\b(?:batch\s+(?:this|it|the work|them)|do (?:it|this) fast|work(?:ing)? in parallel|in parallel|parallel lanes?|split (?:it|the work|this) up|all at once)\b/i.test(String(message || ''));
}

// Status questions answered from receipts, never from model guesses.
export function statusIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey|shay)[,:]?\s+/i, '');
  if (/^(?:ok(?:ay)?|k|alright|all right|cool|got it)[.!]?$/i.test(text)) return { kind: 'ack' };
  if (/\b(?:tell|let)\s+me\s+(?:know\s+)?when\s+(?:you(?:'re| are)|it(?:'s| is)|everything is)\s+(?:ready|done|finished)\b/i.test(text)) return { kind: 'status' };
  if (/^(?:status|update|progress)\??$/i.test(text)
    || /\b(?:what(?:'s| is)\s+(?:the\s+)?(?:status|progress)|where\s+are\s+(?:we|you)(?:\s+at)?|are\s+you\s+(?:done|ready|finished)|how(?:'s| is)\s+(?:it|the (?:job|work|coding)) going)\b/i.test(text)
    || new RegExp(`\\b(?:did|has|have|is|are)\\s+${PEER_WORDS}\\b[^.?!]{0,25}\\b(?:repl\\w*|answer\\w*|respond\\w*|working|done|finished|help\\w*|said)\\b`, 'i').test(text)
    || new RegExp(`\\bwhat\\s+(?:did|is)\\s+${PEER_WORDS}\\s+(?:say|doing)\\b`, 'i').test(text)) {
    return { kind: 'status' };
  }
  return null;
}

// The independent work lanes CHE runs for a batched request. Lanes that would
// write the same files are never split: implementation stays one lane, run
// by CHE's crew (planners, engineers and reviewers already work in parallel
// pairs); peers work as parallel reviewers/advisors.
export function planParallelLanes(request, peers = []) {
  const lanes = [
    { lane: 'discovery+implementation', owner: 'CHE engineering crew', mode: 'job' },
    { lane: 'independent review (correctness, accessibility, security)', owner: 'CHE reviewers', mode: 'job' },
  ];
  for (const peer of peers) lanes.push({ lane: `peer review/advice`, owner: peer, mode: 'mailbox' });
  return lanes;
}

export function collaborationSessionId(request, peers) {
  return `collab-${idempotencyKey('collab', `${[...peers].sort().join(',')}|${request}`).split(':')[1]}`;
}

// The packet each peer receives: the owner's actual request plus grounded
// context, constraints and the reply format. No secrets.
export function buildCollaborationPacket({ sessionId, request, mainSha, files = [], repos = [], jobId = '', peers = [] }) {
  return [
    `CHE collaboration session ${sessionId}.`,
    `Owner request (verbatim): ${String(request || '').slice(0, 1500)}`,
    mainSha ? `Repository: Vondada/chey-app, main at ${mainSha}.` : 'Repository: Vondada/chey-app (main).',
    files.length ? `Files CHE is inspecting: ${files.slice(0, 12).join(', ')}.` : '',
    repos.length ? `Reference repositories selected by the owner: ${repos.join(', ')} (check licenses before reusing code).` : '',
    jobId ? `CHE's own coding job ${jobId} is running in parallel; CHE leads and will merge findings.` : '',
    peers.length > 1 ? `Also asked: ${peers.join(', ')}.` : '',
    'Constraints: owner approval is required for PRs, merges and deploys; keep voice-first accessibility; never include secrets; do not edit .github/ or signing/secret files.',
    `Please reply in this mailbox with reply_to set to this message, starting with "${sessionId}": findings, a concrete patch or review, and anything CHE should not do.`,
  ].filter(Boolean).join('\n');
}
