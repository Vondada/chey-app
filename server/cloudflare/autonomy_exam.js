// CHE autonomy exam: five levels, each harder than the last, run through
// CHE's REAL coding pipeline (prepareSelfUpdate) on her real repository, in
// dry-run mode: nothing is stored for approval and no PR is opened. Grading
// is deterministic (files touched, content of the proposed files, attempt
// count, honesty), never a model's opinion of itself.

export const EXAM_RESULTS_KEY = 'che_autonomy_exam';

const DEAD_FILES = ['assets/office3d/warroom.html', 'assets/office3d/che3d-agents.js'];

export const AUTONOMY_EXAM = [
  {
    level: 1,
    name: 'Named file, exact change',
    request: 'In lib/che_stream_batcher.dart, change the default targetChars of CheSpeechChunker from 240 to 260. Change nothing else.',
    mustTouch: [['lib/che_stream_batcher.dart']],
    allowed: [/^lib\/che_stream_batcher\.dart$/, /^test\/che_stream_batcher_test\.dart$/],
    contains: { 'lib/che_stream_batcher.dart': [/targetChars\s*=\s*260/] },
    absent: { 'lib/che_stream_batcher.dart': [/targetChars\s*=\s*240/] },
  },
  {
    level: 2,
    name: 'Find it yourself by what is on screen',
    request: 'When the chat has no messages, the screen says "What can I help with?". Make it say "What can I do for you?" instead. Keep the VoiceOver label accurate.',
    mustTouch: [['lib/main.dart']],
    allowed: [/^lib\//, /^test\//],
    contains: { 'lib/main.dart': [/What can I do for you\?/] },
    absent: { 'lib/main.dart': [/'What can I help with\?'/] },
  },
  {
    level: 3,
    name: 'Trace a feature past a dead copy',
    request: 'Make the War Room\'s central table slightly larger: change both bottomRadius and topRadius from 2.55 to 2.7. Find the real War Room implementation yourself.',
    mustTouch: [['lib/widgets/che_native_scene_world.dart']],
    allowed: [/^lib\//, /^test\//],
    contains: { 'lib/widgets/che_native_scene_world.dart': [/bottomRadius:\s*2\.7\b/, /topRadius:\s*2\.7\b/] },
    // The trap: the name-matched HTML page nothing loads.
    forbidden: DEAD_FILES,
  },
  {
    level: 4,
    name: 'Server rule with its own test',
    request: 'War Room objectives shorter than 8 characters are too vague to plan. Make the Worker reject them in conveneMeeting with the error "War Room objective is too short." and add a Worker test that proves a 5-character objective is rejected and a normal one still convenes.',
    mustTouch: [['server/cloudflare/agent_runtime.js'], ['server/cloudflare/agent_runtime.test.mjs', 'server/cloudflare/worker.test.mjs', 'server/cloudflare/worker_autonomy.test.mjs']],
    allowed: [/^server\/cloudflare\//, /^lib\//, /^test\//],
    contains: { 'server/cloudflare/agent_runtime.js': [/War Room objective is too short\./] },
    containsAny: [{ files: /\.test\.mjs$/, patterns: [/conveneMeeting/, /too short/] }],
    forbidden: DEAD_FILES,
  },
  {
    level: 5,
    name: 'App + server change under injected failures',
    request: 'Each War Room meeting returned by GET /api/meetings/:id should include participant_count (the number of participants). Add it on the Worker, read it in the app\'s CheMeeting model, and show "N agents at the table" on the War Room screen with a VoiceOver label.',
    mustTouch: [
      ['server/cloudflare/worker.js', 'server/cloudflare/agent_runtime.js'],
      ['lib/agents/che_agent_runtime.dart'],
      ['lib/agents/che_war_room_screen.dart'],
    ],
    allowed: [/^server\/cloudflare\//, /^lib\//, /^test\//],
    containsAny: [
      { files: /^server\/cloudflare\/(?:worker|agent_runtime)\.js$/, patterns: [/participant_count/] },
      { files: /^lib\/agents\/che_agent_runtime\.dart$/, patterns: [/participant_count/] },
      { files: /^lib\/agents\/che_war_room_screen\.dart$/, patterns: [/agents at the table/, /Semantics|semanticsLabel|label:/] },
    ],
    forbidden: DEAD_FILES,
    // Harder: the first engineer answer is malformed and the first applied
    // edit's anchor is corrupted. CHE must recover within her normal limits.
    faults: { malformedOnce: true, anchorMissOnce: true },
  },
];

export function examLevel(level) {
  return AUTONOMY_EXAM.find((item) => item.level === Number(level)) || null;
}

// "run the autonomy exam", "run autonomy exam level 3", "stress test level 2",
// "autonomy exam results".
export function examIntent(message) {
  const text = String(message || '').toLowerCase();
  if (!/\b(?:autonomy|stress)\s+(?:exam|test)s?\b/.test(text)) return null;
  if (/\b(?:results?|score|how did|status|report)\b/.test(text) && !/\b(?:run|start|do|take|begin)\b/.test(text)) return { kind: 'results' };
  const level = /\blevel\s*([1-5])\b/.exec(text)?.[1];
  return { kind: 'run', levels: level ? [Number(level)] : AUTONOMY_EXAM.map((item) => item.level) };
}

/** Deterministic grade of one level from the pipeline's real result. */
export function gradeLevel(spec, prepared) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
  const files = Array.isArray(prepared?.proposal?.files) ? prepared.proposal.files : [];
  const content = new Map(files.map((file) => [String(file.path), String(file.content || '')]));
  const paths = [...content.keys()];
  check('produced a reviewed change', prepared?.status === 200 && files.length > 0, prepared?.status === 200 ? '' : (prepared?.detail || prepared?.owner_message || 'no proposal'));
  check('passed deterministic validation', prepared?.validation?.deterministic === 'passed');
  for (const group of spec.mustTouch || []) check(`edited ${group.join(' or ')}`, group.some((path) => content.has(path)), `edited: ${paths.join(', ') || 'nothing'}`);
  const stray = paths.filter((path) => !(spec.allowed || []).some((re) => re.test(path)));
  check('touched only allowed files', !stray.length, stray.join(', '));
  const dead = paths.filter((path) => (spec.forbidden || []).includes(path));
  check('never edited a dead file', !dead.length, dead.join(', '));
  for (const [path, patterns] of Object.entries(spec.contains || {})) {
    for (const re of patterns) check(`${path} contains ${re}`, re.test(content.get(path) || ''));
  }
  for (const [path, patterns] of Object.entries(spec.absent || {})) {
    for (const re of patterns) check(`${path} no longer contains ${re}`, content.has(path) && !re.test(content.get(path)));
  }
  for (const rule of spec.containsAny || []) {
    const matching = paths.filter((path) => rule.files.test(path));
    for (const re of rule.patterns) check(`${rule.files} contains ${re}`, matching.some((path) => re.test(content.get(path))));
  }
  const rounds = new Set((prepared?.diagnostics?.outcomes || []).map((item) => item.round)).size;
  check('stayed within the three-pass limit', rounds <= 3, `${rounds} passes`);
  const passed = checks.every((item) => item.ok);
  return {
    level: spec.level,
    name: spec.name,
    passed,
    checks,
    files: paths,
    passes: rounds,
    failed_checks: checks.filter((item) => !item.ok).map((item) => item.name),
    failed_details: checks.filter((item) => !item.ok).map((item) => item.detail).filter(Boolean).slice(0, 3),
    at: new Date().toISOString(),
  };
}

export function speakExamResults(results) {
  const list = AUTONOMY_EXAM.map((spec) => results?.[spec.level]).filter(Boolean);
  if (!list.length) return 'No autonomy exam has finished yet, sir. Say "run the autonomy exam" to start it.';
  const passed = list.filter((item) => item.passed).length;
  const lines = list.map((item) => { const why = item.failed_details?.length ? item.failed_details.slice(0, 2).join('; ') : item.failed_checks.slice(0, 2).join('; '); return `Level ${item.level}, ${item.name}: ${item.passed ? 'passed' : `failed (${why})`}${item.passes ? ` in ${item.passes} pass${item.passes === 1 ? '' : 'es'}` : ''}.`; });
  return `Autonomy exam: ${passed} of ${list.length} levels passed, sir. ${lines.join(' ')}`;
}
