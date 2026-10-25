// Paid GPU provider adapters for the compute pool (compute_pool.js). Each one can: read the prepaid balance (a free,
// read-only call that also verifies the key), start ONE GPU machine that runs CHE's character worker
// (scripts/che_gpu_worker.py) against CHE's existing queue with a scoped, expiring pool token, read its billed cost,
// and terminate it. They never buy credit, add a payment method or change account settings.
//
// Sources (read 2026-10-25; the hosts themselves are blocked from the build container, so the documentation was read
// from the providers' own GitHub repositories):
// - RunPod REST API v1: OpenAPI at github.com/runpod/docs api-reference/openapi.json (server https://rest.runpod.io/v1,
//   Bearer key): POST /pods (PodCreateInput: name, imageName, gpuTypeIds, gpuTypePriority, cloudType COMMUNITY|SECURE,
//   computeType, containerDiskInGb, volumeInGb, env, dockerStartCmd, interruptible), DELETE /pods/{podId}, GET
//   /billing/pods (grouping=podId; BillingRecord.amount in USD). Pod.costPerHr is the real hourly price.
//   Balance: GraphQL https://api.runpod.io/graphql `myself { clientBalance }` (field named in the runpodctl `user`
//   reference output, github.com/runpod/docs runpodctl/reference/runpodctl-user.mdx).
//   Billing: prepaid credits, per second; Pods stop when the balance reaches $0; a new Pod needs one hour of credit;
//   default spend limit $80/hour (github.com/runpod/docs accounts-billing/billing.mdx).
// - Vast.ai: the official CLI (github.com/vast-ai/vast-cli vast.py): base https://console.vast.ai/api/v0, Bearer key;
//   GET /users/current (has `credit`), POST /bundles/ (offer search, rows in `offers`, price `dph_total`),
//   PUT /asks/{offer_id}/ (rent: image, disk, onstart, runtype; returns new_contract), DELETE /instances/{id}/.
//   The exact create body beyond what the CLI sends is unverified until a real rental.

const RUNPOD_REST = 'https://rest.runpod.io/v1';
const RUNPOD_GQL = 'https://api.runpod.io/graphql';
const VAST = 'https://console.vast.ai/api/v0';
// A public CUDA runtime image (Docker Hub nvidia/cuda). Blender brings its own libraries; the start command adds
// python3 and the X/GL libraries Blender needs in background mode, then runs the boot script from the env.
export const WORKER_IMAGE = 'nvidia/cuda:12.4.1-runtime-ubuntu22.04';
const START_SH = 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 ca-certificates xz-utils libxi6 libxkbcommon0 libsm6 libxrender1 libgl1 libegl1 libxxf86vm1 libxfixes3 >/dev/null 2>&1; echo "$CHE_BOOT" | base64 -d > /che_boot.py && exec python3 /che_boot.py';

const b64 = (text) => { const bytes = new TextEncoder().encode(text); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const short = (v, n = 160) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);

async function call(fetcher, url, { method = 'GET', key, body = null, timeout = 15000 } = {}) {
  try {
    const r = await fetcher(url, { method, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: short(e?.message || e, 80) };
  }
}
const said = (r) => (r.status === 401 || r.status === 403 ? 'unauthorized' : r.status === 429 ? 'rate_limited' : r.status === 0 ? 'network' : 'unknown');

export const runpod = {
  id: 'runpod',
  name: 'RunPod',
  env: 'RUNPOD_API_KEY',
  /** Free read: the prepaid balance. Also proves the key. */
  async balance(key, fetcher = fetch) {
    const r = await call(fetcher, RUNPOD_GQL, { method: 'POST', key, body: { query: 'query { myself { id clientBalance currentSpendPerHr } }' } });
    const me = r.data?.data?.myself;
    if (!r.ok || !me || r.data?.errors) return { ok: false, status: said(r), http: r.status, detail: short(r.data?.errors?.[0]?.message || r.error || '') };
    return { ok: true, usd: Number(me.clientBalance), spend_per_hr: Number(me.currentSpendPerHr) || 0 };
  },
  /** One Community Cloud GPU Pod, cheapest acceptable GPU first, no volume (nothing bills after it is deleted). */
  async start(key, { name = 'che-character-worker', script, gpuTypeIds, maxUsdHr }, fetcher = fetch) {
    const body = { name, imageName: WORKER_IMAGE, cloudType: 'COMMUNITY', computeType: 'GPU', gpuCount: 1, gpuTypeIds, gpuTypePriority: 'custom',
      containerDiskInGb: 30, volumeInGb: 0, interruptible: false, ports: [], env: { CHE_BOOT: b64(script) }, dockerStartCmd: ['bash', '-c', START_SH] };
    const r = await call(fetcher, `${RUNPOD_REST}/pods`, { method: 'POST', key, body, timeout: 30000 });
    if (!r.ok || !r.data?.id) return { ok: false, status: said(r), quota: r.status === 429, error: `RunPod did not start a GPU (HTTP ${r.status}${r.data?.error ? `: ${short(r.data.error, 120)}` : ''}).` };
    const usdHr = Number(r.data.costPerHr ?? r.data.adjustedCostPerHr);
    const gpu = short(r.data.gpu?.displayName || r.data.gpu?.id || r.data.machine?.gpuTypeId || gpuTypeIds[0], 60);
    if (Number.isFinite(usdHr) && usdHr > maxUsdHr + 1e-9) {
      await this.stop(key, r.data.id, fetcher);
      return { ok: false, status: 'too_expensive', error: `RunPod gave a machine at $${usdHr}/h, above the $${maxUsdHr}/h CHE accepts; CHE deleted it at once.`, ref: r.data.id, usd_hr: usdHr };
    }
    return { ok: true, ref: String(r.data.id), usd_hr: Number.isFinite(usdHr) ? usdHr : null, gpu };
  },
  /** Terminate (DELETE): a stopped Pod would keep billing its disk, so CHE deletes it. 404 = already gone. */
  async stop(key, ref, fetcher = fetch) {
    const r = await call(fetcher, `${RUNPOD_REST}/pods/${encodeURIComponent(ref)}`, { method: 'DELETE', key });
    return r.ok || r.status === 404 ? { ok: true, gone: r.status === 404 } : { ok: false, status: said(r), error: `RunPod did not delete Pod ${short(ref, 40)} (HTTP ${r.status}).` };
  },
  /** The billed USD for one Pod from RunPod's billing history (null when not listed yet; billing runs every 5 min). */
  async billing(key, ref, sinceMs, fetcher = fetch) {
    const q = new URLSearchParams({ grouping: 'podId', bucketSize: 'day', startTime: new Date(sinceMs - 86400_000).toISOString() });
    const r = await call(fetcher, `${RUNPOD_REST}/billing/pods?${q}`, { key });
    if (!r.ok) return null;
    const rows = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.records) ? r.data.records : [];
    const mine = rows.filter((x) => x?.podId === ref).map((x) => Number(x.amount)).filter(Number.isFinite);
    return mine.length ? mine.reduce((a, b) => a + b, 0) : null;
  },
};

