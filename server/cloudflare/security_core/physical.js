// Security Core: physical security — architecture only. No camera, lock, alarm or sensor integration exists yet.
// The model below lets a future adapter plug in, and its rules hold from day one:
//  • a device is "connected" only when a supported adapter has completed a verified handshake; otherwise it is
//    listed as unsupported or not connected, never shown as live;
//  • the only autonomous responses are notifying and recording; anything that moves hardware needs the owner, and
//    responses that could harm, trap or confront a person are refused outright.

export const PHYSICAL_DEVICE_CLASSES = Object.freeze(['camera', 'door_lock', 'alarm', 'motion_sensor', 'contact_sensor', 'smoke_detector', 'smart_plug', 'gate']);
export const PHYSICAL_STATUSES = Object.freeze(['unsupported', 'not_connected', 'connected', 'error']);

// No adapters ship yet. A future adapter registers here with { id, classes, handshake(device) → Promise<boolean> }.
const ADAPTERS = new Map();

export function registerPhysicalAdapter(adapter) {
  if (!adapter?.id || typeof adapter.handshake !== 'function' || !Array.isArray(adapter.classes)) throw new Error('A physical adapter needs an id, classes and a handshake.');
  ADAPTERS.set(adapter.id, adapter);
}
export function supportedAdapters() { return [...ADAPTERS.keys()]; }
export function _clearPhysicalAdapters() { ADAPTERS.clear(); }

/** A physical device record. It starts unsupported or not connected; only verifyPhysicalDevice can mark it connected. */
export function physicalDevice({ id, device_class, name = '', adapter = null } = {}) {
  if (!PHYSICAL_DEVICE_CLASSES.includes(device_class)) throw new Error('Unknown physical device class.');
  const supported = adapter && ADAPTERS.has(adapter) && ADAPTERS.get(adapter).classes.includes(device_class);
  return { id: String(id || ''), device_class, name: String(name || device_class), adapter: supported ? adapter : null, status: supported ? 'not_connected' : 'unsupported', verified_at: null };
}

/** Connected only after a supported adapter's handshake succeeds. A failed or throwing handshake is an error, not connected. */
export async function verifyPhysicalDevice(device, now = new Date().toISOString()) {
  if (!device?.adapter || !ADAPTERS.has(device.adapter)) return { ...device, status: 'unsupported', verified_at: null };
  let ok = false;
  try { ok = (await ADAPTERS.get(device.adapter).handshake(device)) === true; } catch (_) { ok = false; }
  return { ...device, status: ok ? 'connected' : 'error', verified_at: ok ? now : null };
}

export const AUTONOMOUS_RESPONSES = Object.freeze(['notify_owner', 'record_event', 'save_clip_reference']);
export const OWNER_ONLY_RESPONSES = Object.freeze(['lock_door', 'unlock_door', 'arm_alarm', 'disarm_alarm', 'sound_siren', 'turn_off_power', 'open_gate', 'close_gate']);
export const FORBIDDEN_RESPONSES = Object.freeze(['trap_person', 'lock_person_in', 'disable_smoke_detector', 'disable_life_safety', 'confront_person', 'use_force', 'deter_with_harm', 'contact_intruder', 'retaliate', 'publish_identity']);

/** Whether a physical response may run, and who must decide. Unknown responses are refused. */
export function physicalResponse(action, { owner_confirmed = false, device = null } = {}) {
  if (FORBIDDEN_RESPONSES.includes(action)) return { allowed: false, reason: 'This response could harm or endanger a person and is never taken.' };
  if (AUTONOMOUS_RESPONSES.includes(action)) return { allowed: true, autonomous: true };
  if (OWNER_ONLY_RESPONSES.includes(action)) {
    if (!device || device.status !== 'connected') return { allowed: false, reason: 'No verified, connected device can do that.' };
    if (!owner_confirmed) return { allowed: false, reason: 'This needs the owner to decide.', needs_owner: true };
    return { allowed: true, autonomous: false };
  }
  return { allowed: false, reason: 'Unknown physical response.' };
}

/** The physical layer as shown to the owner: honest about what exists. */
export function physicalView(devices = []) {
  return {
    architecture_only: ADAPTERS.size === 0,
    adapters: supportedAdapters(),
    devices: devices.map((d) => ({ id: d.id, device_class: d.device_class, name: d.name, status: PHYSICAL_STATUSES.includes(d.status) ? d.status : 'unsupported', connected: d.status === 'connected' && Boolean(d.verified_at) })),
    note: ADAPTERS.size === 0 ? 'Physical security is architecture only: no camera, lock, alarm or sensor is connected.' : '',
  };
}
