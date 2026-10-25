#!/usr/bin/env node
// Writes test/fixtures/strategy_matrix.json: the Worker's own GET /api/trading/strategy-matrix body
// (strategy_matrix.strategyMatrixView over the committed research results), cut to a few rows of each tier so the
// Flutter widget test reads the real shape. Regenerate after a change to the view: node tool/dump_strategy_matrix_fixture.mjs
import { writeFileSync } from 'node:fs';
import { strategyMatrixView } from '../server/cloudflare/strategy_matrix.js';

const view = await strategyMatrixView(null, { now: Date.parse('2026-10-25T12:30:00Z') });
const pick = [];
for (const tier of ['ranked', 'insufficient sample', 'demoted', 'not applicable']) pick.push(...view.rows.filter((r) => r.tier === tier).slice(0, 2));
const slim = (r) => ({ ...r, walk_forward: { ...r.walk_forward, windows: (r.walk_forward?.windows || []).slice(0, 1) } });
writeFileSync(new URL('../test/fixtures/strategy_matrix.json', import.meta.url), `${JSON.stringify({ ...view, rows: pick.map(slim) }, null, 1)}\n`);
console.log(`wrote ${pick.length} rows`);
