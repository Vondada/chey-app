// CHE capacity model (owner, 2026-10-24): how much compute, storage, bandwidth and money CHE needs at 1, 1,000,
// 100,000 and 1,000,000 simultaneous users, and for 1,000,000 thirty-minute videos. It is arithmetic over named
// assumptions, never a measurement: every number it uses is in ASSUMPTIONS with its source or the word "assumption",
// and every answer carries them. Change an assumption and the answer changes; nothing is hidden.
//
// Shape of a scenario: users who are active at the same time, how often each sends a chat turn, and how many of them
// start a 1-, 10- or 30-minute video in the peak hour, with a render profile (how the video is made). Output: request
// rates, Durable Object shards, LLM tokens, video output seconds, GPU-seconds by GPU type, GPUs needed to keep up,
// queue wait and completion time (Erlang C over parallel segments), storage, bandwidth and a monthly cost range.
// Nothing here provisions or buys anything; capacity_model.test.mjs pins the arithmetic.

/** Each assumption: value, unit, and where it comes from. "assumption" means CHE's own planning guess, to calibrate. */
export const ASSUMPTIONS = Object.freeze({
  // Prices (USD). Third-party summaries of public price lists, 2026; confirm on the provider's page before buying.
  r2_storage_gb_month: { value: 0.015, unit: 'USD/GB-month', source: 'Cloudflare R2 Standard storage (filebase.com 2026 summary of Cloudflare pricing)' },
  r2_class_a_per_m: { value: 4.5, unit: 'USD/million writes', source: 'Cloudflare R2 Class A' },
  r2_class_b_per_m: { value: 0.36, unit: 'USD/million reads', source: 'Cloudflare R2 Class B' },
  r2_egress_gb: { value: 0, unit: 'USD/GB', source: 'Cloudflare R2: no egress fee to the internet' },
  r2_free_gb: { value: 10, unit: 'GB-month free', source: 'Cloudflare R2 free tier' },
  workers_paid_base: { value: 5, unit: 'USD/month', source: 'Workers Paid plan minimum' },
  workers_requests_per_m: { value: 0.3, unit: 'USD/million requests beyond 10M', source: 'Workers Paid plan (assumption: standard request pricing)' },
  do_requests_per_m: { value: 0.15, unit: 'USD/million beyond 1M', source: 'developers.cloudflare.com/durable-objects/platform/pricing' },
  do_storage_gb_month: { value: 0.2, unit: 'USD/GB-month beyond 5 GB', source: 'Durable Objects SQLite stored data' },
  gpu_h100_hour: { value: 2.69, unit: 'USD/hour', source: 'RunPod Secure Cloud H100 SXM (spheron.network 2026 summary); Lambda lists $2.99-$4.29' },
  gpu_l4_hour: { value: 0.6, unit: 'USD/hour', source: 'L4 $0.44-$0.80/hour (cloudzero.com 2026 summary); midpoint' },
  gpu_t4_hour: { value: 0.35, unit: 'USD/hour', source: 'assumption: typical on-demand T4; not verified for a provider' },
  cpu_runner_hour: { value: 0.04, unit: 'USD/vCPU-hour x4', source: 'assumption: paid 4-vCPU cloud runner; GitHub-hosted runners are $0 for this public repository' },
  llm_tokens_per_m: { value: 0.4, unit: 'USD/million tokens (blended in+out)', source: 'assumption: a small hosted model; CHE routes most turns to fast models' },
  // Relative GPU throughput for diffusion video (H100 = 1). Assumption from FP16 throughput ratios; calibrate per model.
  speed_h100: { value: 1, unit: 'x H100', source: 'reference' },
  speed_l4: { value: 0.2, unit: 'x H100', source: 'assumption (FP16 tensor throughput ratio, roughly 1/5)' },
  speed_t4: { value: 0.12, unit: 'x H100', source: 'assumption (roughly 1/8)' },
  // Render cost per second of finished video, in H100-seconds (GPU) or 4-vCPU-runner-seconds (CPU).
  gen_quality_gpu_s: { value: 57, unit: 'H100-s per output s', source: 'Wan 2.1 720p: 284 s per ~5 s clip on H100 (instasd.com benchmark); another guide says 10-12 min, i.e. 2x worse' },
  gen_fast_gpu_s: { value: 1.9, unit: 'H100-s per output s', source: 'LTX-2.3 vendor claim: 8 s FHD in ~15 s on H100 (ltx.io)' },
  blender_gpu_s: { value: 14, unit: 'H100-s per output s', source: 'assumption: Cycles, 24 fps at ~0.6 H100-s per frame for a draft character shot; calibrate with che_gpu_face_preview receipts' },
  composited_cpu_s: { value: 1, unit: 'runner-s per output s', source: 'assumption: TTS + stills + ffmpeg 1080p30 on a 4-vCPU runner (che-video-render.yml); calibrate from run durations' },
  // Media sizes.
  video_mbps: { value: 8, unit: 'Mbit/s', source: 'assumption: 1080p H.264 delivery bitrate (60 MB per minute)' },
  temp_factor: { value: 3, unit: 'x final size', source: 'assumption: segments, frames and audio stems kept until the receipt verifies' },
  temp_days: { value: 7, unit: 'days', source: 'CHE retention for temporary render files (object_storage.js RETENTION.tmp)' },
  thumb_mb: { value: 0.3, unit: 'MB per video (3 variations)', source: 'assumption' },
  views_per_video: { value: 3, unit: 'downloads per video per month', source: 'assumption' },
  // Platform behaviour.
  chat_turn_s: { value: 60, unit: 's between turns per active user', source: 'assumption' },
  worker_requests_per_turn: { value: 4, unit: 'requests', source: 'assumption: turn + stream + 2 status polls' },
  tokens_per_turn: { value: 2000, unit: 'tokens', source: 'assumption: context + reply, after CHE context budgets' },
  do_rps_per_object: { value: 1000, unit: 'requests/s per Durable Object', source: 'Cloudflare guidance: a single Durable Object handles about 1,000 requests/s' },
  brain_mb_per_user: { value: 20, unit: 'MB per user', source: 'assumption: memories, preferences, project records and search index' },
  max_parallel_segments: { value: 20, unit: 'segments in flight per job', source: 'CHE fair-share cap (job_quota.js PLANS); one job never takes the whole pool' },
  segment_s: { value: 10, unit: 's of video per parallel segment', source: 'CHE film farm splits films into segments (che-film-render.yml)' },
  stitch_s: { value: 60, unit: 's to stitch and verify', source: 'assumption' },
  utilization: { value: 0.7, unit: 'target GPU utilization', source: 'assumption: headroom for retries and bursts' },
  active_hours_per_day: { value: 4, unit: 'peak-equivalent hours per day', source: 'assumption: converts peak load to monthly totals' },
});