export const vast = {
  id: 'vast',
  name: 'Vast.ai',
  env: 'VAST_API_KEY',
  async balance(key, fetcher = fetch) {
    const r = await call(fetcher, `${VAST}/users/current/`, { key });
    if (!r.ok || !r.data || r.data.credit === undefined) return { ok: false, status: said(r), http: r.status, detail: short(r.data?.msg || r.data?.error || r.error || '') };
    return { ok: true, usd: Number(r.data.credit) };
  },
  /** The cheapest verified, rentable single-GPU on-demand offer at or under maxUsdHr, then rent it. */
  async start(key, { name = 'che-character-worker', script, gpuNames, maxUsdHr }, fetcher = fetch) {
    const q = { verified: { eq: true }, rentable: { eq: true }, rented: { eq: false }, num_gpus: { eq: 1 }, gpu_name: { in: gpuNames }, dph_total: { lte: maxUsdHr },
      reliability2: { gte: 0.95 }, order: [['dph_total', 'asc']], type: 'on-demand', limit: 5, allocated_storage: 30 };
    const s = await call(fetcher, `${VAST}/bundles/`, { method: 'POST', key, body: q });
    const offers = (s.data?.offers || []).filter((o) => Number(o.dph_total) <= maxUsdHr + 1e-9 && gpuNames.includes(o.gpu_name));
    if (!s.ok) return { ok: false, status: said(s), quota: s.status === 429, error: `Vast.ai offer search failed (HTTP ${s.status}).` };
    if (!offers.length) return { ok: false, status: 'no_offer', error: `Vast.ai has no verified ${gpuNames.join(' / ')} at or under $${maxUsdHr}/h right now.` };
    const o = offers.sort((a, b) => a.dph_total - b.dph_total)[0];
    const onstart = `export CHE_BOOT='${b64(script)}'; ${START_SH}`;
    const r = await call(fetcher, `${VAST}/asks/${encodeURIComponent(o.id)}/`, { method: 'PUT', key, body: { client_id: 'me', image: WORKER_IMAGE, disk: 30, label: name, onstart, runtype: 'ssh_proxy', cancel_unavail: true }, timeout: 30000 });
    if (!r.ok || !r.data?.new_contract) return { ok: false, status: said(r), quota: r.status === 429, error: `Vast.ai did not rent offer ${o.id} (HTTP ${r.status}${r.data?.msg ? `: ${short(r.data.msg, 120)}` : ''}).` };
    return { ok: true, ref: String(r.data.new_contract), usd_hr: Number(o.dph_total), gpu: short(o.gpu_name, 60) };
  },
  async stop(key, ref, fetcher = fetch) {
    const r = await call(fetcher, `${VAST}/instances/${encodeURIComponent(ref)}/`, { method: 'DELETE', key, body: {} });
    return r.ok || r.status === 404 ? { ok: true, gone: r.status === 404 } : { ok: false, status: said(r), error: `Vast.ai did not destroy instance ${short(ref, 40)} (HTTP ${r.status}).` };
  },
  async billing() { return null; },   // Vast's per-instance charges are not read yet: the wall-time estimate stands
};

export const ADAPTERS = Object.freeze({ runpod, vast });
