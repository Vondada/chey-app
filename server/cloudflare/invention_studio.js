// CHE's Invention Studio (owner, 2026-10-22): concept-to-breakdown for engineered designs such as a powered suit, an
// exoskeleton, a robot or a device. It is not an image engine. A project holds the subsystems, a bill of materials with
// truthful sourcing labels, cost bands per tier, feasibility notes and staged plans. Concept pictures come from the
// existing media engine (media.js generateImage) through worker.js; nothing here draws.
//
// Truth rules: no supplier, link, lead time or exact price is invented. Live supplier lookup is not connected, so no
// vendor is ever "verified" here; every part carries one sourcing label and every cost is a planning band, not a quote.
// Safety: weapons, illegal bypasses and dangerous optimisation are refused; ambiguous requests are read as safe engineering.

export const LABELS = Object.freeze({
  verified: 'verified source',
  estimated: 'estimated source',
  conceptual: 'conceptual',
  custom: 'custom fabrication required',
  unknown: 'unavailable / unknown',
});

export const TIERS = Object.freeze(['budget', 'mid', 'premium']);
export const TIER_NAMES = Object.freeze({ budget: 'Low-budget prototype', mid: 'Mid-range', premium: 'Premium / advanced' });

const WEAPON = /\b(?:weapon|gun|rifle|missile|explosive|bomb|grenade|flamethrower|turret|munition|ammunition|laser\s+cannon)\b/i;
const BYPASS = /\b(?:bypass|disable)\s+(?:the\s+)?(?:safety|limiter|interlock|governor|lockout)\b/i;
// A design verb on its own, or build/make/create aimed at an invention word (so "make a plan" is not a design).
const DESIGN = /\b(?:design|invent|concept|prototype|engineer|sketch)\b|\b(?:build|make|create)\s+(?:me\s+)?(?:an?\s+|the\s+|my\s+)?(?:iron\s*man|powered|exo\w*|robot\w*|suit|invention|prosthe\w*|armou?r|gadget)\b/i;
const SUBJECT = /\b(?:suit|exoskeleton|exosuit|robot|robotic|device|invention|gadget|machine|armou?r|harness|prosthe\w+|drone|vehicle|wearable)\b|iron\s*man/i;
const ASSEMBLY = /\b(?:assembl\w*|piece\s+by\s+piece|step\s+by\s+step|explode\w*|exploded|layers?|breakdown|break\s+it\s+down|how\s+it\s+(?:fits|goes|comes)\s+together)\b/i;
const COST = /\b(?:cost|costs|price|prices|budget|estimate|how\s+much|bill\s+of\s+materials|bom|parts\s+list)\b/i;
const SOURCING = /\b(?:where\s+(?:can|do|could)\s+i\s+(?:get|buy|find|order)|where\s+to\s+(?:get|buy|find)|source|sourcing|suppliers?|vendors?|buy\s+the\s+parts|lead\s+times?)\b/i;
const REALITY = /\b(?:real\s+(?:or|versus|vs\.?)\s+conceptual|what\s+is\s+(?:real|possible|realistic|science\s*fiction)|realistic|feasib\w*|too\s+heavy|power[-\s]limited|is\s+(?:it|this)\s+possible|conceptual\s+only)\b/i;
const PLAN = /\b(?:stages?|plan|roadmap|milestones?|test(?:ing)?\s+checklist|build\s+order)\b/i;
// Words that point at the project the owner already has ("piece by piece", "the parts", "it"), not at another subject.
// Words that ask the project planner for an estimate, a categorised list, a render or a sourced plan. The planner keeps them.
const PLANNER_WORDS = /\b(?:estimate|categori[sz]e|come\s+up\s+with|render|wikipedia)\b/i;
const PROJECT_WORD = /\b(?:parts?|bom|bill\s+of\s+materials|piece\s+by\s+piece|subsystems?|it|this|that|real|conceptual)\b/i;
const OPEN = /\b(?:open|reopen|show|bring\s+up|my)\b[^.?!]{0,40}\b(?:invention|suit|design|project)s?\b/i;

