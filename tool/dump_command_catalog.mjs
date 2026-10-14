#!/usr/bin/env node
// Writes the Command Center catalog (as the Worker serves it with no
// connectors set up) to test/fixtures/command_catalog.json for the Flutter
// tests. server/cloudflare/command_center.test.mjs fails when it is stale.
import { writeFileSync } from 'node:fs';
import { catalogView, connectorStatus } from '../server/cloudflare/command_catalog.js';

export function fixtureCatalog() {
  return catalogView(connectorStatus({ AI: {} }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('../test/fixtures/command_catalog.json', import.meta.url);
  writeFileSync(out, `${JSON.stringify(fixtureCatalog(), null, 1)}\n`);
  console.log(`wrote ${out.pathname}`);
}
