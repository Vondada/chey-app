// Roblox / Luau experience studio — monetizable legal services for the owner.
// Catalog: games, weapons, clothing/UGC/avatars, game passes, and similar.
// No Roblox Studio desktop automation in this Worker: agents draft Luau,
// experience/specs, asset briefs and listing copy. Owner must confirm before
// publish, spend, upload, or outreach.

export const ROBLOX_CATALOG = [
  'game',
  'weapon',
  'clothing',
  'avatar',
  'ugc',
  'pass',
  'tool',
  'map',
];

export const ROBLOX_PROJECT_TYPES = [
  'roblox',
  'roblox_game',
  'roblox_weapon',
  'roblox_clothing',
  'roblox_avatar',
  'roblox_ugc',
  'roblox_pass',
];

/** Capability blurb for Office agents / CHE system addons. */
export function robloxCapabilityNote() {
  return [
    'Roblox / Luau experience studio is a legal monetizable CHE service line.',
    'Catalog: games, weapons, clothing/UGC/avatars, game passes, tools, maps and similar experiences.',
    'Knox (code) + Nova (product/listings) + Lyra/Iris (creative) can draft Luau scripts, experience specs, UGC briefs and store listing copy.',
    'This Worker does NOT drive Roblox Studio desktop automation; deliverables are specs, Luau drafts, asset briefs and publish checklists.',
    'HARD RULE: owner confirm required before Roblox publish/upload, Robux spend, marketplace listing, or any outreach.',
  ].join(' ');
}

export function looksLikeRobloxWork(text) {
  const t = String(text || '').toLowerCase();
  return /\broblox\b|\bluau\b|\bugc\b|\bgame\s*pass(?:es)?\b|\brobucks?\b/.test(t)
    || (/\b(?:weapon|sword|gun|clothing|shirt|pants|hoodie|avatar|skin|accessory)\b/.test(t) && /\b(?:roblox|luau|ugc|game)\b/.test(t));
}

export function classifyRobloxCatalog(text) {
  const t = String(text || '').toLowerCase();
  // Prefer experience/game when those words appear (e.g. "roblox game ... sword shop").
  if (/\b(?:game\s*)?pass(?:es)?\b/.test(t)) return 'pass';
  if (/\b(?:game|obby|experience|tycoon|simulator)\b/.test(t)) return 'game';
  if (/\bclothing|shirt|pants|hoodie|fit|outfit|ugc|avatar|accessory|skin\b/.test(t)) return 'clothing';
  if (/\bweapon|sword|gun|blade|tool\b/.test(t)) return 'weapon';
  if (/\bmap|place|lobby\b/.test(t)) return 'map';
  return 'game';
}

export function robloxProjectTypeFor(text) {
  const cat = classifyRobloxCatalog(text);
  return ({
    game: 'roblox_game',
    weapon: 'roblox_weapon',
    clothing: 'roblox_clothing',
    avatar: 'roblox_avatar',
    ugc: 'roblox_ugc',
    pass: 'roblox_pass',
    tool: 'roblox_weapon',
    map: 'roblox_game',
  })[cat] || 'roblox';
}

/**
 * Voice phrases: hire Roblox help, or task the Office on Roblox catalog work.
 * Returns null when not a Roblox phrase.
 */
export function parseRobloxPhrase(original, normalized) {
  const o = String(original || '').trim();
  const t = String(normalized || '').toLowerCase();

  // hire knox/nova for roblox… / hire a roblox (game|weapon|…) developer
  if (/\bhire\b/.test(t) && (/\broblox\b/.test(t) || /\bluau\b/.test(t))) {
    const from = o.match(/\bhire\b[\s\S]{0,80}?\b(?:for|to|as)\s+(.+)$/i);
    const task = (from && from[1] ? from[1] : o).replace(/[.!?]+$/, '').trim();
    return {
      type: 'robloxJob',
      catalog: classifyRobloxCatalog(task),
      task: task.slice(0, 500),
      owner_confirm_required: true,
    };
  }

  // build/make/create a roblox game|weapon|clothing|pass…
  if (/\b(?:build|make|create|design|code|develop)\b/.test(t) && looksLikeRobloxWork(t)) {
    const from = o.match(/\b(?:build|make|create|design|code|develop)\s+(.+)$/i);
    const task = (from && from[1] ? from[1] : o).replace(/[.!?]+$/, '').trim();
    return {
      type: 'robloxJob',
      catalog: classifyRobloxCatalog(task),
      task: task.slice(0, 500),
      owner_confirm_required: true,
    };
  }

  // tell the office to … roblox …
  if (/\broblox\b|\bluau\b/.test(t) && /\b(?:tell|have|put|get) the office\b/.test(t)) {
    return null; // fall through to normal goal splitter (GOAL_ROUTES also match roblox)
  }

  return null;
}

export function buildRobloxJobBrief(task, catalog = 'game') {
  const cat = ROBLOX_CATALOG.includes(catalog) ? catalog : classifyRobloxCatalog(task);
  return [
    `Roblox / Luau studio job (${cat}).`,
    `Owner request: ${String(task || '').trim().slice(0, 400)}`,
    'Deliver: structured experience/spec, Luau draft or UGC asset brief, listing copy, and a publish checklist.',
    'Do not publish, upload, spend Robux, list on Marketplace, or message anyone without owner confirm.',
  ].join(' ');
}

export function speakRobloxJobPlan(jobs, catalog, task) {
  const cat = catalog || 'game';
  if (!jobs.length) {
    return `CHE here. I can staff Roblox ${cat} work, but no job queued. Say build a Roblox ${cat}, then the details.`;
  }
  const lines = jobs.map((j, i) => `${i + 1}. ${j.agent}: ${j.task}${j.blocker ? ` — ${j.blocker}` : ''}`).join('. ');
  return [
    `CHE here. Queued Roblox ${cat} work for: ${String(task || '').slice(0, 120)}.`,
    lines,
    'Owner confirm is required before publish, upload, Robux spend, or outreach. I will not drive Roblox Studio for you in this build — the crew drafts Luau, specs and asset briefs.',
  ].join(' ');
}

/** Creator Studio system add-on when project type is Roblox catalog. */
export function robloxCreatorSystemAddon(type) {
  const t = String(type || '').toLowerCase();
  if (!ROBLOX_PROJECT_TYPES.includes(t) && t !== 'roblox') return '';
  return [
    'This is a Roblox / Luau project (games, weapon, clothing/UGC/avatar, game pass, or similar).',
    'Produce a usable first draft: experience outline or asset brief, Luau script stubs where relevant, monetization notes (passes), and a publish checklist.',
    'Never claim the experience was published. Owner confirm before upload/spend.',
  ].join(' ');
}