/** The Invention Studio request in a message, with what it asks for, or null when it is not about an invention. */
export function inventionIntent(message) {
  const text = String(message || '').replace(/^(?:che|chay|chey)[,:]?\s+/i, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 800) return null;
  // A request for a sourced plan, estimate or render is the project planner's (project_plan.js), which owns those words.
  if (PLANNER_WORDS.test(text)) return null;
  if (WEAPON.test(text) || BYPASS.test(text)) return { kind: 'refused', subject: text };
  const about = SUBJECT.test(text);
  const designing = DESIGN.test(text) && about;
  let kind = null;
  // Cost and sourcing questions win over the words "piece by piece", unless the message also asks for a new design.
  if (SOURCING.test(text)) kind = 'sourcing';
  else if (COST.test(text) && !designing && (about || PROJECT_WORD.test(text))) kind = 'cost';
  else if (ASSEMBLY.test(text)) kind = 'assembly';
  else if (REALITY.test(text) && (about || PROJECT_WORD.test(text))) kind = 'reality';
  else if (PLAN.test(text) && about) kind = 'plan';
  else if (designing) kind = 'design';
  else if (OPEN.test(text) && /\b(?:invention|suit|project)s?\b/i.test(text)) kind = 'open';
  return kind ? { kind, subject: text } : null;
}

/** The project template a request names. Ambiguous requests are read as the safe engineering concept of the nearest kind. */
export function templateFor(request = '') {
  const text = String(request);
  if (/\b(?:suit|iron\s*man|armou?r|exosuit|powered)\b/i.test(text)) return /exo/i.test(text) ? 'exoskeleton' : 'powered_suit';
  if (/\bexo\w*/i.test(text)) return 'exoskeleton';
  if (/\b(?:robot|robotic|android|humanoid)\b/i.test(text)) return 'robot';
  return 'device';
}

// Each part: name, subsystem, quantity, label (LABELS), kind (off_the_shelf | custom_fabricated | conceptual), where it
// could come from (categories only), alternatives, and planning cost bands in USD per unit: [low, high] per tier.
// Bands are rough planning figures for scoping, never a quote; the reply says so.
function part(name, subsystem, quantity, label, kind, categories, cost, alternatives = []) {
  return {
    name, subsystem, quantity, label, kind,
    sourcing: { categories, vendor: null, link: null, lead_time: null, alternatives },
    unit_cost: Object.fromEntries(TIERS.map((tier) => [tier, cost[tier] || null])),
  };
}

const SUBSYSTEMS = Object.freeze([
  ['frame', 'Frame'], ['shell', 'Shell'], ['power', 'Power'], ['movement', 'Movement'], ['sensors', 'Sensors'],
  ['control', 'Control'], ['cooling', 'Cooling'], ['safety', 'Safety'], ['accessories', 'Accessories'],
]);

