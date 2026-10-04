// CHE platform tenancy, device enrollment, Core requests, notifications and
// privacy boundaries. Pure helpers keep the policy testable and keep tenant
// data out of the owner/global prompt path.

const OWNER_TENANT_ID = 'owner-369';
const CORE_RULES = Object.freeze([
  { id: 'CORE-PRIVACY-1', version: 1, text: 'Personal memories stay inside their tenant and never become shared Core knowledge.' },
  { id: 'CORE-SECRETS-1', version: 1, text: 'Secrets and credentials are never copied into shared learning, prompts, logs, or invitations.' },
  { id: 'CORE-SKILLS-1', version: 1, text: 'Verified sanitized skills may be shared through Core; personal memories may not.' },
  { id: 'CORE-SAFETY-1', version: 1, text: 'Core requests cannot bypass privacy, consent, security, provider, or platform rules.' },
]);

const text = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const nowIso = (now = new Date()) => now.toISOString();
const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const newDeviceId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export function ensurePlatform(data) {
  data.platform = data.platform && typeof data.platform === 'object' ? data.platform : {};
  const p = data.platform;
  p.version = Number(p.version || 1);
  p.tenants = p.tenants && typeof p.tenants === 'object' && !Array.isArray(p.tenants) ? p.tenants : {};
  p.devices = p.devices && typeof p.devices === 'object' && !Array.isArray(p.devices) ? p.devices : {};
  p.invites = Array.isArray(p.invites) ? p.invites : [];
  p.notifications = Array.isArray(p.notifications) ? p.notifications : [];
  p.core_requests = Array.isArray(p.core_requests) ? p.core_requests : [];
  p.shared_skills = Array.isArray(p.shared_skills) ? p.shared_skills : [];
  // Every device gets a random public id the owner can name it by; devices
  // paired before ids existed get one the first time the platform loads.
  for (const device of Object.values(p.devices)) if (device && !device.id) device.id = newDeviceId();
  if (!p.tenants[OWNER_TENANT_ID]) {
    p.tenants[OWNER_TENANT_ID] = {
      id: OWNER_TENANT_ID, name: 'CHE Owner', role: 'owner', created_at: nowIso(),
      flagstaff: '369', memory_scope: 'private', office: { starter_roster: ['Nova','Atlas','Mira','Knox','Sage','Lyra','Iris'] },
    };
  }
  return p;
}

export function tenantForDevice(data, tokenHash) {
  const p = ensurePlatform(data);
  const device = p.devices[tokenHash];
  return p.tenants[device?.tenant_id || OWNER_TENANT_ID] || p.tenants[OWNER_TENANT_ID];
}

export function registerPairedDevice(data, tokenHash, { name = 'CHE device', access = 'full', tenantId = OWNER_TENANT_ID } = {}) {
  const p = ensurePlatform(data);
  const tenant = p.tenants[tenantId] || p.tenants[OWNER_TENANT_ID];
  p.devices[tokenHash] = {
    id: newDeviceId(), token_hash: tokenHash, tenant_id: tenant.id, name: text(name, 80) || 'CHE device',
    access: access === 'private' ? 'private' : 'full', created_at: nowIso(), last_seen_at: nowIso(), revoked_at: null,
  };
  return p.devices[tokenHash];
}

export function touchDevice(data, tokenHash) {
  const p = ensurePlatform(data);
  const device = p.devices[tokenHash];
  if (device && !device.revoked_at) device.last_seen_at = nowIso();
  return device;
}

export function createEnrollment(data, { tenantId = OWNER_TENANT_ID, access = 'private', ttlMinutes = 10, singleUse = true } = {}) {
  const p = ensurePlatform(data);
  if (!p.tenants[tenantId]) return { error: 'tenant_not_found' };
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2,'0')).join('');
  const invite = {
    id: randomId('invite'), token: raw, tenant_id: tenantId, access: access === 'full' ? 'full' : 'private',
    single_use: singleUse !== false, created_at: nowIso(), expires_at: new Date(Date.now() + Math.max(1, Math.min(60, Number(ttlMinutes)||10))*60000).toISOString(),
    used_at: null, revoked_at: null,
  };
  p.invites.push(invite);
  return { invite, token: raw };
}