const A = (k) => ASSUMPTIONS[k].value;

/** How a video is made: share of its runtime per technique. `hybrid` is CHE's recommended production default. */
export const PROFILES = Object.freeze({
  composited: { composited: 1 },
  blender_3d: { blender: 1 },
  gen_fast: { gen_fast: 1 },
  gen_quality: { gen_quality: 1 },
  hybrid: { gen_quality: 0.1, gen_fast: 0.2, composited: 0.7 },
});

export const GPU_TYPES = Object.freeze({
  h100: { speed: 'speed_h100', price: 'gpu_h100_hour' },
  l4: { speed: 'speed_l4', price: 'gpu_l4_hour' },
  t4: { speed: 'speed_t4', price: 'gpu_t4_hour' },
});

/** Render work for `seconds` of finished video: { gpu_s (H100-seconds), cpu_s (runner-seconds) }. */
export function renderWork(seconds, profile = 'hybrid') {
  const mix = PROFILES[profile];
  if (!mix) throw new Error(`unknown profile ${profile}`);
  const gpu = (mix.gen_quality || 0) * A('gen_quality_gpu_s') + (mix.gen_fast || 0) * A('gen_fast_gpu_s') + (mix.blender || 0) * A('blender_gpu_s');
  return { gpu_s: seconds * gpu, cpu_s: seconds * (mix.composited || 0) * A('composited_cpu_s') };
}

