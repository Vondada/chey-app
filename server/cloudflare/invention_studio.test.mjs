// CHE's Invention Studio (owner, 2026-10-22): concept-to-breakdown, with truthful sourcing labels and cost bands.
// The module tests check the rules; the chat tests drive /api/chat the way the owner does (no model call for the studio).
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { LABELS, inventionIntent, inventionReply, planInvention, rollUp, templateFor, TIERS } from './invention_studio.js';

test('intents: the owner\'s phrasings reach the studio; ordinary cost and mail questions do not', () => {
  assert.equal(inventionIntent('Design me an Iron Man-style suit')?.kind, 'design');
  assert.equal(inventionIntent('Show me how it assembles')?.kind, 'assembly');
  assert.equal(inventionIntent('Tell me piece by piece what it costs')?.kind, 'cost');
  assert.equal(inventionIntent('Where can I get the parts?')?.kind, 'sourcing');
  assert.equal(inventionIntent('What parts are real versus conceptual?')?.kind, 'reality');
  assert.equal(inventionIntent('make a plan for my trading room'), null, 'a plan for a room is not a design');
  assert.equal(inventionIntent('how much does a Netflix subscription cost'), null);
});

test('weapons and safety bypasses are refused as intents, never designed', () => {
  assert.equal(inventionIntent('design me a suit with a missile launcher')?.kind, 'refused');
  assert.equal(inventionIntent('design a robot and bypass the safety interlock')?.kind, 'refused');
});

test('templates: a suit is a powered suit, an exo is an exoskeleton, a robot is a robot, the rest is a device', () => {
  assert.equal(templateFor('Iron Man-style suit'), 'powered_suit');
  assert.equal(templateFor('a hip exoskeleton'), 'exoskeleton');
  assert.equal(templateFor('a walking robot'), 'robot');
  assert.equal(templateFor('a cat feeder'), 'device');
});

test('a powered suit project: nine subsystems, and every part carries one sourcing label', () => {
  const project = planInvention('Design me an Iron Man-style suit', { id: 'inv-test' });
  assert.deepEqual(project.subsystems.map((s) => s.id), ['frame', 'shell', 'power', 'movement', 'sensors', 'control', 'cooling', 'safety', 'accessories']);
  const allowed = new Set(Object.values(LABELS));
  for (const p of project.parts) assert.ok(allowed.has(p.label), `${p.name} has one of the five labels`);
  assert.ok(project.parts.filter((p) => p.kind !== 'conceptual').length >= 15, 'real parts are listed');
});

test('no supplier is invented: no vendor or link is set, no source is verified, and lookup is labelled not connected', () => {
  const project = planInvention('powered suit');
  for (const p of project.parts) {
    assert.equal(p.sourcing.vendor, null, p.name);
    assert.equal(p.sourcing.link, null, p.name);
    assert.equal(p.sourcing.lead_time, null, p.name);
    assert.notEqual(p.label, LABELS.verified, p.name);
  }
  assert.equal(project.sourcing.verified_sources, 0);
  assert.equal(project.sourcing.live_lookup, 'not connected');
});

test('conceptual items are never costed; custom and off-the-shelf parts are labelled as such', () => {
  const project = planInvention('powered suit');
  const concept = project.parts.filter((p) => p.kind === 'conceptual');
  assert.ok(concept.length >= 1);
  for (const c of concept) assert.equal(c.cost, null, c.name);
  assert.ok(project.parts.some((p) => p.kind === 'custom_fabricated' && p.label === LABELS.custom));
  assert.ok(project.parts.some((p) => p.kind === 'off_the_shelf' && p.label === LABELS.estimated));
});

test('cost roll-up: the tiers rise from prototype to premium, and the subsystems add up to the total', () => {
  const project = planInvention('powered suit');
  const t = project.cost.tiers;
  assert.ok(t.budget.high < t.mid.high && t.mid.high < t.premium.high, 'budget < mid < premium');
  for (const tier of TIERS) {
    const bySubsystem = project.subsystems.reduce((sum, s) => sum + s.cost[tier].high, 0);
    assert.equal(bySubsystem, t[tier].high, `${tier} high adds up`);
    const lowSum = project.subsystems.reduce((sum, s) => sum + s.cost[tier].low, 0);
    assert.equal(lowSum, t[tier].low, `${tier} low adds up`);
  }
  assert.equal(rollUp(project.parts.slice(0, 1), 'budget').unknown_parts, 0);
});

test('feasibility covers every answer the owner asked for: realistic, too heavy, power-limited, unsafe, fabrication, prototype, concept-only', () => {
  const f = planInvention('powered suit').feasibility;
  for (const key of ['realistic_today', 'too_heavy', 'power_limited', 'unsafe', 'advanced_fabrication', 'prototype_first', 'concept_only']) {
    assert.ok(Array.isArray(f[key]) && f[key].length, key);
  }
  const reply = inventionReply(planInvention('powered suit', { id: 'inv-x' }), 'reality');
  assert.match(reply, /Realistic today:/);
  assert.match(reply, /Concept only: Flight, repulsor/);
});

test('the cost reply says the bands are planning figures and that no vendor is confirmed', () => {
  const reply = inventionReply(planInvention('powered suit', { id: 'inv-x' }), 'cost');
  assert.match(reply, /Planning bands for the parts/);
  assert.match(reply, /no vendor, link, exact price or lead time is confirmed/);
});

test('stages and the testing checklist are present in the project', () => {
  const project = planInvention('powered suit');
  assert.deepEqual(project.stages.map((s) => s.id), ['concept_render', 'static_shell', 'wearable_mockup', 'powered_subsystem', 'integrated', 'testing']);
  assert.ok(project.tests.length >= 5);
});