export function consumeEnrollment(data, rawToken, deviceName) {
  const p = ensurePlatform(data);
  const invite = p.invites.find(i => i.token === String(rawToken || ''));
  if (!invite || invite.revoked_at || (invite.single_use && invite.used_at) || Date.parse(invite.expires_at) <= Date.now()) {
    return { error: 'invalid_or_expired_invite' };
  }
  invite.used_at = nowIso();
  return { invite, device_name: text(deviceName, 80) || 'CHE device' };
}

export function createPersonalTenant(data, { name, role = 'personal' } = {}) {
  const p = ensurePlatform(data);
  const id = randomId('tenant');
  p.tenants[id] = {
    id, name: text(name, 80) || 'Personal CHE', role: role === 'parental_guidance' ? role : 'personal',
    created_at: nowIso(), flagstaff: randomId('flagstaff'), memory_scope: 'isolated',
    office: { starter_roster: ['Nova','Atlas','Mira','Knox','Sage','Lyra','Iris'] },
  };
  return p.tenants[id];
}

export function addNotification(data, { tenantId = OWNER_TENANT_ID, source = 'CHE', title, body, priority = 'normal', target = '' } = {}) {
  const p = ensurePlatform(data);
  const item = {
    id: randomId('notice'), tenant_id: tenantId, source: text(source, 60), title: text(title, 160),
    body: text(body, 1200), priority: ['low','normal','high','urgent'].includes(priority) ? priority : 'normal',
    target: text(target, 240), created_at: nowIso(), read_at: null,
  };
  p.notifications.unshift(item);
  p.notifications = p.notifications.slice(0, 500);
  return item;
}

export function notificationsFor(data, tenantId, { unreadOnly = false } = {}) {
  return ensurePlatform(data).notifications
    .filter(n => n.tenant_id === tenantId && (!unreadOnly || !n.read_at))
    .sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at));
}

export function markNotificationRead(data, tenantId, id) {
  const item = ensurePlatform(data).notifications.find(n => n.id === id && n.tenant_id === tenantId);
  if (!item) return null;
  item.read_at ||= nowIso();
  return item;
}

export function coreRules() { return CORE_RULES.map(r => ({ ...r })); }

export function createCoreRequest(data, tenantId, body) {
  const p = ensurePlatform(data);
  const request = {
    id: randomId('core'), tenant_id: tenantId, title: text(body.title || body.request, 160),
    request: text(body.request, 4000), kind: text(body.kind || 'capability', 60),
    priority_requested: body.priority === true, paid_priority_authorized: body.paid_priority_authorized === true,
    status: 'submitted', decision: null, rule_ids: [], created_at: nowIso(), updated_at: nowIso(),
  };
  if (!request.request) return { error: 'request_required' };
  p.core_requests.unshift(request);
  return { request };
}

export function coreRequestsFor(data, tenantId) {
  return ensurePlatform(data).core_requests.filter(r => r.tenant_id === tenantId)
    .sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at));
}

export function sanitizeSharedSkill(input) {
  const source = input && typeof input === 'object' ? input : {};
  const skill = {
    id: text(source.id, 120) || randomId('skill'), title: text(source.title, 160),
    technique: text(source.technique, 4000), provenance: text(source.provenance, 500),
    verified_at: text(source.verified_at, 80), personal_data_removed: source.personal_data_removed === true,
  };
  if (!skill.title || !skill.technique || !skill.provenance || !skill.verified_at || !skill.personal_data_removed) return null;
  return skill;
}