/** Erlang C: probability an arrival waits, for c servers at offered load a = lambda/mu (a < c). */
export function erlangC(c, a) {
  if (a <= 0) return 0;
  if (a >= c) return 1;
  // Iterative Erlang B, then convert: numerically stable for c in the millions.
  let b = 1;
  for (let k = 1; k <= c; k += 1) b = (a * b) / (k + a * b);
  return b / (1 - (a / c) * (1 - b));
}

/** Mean wait in an M/M/c queue, in the same time unit as `service`. Infinity when overloaded. */
export function meanWait(c, arrivalsPerUnit, service) {
  const a = arrivalsPerUnit * service;
  if (a >= c) return Infinity;
  return (erlangC(c, a) * service) / (c - a);
}

/** Pre-job estimate for one video: GPU and CPU time, wall time on `gpus` parallel workers, storage, cost range. */
export function estimateVideo({ minutes, profile = 'hybrid', gpu = 'h100', gpus = 1 } = {}) {
  const seconds = Math.max(0, Number(minutes) || 0) * 60;
  const w = renderWork(seconds, profile);
  const g = GPU_TYPES[gpu] || GPU_TYPES.h100;
  const gpuSecondsOnType = w.gpu_s / A(g.speed);
  const segments = Math.max(1, Math.ceil(seconds / A('segment_s')));
  const perSegment = gpuSecondsOnType / segments;
  const waves = Math.ceil(segments / Math.max(1, Math.min(gpus, A('max_parallel_segments'))));
  const finalMb = (seconds * A('video_mbps')) / 8;
  return {
    minutes: seconds / 60, profile, gpu, gpus, segments,
    gpu_hours: round(gpuSecondsOnType / 3600, 3),
    h100_hours: round(w.gpu_s / 3600, 3),
    cpu_runner_hours: round(w.cpu_s / 3600, 3),
    wall_minutes: round((waves * perSegment + A('stitch_s')) / 60, 1),
    storage_mb: { final: round(finalMb, 1), temp: round(finalMb * A('temp_factor'), 1), thumbnails: A('thumb_mb') },
    cost_usd: {
      free_path: 0,
      paid: round((gpuSecondsOnType / 3600) * A(g.price) + (w.cpu_s / 3600) * A('cpu_runner_hour') * 4, 2),
    },
    note: 'Estimate from capacity_model.js ASSUMPTIONS; the receipt of the finished job is the real number.',
  };
}

/**
 * One scenario. `videos` = per-hour starts per active user for each length, e.g. { 1: 0.1, 10: 0.03, 30: 0.01 }.
 * Returns the full sizing at peak plus a monthly view.
 */
