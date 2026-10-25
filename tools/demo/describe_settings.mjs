// The Create Room demo's job settings from its description, through the Worker's own describe-a-person path
// (creation_studio.describePerson -> avatar_identity.toSettings + shapeSettings + personExtras), the same settings the
// Create button queues. The first demo hand-wrote them, so "warm brown skin, woman in her thirties" was built with no
// hair style (a scalp cap), age 27 and an arbitrary outfit colour.
//
//   node tools/demo/describe_settings.mjs            prints the base settings for characters.json's description
//   node tools/demo/describe_settings.mjs --write    writes them into tools/demo/characters.json (base)
// server/cloudflare/creation_demo_settings.test.mjs fails when characters.json's base drifts from this.
import { readFileSync, writeFileSync } from 'node:fs';
import { describePerson, personExtras, shapeSettings } from '../../server/cloudflare/creation_studio.js';
import { toSettings } from '../../server/cloudflare/avatar_identity.js';

const PATH = new URL('./characters.json', import.meta.url);

/** The base job settings (look-independent: STYLE is set per job) for a description. */
export function demoBase(description) {
  const d = describePerson(description);
  if (!d.ok) throw new Error(d.detail);
  const s = { ...toSettings(d.params, 'photoreal'), ...shapeSettings(d.shape), ...personExtras({ params: d.params }), MODEL_MODE: 'full_body', RENDER_PROFILE: 'final' };
  delete s.STYLE;
  return Object.fromEntries(Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const spec = JSON.parse(readFileSync(PATH, 'utf8'));
  const base = demoBase(spec.description);
  if (process.argv.includes('--write')) { spec.base = base; writeFileSync(PATH, JSON.stringify(spec, null, 2) + '\n'); }
  console.log(JSON.stringify(base, null, 1));
}
