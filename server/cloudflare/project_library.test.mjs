// Project manager and Roblox recovery (project_library.js, roblox_place.js), with the shapes the Worker really stores:
// officeRobloxJob's "Roblox game studio — tonight" projects, their crew tasks, ML runs and Creator Studio projects.
import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryOf, projectLibrary, projectLibraryRoute, robloxRecovery, stateOf } from './project_library.js';
import { extractLuau, placeXml, scriptClassFor } from './roblox_place.js';

const NOTE = 'Roblox / Luau experience studio is a legal monetizable CHE service line.';
const robloxProject = (id, brief, at, extra = {}) => ({
  id, title: 'Roblox game studio — tonight', type: 'roblox_game', brief: `${brief}\n\n${NOTE}`,
  content: '# Roblox game — first draft stub', status: 'in_progress', goal_id: `goal-${id}`, job_ids: [`t-${id}-1`, `t-${id}-2`],
  owner_confirm_required: true, created_at: at, updated_at: at, ...extra,
});
const LUAU_SERVER = '```luau\n-- name: ObbyServer\nlocal Players = game:GetService("Players")\nPlayers.PlayerAdded:Connect(function(p) print(p.Name) end)\n```';
const LUAU_TOOL = '```lua\nlocal tool = script.Parent\ntool.Activated:Connect(function() game.Players.LocalPlayer.Character.Humanoid.Jump = true end)\n```';
const LUAU_MODULE = '```luau\nlocal SwordShop = {}\nfunction SwordShop.price(n) return n * 10 end\nreturn SwordShop\n```';

