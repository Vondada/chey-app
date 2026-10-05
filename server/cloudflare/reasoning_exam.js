// CHE five-layer autonomy exam, layers 1-4: reasoning problems answered by
// CHE's own router (whatever healthy engine it picks) and graded by
// deterministic checks, never by a model's opinion. Layer 5 is the existing
// autonomy exam level 5 (autonomy_exam.js): a real self-patch through CHE's
// self-development pipeline with injected failures. An engine outage or an
// empty answer is infrastructure: the layer is ungradable and retried, never
// scored as an intelligence failure.

import { routeText } from './ai_router.js';

export const LAYER_RESULTS_KEY = 'che_reasoning_exam';

const BATCH_CODE = `def batch_average_sensor_readings(data_packets, default_bias=0.0):
    """Memory-efficient average calculation using generator expression."""
    from typing import Iterable, Dict, Optional
    results: Dict[str, float] = {}
    counts: Dict[str, int] = {}
    for packet in data_packets:
        for sensor_id, val in packet.items():
            if val is not None:
                results[sensor_id] = results.get(sensor_id, 0.0) + (val - default_bias)
                counts[sensor_id] = counts.get(sensor_id, 0) + 1
    return {k: results[k] / counts[k] for k in results if counts[k] > 0}`;

const THRUSTER_CODE = `import threading

class ThrusterManager:
    def __init__(self):
        self.fuel_lock = threading.Lock()
        self.nozzle_lock = threading.Lock()
        self.fuel = 100.0
        self.angle = 0.0

    def fire(self, amount):
        with self.fuel_lock:
            with self.nozzle_lock:
                self.fuel -= amount

    def gimbal(self, angle):
        with self.nozzle_lock:
            with self.fuel_lock:
                self.angle = angle`;

// Reference values for layer 3 (mu = 398600.4418 km^3/s^2, Re = 6378.137 km).
const HOHMANN = { dv1: 2.3975, dv2: 1.4565, tof: 5.2912, mf: 2087.81 };

export const REASONING_LAYERS = [
  {
    layer: 1,
    name: 'Constraint reasoning',
    prompt: 'A steel ball is released from rest 45 meters above flat ground (use g = 10 m/s^2, ignore air resistance). How many seconds until it reaches the ground, and what is its speed in m/s at impact? Show the reasoning. Rules: your answer must NOT contain the words "gravity", "fall", "falling" or "drop" anywhere. The last line of your answer must be exactly: ASSERT time_s=<number> speed_ms=<number>',
    forbidden: /\b(?:gravity|fall|falling|drop)\b/i,
  },
  {
    layer: 2,
    name: 'Production debugging',
    prompt: `Audit this production Python function. A teammate claims it has three bugs: (a) it divides by zero on an empty batch, (b) sum() overflows on large float batches in Python, (c) a non-numeric, NaN or infinite reading crashes it or poisons the average. Say which claims are REAL bugs and which are FALSE premises, and why. Then return a production-quality, type-annotated replacement that skips invalid readings (non-numeric, bool, NaN, infinity), returns None for a batch with no valid readings, and uses streaming aggregates (a running total and count) instead of building a list of readings. Put the code in one \`\`\`python block.\n\n\`\`\`python\n${BATCH_CODE}\n\`\`\``,
  },
  {
    layer: 3,
    name: 'Orbital mechanics',
    prompt: 'Plan a Hohmann transfer from a circular LEO at 400 km altitude to GEO (orbital radius 42,164 km). Use mu = 398600.4418 km^3/s^2 and Earth radius 6378.137 km. Derive and compute: the first burn delta-v, the second (circularization) burn delta-v, and the transfer time in hours. Then, for a 5,000 kg spacecraft with Isp = 450 s (g0 = 9.80665 m/s^2), use the rocket equation to find the final mass after both burns. Show every formula and intermediate value so the calculation can be audited. The last line must be exactly: ASSERT dv1_kms=<number> dv2_kms=<number> tof_h=<number> mf_kg=<number>',
  },
  {
    layer: 4,
    name: 'Concurrency',
    prompt: `This flight-control class sometimes hangs. Find the defect, explain the exact thread interleaving that causes it (which thread holds which lock and waits for which), and return a verified thread-safe implementation with the same public methods. Put the code in one \`\`\`python block.\n\n\`\`\`python\n${THRUSTER_CODE}\n\`\`\``,
  },
];

export function reasoningLayer(layer) {
  return REASONING_LAYERS.find((item) => item.layer === Number(layer)) || null;
}