export function simulate({ name = 'scenario', users, videos = { 1: 0.1, 10: 0.03, 30: 0.01 }, profile = 'hybrid', gpu = 'h100', gpus = null, cpuRunners = null } = {}) {
  const u = Math.max(0, Number(users) || 0);
  const g = GPU_TYPES[gpu] || GPU_TYPES.h100;
  const speed = A(g.speed);
  // Chat and API.
  const turnsPerS = u / A('chat_turn_s');
  const workerRps = turnsPerS * A('worker_requests_per_turn');
  const doShards = Math.max(1, Math.ceil(u)); // one Durable Object per tenant: isolation is also the shard key
  const hottestShardRps = A('worker_requests_per_turn') / A('chat_turn_s');
  // Video demand in the peak hour.
  const lengths = Object.entries(videos).map(([m, rate]) => ({ minutes: Number(m), perHour: u * Number(rate) }));
  let gpuSPerHour = 0; let cpuSPerHour = 0; let outputSPerHour = 0; let jobsPerHour = 0; let segmentsPerHour = 0;
  for (const l of lengths) {
    const w = renderWork(l.minutes * 60, profile);
    gpuSPerHour += l.perHour * (w.gpu_s / speed);
    cpuSPerHour += l.perHour * w.cpu_s;
    outputSPerHour += l.perHour * l.minutes * 60;
    jobsPerHour += l.perHour;
    segmentsPerHour += l.perHour * Math.ceil((l.minutes * 60) / A('segment_s'));
  }
  const gpusNeeded = Math.ceil(gpuSPerHour / 3600 / A('utilization'));
  const cpuNeeded = Math.ceil(cpuSPerHour / 3600 / A('utilization'));
  const gpuPool = gpus == null ? gpusNeeded : gpus;
  const cpuPool = cpuRunners == null ? cpuNeeded : cpuRunners;
  // Queueing: segments are the unit of scheduling (each length's segments spread across the pool).
  const segGpuS = segmentsPerHour > 0 ? gpuSPerHour / segmentsPerHour : 0;
  const waitS = gpuPool > 0 && segGpuS > 0 ? meanWait(gpuPool, segmentsPerHour / 3600, segGpuS) : (segGpuS > 0 ? Infinity : 0);
  const completion = {};
  for (const l of lengths) {
    const segs = Math.ceil((l.minutes * 60) / A('segment_s'));
    const w = renderWork(l.minutes * 60, profile);
    const perSeg = w.gpu_s / speed / segs;
    // A job gets its fair share: the idle part of the pool, capped per job so one user never takes it all.
    const share = Math.max(1, Math.min(segs, A('max_parallel_segments'), Math.floor(gpuPool * (1 - A('utilization')))));
    const gpuWall = Number.isFinite(waitS) ? waitS + Math.ceil(segs / share) * perSeg : Infinity;
    const cpuWall = (w.cpu_s / Math.max(1, Math.min(segs, cpuPool || 1)));
    completion[`${l.minutes}_min`] = Number.isFinite(gpuWall) ? round((Math.max(gpuWall, cpuWall) + A('stitch_s')) / 60, 1) : 'never (the pool cannot keep up)';
  }
  // Storage and bandwidth.
  const finalGbPerHour = (outputSPerHour * A('video_mbps')) / 8 / 1024;
  const hoursPerMonth = A('active_hours_per_day') * 30;
  const finalGbMonth = finalGbPerHour * hoursPerMonth;
  const tempGbSteady = finalGbPerHour * A('temp_factor') * A('active_hours_per_day') * A('temp_days');
  const thumbsGbMonth = (jobsPerHour * hoursPerMonth * A('thumb_mb')) / 1024;
  const brainGb = (u * A('brain_mb_per_user')) / 1024;
  const egressGbMonth = finalGbMonth * A('views_per_video');
  // Monthly cost (one month of new output; stored output accumulates month over month).
  const gpuHoursMonth = (gpuSPerHour / 3600) * hoursPerMonth;
  const cpuHoursMonth = (cpuSPerHour / 3600) * hoursPerMonth;
  const requestsMonth = workerRps * 3600 * hoursPerMonth;
  const tokensMonth = turnsPerS * 3600 * hoursPerMonth * A('tokens_per_turn');
  const r2Gb = Math.max(0, finalGbMonth + tempGbSteady + thumbsGbMonth - A('r2_free_gb'));
  const cost = {
    gpu: round(gpuHoursMonth * A(g.price), 0),
    cpu_render: round(cpuHoursMonth * A('cpu_runner_hour') * 4, 0),
    r2_storage_first_month: round(r2Gb * A('r2_storage_gb_month'), 0),
    r2_operations: round(((jobsPerHour * hoursPerMonth * 40) / 1e6) * A('r2_class_a_per_m') + ((jobsPerHour * hoursPerMonth * A('views_per_video') * 20) / 1e6) * A('r2_class_b_per_m'), 0),
    workers: round(A('workers_paid_base') + Math.max(0, requestsMonth - 10e6) / 1e6 * A('workers_requests_per_m'), 0),
    durable_objects: round(Math.max(0, requestsMonth - 1e6) / 1e6 * A('do_requests_per_m') + Math.max(0, brainGb - 5) * A('do_storage_gb_month'), 0),
    llm: round((tokensMonth / 1e6) * A('llm_tokens_per_m'), 0),
    egress: 0,
  };
  cost.total = Object.values(cost).reduce((s, v) => s + v, 0);
  return {
    name, users: u, profile, gpu,
    chat: { turns_per_s: round(turnsPerS, 1), worker_rps: round(workerRps, 0), durable_objects: doShards, hottest_object_rps: round(hottestShardRps, 3), do_limit_rps: A('do_rps_per_object') },
    video: {
      jobs_per_hour: round(jobsPerHour, 0), output_hours_per_hour: round(outputSPerHour / 3600, 1),
      gpu_hours_per_hour: round(gpuSPerHour / 3600, 1), cpu_runner_hours_per_hour: round(cpuSPerHour / 3600, 1),
      gpus_needed: gpusNeeded, cpu_runners_needed: cpuNeeded, gpu_pool: gpuPool,
      queue_wait_min: Number.isFinite(waitS) ? round(waitS / 60, 2) : 'unbounded', completion_min: completion,
    },
    storage_gb: { new_final_per_month: round(finalGbMonth, 0), temp_steady: round(tempGbSteady, 0), thumbnails_per_month: round(thumbsGbMonth, 0), brains: round(brainGb, 0) },
    bandwidth_gb_per_month: round(egressGbMonth, 0),
    monthly_cost_usd: cost,
    assumptions: 'capacity_model.js ASSUMPTIONS (prices are 2026 third-party summaries; render speeds are benchmarks or CHE assumptions to calibrate).',
  };
}