function fixture() {
  return {
    projects: [
      robloxProject('r3', 'obby with a sword shop', '2026-10-20T03:00:00Z'),
      robloxProject('r2', 'obby with a sword shop', '2026-10-19T03:00:00Z'),
      robloxProject('r1', 'tycoon with pets', '2026-10-18T03:00:00Z'),
      { id: 'ml1', title: 'ML classification · 3 labels', type: 'ml_classification', goal_kind: 'ml_eval', status: 'complete', content: '# metrics', created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z' },
      { id: 'ml2', title: 'ML clustering · k=4', type: 'ml_clustering', goal_kind: 'ml_eval', status: 'complete', content: '# metrics', created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z' },
      { id: 'film1', title: 'Street Smart Explainers', type: 'video_series', status: 'draft', content: 'Episode one script words here', created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' },
      { id: 'app1', title: 'Budget app', type: 'app', status: 'paused', content: '', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' },
    ],
    team_tasks: [
      { id: 't-r2-1', partner_name: 'Atlas', status: 'done', result: `Here is the obby.\n${LUAU_SERVER}\n${LUAU_TOOL}`, job_id: 'goal-r2', created_at: '2026-10-19T03:00:00Z', updated_at: '2026-10-19T04:00:00Z' },
      { id: 't-r2-2', partner_name: 'Nova', status: 'done', result: `Listing.\n${LUAU_MODULE}`, job_id: 'goal-r2', created_at: '2026-10-19T03:00:00Z', updated_at: '2026-10-19T04:10:00Z' },
      { id: 't-r3-1', partner_name: 'Atlas', status: 'queued', result: '', job_id: 'goal-r3', created_at: '2026-10-20T03:00:00Z', updated_at: '2026-10-20T03:00:00Z' },
      { id: 't-r1-1', partner_name: 'Atlas', status: 'blocked', result: '', error: 'No coding model is configured.', job_id: 'goal-r1', created_at: '2026-10-18T03:00:00Z', updated_at: '2026-10-18T03:05:00Z' },
    ],
  };
}

test('ML runs leave the creative list for AI, code and research; nothing is dropped', () => {
  const lib = projectLibrary(fixture());
  const ml = lib.cards.filter((c) => c.id === 'ml1' || c.id === 'ml2');
  assert.equal(ml.length, 2);
  assert.ok(ml.every((c) => c.category === 'research' && c.creative === false && c.state === 'completed'));
  assert.equal(categoryOf({ type: 'app' }), 'code');
  assert.equal(lib.cards.find((c) => c.id === 'film1').category, 'film');
  assert.equal(lib.counts.ai_code_research.completed, 2);
  assert.equal(lib.counts.ai_code_research.paused, 1, 'the budget app is code, paused');
  // Every stored project is behind some card.
  const covered = new Set(lib.cards.flatMap((c) => c.ids));
  for (const p of fixture().projects) assert.ok(covered.has(p.id), p.id);
});

test('duplicate "tonight" cards collapse into one card that keeps every copy and its history', () => {
  const lib = projectLibrary(fixture());
  const roblox = lib.cards.filter((c) => c.category === 'roblox');
  assert.equal(roblox.length, 2, 'the sword-shop obby twice is one card; the tycoon is its own');
  const obby = roblox.find((c) => c.request === 'obby with a sword shop');
  assert.deepEqual(obby.ids.sort(), ['r2', 'r3']);
  assert.equal(obby.copies, 2);
  assert.equal(obby.id, 'r2', 'the copy with the real crew results leads the card');
  assert.match(obby.output.line, /3 Luau scripts, 2 crew results/);
  assert.match(obby.next_action, /still working/, 'r3 still has a queued task');
  assert.ok(obby.history.some((e) => e.copy === 1) && obby.history.some((e) => e.copy === 2));
  const tycoon = roblox.find((c) => c.request === 'tycoon with pets');
  assert.match(tycoon.next_action, /blocked: No coding model is configured/);
  assert.equal(lib.duplicates.length, 1);
  assert.match(lib.spoken, /1 had duplicate copies, now shown once; every copy is kept/);
});

test('Roblox recovery lists each project\'s real scripts and never calls one playable', () => {
  const rec = robloxRecovery(fixture());
  assert.equal(rec.stored_copies, 3);
  const obby = rec.projects.find((p) => p.ids.includes('r2'));
  assert.deepEqual(obby.scripts.map((s) => [s.name, s.kind]), [['ObbyServer', 'Script'], ['Script2', 'ToolLocalScript'], ['SwordShop', 'ModuleScript']]);
  assert.equal(obby.place_file, '/api/projects/roblox/place.rbxlx?id=r2');
  assert.ok(rec.projects.every((p) => p.verified === false));
  const tycoon = rec.projects.find((p) => p.ids.includes('r1'));
  assert.equal(tycoon.place_file, null);
  assert.match(rec.spoken, /2 Roblox projects \(3 saved copies, nothing removed\)\. 1 has Luau scripts .* 1 has only notes so far\. None has been playtested/);
});

test('the place file holds exactly the crew\'s scripts where their code says they run', async () => {
  const data = fixture();
  const route = (path, method = 'GET', body = {}) => projectLibraryRoute({ data, save: async () => {} }, path.split('?')[0], new Request(`https://che.example${path}`, { method }), body);
  const res = await route('/api/projects/roblox/place.rbxlx?id=r3');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-CHE-Verified'), 'false');
  const xml = await res.text();
  assert.match(xml, /^<roblox [^>]*version="4">/);
  assert.match(xml, /<Item class="ServerScriptService"[^>]*>.*<Item class="Script"[^>]*><Properties><string name="Name">ObbyServer<\/string>/s);
  assert.match(xml, /<Item class="StarterPack".*<Item class="Tool".*<string name="Name">Handle<\/string>.*<Item class="LocalScript"/s);
  assert.match(xml, /<Item class="ReplicatedStorage".*<string name="Name">SwordShop<\/string>/s);
  assert.match(xml, /CDATA\[local SwordShop = \{\}/);
  assert.equal((xml.match(/<Item /g) || []).length, (xml.match(/<\/Item>/g) || []).length, 'balanced items');
  const none = await route('/api/projects/roblox/place.rbxlx?id=r1');
  assert.equal(none.status, 404);
  assert.match((await none.json()).detail, /no Luau scripts yet, .* Nothing was made up/);
});

test('Pause, Complete, Archive and Restore write the existing status field with a receipt, for every copy', async () => {
  const data = fixture(); let saves = 0;
  const route = (body) => projectLibraryRoute({ data, save: async () => { saves++; }, now: () => Date.parse('2026-10-24T21:00:00Z') }, '/api/projects/state', new Request('https://che.example/api/projects/state', { method: 'POST' }), body);
  const out = await (await route({ ids: ['r2', 'r3'], state: 'archived' })).json();
  assert.equal(out.ok, true); assert.equal(saves, 1);
  assert.deepEqual(out.receipt, { at: '2026-10-24T21:00:00.000Z', ids: ['r3', 'r2'], state: 'archived', stored: true });
  assert.match(out.spoken, /now archived \(all 2 copies\)\. Saved\./);
  assert.ok(data.projects.filter((p) => ['r2', 'r3'].includes(p.id)).every((p) => p.status === 'archived' && p.history.at(-1).event === 'Active → Archived'));
  assert.equal(projectLibrary(data).cards.find((c) => c.ids.includes('r2')).state, 'archived');
  await route({ id: 'r2', state: 'active' });
  assert.equal(stateOf(data.projects.find((p) => p.id === 'r2')), 'active');
  assert.equal(data.projects.length, 7, 'nothing removed');
  assert.equal((await route({ id: 'r2', state: 'deleted' })).status, 400);
  assert.equal((await route({ id: 'nope', state: 'paused' })).status, 404);
});

test('3D creations are cards too, with their real job state and model', () => {
  const lib = projectLibrary({ projects: [] }, [
    { id: 'cr_aaaaaaaaaaaa', kind: 'person', title: 'Cloud engine check (automatic test)', updated_at: '2026-10-24T20:00:00Z', model_url: '/api/gpu/jobs/gpu_x/model.glb', job: { id: 'gpu_x', state: 'completed' } },
    { id: 'cr_bbbbbbbbbbbb', kind: 'person', title: 'Hero', updated_at: '2026-10-24T19:00:00Z', job: { id: 'gpu_y', state: 'paused', owner_paused: true } },
  ]);
  assert.deepEqual(lib.cards.map((c) => [c.id, c.state, c.output.line]), [['cr_aaaaaaaaaaaa', 'completed', '3D model ready'], ['cr_bbbbbbbbbbbb', 'paused', 'paused']]);
});

test('Luau placement heuristics and CDATA safety', () => {
  assert.equal(scriptClassFor('local x = 1\nreturn x'), 'ModuleScript');
  assert.equal(scriptClassFor('game:GetService("UserInputService").InputBegan:Connect(print)'), 'LocalScript');
  assert.equal(scriptClassFor('print("server")'), 'Script');
  assert.deepEqual(extractLuau('no code here'), []);
  const { xml } = placeXml({ scripts: [{ name: 'Tricky', source: 'local s = "]]>"\nprint(s)' }] });
  assert.match(xml, /\]\]\]\]><!\[CDATA\[>/, '"]]>" inside the source cannot end the CDATA section');
});

test('Continue on a Roblox card queues one crew task on the existing project, never a new card', async () => {
  const data = fixture(); const calls = [];
  const continueProject = async (p, brief) => { calls.push({ id: p.id, brief }); p.job_ids.push('t-new'); return { ok: true, task_id: 't-new', agent: 'Atlas' }; };
  const route = (body) => projectLibraryRoute({ data, save: async () => {}, continueProject, now: () => Date.parse('2026-10-24T21:00:00Z') }, '/api/projects/continue', new Request('https://che.example/api/projects/continue', { method: 'POST' }), body);
  const out = await (await route({ id: 'r3' })).json();
  assert.equal(out.ok, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'r2', 'the copy holding the work is continued');
  assert.match(calls[0].brief, /owner request: obby with a sword shop/);
  assert.match(calls[0].brief, /Scripts already written: ObbyServer \(Script\), Script2 \(ToolLocalScript\), SwordShop \(ModuleScript\)/);
  assert.match(calls[0].brief, /-- name: ScriptName/);
  assert.match(calls[0].brief, /Do not publish, upload, spend Robux/);
  assert.equal(out.receipt.task_id, 't-new');
  assert.match(out.spoken, /none of it is called playable until it is playtested/);
  assert.equal(data.projects.length, 7, 'no new project');
  const film = await route({ id: 'film1' });
  assert.equal(film.status, 409); assert.equal((await film.json()).open_editor, true);
});