const num = (text, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, 'i').exec(text);
  return m ? Number(m[1]) : NaN;
};
const near = (value, expected, tolerance) => Number.isFinite(value) && Math.abs(value - expected) <= Math.abs(expected) * tolerance;
const lastLine = (text) => String(text || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
// The LAST code block is the answer (the first is often the quoted original).
const pythonBlock = (text) => [...String(text || '').matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]).pop() || '';

// Lock acquisition order per method: [['fire', ['fuel_lock', 'nozzle_lock']], ...].
export function lockOrders(code) {
  const methods = [];
  let current = null;
  for (const line of String(code || '').split('\n')) {
    const def = /^\s*def\s+(\w+)/.exec(line);
    if (def) { current = { name: def[1], locks: [] }; methods.push(current); continue; }
    if (!current) continue;
    // "with self.a, self.b:" takes both, in order.
    const withItems = /^\s*(?:async\s+)?with\s+(.+?):\s*$/.exec(line);
    if (withItems) for (const m of withItems[1].matchAll(/self\.(\w+)/g)) current.locks.push(m[1]);
    for (const m of line.matchAll(/self\.(\w+)\.acquire\s*\(/g)) current.locks.push(m[1]);
  }
  return methods;
}

/** True when two methods take the same pair of locks in opposite orders. */
export function hasLockOrderInversion(code) {
  const seen = new Set();
  for (const { locks } of lockOrders(code)) {
    for (let i = 0; i < locks.length; i += 1) {
      for (let j = i + 1; j < locks.length; j += 1) {
        if (locks[i] === locks[j]) continue;
        if (seen.has(`${locks[j]}>${locks[i]}`)) return true;
        seen.add(`${locks[i]}>${locks[j]}`);
      }
    }
  }
  return false;
}

/** Deterministic grade of one layer's answer. */
export function gradeReasoningLayer(spec, answer) {
  const text = String(answer || '');
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 200) } : {}) });
  if (spec.layer === 1) {
    const last = lastLine(text);
    check('ends with the required assertion', /^ASSERT\s+time_s=\S+\s+speed_ms=\S+$/.test(last), last);
    check('time is 3 s', near(num(last, 'time_s'), 3, 0.01), last);
    check('impact speed is 30 m/s', near(num(last, 'speed_ms'), 30, 0.01), last);
    check('never used a forbidden word', !spec.forbidden.test(text), (text.match(spec.forbidden) || [])[0]);
  } else if (spec.layer === 2) {
    const code = pythonBlock(text);
    check('returned one Python code block', Boolean(code));
    check('called empty-batch division a real bug', /(?:\(a\)|\bclaim a\b|\bempty\b)[^\n]{0,160}\b(?:real|valid|true|correct|genuine)\b/i.test(text));
    check('rejected the float-overflow premise', /overflow[^\n]{0,200}\b(?:false|not a (?:real )?bug|does(?:n't| not)|cannot|can't|won't|incorrect|myth)\b|(?:\(b\)|\bclaim b\b)[^\n]{0,200}\b(?:false|not a (?:real )?bug|incorrect)\b/i.test(text));
    check('typed signature', /def\s+batch_average_sensor_readings\s*\([^)]*:[^)]*\)\s*->/.test(code));
    check('rejects NaN and infinity', /isfinite|isnan|isinf/.test(code));
    check('rejects non-numeric and bool readings', /isinstance\s*\(/.test(code) && /\bbool\b/.test(code));
    check('streaming aggregates, no per-batch list of readings', /\+=/.test(code) && !/values\.append|readings\.append|valid\.append/.test(code) && !/\[\s*\w+\s+for\s+\w+\s+in\s+batch/.test(code));
    check('empty batch returns None', /\bNone\b/.test(code));
  } else if (spec.layer === 3) {
    const last = lastLine(text);
    check('ends with the required assertion', /^ASSERT\s+dv1_kms=/.test(last), last);
    check('first burn about 2.40 km/s', near(num(last, 'dv1_kms'), HOHMANN.dv1, 0.01), last);
    check('second burn about 1.46 km/s', near(num(last, 'dv2_kms'), HOHMANN.dv2, 0.01), last);
    check('transfer time about 5.29 h', near(num(last, 'tof_h'), HOHMANN.tof, 0.01), last);
    check('final mass about 2088 kg', near(num(last, 'mf_kg'), HOHMANN.mf, 0.01), last);
    check('shows the vis-viva and rocket-equation work', /vis.?viva|sqrt\s*\(\s*(?:mu|μ)|√/i.test(text) && /\bln\b|\bexp\b|e\^|rocket equation/i.test(text));
  } else if (spec.layer === 4) {
    const code = pythonBlock(text);
    check('named the deadlock', /deadlock/i.test(text));
    check('explained the interleaving', /fuel_lock/.test(text) && /nozzle_lock/.test(text) && /\bhold|holds|holding|acquired\b/i.test(text) && /\bwait|waits|waiting|blocks?\b/i.test(text));
    check('returned one Python code block', Boolean(code));
    check('kept the public methods', /def\s+fire\s*\(/.test(code) && /def\s+gimbal\s*\(/.test(code));
    check('no lock-order inversion remains', code && !hasLockOrderInversion(code), JSON.stringify(lockOrders(code).map((m) => [m.name, m.locks])));
    check('still uses locking', /threading\.(?:R?Lock|Condition)\s*\(/.test(code) && /with\s+self\.|\.acquire\s*\(/.test(code));
  }
  const passed = checks.length > 0 && checks.every((item) => item.ok);
  return {
    level: spec.layer,
    name: spec.name,
    passed,
    checks,
    failed_checks: checks.filter((item) => !item.ok).map((item) => item.name),
    failed_details: checks.filter((item) => !item.ok).map((item) => item.detail).filter(Boolean).slice(0, 3),
    at: new Date().toISOString(),
  };
}

/**
 * Runs one layer through CHE's router. Returns { grade, engine } or
 * { ungradable: true, reason } when no engine produced a usable answer.
 */
export async function runReasoningLayer(env, spec, { route = routeText, storage = null, fetcher = fetch } = {}) {
  let out;
  try {
    out = await route(env, env.CHE_STRONG_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You are CHE taking a graded exam. Follow every format rule exactly. Be correct and concise.' },
        { role: 'user', content: spec.prompt },
      ],
      max_tokens: 2400,
      che_strongest: true,
    }, fetcher, storage);
  } catch (error) {
    return { ungradable: true, reason: `engines unavailable: ${String(error?.message || error).slice(0, 200)}` };
  }
  const answer = String(out?.response ?? out?.choices?.[0]?.message?.content ?? '').trim();
  // A cut-off or empty answer is a transport failure, not a wrong answer.
  if (answer.length < 40) return { ungradable: true, reason: 'empty or truncated engine answer' };
  return { grade: { ...gradeReasoningLayer(spec, answer), engine: String(out?.engine || '').slice(0, 40) }, answer };
}

// "run the five layer exam", "five-layer autonomy exam", "reasoning exam".
export function fiveLayerIntent(message) {
  const text = String(message || '').toLowerCase();
  if (!/\b(?:five|5)[- ]layer\b|\breasoning exam\b/.test(text)) return null;
  if (/\b(?:results?|score|how did|status|report)\b/.test(text) && !/\b(?:run|start|do|take|begin)\b/.test(text)) return { kind: 'results' };
  // Only an explicit request starts a run ("what is the five layer exam?" does not).
  if (!/\b(?:run|start|do|take|begin|retake|redo)\b/.test(text)) return null;
  const layer = /\blayer\s*([1-5])\b/.exec(text)?.[1];
  return { kind: 'run', layers: layer ? [Number(layer)] : [1, 2, 3, 4, 5] };
}

export function speakFiveLayerResults(reasoning, coding) {
  const layers = reasoning?.results && typeof reasoning.results === 'object' ? reasoning.results : {};
  // Layer 5 is scored by the autonomy exam run this five-layer run started or joined.
  const codingRun = reasoning?.coding_run_id;
  const level5 = codingRun && coding?.run_id === codingRun ? coding.results?.[5] : null;
  const list = [1, 2, 3, 4].map((n) => layers[n]).filter(Boolean);
  if (level5) list.push({ ...level5, level: 5, name: 'Autonomous self-patching' });
  if (!list.length) return 'No five-layer exam has finished yet, sir. Say "run the five layer exam" to start it.';
  const passed = list.filter((item) => item.passed).length;
  const lines = list.map((item) => `Layer ${item.level}, ${item.name}: ${item.passed ? 'passed' : `failed (${(item.failed_details?.length ? item.failed_details : item.failed_checks || []).slice(0, 2).join('; ')})`}.`);
  return `Five-layer exam: ${passed} of ${list.length} finished layers passed, sir. ${lines.join(' ')}`;
}