/** A fixed batch (e.g. 1,000,000 thirty-minute videos): total work, time to finish with `gpus`, storage, cost. */
export function batch({ count, minutes, profile = 'hybrid', gpu = 'h100', gpus = 10_000, cpuRunners = 10_000 } = {}) {
  const g = GPU_TYPES[gpu] || GPU_TYPES.h100;
  const w = renderWork(minutes * 60, profile);
  const gpuHours = (count * w.gpu_s) / A(g.speed) / 3600;
  const cpuHours = (count * w.cpu_s) / 3600;
  const finalTb = (count * minutes * 60 * A('video_mbps')) / 8 / 1024 / 1024;
  const days = Math.max(gpus > 0 ? gpuHours / gpus : Infinity, cpuRunners > 0 ? cpuHours / cpuRunners : Infinity) / 24 / A('utilization');
  return {
    count, minutes, profile, gpu, gpus, cpu_runners: cpuRunners,
    output_hours: round((count * minutes) / 60, 0), gpu_hours: round(gpuHours, 0), cpu_runner_hours: round(cpuHours, 0),
    days_to_finish: round(days, 1), storage_tb: round(finalTb, 1),
    storage_usd_per_month: round(finalTb * 1024 * A('r2_storage_gb_month'), 0),
    compute_usd: round(gpuHours * A(g.price) + cpuHours * A('cpu_runner_hour') * 4, 0),
  };
}

/** The owner's five scenarios, in one call. */
export function scenarios() {
  return {
    one_user: simulate({ name: '1 user (today)', users: 1 }),
    users_1k: simulate({ name: '1,000 simultaneous users', users: 1_000 }),
    users_100k: simulate({ name: '100,000 simultaneous users', users: 100_000 }),
    users_1m: simulate({ name: '1,000,000 simultaneous users', users: 1_000_000 }),
    videos_1m_30min: {
      hybrid: batch({ count: 1_000_000, minutes: 30, profile: 'hybrid' }),
      composited: batch({ count: 1_000_000, minutes: 30, profile: 'composited' }),
      gen_quality: batch({ count: 1_000_000, minutes: 30, profile: 'gen_quality' }),
    },
  };
}

function round(n, d) {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
