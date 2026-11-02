// /health names the commit the live Worker runs. A deploy tags the version with the commit; a later secret change (the
// certification run's probe token) makes an untagged version of the same code, which keeps the deploy's CHE_POOL_COMMIT
// var. Run 41403181740 failed its live-commit check for that reason after run 20 changed the token.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.health_version_tag.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const worker = mod.default;
const sha = 'c3b38703950c088f70cc96bf5b7e06d079271894';
const health = async (env) => (await worker.fetch(new Request('https://che.test/health'), env, {})).json();

test('a tagged deploy reports its tag', async () => {
  const out = await health({ CF_VERSION_METADATA: { id: 'v1', tag: 'c3b38703950c' }, CHE_POOL_COMMIT: sha });
  assert.equal(out.version_tag, 'c3b38703950c');
  assert.equal(out.version_source, 'tag');
});

test('an untagged secret-change version reports the deploy commit it still runs', async () => {
  const out = await health({ CF_VERSION_METADATA: { id: 'v2', tag: '' }, CHE_POOL_COMMIT: sha });
  assert.equal(out.version_tag, 'c3b38703950c');
  assert.equal(out.version_source, 'deploy_var');
});

test('with neither a tag nor a valid deploy commit, no commit is claimed', async () => {
  for (const env of [{ CF_VERSION_METADATA: { id: 'v3' } }, { CF_VERSION_METADATA: { id: 'v3' }, CHE_POOL_COMMIT: 'main' }]) {
    const out = await health(env);
    assert.equal(out.version_tag, '');
    assert.equal(out.version_source, 'none');
  }
});
