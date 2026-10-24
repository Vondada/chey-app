// CHE Living World: room proposals (owner mission, 2026-10-24). CHE designs a room for a need from a reviewed
// template, shows its layout for preview, and builds it only after the owner approves. Building reuses existing
// agents and reusable room parts, verifies the room with deterministic checks, and keeps every earlier version so the
// owner can roll back. Nothing here buys equipment, connects a device, publishes a room or changes production code.

const CONNECTED_TOOLS = new Set(['Office task runtime']);
const ROOM_BOUNDS = 5;

/** Reviewed room designs. A new design is one more entry here, reviewed like any other code. */
export const ROOM_TEMPLATES = Object.freeze({
  robotics_lab: Object.freeze({
    id: 'robotics_lab',
    name: 'Robotics Lab',
    short: 'Robotics',
    department: 'robotics',
    needs: /\b(robot|robots|robotics|robotic|actuator|motion control|hardware lab)\b/i,
    purpose: 'Design and simulate robot tasks, record every experiment as an Office task, and review hardware plans. No real robot is connected.',
    lead: Object.freeze({ name: 'Knox', reason: 'Knox leads engineering. The Robotics Lab uses that role until the owner names a specialist.' }),
    layout: Object.freeze([
      Object.freeze({ kind: 'bench', label: 'Workbench', x: -2.2, z: -2.6 }),
      Object.freeze({ kind: 'desk', label: 'Simulation desk', x: 0, z: -2.8 }),
      Object.freeze({ kind: 'equipment', label: 'Robot arm (simulated)', x: 2.2, z: -2.6 }),
      Object.freeze({ kind: 'shelf', label: 'Parts shelf', x: -3.6, z: 0.4 }),
      Object.freeze({ kind: 'desk', label: 'Review desk', x: 2.4, z: 0.6 }),
    ]),
    equipment: Object.freeze([Object.freeze({ name: 'Robot arm (simulated)', connected: false, cost: 'not measured', needs_approval: true })]),
    tools: Object.freeze([
      Object.freeze({ name: 'Office task runtime', connected: true }),
      Object.freeze({ name: 'Robot simulator', connected: false }),
      Object.freeze({ name: 'Physical robot', connected: false }),
    ]),
    workflows: Object.freeze([
      'Assign a simulation task to the lead in this room',
      'Record each experiment as an Office task with its result',
      'Vale verifies a result before CHE reports it as done',
    ]),
    approvals: Object.freeze([
      'Buying or ordering any equipment',
      'Connecting a real robot or device',
      'Publishing the room to the Office',
    ]),
    checks: Object.freeze([
      'the lead is on the roster',
      'the layout stays inside the room',
      'no tool is claimed connected unless it is',
      'equipment waits for approval and is not connected',
      'the room id is unique',
    ]),
  }),
});

const newId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const rosterHas = (data, name) => (data.team || []).some((a) => a && !a.retired && a.name === name);

function log(proposal, event, detail, now) {
  proposal.history.push({ at: now, event, detail: String(detail).slice(0, 300) });
  proposal.history = proposal.history.slice(-40);
  proposal.updated_at = now;
}

/** The template whose need pattern matches the owner's words, or null when CHE has no design for it. */
export function templateForNeed(need) {
  const text = String(need || '').trim();
  if (!text) return null;
  return Object.values(ROOM_TEMPLATES).find((t) => t.needs.test(text)) || null;
}

/** CHE proposes a room: the design, the lead she recommends, the tools it needs and what waits for approval. */
export function designProposal(data, { need, now = new Date().toISOString() } = {}) {
  const text = String(need || '').trim().slice(0, 400);
  const template = templateForNeed(text);
  if (!template) {
    return { error: 'CHE has no room design for that yet. Describe the work in more detail, or ask for a room she already has.', status: 400 };
  }
  data.hq_proposals = Array.isArray(data.hq_proposals) ? data.hq_proposals : [];
  const open = data.hq_proposals.find((p) => p.template === template.id && p.status === 'proposed');
  if (open) return { proposal: open, reused: true };
  const proposal = {
    id: newId('rp'),
    template: template.id,
    need: text,
    status: 'proposed',
    version: 1,
    room: { id: template.id, name: template.name, short: template.short, purpose: template.purpose, department: template.department },
    lead: { name: template.lead.name, reason: template.lead.reason, on_roster: rosterHas(data, template.lead.name) },
    layout: clone(template.layout),
    equipment: clone(template.equipment),
    tools: clone(template.tools),
    workflows: [...template.workflows],
    approvals: [...template.approvals],
    cost: { measured: null, note: 'Not measured. Nothing is bought or ordered; equipment waits for approval.' },
    checks: [...template.checks],
    verification: null,
    history: [],
    created_at: now,
    updated_at: now,
  };
  log(proposal, 'proposed', `CHE proposes ${template.name} for: ${text}`, now);
  data.hq_proposals.unshift(proposal);
  data.hq_proposals = data.hq_proposals.slice(0, 40);
  return { proposal };
}

function roomPayload(proposal) {
  return {
    id: proposal.room.id,
    name: proposal.room.name,
    short: proposal.room.short,
    purpose: proposal.room.purpose,
    department: proposal.room.department,
    lead: proposal.lead.name,
    layout: clone(proposal.layout),
    equipment: clone(proposal.equipment),
    tools: clone(proposal.tools),
    workflows: [...proposal.workflows],
    approvals: [...proposal.approvals],
    version: proposal.version,
    template: proposal.template,
  };
}

