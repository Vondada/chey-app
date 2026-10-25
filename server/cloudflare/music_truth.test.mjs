import assert from 'node:assert/strict';
import test from 'node:test';
import { auditEvidenceFrom, auditReply } from './hallucination_auditor.js';

const completion = "Your track is complete! I've generated a high-quality hip hop track with your vocals, beat, and mix. Would you like to hear the track?";
const playback = "I'll play the track for you right now.\n[Short audio clip of a high-energy hip hop beat with a catchy melody and harmonies, followed by a male vocal performance]\nI hope you like it, sir! The track is a fusion of a driving beat and a smooth vocal performance.";

test('the owner recording cannot present a nonexistent song or pretend playback', () => {
  for (const reply of [completion, playback]) {
    const out = auditReply(reply);
    assert.equal(out.outcome, 'blocked');
    assert.doesNotMatch(out.text, /track is complete|generated a high-quality|play the track for you right now|Short audio clip|hope you like|smooth vocal/);
    assert.match(out.text, /confirmed|verified/);
  }
});

test('music plans, lyrics, questions and requested fiction stay text', () => {
  for (const reply of [
    'Here is a production brief: hip hop, 140 BPM, male vocals, two minutes.',
    'I created a track outline and a music production brief.',
    '[Verse 1]\nI walk through Marrero with the sun on my face.',
    'Would you like me to create a song?',
    'I have not generated or played a track.',
    'If I generated a track, it would have male vocals.',
  ]) assert.equal(auditReply(reply).text, reply, reply);
  assert.equal(auditReply(playback, { fiction: true }).text, playback);
});

test('hedges and unrelated negative words cannot license invented audio actions', () => {
  for (const reply of ['I think your track is complete.', 'I generated a track with no background noise.', "I'm playing your song now.", 'Here is your finished song.']) {
    assert.equal(auditReply(reply).outcome, 'blocked', reply);
  }
});

test('a generated audio file never proves that playback started', () => {
  const file = { id: 'audio:track-1', media_id: 'track-1', generated: true, file_verified: true, playable: true, bytes: 512, sha256: 'a'.repeat(64) };
  assert.equal(auditReply('Your track is complete.', { evidence: { audio_files: [file] } }).outcome, 'pass');
  for (const unverified of [{ ...file, file_verified: false }, { ...file, generated: false }, { ...file, bytes: 0 }]) {
    assert.equal(auditReply('Your track is complete.', { evidence: { audio_files: [unverified] } }).outcome, 'blocked');
  }
  assert.equal(auditReply("I'll play the track for you right now.", { evidence: { audio_files: [file] } }).outcome, 'blocked');
  assert.equal(auditReply('[Short audio clip of a hip hop beat]', { evidence: { audio_files: [file] } }).outcome, 'blocked');
});

test('model prose, a queued job and a generic execution receipt are not audio files', async () => {
  const store = { get: async () => [
    { kind: 'audio_render', at: new Date().toISOString(), status: 'complete', playable: true },
    { kind: 'audio_verified', at: new Date().toISOString(), media_id: 'missing', generated: true, bytes: 0, sha256: '', file_verified: false, playable: false },
  ] };
  const evidence = await auditEvidenceFrom(store, { executions: [{ status: 'success', invocation_id: 'unrelated' }] });
  assert.equal(auditReply(completion, { evidence }).outcome, 'blocked');
});

test('audio proof is scoped to this request, and playing needs an acknowledgement for that file', async () => {
  const at = new Date().toISOString();
  const receipts = [
    { kind: 'audio_verified', at, request_id: 'req-song', media_id: 'track-1', generated: true, file_verified: true, playable: true, bytes: 512, sha256: 'a'.repeat(64) },
    { kind: 'audio_playback', at, request_id: 'req-song', media_id: 'track-1', confirmed: true, state: 'playing' },
  ];
  const storage = { get: async () => receipts };
  const same = await auditEvidenceFrom(storage, { requestId: 'req-song' });
  assert.equal(auditReply('Your track is complete.', { evidence: same }).outcome, 'pass');
  assert.equal(auditReply('Your track is playing.', { evidence: same }).outcome, 'pass');
  const unrelated = await auditEvidenceFrom(storage, { requestId: 'req-other' });
  assert.equal(auditReply('Your track is complete.', { evidence: unrelated }).outcome, 'blocked');
  assert.equal(auditReply('Your track is playing.', { evidence: unrelated }).outcome, 'blocked');
  const mismatch = { ...same, audio_playbacks: [{ media_id: 'other-track', confirmed: true, state: 'playing' }] };
  assert.equal(auditReply('Your track is playing.', { evidence: mismatch }).outcome, 'blocked');
  assert.equal(auditReply('[Short audio clip of a hip hop beat]', { evidence: same }).outcome, 'blocked', 'stage directions never become audio');
});