const PARTS = {
  powered_suit: [
    part('Aluminium or carbon-fibre frame members (torso, arm, leg)', 'frame', 1, LABELS.estimated, 'off_the_shelf', ['metal or composite stock suppliers', 'online plastics and metals suppliers'], { budget: [60, 150], mid: [200, 500], premium: [800, 2500] }, ['3D-printed nylon for a light mock-up']),
    part('Joint bearings and hinge housings', 'frame', 10, LABELS.estimated, 'off_the_shelf', ['bearing distributors', 'industrial hardware suppliers'], { budget: [5, 15], mid: [15, 40], premium: [40, 120] }),
    part('Shell panels (chest, arms, legs, helmet)', 'shell', 1, LABELS.custom, 'custom_fabricated', ['local 3D-printing service', 'foam or EVA craft stock for a mock-up'], { budget: [80, 200], mid: [300, 900], premium: [1500, 5000] }, ['foam or cardboard mock-up first']),
    part('Padded harness and straps', 'accessories', 1, LABELS.estimated, 'off_the_shelf', ['climbing or load-harness suppliers', 'sewing or upholstery supply'], { budget: [40, 90], mid: [120, 260], premium: [300, 700] }),
    part('High-capacity lithium battery pack with battery management system', 'power', 1, LABELS.estimated, 'off_the_shelf', ['battery pack integrators', 'e-bike or power-tool battery suppliers'], { budget: [150, 300], mid: [400, 800], premium: [1000, 2500] }, ['smaller pack for a short bench test']),
    part('Main fuse, contactor and power distribution board', 'power', 1, LABELS.estimated, 'off_the_shelf', ['electrical component distributors'], { budget: [20, 60], mid: [80, 180], premium: [200, 450] }),
    part('Brushless motors for hip, knee and shoulder joints', 'movement', 6, LABELS.estimated, 'off_the_shelf', ['robotics motor suppliers', 'hobby brushless motor suppliers'], { budget: [40, 90], mid: [150, 350], premium: [500, 1200] }, ['geared servo motors for a light assist test']),
    part('Gearboxes or harmonic drives for each joint', 'movement', 6, LABELS.estimated, 'off_the_shelf', ['harmonic drive and gearbox suppliers'], { budget: [60, 120], mid: [250, 600], premium: [800, 2000] }),
    part('Motor controllers (ESCs or servo drives)', 'movement', 6, LABELS.estimated, 'off_the_shelf', ['robotics controller suppliers'], { budget: [25, 50], mid: [80, 200], premium: [250, 600] }),
    part('Inertial measurement units (IMUs)', 'sensors', 4, LABELS.estimated, 'off_the_shelf', ['electronics distributors'], { budget: [10, 25], mid: [30, 80], premium: [120, 300] }),
    part('Load cells and force sensors at the feet and hands', 'sensors', 4, LABELS.estimated, 'off_the_shelf', ['industrial sensor suppliers'], { budget: [15, 40], mid: [60, 150], premium: [200, 500] }),
    part('Joint encoders', 'sensors', 6, LABELS.estimated, 'off_the_shelf', ['encoder and motion-sensor suppliers'], { budget: [15, 40], mid: [60, 160], premium: [200, 450] }),
    part('Main controller (single-board computer or real-time microcontroller)', 'control', 1, LABELS.estimated, 'off_the_shelf', ['embedded-computer distributors'], { budget: [30, 60], mid: [100, 250], premium: [400, 900] }),
    part('Wireless emergency-stop receiver and remote', 'safety', 1, LABELS.estimated, 'off_the_shelf', ['industrial remote-control suppliers'], { budget: [50, 120], mid: [150, 350], premium: [400, 900] }),
    part('Mechanical hard stops and torque limiters on each joint', 'safety', 6, LABELS.custom, 'custom_fabricated', ['machine shop', 'clutch and torque-limiter suppliers'], { budget: [10, 30], mid: [40, 120], premium: [150, 400] }),
    part('Cooling fans and heat sinks for the controller and drivers', 'cooling', 4, LABELS.estimated, 'off_the_shelf', ['computer-cooling suppliers'], { budget: [8, 20], mid: [25, 60], premium: [80, 200] }),
    part('Battery temperature sensor and thermal cut-off', 'cooling', 1, LABELS.estimated, 'off_the_shelf', ['electronics distributors'], { budget: [5, 15], mid: [20, 50], premium: [60, 150] }),
  ],
  exoskeleton: [
    part('Lightweight frame members (leg and hip)', 'frame', 1, LABELS.estimated, 'off_the_shelf', ['metal or composite stock suppliers'], { budget: [40, 120], mid: [150, 400], premium: [500, 1500] }),
    part('Hip, knee and ankle joint assemblies', 'movement', 2, LABELS.custom, 'custom_fabricated', ['machine shop'], { budget: [60, 150], mid: [250, 700], premium: [900, 2500] }),
    part('Brushless motors with gearboxes for hip and knee', 'movement', 4, LABELS.estimated, 'off_the_shelf', ['robotics motor suppliers'], { budget: [50, 110], mid: [200, 450], premium: [600, 1500] }),
    part('Battery pack with battery management system', 'power', 1, LABELS.estimated, 'off_the_shelf', ['battery pack integrators'], { budget: [100, 220], mid: [300, 650], premium: [800, 1800] }),
    part('Force and torque sensors at the foot and thigh', 'sensors', 4, LABELS.estimated, 'off_the_shelf', ['industrial sensor suppliers'], { budget: [20, 50], mid: [80, 180], premium: [250, 600] }),
    part('Main controller and motor drivers', 'control', 1, LABELS.estimated, 'off_the_shelf', ['embedded-computer distributors'], { budget: [60, 130], mid: [180, 400], premium: [500, 1100] }),
    part('Padded leg cuffs and waist harness', 'accessories', 1, LABELS.estimated, 'off_the_shelf', ['orthotic or harness suppliers'], { budget: [40, 90], mid: [120, 260], premium: [300, 700] }),
    part('Emergency stop and hard limits on each joint', 'safety', 1, LABELS.estimated, 'off_the_shelf', ['industrial remote-control suppliers'], { budget: [50, 120], mid: [150, 350], premium: [400, 900] }),
  ],
  robot: [
    part('Structural chassis and limbs', 'frame', 1, LABELS.custom, 'custom_fabricated', ['local 3D-printing service', 'metal or composite stock suppliers'], { budget: [60, 180], mid: [250, 700], premium: [900, 2500] }),
    part('Servo or brushless actuators for each joint', 'movement', 12, LABELS.estimated, 'off_the_shelf', ['robotics actuator suppliers'], { budget: [20, 60], mid: [80, 250], premium: [300, 900] }),
    part('Battery pack and power board', 'power', 1, LABELS.estimated, 'off_the_shelf', ['battery pack integrators', 'electrical component distributors'], { budget: [80, 180], mid: [250, 550], premium: [700, 1600] }),
    part('Camera and depth sensor', 'sensors', 1, LABELS.estimated, 'off_the_shelf', ['robotics sensor suppliers'], { budget: [40, 120], mid: [200, 500], premium: [600, 1500] }),
    part('IMU and joint encoders', 'sensors', 1, LABELS.estimated, 'off_the_shelf', ['electronics distributors'], { budget: [30, 80], mid: [120, 300], premium: [350, 800] }),
    part('Single-board computer with motion controller', 'control', 1, LABELS.estimated, 'off_the_shelf', ['embedded-computer distributors'], { budget: [60, 140], mid: [200, 450], premium: [600, 1400] }),
    part('Emergency stop and current limiting', 'safety', 1, LABELS.estimated, 'off_the_shelf', ['industrial remote-control suppliers'], { budget: [40, 100], mid: [120, 300], premium: [350, 800] }),
    part('Fans and heat sinks for the controller', 'cooling', 2, LABELS.estimated, 'off_the_shelf', ['computer-cooling suppliers'], { budget: [8, 20], mid: [25, 60], premium: [80, 200] }),
  ],
  device: [
    part('Enclosure and mounting parts', 'shell', 1, LABELS.custom, 'custom_fabricated', ['local 3D-printing service'], { budget: [20, 60], mid: [80, 250], premium: [300, 900] }),
    part('Microcontroller board', 'control', 1, LABELS.estimated, 'off_the_shelf', ['electronics distributors'], { budget: [10, 30], mid: [40, 120], premium: [150, 400] }),
    part('Rechargeable battery and charger', 'power', 1, LABELS.estimated, 'off_the_shelf', ['battery pack integrators'], { budget: [20, 60], mid: [80, 200], premium: [250, 600] }),
    part('Sensors for the main function', 'sensors', 2, LABELS.estimated, 'off_the_shelf', ['electronics distributors'], { budget: [10, 40], mid: [50, 150], premium: [200, 500] }),
    part('Fuse and power switch', 'safety', 1, LABELS.estimated, 'off_the_shelf', ['electrical component distributors'], { budget: [5, 15], mid: [15, 40], premium: [40, 100] }),
  ],
};

