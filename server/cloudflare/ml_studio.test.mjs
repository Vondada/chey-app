import assert from 'node:assert/strict';
import {
  classificationMetrics,
  hashEmbed,
  kMeans,
  runClassificationJob,
  runClusteringJob,
  silhouetteScore,
  parseMlPhrase,
} from './ml_studio.js';

const examples = [
  { text: 'buy laptop online store', label: 'shop' },
  { text: 'purchase headphones shopping cart', label: 'shop' },
  { text: 'order shoes ecommerce', label: 'shop' },
  { text: 'soccer match score goals', label: 'sports' },
  { text: 'basketball championship game', label: 'sports' },
  { text: 'tennis tournament winner', label: 'sports' },
  { text: 'recipe pasta cooking dinner', label: 'food' },
  { text: 'bake cake kitchen ingredients', label: 'food' },
];

const clf = await runClassificationJob({}, { examples, holdout: 0.25 });
assert.equal(clf.ok, true);
assert.equal(clf.learning, 'supervised');
assert.ok(clf.metrics.accuracy >= 0);
assert.ok('macro_f1' in clf.metrics);

const cluster = await runClusteringJob({}, { examples: examples.map((e) => e.text), k: 3 });
assert.equal(cluster.ok, true);
assert.equal(cluster.learning, 'unsupervised');
assert.ok('silhouette' in cluster.metrics);

const m = classificationMetrics(['a', 'a', 'b', 'b'], ['a', 'b', 'b', 'b']);
assert.ok(m.accuracy > 0 && m.accuracy <= 1);

const vecs = examples.map((e) => hashEmbed(e.text));
const km = kMeans(vecs, 3);
assert.equal(km.labels.length, examples.length);
assert.ok(Number.isFinite(silhouetteScore(vecs, km.labels)));

const phrase = parseMlPhrase('Run classification on my labels', 'run classification on my labels');
assert.equal(phrase?.type, 'mlJob');
assert.equal(phrase?.kind, 'classification');

console.log('ml_studio.test.mjs ok');

const m2 = classificationMetrics(['a', 'a', 'b', 'b'], ['a', 'b', 'b', 'b']);
assert.ok(m2.confusion_matrix);
assert.match(m2.confusion_matrix.summary, /correct/);
assert.ok('precision' in m2 && 'recall' in m2 && 'f1' in m2);

const clusterPhrase = parseMlPhrase('Start clustering now', 'start clustering now');
assert.equal(clusterPhrase?.type, 'mlJob');
assert.equal(clusterPhrase?.kind, 'clustering');
