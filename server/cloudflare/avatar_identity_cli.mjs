// Prints the Worker's render settings for every built-in preset and look as JSON ({id: {style: settings}}), for the
// Python parity test (tools/test_avatar_identity.py). --write-presets regenerates avatar_identity_presets.js from
// tools/avatar_face/identities.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (process.argv.includes('--write-presets')) {
  const data = JSON.parse(readFileSync(join(here, '..', '..', 'tools', 'avatar_face', 'identities.json'), 'utf8'));
  writeFileSync(join(here, 'avatar_identity_presets.js'),
    '// Generated from tools/avatar_face/identities.json, which the Python renderer reads; avatar_identity.test.mjs fails if\n'
    + '// they differ. Edit the JSON, then regenerate: node server/cloudflare/avatar_identity_cli.mjs --write-presets\n'
    + `export const IDENTITIES = ${JSON.stringify(data, null, 2)};\n`);
  console.log('wrote avatar_identity_presets.js');
} else {
  const { BUILT_IN, STYLES, toSettings } = await import('./avatar_identity.js');
  console.log(JSON.stringify(Object.fromEntries(BUILT_IN.map((p) => [p.id, Object.fromEntries(STYLES.map((s) => [s, toSettings(p, s)]))]))));
}