// Conceptual items are listed honestly and never costed: no source exists that CHE can name or check.
const CONCEPTUAL = {
  powered_suit: [
    { name: 'Flight thrusters or repulsors', subsystem: 'movement', reason: 'no flight-capable power source or thrust system at wearable scale is practical today' },
    { name: 'Compact fusion or arc-reactor power source', subsystem: 'power', reason: 'no compact, safe power source of that output exists' },
    { name: 'Integrated heads-up display with full augmented-reality overlay', subsystem: 'sensors', reason: 'possible in part; a full overlay is a research project' },
  ],
  exoskeleton: [{ name: 'Fully autonomous gait planning for uneven ground', subsystem: 'control', reason: 'research-grade; a supervised assist mode is buildable first' }],
  robot: [{ name: 'General-purpose manipulation of unfamiliar objects', subsystem: 'control', reason: 'research-grade; scripted tasks are buildable first' }],
  device: [],
};

const FEASIBILITY = {
  powered_suit: {
    realistic_today: ['A passive or lightly powered shell and frame for display and fitting', 'A powered arm or leg assist that lifts a fraction of its own weight, tested on a stand first', 'Sensor-driven joint limits and a supervised emergency stop'],
    too_heavy: ['A full-body powered suit carrying its own battery, motors and armour at useful weight is well beyond current practical limits for an untethered wearer'],
    power_limited: ['Battery energy density limits run time to minutes at high load; a battery that lasts an hour of assist adds heavy mass', 'Flight or jet-style lift needs far more power than any wearable battery can supply'],
    unsafe: ['High-current lithium packs can fail with fire; a fused, temperature-monitored pack and a supervised test area are required', 'Powered joints pinch and crush; every joint needs hard stops, torque limits and an emergency stop before the first wear', 'Never test a load-bearing suit unsupervised or with a person until stands and bench tests pass'],
    advanced_fabrication: ['Lightweight load-bearing structures, custom joint castings and precise bearing seats need machine shop or advanced composite work'],
    prototype_first: ['Static shell in foam or cardboard for fit and proportion', 'Unpowered wearable mock-up with the harness', 'A bench-tested powered elbow or knee on a fixture, low voltage, with an emergency stop'],
    concept_only: ['Flight, repulsor thrust, and an arc-reactor power source remain science fiction or concept-only'],
  },
  exoskeleton: {
    realistic_today: ['Assist-mode hip or knee support for slow walking, tested with a fixture before any wearer'],
    too_heavy: ['A battery and four motors add mass that the wearer must carry; keep the design light'],
    power_limited: ['Run time depends on battery size; plan for a short assist session'],
    unsafe: ['Joint pinch and misaligned axes can injure; clinical or qualified supervision is needed before any wearer'],
    advanced_fabrication: ['Precise joint alignment with the human hip and knee needs machine-shop work'],
    prototype_first: ['Frame and cuffs on a fixture', 'Single-joint powered test on a stand'],
    concept_only: ['Fully autonomous gait planning across uneven ground is concept-only'],
  },
  robot: {
    realistic_today: ['A desk-scale or tabletop robot with scripted motions and sensors'],
    too_heavy: ['Full-size walking robots with dense actuators are heavy and expensive'],
    power_limited: ['Untethered run time is limited by battery size and actuator draw'],
    unsafe: ['Moving limbs are a hazard; keep robots behind guards and use current limits'],
    advanced_fabrication: ['Precise gearing and high-torque joints need machine-shop parts'],
    prototype_first: ['One joint on a stand', 'A tabletop arm with scripted motion'],
    concept_only: ['General-purpose manipulation of unfamiliar objects is research-grade'],
  },
  device: {
    realistic_today: ['A bench prototype of the main function with off-the-shelf boards and sensors'],
    too_heavy: [],
    power_limited: ['Battery life depends on the chosen cells; measure it on the bench'],
    unsafe: ['Mains power and high-current cells need a qualified person and fusing'],
    advanced_fabrication: ['Tight tolerances or custom castings need fabrication services'],
    prototype_first: ['Bench prototype with the main function'],
    concept_only: [],
  },
};

