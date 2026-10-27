// Roblox place files from the Luau CHE's crew really wrote (owner, 2026-10-24: "build real Roblox-compatible games ...
// provide a path to Roblox Studio ... never claim playable without a verified build").
//
// extractLuau() finds the ```lua / ```luau code blocks in a project's saved text and its crew results. placeXml() writes
// them into an .rbxlx (Roblox's XML place format, which Roblox Studio opens with File > Open) on a baseplate with a spawn,
// each script where its code says it belongs: a server Script in ServerScriptService, a LocalScript in
// StarterPlayerScripts, a script that drives `script.Parent` as a Tool inside a Tool in StarterPack, and anything that
// returns a module in ReplicatedStorage. Nothing here runs the Luau or checks it against Roblox: the file is a draft to
// open and playtest in Studio, and every reply says so. The repository's own game (roblox/che-blade-arena) is built
// and syntax-checked by Rojo and luau-compile in .github/workflows/che-roblox-build.yml.

const FENCE = /```[ \t]*(lua|luau)[^\n]*\n([\s\S]*?)```/gi;
const MAX_SCRIPTS = 40;
const MAX_SOURCE = 60_000;

/** Luau code blocks in [text], each with a name taken from its first comment, a `local X = {}` module, or its place. */
export function extractLuau(text, from = '') {
  const out = [];
  for (const m of String(text || '').matchAll(FENCE)) {
    const source = m[2].replace(/\s+$/, '\n');
    if (!/\S/.test(source)) continue;
    out.push({ name: luauName(source, out.length + 1), source: source.slice(0, MAX_SOURCE), from, kind: scriptClassFor(source) });
    if (out.length >= MAX_SCRIPTS) break;
  }
  return out;
}

function luauName(source, n) {
  const mod = /^\s*local\s+([A-Z][A-Za-z0-9_]{1,40})\s*=\s*\{\s*\}/m.exec(source);
  if (mod) return mod[1];
  const named = /^\s*--+\s*(?:name|script|file)\s*:\s*([A-Za-z0-9_. -]{2,40})/im.exec(source);
  if (named) return named[1].trim().replace(/\.(?:server|client)?\.?luau?$/i, '').replace(/[^A-Za-z0-9_]+/g, '');
  return `Script${n}`;
}

/** Where the code says it runs: a Tool script, a LocalScript, a ModuleScript or a server Script. */
export function scriptClassFor(source) {
  const s = String(source || '');
  const tool = /\bscript\.Parent\b/.test(s) && /\b(?:Activated|Equipped|Unequipped)\b/.test(s);
  const client = /\bLocalPlayer\b|\bUserInputService\b|\bContextActionService\b|:FireServer\(/.test(s);
  if (tool) return client ? 'ToolLocalScript' : 'ToolScript';
  if (client) return 'LocalScript';
  if (/^\s*return\s+[A-Za-z_{]/m.test(s.split('\n').filter((l) => l.trim()).slice(-1)[0] || '')) return 'ModuleScript';
  return 'Script';
}

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// CDATA cannot contain "]]>": split it across two sections.
const cdata = (v) => `<![CDATA[${String(v).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

function part(ref, name, cls, size, y, extra = '') {
  return `<Item class="${cls}" referent="${ref}"><Properties><string name="Name">${esc(name)}</string><bool name="Anchored">true</bool>`
    + `<Vector3 name="size"><X>${size[0]}</X><Y>${size[1]}</Y><Z>${size[2]}</Z></Vector3>`
    + `<CoordinateFrame name="CFrame"><X>0</X><Y>${y}</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>`
    + `${extra}</Properties></Item>`;
}

/**
 * An .rbxlx place: a baseplate and spawn, and [scripts] ({name, source, kind}) where their code says they belong.
 * Returns { xml, placed: [{name, class, parent}] } so the reply can say exactly what is inside.
 */
export function placeXml({ scripts = [] } = {}) {
  let n = 0; const ref = () => `RBX${(++n).toString(16).toUpperCase().padStart(8, '0')}`;
  const placed = []; const groups = { ServerScriptService: [], ReplicatedStorage: [], StarterPlayerScripts: [], Tools: [] };
  const used = new Set();
  for (const s of scripts.slice(0, MAX_SCRIPTS)) {
    let name = String(s.name || 'Script').replace(/[^A-Za-z0-9_ ]+/g, '').slice(0, 40) || 'Script';
    for (let i = 2; used.has(name); i++) name = `${String(s.name || 'Script').slice(0, 36)}${i}`;
    used.add(name);
    const kind = s.kind || scriptClassFor(s.source);
    const cls = kind === 'ToolLocalScript' ? 'LocalScript' : kind === 'ToolScript' ? 'Script' : kind;
    const item = `<Item class="${cls}" referent="${ref()}"><Properties><string name="Name">${esc(name)}</string>`
      + `<ProtectedString name="Source">${cdata(String(s.source || '').slice(0, MAX_SOURCE))}</ProtectedString></Properties></Item>`;
    const parent = kind.startsWith('Tool') ? 'StarterPack' : cls === 'LocalScript' ? 'StarterPlayerScripts' : cls === 'ModuleScript' ? 'ReplicatedStorage' : 'ServerScriptService';
    (kind.startsWith('Tool') ? groups.Tools : groups[parent]).push({ name, item });
    placed.push({ name, class: cls, parent: kind.startsWith('Tool') ? `StarterPack/${name}Tool` : parent });
  }
  const svc = (cls, items) => `<Item class="${cls}" referent="${ref()}"><Properties><string name="Name">${cls}</string></Properties>${items.join('')}</Item>`;
  const tools = groups.Tools.map((t) => `<Item class="Tool" referent="${ref()}"><Properties><string name="Name">${esc(t.name)}Tool</string><bool name="RequiresHandle">true</bool></Properties>`
    + `<Item class="Part" referent="${ref()}"><Properties><string name="Name">Handle</string><bool name="CanCollide">false</bool><Vector3 name="size"><X>0.4</X><Y>4</Y><Z>0.4</Z></Vector3></Properties></Item>${t.item}</Item>`);
  const xml = '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    + 'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">'
    + `<Item class="Workspace" referent="${ref()}"><Properties><string name="Name">Workspace</string></Properties>`
    + part(ref(), 'Baseplate', 'Part', [256, 2, 256], -1, '<bool name="Locked">true</bool>')
    + part(ref(), 'SpawnLocation', 'SpawnLocation', [8, 1, 8], 0.5)
    + '</Item>'
    + svc('ServerScriptService', groups.ServerScriptService.map((g) => g.item))
    + svc('ReplicatedStorage', groups.ReplicatedStorage.map((g) => g.item))
    + svc('StarterPack', tools)
    + `<Item class="StarterPlayer" referent="${ref()}"><Properties><string name="Name">StarterPlayer</string></Properties>`
    + svc('StarterPlayerScripts', groups.StarterPlayerScripts.map((g) => g.item)) + '</Item>'
    + '</roblox>';
  return { xml, placed };
}
