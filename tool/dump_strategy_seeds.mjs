// Writes the library's executable seed definitions for the Dart validator test
// (test/che_strategy_dsl_test.dart). strategy_library.test.mjs fails when this file is stale.
import { writeFileSync } from 'node:fs';
import { LIBRARY_SEEDS } from '../server/cloudflare/library_seeds/index.js';

export const seedDefinitions = () => LIBRARY_SEEDS.filter((e) => e.definition).map((e) => e.definition);
if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL('../test/fixtures/strategy_seeds.json', import.meta.url), `${JSON.stringify(seedDefinitions(), null, 2)}\n`);
}