const STAGES = [
  { id: 'concept_render', name: 'Concept render', detail: 'Front, side and back views of the design, from the media engine. Says plainly when no image engine is connected.' },
  { id: 'static_shell', name: 'Static shell prototype', detail: 'Foam or cardboard shell for proportion and fit. No power, no moving parts.' },
  { id: 'wearable_mockup', name: 'Wearable mock-up', detail: 'Shell and harness fitted on a person or a mannequin. Still unpowered.' },
  { id: 'powered_subsystem', name: 'Powered subsystem prototype', detail: 'One joint or one function on a fixture, low voltage, fused, with a working emergency stop.' },
  { id: 'integrated', name: 'Integrated prototype', detail: 'Subsystems combined. Each step is tested before the next. Supervised only.' },
  { id: 'testing', name: 'Testing checklist', detail: 'Pass each item before the next stage.' },
];

const TESTS = [
  'Weigh each subsystem and the whole design; compare with the planned mass',
  'Check every joint for hard stops and torque limits before any power',
  'Confirm the emergency stop cuts power to all motors within one second',
  'Measure battery temperature and voltage under the planned load, with the cut-off armed',
  'Run each powered joint on a fixture, low speed, with a supervisor present',
  'Check the harness and straps under the rated load before any wearer',
  'Record every test result with date and outcome in the project',
];