export function platformView(data, tenantId, tokenHash) {
  const p = ensurePlatform(data);
  const tenant = p.tenants[tenantId] || p.tenants[OWNER_TENANT_ID];
  const device = p.devices[tokenHash] || null;
  return {
    version: p.version, tenant: { ...tenant }, device: device ? { ...device, token_hash: undefined } : null,
    core_rules: coreRules(), notifications: notificationsFor(data, tenant.id),
    core_requests: coreRequestsFor(data, tenant.id),
    // The owner sees every device on every profile (his and his family's),
    // each with a short public id he can revoke by. Token hashes stay hidden.
    devices: tenant.role === 'owner'
      ? Object.values(p.devices).map(({ token_hash, ...d }) => ({ ...d, profile: p.tenants[d.tenant_id]?.name || 'CHE' }))
      : [],
  };
}

// The public id of the device holding this token (random, never derived
// from the token).
export function deviceId(data, tokenHash) {
  return ensurePlatform(data).devices[tokenHash]?.id || '';
}

// Owner revokes a lost or retired device from any other device. The device's
// token stops working on its next request. The device making the request
// cannot revoke itself here (that is /api/security/revoke_self).
export function revokeDevice(data, id, { byTokenHash = '' } = {}) {
  const p = ensurePlatform(data);
  const key = String(id || '').trim().toLowerCase();
  if (key.length < 6) return { error: 'device_not_found' };
  const entry = Object.entries(p.devices).find(([, d]) => d?.id === key);
  if (!entry) return { error: 'device_not_found' };
  const [hash, device] = entry;
  if (hash === byTokenHash) return { error: 'cannot_revoke_current_device' };
  if (!device.revoked_at) device.revoked_at = nowIso();
  if (data.devices && typeof data.devices === 'object') delete data.devices[hash];
  const { token_hash: _hidden, ...visible } = device;
  return { device: visible };
}

// "List my devices" / "remove my lost iPhone" / "revoke device 3fa2c1d09b7e".
export function deviceCommandIntent(message) {
  const text = String(message || '').trim().replace(/[.!?]+$/, '');
  if (!text || text.length > 120) return null;
  if (/^(?:(?:che|chay|chey)[,:]?\s*)?(?:list|show|read|what are)\s+(?:me\s+)?(?:all\s+)?(?:my|the|your)\s+(?:paired\s+|signed[-\s]in\s+)?devices$/i.test(text)
    || /^(?:(?:che|chay|chey)[,:]?\s*)?(?:which|what)\s+devices\s+(?:are|can)\s+(?:signed in|paired|connected|use you)/i.test(text)) return { kind: 'list' };
  const m = /^(?:(?:che|chay|chey)[,:]?\s*)?(?:please\s+)?(?:revoke|remove|disconnect|sign out|log out|lock out|block|cut off)\s+(?:my\s+|the\s+)?(?:lost\s+|stolen\s+|old\s+)?(?:device\s+)?(.{2,60}?)(?:\s+device)?$/i.exec(text);
  if (m && /\b(?:device|phone|iphone|ipad|laptop|computer|mac|tablet|browser|pc)\b|^[0-9a-f]{6,12}$/i.test(`${text} ${m[1]}`)) return { kind: 'revoke', target: m[1].trim() };
  return null;
}

// Finds the device the owner named (by id prefix or by name words).
export function findDevice(data, target) {
  const p = ensurePlatform(data);
  const t = String(target || '').trim().toLowerCase();
  const live = Object.entries(p.devices).filter(([, d]) => !d.revoked_at);
  if (/^[0-9a-f]{12}$/.test(t)) return live.filter(([, d]) => d.id === t);
  const words = t.replace(/\b(?:my|the|lost|stolen|old|device)\b/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  return live.filter(([, d]) => words.length && words.every((w) => String(d.name || '').toLowerCase().includes(w)));
}

export { OWNER_TENANT_ID };
