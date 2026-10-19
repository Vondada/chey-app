#!/usr/bin/env node
// Writes CHE's Knowledge Atlas cards to assets/atlas/knowledge_atlas.json, which the phone
// bundles so the Atlas page works offline. server/cloudflare/knowledge_atlas.test.mjs fails
// when the file is stale.
import { mkdirSync, writeFileSync } from 'node:fs';
import { atlasExport } from '../server/cloudflare/knowledge_atlas.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('../assets/atlas/knowledge_atlas.json', import.meta.url);
  mkdirSync(new URL('.', out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(atlasExport(), null, 1)}\n`);
  console.log(`wrote ${out.pathname}`);
}
