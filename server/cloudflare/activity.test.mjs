import assert from 'node:assert/strict';
import test from 'node:test';

import { activityFeed, creations, findCreations, greeting, shortTitle, suggestions } from './activity.js';

const data = {
  team: [{ id: 'a1', name: 'Mira' }, { id: 'a2', name: 'Nova' }],
  team_tasks: [
    { id: 't1', partner_name: 'Mira', task: 'Write a chill song about summer nights for the launch video', status: 'complete', result: 'Verse one: warm lights…', updated_at: '2026-09-29T10:00:00Z' },
    { id: 't2', partner_name: 'Nova', task: 'Research competitors in Houston', status: 'running', updated_at: '2026-09-29T11:00:00Z' },
  ],
  meetings: [{ id: 'm1', objective: 'Plan the launch', final_plan: '1. Ship it', updated_at: '2026-09-29T09:00:00Z' }],
  projects: [{ id: 'p1', title: 'Summer launch', type: 'app', created_at: '2026-09-28T09:00:00Z' }],
  vault_items: [], jobs: [],
};
const media = [{ id: 'i1', title: 'Neon city', prompt: 'a neon city at night', created_at: '2026-09-29T08:00:00Z', blob: 'do' }];

test('short titles are 3–6 words', () => {
  assert.equal(shortTitle('Research competitors in Houston'), 'Research competitors in Houston');
  assert.equal(shortTitle('Write a chill song about summer nights for the launch video'), 'Write a chill song about summer…');
});

test('finds things made in any room by maker and topic', () => {
  const song = findCreations(data, media, 'play the song Mira made', 'https://che.example');
  assert.equal(song[0].id, 't1');
  assert.equal(song[0].maker, 'Mira');
  const image = findCreations(data, media, 'show the neon city picture', 'https://che.example');
  assert.equal(image[0].media_url, 'https://che.example/api/media/i1/image');
  assert.deepEqual(findCreations(data, media, 'the song Nova made'), [], 'never credits the wrong maker');
  // The home suggestion "Read me what Mira finished" finds her stored result.
  const finished = findCreations(data, media, suggestions(data, { hour: 9 })[0]);
  assert.equal(suggestions(data, { hour: 9 })[0], 'Read me what Mira finished');
  assert.equal(finished[0].id, 't1');
  assert.match(finished[0].text, /Verse one/);
});

test('activity feed and greeting use only real state', () => {
  const feed = activityFeed(data, media);
  assert.equal(feed[0].line, 'Nova is working on “Research competitors in Houston”.');
  assert.ok(feed.some((e) => e.line.startsWith('Mira finished')));
  const g = greeting(data, media, { hour: 9 });
  assert.match(g.line, /^Good morning! Mira finished “Write a chill song about…”/);
  const quiet = greeting({ team_tasks: [], meetings: [] }, [], { hour: 20 });
  assert.equal(quiet.kind, 'suggestion');
  assert.equal(suggestions(data, { hour: 9 }).length, 3);
});

test('creations tolerates twilio queues without throwing', () => {
  const items = creations({
    twilio_bulk_jobs: [{ id: 'b1', status: 'pending_owner', recipient_count: 3, sample: 'hi', created_at: '2026-09-30T00:00:00Z' }],
    twilio_inbound: [{ id: 'i1', at: '2026-09-30T00:01:00Z', from: '+10000000000', body: 'STOP', kind: 'opt_out' }],
    team_tasks: [],
    projects: [],
    vault_items: [],
    jobs: [],
    meetings: [],
  }, []);
  assert.ok(Array.isArray(items));
});

test('activityFeed includes pending twilio bulk decisions', () => {
  const events = activityFeed({
    twilio_bulk_jobs: [{ id: 'b1', status: 'pending_owner', recipient_count: 2, sample: 'hello', created_at: '2026-09-30T00:00:00Z' }],
    twilio_inbound: [],
    team_tasks: [],
    projects: [],
    jobs: [],
    meetings: [],
  }, []);
  assert.equal(events.some((e) => e.kind === 'twilio_bulk'), true);
});