/** The sourcing label a part carries, from its record. Anything not one of the five labels is unknown. */
export function labelOf(item) {
  return Object.values(LABELS).includes(item?.label) ? item.label : LABELS.unknown;
}

/** A project for a request: subsystems, parts with cost bands per tier, roll-ups, feasibility, stages and tests. */
export function planInvention(request, { id = '', at = new Date().toISOString(), concept = null } = {}) {
  const template = templateFor(request);
  const parts = PARTS[template].map((p) => ({ ...p, total: totalsFor(p) }));
  const subsystems = SUBSYSTEMS.map(([id2, name]) => ({
    id: id2,
    name,
    parts: parts.filter((p) => p.subsystem === id2).map((p) => p.name),
    cost: rollUp(parts.filter((p) => p.subsystem === id2)),
  }));
  const conceptual = (CONCEPTUAL[template] || []).map((c) => ({
    ...c, label: LABELS.conceptual, kind: 'conceptual', cost: null,
    sourcing: { categories: [], vendor: null, link: null, lead_time: null, alternatives: [] },
  }));
  const title = titleFor(template, request);
  return {
    id: id || `inv-${Date.parse(at) || 0}`,
    title,
    request: String(request || '').slice(0, 600),
    template,
    created_at: at,
    concept: concept || { status: 'not_generated', media_id: null, reason: 'No image engine answered for this design; the parts and feasibility are complete without it.' },
    subsystems,
    parts: [...parts, ...conceptual],
    cost: { tiers: Object.fromEntries(TIERS.map((tier) => [tier, rollUp(parts, tier)])), currency: 'USD', basis: 'planning bands, not quotes' },
    feasibility: FEASIBILITY[template],
    stages: STAGES,
    tests: TESTS,
    sourcing: { live_lookup: 'not connected', verified_sources: 0, note: 'No supplier was checked live, so no vendor, link, price or lead time is confirmed.' },
  };
}

function titleFor(template, request) {
  const named = {
    powered_suit: 'Powered suit concept',
    exoskeleton: 'Exoskeleton concept',
    robot: 'Robot concept',
    device: 'Device concept',
  }[template];
  const text = String(request || '').replace(/\s+/g, ' ').trim().replace(/^(?:design|invent|build|make|create|sketch|concept)\s+(?:me\s+)?(?:an?\s+|the\s+)?/i, '');
  return text ? `${named}: ${text.slice(0, 60)}` : named;
}

