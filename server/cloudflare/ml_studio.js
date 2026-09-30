// CHE ML studio — supervised + unsupervised learning jobs with real metrics.
// Classification / clustering run on the Worker (embeddings via Workers AI when
// available; otherwise hashed bag-of-words features). Not chat-memorization.
// Owner confirm before spending on external training endpoints (fine_tuning.js).

import { embedForMemory, vectorMemoryReadiness } from './vector_memory.js';
import { fineTuneReadiness } from './fine_tuning.js';

export const ML_JOB_KINDS = ['classification', 'clustering', 'supervised', 'unsupervised', 'evaluate'];

function clip(value, max = 4000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function tokenize(text) {
  return clip(text, 8000).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

/** Deterministic hashed bag-of-words vector (dim fixed) for offline ML. */
export function hashEmbed(text, dim = 64) {
  const v = new Array(dim).fill(0);
  for (const tok of tokenize(text)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dim;
    const sign = (h & 1) === 0 ? 1 : -1;
    v[idx] += sign;
  }
  return l2normalize(v);
}

export function l2normalize(vec) {
  let s = 0;
  for (const n of vec) s += n * n;
  const nrm = Math.sqrt(s) || 1;
  return vec.map((n) => n / nrm);
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function euclidean(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// ─── Metrics ───────────────────────────────────────────────────────────────

export function classificationMetrics(yTrue, yPred) {
  const labels = [...new Set([...yTrue, ...yPred].map(String))];
  const n = yTrue.length;
  let correct = 0;
  const per = {};
  for (const lab of labels) {
    per[lab] = { tp: 0, fp: 0, fn: 0, support: 0 };
  }
  for (let i = 0; i < n; i++) {
    const t = String(yTrue[i]);
    const p = String(yPred[i]);
    if (per[t]) per[t].support += 1;
    if (t === p) {
      correct += 1;
      if (per[t]) per[t].tp += 1;
    } else {
      if (per[p]) per[p].fp += 1;
      if (per[t]) per[t].fn += 1;
    }
  }
  const accuracy = n ? correct / n : 0;
  const rows = [];
  let sumF1 = 0;
  let sumP = 0;
  let sumR = 0;
  let labeled = 0;
  for (const lab of labels) {
    const { tp, fp, fn, support } = per[lab];
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    rows.push({ label: lab, precision, recall, f1, support });
    if (support > 0) {
      sumF1 += f1;
      sumP += precision;
      sumR += recall;
      labeled += 1;
    }
  }
  const macro_f1 = labeled ? sumF1 / labeled : 0;
  const macro_precision = labeled ? sumP / labeled : 0;
  const macro_recall = labeled ? sumR / labeled : 0;
  // Confusion matrix (rows = truth, cols = pred)
  const matrix = labels.map(() => labels.map(() => 0));
  const index = new Map(labels.map((lab, i) => [lab, i]));
  for (let i = 0; i < n; i++) {
    const ti = index.get(String(yTrue[i]));
    const pi = index.get(String(yPred[i]));
    if (ti == null || pi == null) continue;
    matrix[ti][pi] += 1;
  }
  return {
    task: 'classification',
    n,
    accuracy,
    precision: macro_precision,
    recall: macro_recall,
    f1: macro_f1,
    macro_precision,
    macro_recall,
    macro_f1,
    per_label: rows,
    confusion_matrix: {
      labels,
      matrix,
      summary: `${correct}/${n} correct`,
    },
  };
}

/** Mean silhouette coefficient (−1..1) for soft cluster quality. */
export function silhouetteScore(vectors, labels) {
  const n = vectors.length;
  if (n < 2) return 0;
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const lab = String(labels[i]);
    if (!clusters.has(lab)) clusters.set(lab, []);
    clusters.get(lab).push(i);
  }
  if (clusters.size < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const lab = String(labels[i]);
    const same = clusters.get(lab) || [];
    let a = 0;
    if (same.length > 1) {
      for (const j of same) {
        if (j === i) continue;
        a += euclidean(vectors[i], vectors[j]);
      }
      a /= same.length - 1;
    }
    let b = Infinity;
    for (const [other, idxs] of clusters) {
      if (other === lab || !idxs.length) continue;
      let dist = 0;
      for (const j of idxs) dist += euclidean(vectors[i], vectors[j]);
      dist /= idxs.length;
      if (dist < b) b = dist;
    }
    const s = b === Infinity && a === 0 ? 0 : (b - a) / Math.max(a, b, 1e-9);
    sum += s;
  }
  return sum / n;
}

export function clusteringInertia(vectors, labels, centroids) {
  let s = 0;
  for (let i = 0; i < vectors.length; i++) {
    const c = centroids[String(labels[i])];
    if (!c) continue;
    const d = euclidean(vectors[i], c);
    s += d * d;
  }
  return s;
}

// ─── Algorithms ────────────────────────────────────────────────────────────

function meanVectors(vectors) {
  if (!vectors.length) return [];
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  return l2normalize(out.map((n) => n / vectors.length));
}

/** Nearest-centroid supervised classifier (works on embeddings or hash vectors). */
export function fitNearestCentroid(trainX, trainY) {
  const by = new Map();
  for (let i = 0; i < trainX.length; i++) {
    const y = String(trainY[i]);
    if (!by.has(y)) by.set(y, []);
    by.get(y).push(trainX[i]);
  }
  const centroids = {};
  for (const [lab, vecs] of by) centroids[lab] = meanVectors(vecs);
  return { kind: 'nearest_centroid', centroids };
}

export function predictNearestCentroid(model, x) {
  let best = null;
  let bestScore = -Infinity;
  for (const [lab, c] of Object.entries(model.centroids || {})) {
    const score = cosine(x, c);
    if (score > bestScore) {
      bestScore = score;
      best = lab;
    }
  }
  return best ?? 'unknown';
}

/** Mini k-means (k-means++-lite init), deterministic for small n. */
export function kMeans(vectors, k = 3, maxIter = 25) {
  const n = vectors.length;
  if (!n) return { labels: [], centroids: {}, inertia: 0, k: 0 };
  const kk = Math.max(1, Math.min(k, n));
  const centroids = [];
  centroids.push(vectors[0].slice());
  while (centroids.length < kk) {
    let far = 0;
    let farIdx = 0;
    for (let i = 0; i < n; i++) {
      let dmin = Infinity;
      for (const c of centroids) dmin = Math.min(dmin, euclidean(vectors[i], c));
      if (dmin > far) {
        far = dmin;
        farIdx = i;
      }
    }
    centroids.push(vectors[farIdx].slice());
  }
  let labels = new Array(n).fill('0');
  for (let iter = 0; iter < maxIter; iter++) {
    const groups = Array.from({ length: kk }, () => []);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = euclidean(vectors[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      labels[i] = String(best);
      groups[best].push(vectors[i]);
    }
    for (let c = 0; c < kk; c++) {
      if (groups[c].length) centroids[c] = meanVectors(groups[c]);
    }
  }
  const centroidMap = {};
  for (let c = 0; c < kk; c++) centroidMap[String(c)] = centroids[c];
  return {
    labels,
    centroids: centroidMap,
    inertia: clusteringInertia(vectors, labels, centroidMap),
    k: kk,
  };
}

export function trainTestSplit(items, holdout = 0.25) {
  const n = items.length;
  const testN = Math.max(1, Math.min(n - 1, Math.round(n * holdout)));
  const train = items.slice(0, n - testN);
  const test = items.slice(n - testN);
  return { train, test };
}

// ─── Job runners ───────────────────────────────────────────────────────────

export function mlReadiness(env) {
  const vec = vectorMemoryReadiness(env);
  const ft = fineTuneReadiness(env);
  return {
    embeddings: vec.embeddings,
    embedding_model: vec.embedding_model,
    local_hash_features: true,
    supervised: true,
    unsupervised: true,
    classification: true,
    clustering: true,
    fine_tuning: ft,
    note: 'CHE runs classification/clustering on-Worker with real metrics. Hosted LoRA fine-tuning still needs owner-approved VMware/HF endpoints.',
  };
}

/**
 * Normalize owner/API examples:
 * classification: [{ text, label }]
 * clustering: [{ text }] or strings
 */
export function normalizeExamples(body = {}) {
  const raw = Array.isArray(body.examples)
    ? body.examples
    : Array.isArray(body.samples)
      ? body.samples
      : Array.isArray(body.texts)
        ? body.texts
        : [];
  return raw.map((row, i) => {
    if (typeof row === 'string') return { id: String(i), text: clip(row, 4000), label: null };
    if (row && typeof row === 'object') {
      return {
        id: String(row.id ?? i),
        text: clip(row.text ?? row.content ?? row.input ?? '', 4000),
        label: row.label != null ? String(row.label).slice(0, 80) : (row.y != null ? String(row.y).slice(0, 80) : null),
      };
    }
    return { id: String(i), text: '', label: null };
  }).filter((r) => r.text);
}

async function embedAll(env, texts) {
  const out = [];
  let mode = 'hash';
  for (const text of texts) {
    let v = null;
    if (env?.AI) {
      try {
        v = await embedForMemory(env, text);
      } catch (_) {
        v = null;
      }
    }
    if (v) {
      mode = 'workers_ai';
      out.push(l2normalize(v));
    } else {
      out.push(hashEmbed(text));
    }
  }
  return { vectors: out, feature_mode: mode };
}

export async function runClassificationJob(env, body = {}) {
  const examples = normalizeExamples(body);
  const labeled = examples.filter((e) => e.label != null && e.label !== '');
  if (labeled.length < 4) {
    return { ok: false, status: 400, detail: 'Need at least 4 labeled examples for classification (text + label).' };
  }
  const holdout = Math.max(0.15, Math.min(0.4, Number(body.holdout || body.holdout_fraction || 0.25)));
  const { train, test } = trainTestSplit(labeled, holdout);
  if (!train.length || !test.length) {
    return { ok: false, status: 400, detail: 'Train/test split failed — add more labeled examples.' };
  }
  const { vectors: allVec, feature_mode } = await embedAll(env, labeled.map((e) => e.text));
  const trainX = allVec.slice(0, train.length);
  const testX = allVec.slice(train.length);
  const trainY = train.map((e) => e.label);
  const testY = test.map((e) => e.label);
  const model = fitNearestCentroid(trainX, trainY);
  const pred = testX.map((x) => predictNearestCentroid(model, x));
  const metrics = classificationMetrics(testY, pred);
  return {
    ok: true,
    kind: 'classification',
    learning: 'supervised',
    algorithm: 'nearest_centroid',
    feature_mode,
    labels: [...new Set(labeled.map((e) => e.label))],
    train_n: train.length,
    test_n: test.length,
    metrics,
    predictions: test.map((e, i) => ({ id: e.id, text: e.text.slice(0, 120), truth: e.label, pred: pred[i] })),
    progress: 1,
    status: 'complete',
  };
}

export async function runClusteringJob(env, body = {}) {
  const examples = normalizeExamples(body);
  if (examples.length < 4) {
    return { ok: false, status: 400, detail: 'Need at least 4 texts for clustering.' };
  }
  const k = Math.max(2, Math.min(12, Number(body.k || body.clusters || 3)));
  const { vectors, feature_mode } = await embedAll(env, examples.map((e) => e.text));
  const result = kMeans(vectors, k);
  const sil = silhouetteScore(vectors, result.labels);
  const sizes = {};
  for (const lab of result.labels) sizes[lab] = (sizes[lab] || 0) + 1;
  return {
    ok: true,
    kind: 'clustering',
    learning: 'unsupervised',
    algorithm: 'kmeans',
    feature_mode,
    k: result.k,
    metrics: {
      task: 'clustering',
      n: examples.length,
      k: result.k,
      silhouette: sil,
      inertia: result.inertia,
      cluster_sizes: sizes,
    },
    assignments: examples.map((e, i) => ({
      id: e.id,
      text: e.text.slice(0, 120),
      cluster: result.labels[i],
    })),
    progress: 1,
    status: 'complete',
  };
}

export async function runMlJob(env, body = {}) {
  const kind = String(body.kind || body.task || body.type || 'classification').toLowerCase();
  if (kind === 'clustering' || kind === 'unsupervised' || kind === 'cluster') {
    return runClusteringJob(env, body);
  }
  if (kind === 'classification' || kind === 'supervised' || kind === 'classify' || kind === 'evaluate') {
    return runClassificationJob(env, body);
  }
  return { ok: false, status: 400, detail: `Unknown ML kind "${kind}". Use classification or clustering.` };
}

export function parseMlPhrase(original, normalized) {
  const o = String(original || '').trim();
  const t = String(normalized || '').toLowerCase();
  if (!t) return null;
  const wantsMl = /\b(?:ml|machine learning|learning job|model eval|ml.?eval)\b/.test(t)
    || /\b(?:classif(?:y|ication)|cluster(?:ing)?|k-?means|k-?nn|supervised|unsupervised)\b/.test(t);
  if (!wantsMl) return null;
  // Avoid stealing plain "tell the office to classify this as Roblox" without ml cues —
  // require an action verb or explicit ml/eval wording when only "classify" appears.
  const actionable = /\b(?:train|run|start|kick|do|make|evaluate|eval|learn)\b/.test(t)
    || /\bml\b/.test(t)
    || /\bmachine learning\b/.test(t)
    || /\bml.?eval\b/.test(t)
    || /\blearning job\b/.test(t);
  if (!actionable && !/\b(?:clustering|unsupervised|supervised)\b/.test(t)) return null;
  let kind = 'classification';
  if (/\bcluster|unsupervised|k-?means\b/.test(t)) kind = 'clustering';
  else if (/\bclassif|supervised|k-?nn\b/.test(t)) kind = 'classification';
  return { type: 'mlJob', kind, task: o.slice(0, 500), owner_confirm_required: false };
}

export function speakMlPlan(result) {
  if (!result?.ok) return `CHE here. ML job did not run: ${result?.detail || 'unknown error'}.`;
  if (result.kind === 'classification') {
    const m = result.metrics || {};
    const cm = m.confusion_matrix?.summary ? ` Confusion: ${m.confusion_matrix.summary}.` : '';
    return `CHE here. Supervised classification finished. Accuracy ${(m.accuracy * 100).toFixed(1)} percent. Macro F1 ${(m.macro_f1 * 100).toFixed(1)}. Precision ${(m.macro_precision * 100).toFixed(1)}, recall ${(m.macro_recall * 100).toFixed(1)}. Features: ${result.feature_mode}.${cm}`;
  }
  const m = result.metrics || {};
  return `CHE here. Unsupervised clustering finished. k=${m.k}. Silhouette ${Number(m.silhouette || 0).toFixed(3)}. Inertia ${Number(m.inertia || 0).toFixed(2)}. Features: ${result.feature_mode}.`;
}

/** Persist-friendly project payload from an ML result. */
export function mlProjectFromResult(result, taskText = '') {
  const now = new Date().toISOString();
  const kind = result.kind || 'classification';
  const title = kind === 'clustering'
    ? `ML clustering · k=${result.k || result.metrics?.k || '?'}`
    : `ML classification · ${result.labels?.length || '?'} labels`;
  const metrics = result.metrics || {};
  const lines = [
    `# ${title}`,
    '',
    `Learning: ${result.learning}`,
    `Algorithm: ${result.algorithm}`,
    `Features: ${result.feature_mode}`,
    `Task: ${clip(taskText, 400)}`,
    '',
    '## Metrics',
    '```json',
    JSON.stringify(metrics, null, 2).slice(0, 6000),
    '```',
  ];
  return {
    id: crypto.randomUUID(),
    title,
    type: kind === 'clustering' ? 'ml_clustering' : 'ml_classification',
    goal_kind: 'ml_eval',
    brief: clip(taskText || title, 2000),
    content: lines.join('\n'),
    status: 'complete',
    metrics,
    learning: result.learning,
    ml_kind: kind,
    feature_mode: result.feature_mode,
    owner_confirm_required: false,
    created_at: now,
    updated_at: now,
  };
}