/** Builds the room record. An existing room keeps its earlier versions so a rollback can restore them. */
function buildRoom(data, proposal, now) {
  data.hq_rooms = Array.isArray(data.hq_rooms) ? data.hq_rooms : [];
  const payload = roomPayload(proposal);
  const snapshot = { version: proposal.version, at: now, room: clone(payload) };
  const current = data.hq_rooms.find((r) => r.id === payload.id);
  if (current) {
    current.versions = [...(current.versions || []), snapshot].slice(-10);
    Object.assign(current, payload, { status: 'building' });
    return current;
  }
  const room = { ...payload, status: 'building', versions: [snapshot] };
  data.hq_rooms.push(room);
  return room;
}

/** CHE's deterministic checks on a built room. Every check must pass before the room is activated. */
export function verifyRoom(data, room, { reservedIds = [], now = new Date().toISOString() } = {}) {
  const checks = [];
  const onRoster = rosterHas(data, room.lead);
  checks.push({ check: 'the lead is on the roster', passed: onRoster, detail: room.lead });
  const inside = (room.layout || []).every((item) => Math.abs(item.x) <= ROOM_BOUNDS && Math.abs(item.z) <= ROOM_BOUNDS);
  checks.push({ check: 'the layout stays inside the room', passed: inside });
  const claimed = (room.tools || []).filter((t) => t.connected).map((t) => t.name);
  const honest = claimed.every((name) => CONNECTED_TOOLS.has(name));
  checks.push({ check: 'no tool is claimed connected unless it is', passed: honest, detail: claimed.join(', ') || 'none' });
  const gated = (room.equipment || []).every((e) => e.needs_approval === true && e.connected !== true);
  checks.push({ check: 'equipment waits for approval and is not connected', passed: gated });
  const unique = !reservedIds.includes(room.id) && (data.hq_rooms || []).filter((r) => r.id === room.id && r.status === 'active' && r !== room).length === 0;
  checks.push({ check: 'the room id is unique', passed: unique });
  return { passed: checks.every((c) => c.passed), checks, at: now, by: 'CHE verification (deterministic checks)' };
}

/** The owner's decision on a proposal: approve (build, verify, activate), modify (back for approval) or reject. */
export function decideProposal(data, id, { decision, changes = {}, reservedIds = [], now = new Date().toISOString() } = {}) {
  const proposal = (data.hq_proposals || []).find((p) => p.id === id);
  if (!proposal) return { error: 'There is no room proposal with that id.', status: 404 };
  if (['active', 'rejected', 'failed_verification'].includes(proposal.status)) {
    return { error: `This proposal is ${proposal.status.replace('_', ' ')}. Propose the room again to change it.`, status: 409 };
  }
  if (decision === 'reject') {
    proposal.status = 'rejected';
    log(proposal, 'rejected', 'The owner said no. Nothing was built.', now);
    return { proposal };
  }
  if (decision === 'modify') {
    const name = String(changes.name || '').trim().slice(0, 40);
    const purpose = String(changes.purpose || '').trim().slice(0, 300);
    if (name) proposal.room.name = name;
    if (purpose) proposal.room.purpose = purpose;
    proposal.version += 1;
    log(proposal, 'modified', `Owner changes applied: ${[name && 'name', purpose && 'purpose'].filter(Boolean).join(', ') || 'none'}. Waiting for approval again.`, now);
    return { proposal };
  }
  if (decision !== 'approve') return { error: 'The decision must be approve, modify or reject.', status: 400 };
  proposal.status = 'approved';
  log(proposal, 'approved', 'The owner approved the proposal. Building now.', now);
  const room = buildRoom(data, proposal, now);
  const verification = verifyRoom(data, room, { reservedIds, now });
  proposal.verification = verification;
  if (verification.passed) {
    room.status = 'active';
    proposal.status = 'active';
    log(proposal, 'activated', `Verified: ${verification.checks.length} of ${verification.checks.length} checks passed. The room is in the headquarters.`, now);
  } else {
    room.status = 'failed_verification';
    proposal.status = 'failed_verification';
    const failed = verification.checks.filter((c) => !c.passed).map((c) => c.check).join('; ');
    log(proposal, 'verification failed', `Not activated. Failed: ${failed}.`, now);
  }
  return { proposal, room: { id: room.id, status: room.status, version: room.version } };
}

/** Restores the room's previous version. A room with no earlier version is retired and leaves the headquarters. */
export function rollbackRoom(data, roomId, { now = new Date().toISOString() } = {}) {
  const room = (data.hq_rooms || []).find((r) => r.id === roomId);
  if (!room) return { error: 'There is no built room with that id.', status: 404 };
  const versions = room.versions || [];
  if (versions.length < 2) {
    room.status = 'retired';
    return { room: { id: room.id, status: room.status }, note: 'No earlier version: the room is retired and leaves the headquarters.' };
  }
  versions.pop();
  const previous = versions[versions.length - 1];
  Object.assign(room, clone(previous.room), { versions, status: 'active' });
  return { room: { id: room.id, status: room.status, version: room.version }, rolled_back_to: previous.version, at: now };
}

/** Approved rooms in the headquarters' own room shape (what the static registry uses). */
export function activeRoomsOf(data) {
  return (data.hq_rooms || [])
    .filter((r) => r.status === 'active')
    .map((r) => ({ id: r.id, name: r.name, short: r.short, purpose: r.purpose, department: r.department, lead: r.lead, apps: [], custom: true }));
}

/** The owner's view of proposals and built rooms, newest first. */
export function roomProposalsView(data) {
  return {
    proposals: (data.hq_proposals || []).slice(0, 20),
    rooms: (data.hq_rooms || []).map((r) => ({ id: r.id, name: r.name, lead: r.lead, status: r.status, version: r.version, versions: (r.versions || []).length })),
  };
}