function totalsFor(p) {
  return Object.fromEntries(TIERS.map((tier) => {
    const band = p.unit_cost[tier];
    return [tier, band ? [band[0] * p.quantity, band[1] * p.quantity] : null];
  }));
}

/** Roll-up of parts for one tier (or all tiers when tier is omitted). Parts with no band are counted as unknown. */
export function rollUp(parts, tier = null) {
  const tiersToRead = tier ? [tier] : TIERS;
  const out = {};
  for (const t of tiersToRead) {
    let low = 0;
    let high = 0;
    let unknown = 0;
    for (const p of parts) {
      const band = p.total ? p.total[t] : totalsFor(p)[t];
      if (band) { low += band[0]; high += band[1]; } else unknown += 1;
    }
    out[t] = { low, high, unknown_parts: unknown };
  }
  return tier ? out[tier] : out;
}

/** The short spoken/shown reply for a chat request, from the project record. Never claims a vendor or a live price. */
export function inventionReply(project, kind) {
  const cost = project.cost.tiers;
  const band = (t) => `${cost[t].low.toLocaleString('en-US')} to ${cost[t].high.toLocaleString('en-US')} USD`;
  const realCount = project.parts.filter((p) => p.kind !== 'conceptual').length;
  const conceptCount = project.parts.length - realCount;
  const head = `${project.title} (ID ${project.id}).`;
  const honesty = 'Supplier lookup is not connected, so no vendor, link, exact price or lead time is confirmed; every cost is a planning band.';
  if (kind === 'cost') {
    return `${head} Planning bands for the parts: ${TIER_NAMES.budget} ${band('budget')}; ${TIER_NAMES.mid} ${band('mid')}; ${TIER_NAMES.premium} ${band('premium')}. ${honesty}`;
  }
  if (kind === 'sourcing') {
    const cats = [...new Set(project.parts.flatMap((p) => p.sourcing?.categories || []))].slice(0, 6).join('; ');
    return `${head} I can name where to look, not who to buy from: ${cats || 'no categories recorded'}. ${honesty}`;
  }
  if (kind === 'reality') {
    const f = project.feasibility;
    return `${head} Realistic today: ${f.realistic_today.join('; ')}. Too heavy: ${f.too_heavy.join('; ') || 'none noted'}. Power-limited: ${f.power_limited.join('; ')}. Unsafe: ${f.unsafe.join('; ')}. Needs advanced fabrication: ${f.advanced_fabrication.join('; ')}. Prototype first: ${f.prototype_first.join('; ')}. Concept only: ${f.concept_only.join('; ') || 'none'}.`;
  }
  if (kind === 'assembly') {
    const order = project.subsystems.filter((s) => s.parts.length).map((s, i) => `${i + 1}. ${s.name}: ${s.parts.length} part group${s.parts.length === 1 ? '' : 's'}`).join(' ');
    return `${head} Layers, built up from the frame: ${order}. Each layer is shown as its own card in the Studio, and the stages are in order: ${project.stages.map((s) => s.name).join(', ')}.`;
  }
  if (kind === 'plan') {
    return `${head} Stages: ${project.stages.map((s, i) => `${i + 1}. ${s.name}`).join(' ')}. Testing checklist: ${project.tests.length} items.`;
  }
  return `${head} ${realCount} real parts and ${conceptCount} conceptual items across ${project.subsystems.length} subsystems. Prototype cost bands: ${TIER_NAMES.budget} ${band('budget')}; ${TIER_NAMES.mid} ${band('mid')}; ${TIER_NAMES.premium} ${band('premium')}. Realistic today: ${project.feasibility.realistic_today[0]}. ${honesty} Ask for the reality check, the cost by subsystem, the assembly layers or the stages.`;
}

export function refusalReply() {
  return 'I will not design weapons, sir, or help bypass safety limits. I can design a safe powered-assist, exoskeleton, robot or device concept instead; tell me what it should do for you.';
}
