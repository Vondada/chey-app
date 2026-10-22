// CHE's Capability Showroom (owner addendum, 2026-10-22): what CHE can create, grouped for discovery, with the truth about
// each capability. It is a VIEW over the existing command catalog (command_catalog.js) and its connector facts
// (worker.js commandConnectors, which reads the runtime capability registry). It holds no second registry.
//
// Readiness rule (never advertise a capability as Ready on a button alone):
//   ready        the catalog says the command is available now AND a named test file backs it, with no partial reason
//   needs_setup  the catalog says a connection or key is missing (the reason names it)
//   unavailable  the catalog says it is temporarily blocked
//   partial      some of it works; the reason says what does not
//   planned      not implemented (no command exists for it yet)
// A card marked illustrative is an illustration, never a real output. A card with no real file is never shown as one.

import { commandById, commandStatus } from './command_catalog.js';

export const STATES = Object.freeze({
  ready: 'Ready',
  needs_setup: 'Needs setup',
  partial: 'Partial',
  unavailable: 'Unavailable',
  planned: 'Planned',
});

// Owner categories, in the order the owner asked for them. Each capability: what it is, what it produces, the catalog
// command it runs through (or null), the test file that proves its route (required for Ready), and the reason it is
// partial or planned when that is the truth. recent: which saved record, if any, is shown as the real example.
export const SHOWROOM = Object.freeze([
  {
    id: 'inventions', title: 'Inventions & Engineering', summary: 'Concepts, parts, costs and feasibility for engineered designs.',
    capabilities: [
      cap('suit', 'Iron Man-inspired suit concepts', 'A concept suit with parts by subsystem, cost bands and feasibility notes.', 'Invention project: parts, cost bands, feasibility, stages.', 'Saved invention project', 'Invention Studio (chat)', null, 'invention_chat.test.mjs', { partial: 'Parts, cost bands and feasibility work. There is no 3D model, exploded view or assembly animation yet.', recent: 'invention', start: 'Design me an Iron Man-style suit', illustrative: true }),
      cap('exo', 'Powered exoskeleton designs', 'An assist-device concept with joints, power, sensors and safety limits.', 'Invention project for an exoskeleton.', 'Saved invention project', 'Invention Studio (chat)', null, 'invention_chat.test.mjs', { partial: 'Same limits as the suit: no 3D model or animation yet.', recent: 'invention', start: 'Design me a powered exoskeleton', illustrative: true }),
      cap('robotics', 'Robotics', 'A robot concept with actuators, sensors, control and a supervised test plan.', 'Robot project with a parts list.', 'Saved invention project', 'Invention Studio (chat)', null, 'invention_chat.test.mjs', { partial: 'Parts and plans only. No simulation or hardware check is run.', recent: 'invention', start: 'Design me a walking robot', illustrative: true }),
      cap('mechanical', 'Mechanical assemblies', 'How parts fit together, shown as a layered list.', 'Layer-by-layer assembly list.', 'Text layers', 'Invention Studio (chat)', null, 'invention_chat.test.mjs', { planned: 'No assembly model exists. Only the layer list is written.', start: 'Show me how it assembles' }),
      cap('product', 'Product design', 'A product concept with its parts and costs.', 'Product concept with a parts list.', 'Saved invention project', 'Invention Studio (chat)', null, 'invention_chat.test.mjs', { partial: 'Works for hardware concepts through the Invention Studio only.', recent: 'invention', start: 'Design me a handheld gadget' }),
      cap('modeling3d', '3D modeling', 'A 3D model you can rotate.', 'A 3D model file.', 'Office 3D creator', 'Office 3D creator (create-3d)', 'create-3d', 'invention_chat.test.mjs', { partial: 'The Office creator runs, but no interactive 3D preview is connected in the app.' }),
      cap('exploded', 'Exploded views', 'A view that separates the parts of a design.', 'Exploded diagram.', 'None yet', null, null, null, { planned: 'Not built. The breakdown is a text list.' }),
      cap('assembly', 'Assembly animations', 'Parts that animate into place, one by one.', 'Animated assembly.', 'None yet', null, null, null, { planned: 'Not built. No animation data exists for a model.' }),
      cap('simulation', 'Engineering simulation', 'Runs of a design under stated assumptions.', 'Simulation results with the assumptions shown.', 'Simulation run', 'Simulation Lab (sim_lab)', null, 'sim_lab.test.mjs', { partial: 'The Simulation Lab searches options and runs Monte Carlo on stated physics. It is not an animated engineering simulation.', recent: 'simulation' }),
      cap('parts_pricing', 'Parts, pricing and suppliers', 'Parts with their sourcing status and planning cost bands.', 'Bill of materials with labels on every part.', 'Saved invention project', 'Invention Studio (chat)', null, 'invention_chat.test.mjs', { partial: 'Planning bands and sourcing labels only. Live supplier and price lookup is not connected, so no vendor is confirmed.', recent: 'invention', start: 'Tell me piece by piece what it costs' }),
    ],
  },
  {
    id: 'video', title: 'Video, Film & Animation', summary: 'Short and long videos, explainers, storyboards, narration and thumbnails.',
    capabilities: [
      cap('reels', 'Instagram Reels', 'A vertical video for Reels.', 'A vertical MP4.', 'Rendered MP4', 'Faceless video (yt-video)', 'yt-video', 'media_retrieval.test.mjs', { partial: 'The renderer makes vertical video. A Reels export preset is not built.', recent: 'video', start: 'Make a vertical Reel about how a battery works' }),
      cap('tiktok', 'TikTok videos', 'A short vertical video for TikTok.', 'A vertical MP4.', 'Rendered MP4', 'Faceless video (yt-video)', 'yt-video', 'media_retrieval.test.mjs', { partial: 'The renderer makes vertical video. A TikTok export preset is not built.', recent: 'video', start: 'Make a TikTok about the solar system' }),
      cap('shorts', 'YouTube Shorts', 'A short vertical video for YouTube.', 'A vertical MP4 and its upload title.', 'Rendered MP4', 'Faceless video (yt-video)', 'yt-video', 'media_retrieval.test.mjs', { recent: 'video', start: 'Make a YouTube Short about how rain forms' }),
      cap('explainer', 'Animated educational explainers', 'A narrated explainer with illustrated scenes.', 'An MP4 with narration and captions.', 'Rendered MP4', 'Faceless video (yt-video)', 'yt-video', 'media_retrieval.test.mjs', { partial: 'Illustrated scenes and narration. Full character animation is not built.', recent: 'video', start: 'Make an animated explainer about photosynthesis' }),
      cap('stick', 'Stick-figure animations', 'Stick figures that move through a scene.', 'An animated MP4.', 'None yet', null, null, null, { planned: 'Not built. Only illustrated stills exist today.' }),
      cap('cinematic', 'Cinematic street stories', 'A short story told with a shot list and narration.', 'A pilot script and storyboard.', 'Creator Studio pilot', 'Creator Studio (studio-pilot)', 'studio-pilot', 'creator_studio.test.mjs', { partial: 'The pilot script and storyboard are written. Full cinematic rendering is not connected.', recent: 'video', start: 'Write a pilot for a street story series' }),
      cap('character', 'Character animations', 'A character that moves on screen.', 'An animated character clip.', 'None yet', null, null, null, { planned: 'Not built. Illustrated stills are not animation.' }),
      cap('faceless', 'Faceless videos', 'A video without a presenter on camera.', 'A faceless MP4.', 'Rendered MP4', 'Faceless video (yt-video)', 'yt-video', 'media_retrieval.test.mjs', { recent: 'video', start: 'Make a faceless video about the history of coffee' }),
      cap('storyboards', 'Storyboards', 'Scene-by-scene shot planning.', 'A storyboard list with shot notes.', 'Creator Studio bible', 'Creator Studio (studio-bible)', 'studio-bible', 'creator_studio.test.mjs', { partial: 'Written storyboards. Per-scene images are not rendered by default.', start: 'Make a storyboard for a 30-second ad' }),
      cap('narration', 'AI narration and captions', 'A spoken narration with captions.', 'Narration audio and a caption list.', 'Audio file', 'Narration (yt-voice)', 'yt-voice', 'phone_voice.test.mjs', { partial: 'Narration depends on a voice key being connected.', start: 'Narrate a 60-second explainer about bees' }),
      cap('thumbnails', 'Video thumbnails', 'A thumbnail image for a video.', 'A thumbnail picture.', 'Picture', 'Thumbnail (yt-thumbnail)', 'yt-thumbnail', 'media_retrieval.test.mjs', { recent: 'picture', start: 'Make a thumbnail for my explainer' }),
    ],
  },
  {
    id: 'apps', title: 'Apps, Websites & Games', summary: 'Mobile apps, websites, dashboards, prototypes and 3D worlds.',
    capabilities: [
      cap('mobile', 'Mobile applications', 'An app built and checked before it ships.', 'A build of the app and its source.', 'App build', 'App build (app-build)', 'app-build', 'chey_app_build.test.mjs', { partial: 'Builds need the GitHub build connection. Store publishing is not automatic.', start: 'Build a mobile app for my barbershop bookings' }),
      cap('websites', 'Websites', 'A website with its pages and hosting.', 'A site and its publish link.', 'Website build', 'Website build (site-build)', 'site-build', 'site_hosting.test.mjs', { partial: 'Building works. A live publish needs the hosting connection.', start: 'Build a landing page for my bakery' }),
      cap('dashboards', 'Dashboards', 'A screen of live numbers.', 'A dashboard screen.', 'Trading dashboard', null, null, 'alpaca_paper.test.mjs', { partial: 'Trading and Office dashboards exist. A general dashboard builder is planned.', start: 'Show me a dashboard of my week' }),
      cap('prototypes', 'Interactive prototypes', 'A clickable prototype of a product.', 'A prototype you can click through.', 'None yet', null, null, null, { planned: 'Not built.' }),
      cap('games', 'Game development', 'A small playable game.', 'A playable game build.', 'None yet', null, null, null, { planned: 'Not built. Game scenes are not a builder yet.' }),
      cap('worlds', '3D worlds', 'A world you can move through.', 'A CHE World scene.', 'CHE World scene', 'CHE World', null, 'world_scene.test.mjs', { partial: 'CHE World shows Brain, Office and plan scenes. A general 3D world builder is not built.', recent: 'plan' }),
      cap('interface', 'Interface design', 'Redesigned screens and layouts.', 'A redesign plan and screens.', 'Redesign report', 'Site redesign (site-redesign)', 'site-redesign', 'site_hosting.test.mjs', { partial: 'Redesign plans and checks. The screens are not rendered for review.', start: 'Redesign the checkout page of my site' }),
      cap('automation', 'Automation tools', 'Recurring tasks run on a schedule you approve.', 'A workflow with steps and checkpoints.', 'Workflow record', 'Automate (automate)', 'automate', 'command_center.test.mjs', { start: 'Automate my weekly report' }),
    ],
  },
  {
    id: 'business', title: 'Business & Creative Projects', summary: 'Ads, stores, scripts, logos, plans and launches.',
    capabilities: [
      cap('ads', 'Marketing advertisements', 'Ad copy and an ad plan.', 'Ad copy and a posting plan.', 'Plan text', 'Ads plan (ads-plan)', 'ads-plan', 'command_center.test.mjs', { partial: 'Copy and plans. Ads are not placed or paid for without your yes.', start: 'Make 3 ads for my bakery' }),
      cap('stores', 'Online stores', 'A store with products and checkout.', 'A store build.', 'None yet', null, null, null, { planned: 'Not built. Checkout is not connected.' }),
      cap('books', 'Books and scripts', 'Scripts and series bibles.', 'A script or bible document.', 'Creator Studio bible', 'Creator Studio (studio-bible)', 'studio-bible', 'creator_studio.test.mjs', { partial: 'Scripts and bibles. Long books are not in scope.', start: 'Write the first chapter of a mystery story' }),
      cap('logos', 'Logos and graphics', 'A logo or a graphic.', 'A picture file.', 'Picture', 'Image engine', null, 'media_retrieval.test.mjs', { partial: 'Pictures are made by the image engine. A logo workflow is not built.', recent: 'picture', start: 'Design a logo for my coffee shop' }),
      cap('business_plan', 'Business plans', 'A plan with goals, costs and steps.', 'A plan with stages.', 'Project plan', 'Business launch (business-launch)', 'business-launch', 'project_plan.test.mjs', { recent: 'plan', start: 'Write a business plan for a dog-walking service' }),
      cap('launches', 'Product launches', 'A launch plan with dates and channels.', 'A launch plan.', 'Project plan', 'Marketing plan (marketing-plan)', 'marketing-plan', 'command_center.test.mjs', { start: 'Plan the launch of my new product' }),
    ],
  },
  {
    id: 'trading', title: 'Trading & Research', summary: 'Charts, paper trading, backtests, journals and research. No order is placed from here.',
    capabilities: [
      cap('charts', 'Interactive market charts', 'A chart with markers and levels.', 'A chart screen.', 'Trading chart', 'Trading chart (trade-chart)', 'trade-chart', 'trading_live.test.mjs', { partial: 'Charts use stored delayed bars unless a live feed is connected.', start: 'Show me the NQ chart' }),
      cap('paper', 'Paper trading', 'Simulated trades with no real money.', 'A paper ledger.', 'Paper ledger', 'Paper simulation (trade-sim)', 'trade-sim', 'trading_live.test.mjs', { partial: 'Paper records exist. Live orders are never placed from the Showroom.' }),
      cap('backtest', 'Backtesting', 'A test of a rule on past bars.', 'Backtest results with the rule shown.', 'Backtest record', 'Backtest (trade-backtest)', 'trade-backtest', 'trading_live.test.mjs', { partial: 'Results depend on the bars stored. Long history is not guaranteed.', start: 'Backtest the opening range rule' }),
      cap('strategy_compare', 'Strategy comparisons', 'Two or more rules side by side.', 'A comparison table.', 'Strategy registry', null, null, 'trading_live.test.mjs', { partial: 'The registry lists rules. A side-by-side report is not built.' }),
      cap('journal', 'Trading journals', 'A journal of trades and reasons.', 'A journal list.', 'Trading journal', 'Trading journal (trade-journal)', 'trade-journal', 'trading_live.test.mjs', { recent: 'journal', start: 'Open my trading journal' }),
      cap('market_research', 'Market research', 'Research on a market, with sources shown.', 'A research summary with sources.', 'Research record', 'Market research (trade-research)', 'trade-research', 'research_memory.test.mjs', { partial: 'Sources are shown only when they are retrieved. Unsourced claims are not made.' }),
      cap('trade_education', 'Educational simulations', 'A lesson on a trading idea, with a simulation.', 'A lesson and a simulation.', 'Lesson text', 'Trading learning (trade-learning)', 'trade-learning', 'trading_live.test.mjs', { partial: 'Lessons are text. Interactive simulations are not built.' }),
    ],
  },
  {
    id: 'office', title: 'Office & AI', summary: 'CHE’s agents, coding jobs, research, memory and multi-agent work.',
    capabilities: [
      cap('agents', 'CHE’s agents', 'The Office crew, with their desks and work.', 'Agent status and work records.', 'Office records', 'Office status (office-status)', 'office-status', 'office_board.test.mjs', { recent: 'office', start: 'What is Atlas working on?' }),
      cap('coding', 'Coding jobs', 'Changes to CHE’s code, with a pull request and checks.', 'A job record with its checks and PR.', 'Coding job', 'Build (che-build)', 'che-build', 'coding_history.test.mjs', { partial: 'Jobs run through GitHub Actions. Results appear in the job record.', start: 'What is the status of my coding job?' }),
      cap('ai_research', 'AI research', 'Research on a technical question, with sources.', 'A research note with its sources.', 'Research record', 'Research (che-research)', 'che-research', 'research_memory.test.mjs', { partial: 'Sources are shown only when they are retrieved.', start: 'Research how diffusion models work' }),
      cap('brain', 'Brain and Knowledge Library', 'Your memories and saved knowledge.', 'Memory records with dates and sources.', 'Brain records', 'Memory (che-memory)', 'che-memory', 'personal_recall.test.mjs', { start: 'What do you remember about my favorite food?' }),
      cap('multi_agent', 'Multi-agent projects', 'Several Office agents working on one project.', 'A project with each agent’s work.', 'Office project', 'Delegate (office-delegate)', 'office-delegate', 'office_workforce.test.mjs', { partial: 'Agents are assigned and report. Their output is checked before it is called done.', start: 'Ask the Office to plan a product launch' }),
      cap('skills', 'Skills and workflows', 'Saved steps you can run again.', 'A workflow record.', 'Workflow', 'Skill learn (skill-learn)', 'skill-learn', 'command_center.test.mjs', { partial: 'Only approved skills run. Installing a new skill needs your yes.' }),
    ],
  },
]);

function cap(id, title, description, example, output, command, commandId, proof, extra = {}) {
  return Object.freeze({
    id, title, description, example, output,
    command_label: command,
    command: commandId,
    proof,
    partial: extra.partial || '',
    planned: extra.planned || '',
    recent: extra.recent || '',
    start: extra.start || '',
    illustrative: Boolean(extra.illustrative),
  });
}

/** The readiness state of one capability, with the reason and what is missing. Connectors are the catalog's facts. */
export function capabilityState(item, connectors = {}, { hasProofFile = () => false } = {}) {
  if (item.command) {
    const command = commandById(item.command);
    if (!command) return { state: 'planned', reason: `The catalog has no command ${item.command}.`, missing: [] };
    const status = commandStatus(command, connectors);
    if (status.status === 'setup_required' || status.status === 'unsupported') {
      return {
        state: 'needs_setup',
        reason: status.missing.map((m) => `${m.label}: ${m.detail || m.setup}`.trim()).join(' ') || 'A connection is missing.',
        missing: status.missing.map((m) => m.label),
      };
    }
    if (status.status === 'temporarily_unavailable') return { state: 'unavailable', reason: 'It is temporarily blocked right now.', missing: [] };
    // The catalog says it runs. Ready still needs a named proof, and no partial reason.
    if (item.partial) return { state: 'partial', reason: item.partial, missing: [] };
    if (!item.proof || !hasProofFile(item.proof)) return { state: 'partial', reason: 'It runs through the catalog, but no test file proves its route yet.', missing: [] };
    return { state: 'ready', reason: '', missing: [] };
  }
  if (item.partial) return { state: 'partial', reason: item.partial, missing: [] };
  return { state: 'planned', reason: item.planned || 'Not built yet.', missing: [] };
}

/** The whole showroom: every category with each capability's state, and the counts. Pure given its inputs. */
export function showroomView(connectors = {}, { recent = {}, hasProofFile = () => false } = {}) {
  const counts = { ready: 0, needs_setup: 0, partial: 0, unavailable: 0, planned: 0 };
  const categories = SHOWROOM.map((category, index) => ({
    id: category.id,
    number: index + 1,
    title: category.title,
    summary: category.summary,
    capabilities: category.capabilities.map((item) => {
      const { state, reason, missing } = capabilityState(item, connectors, { hasProofFile });
      counts[state] += 1;
      const real = recent[item.recent] || null;
      return {
        id: item.id,
        title: item.title,
        description: item.description,
        example: item.example,
        output: item.output,
        command: item.command,
        command_label: item.command_label,
        start: item.start,
        state,
        status_label: STATES[state],
        reason,
        missing,
        // A picture is an illustration until a real saved output is attached to the card.
        illustrative: !real,
        thumbnail: real ? 'real' : 'illustration',
        thumbnail_note: real ? 'Real saved output.' : 'Concept example: an illustration, not an output CHE made.',
        recent_project: real ? { ...real, kind: item.recent } : null,
        preview: item.command ? `command:${item.command}` : null,
      };
    }),
  }));
  return { categories, counts, total: counts.ready + counts.needs_setup + counts.partial + counts.unavailable + counts.planned };
}

// The owner asks CHE what she can do, shows an example, or which features need setup. These match the words of
// those questions to the showroom, so the answer comes from the same states the cards show.
const OVERVIEW = /\b(?:what\s+(?:can|could)\s+you\s+(?:create|make|build|design)|show\s+(?:me\s+)?(?:what\s+you\s+can|your\s+capabilit|everything)|capabilit(?:y|ies)|showroom)\b/i;
const NEEDS_SETUP = /\b(?:which|what)\s+(?:features?|capabilit(?:y|ies)|things?)\s+(?:need|still\s+need)\s+(?:setup|set\s+up|connect\w*)|needs?\s+setup\b/i;
const EXAMPLE = /\b(?:show|give|see)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:example|sample|demo)\s+(?:of|for)\s+(?:an?\s+|the\s+)?(.{3,60})/i;
const CAN_RENDER = /\bcan\s+you\s+(?:actually\s+)?(?:render|make|build|design|create|model)\s+(?:this\s+|it\s+|that\s+)?(?:in\s+)?(?:3d|three\s*d|3-d|a\s+video|a\s+game|an?\s+app|a\s+website)\s*[?.!]?\s*$/i;

/** The showroom question in a message, with what it asks for, or null. */
export function showroomIntent(message) {
  const text = String(message || '').replace(/^(?:che|chay|chey)[,:]?\s+/i, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 300) return null;
  if (NEEDS_SETUP.test(text)) return { kind: 'needs_setup', query: text };
  const example = EXAMPLE.exec(text);
  if (example) return { kind: 'example', query: example[1].trim() };
  if (CAN_RENDER.test(text)) return { kind: 'can_render', query: text };
  if (OVERVIEW.test(text)) return { kind: 'overview', query: text };
  return null;
}

const STOP_WORDS = new Set(['the', 'and', 'that', 'this', 'with', 'what', 'show', 'example', 'examples', 'can', 'you', 'your', 'for', 'from', 'into', 'about', 'make', 'give', 'some', 'have', 'does', 'how', 'its', 'are', 'is', 'of', 'me', 'my', 'a', 'an', 'to', 'in', 'on', 'at', 'it', 'list', 'function', 'sorts', 'actually', 'sample', 'demo', 'please', 'there', 'any']);

/** The capabilities a showroom question is about. A match needs a word from the capability's title, so a stray word in a
 * description never claims an answer. The best matches come first. */
export function matchShowroom(view, query = '') {
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  const all = view.categories.flatMap((c) => c.capabilities.map((item) => {
    const title = item.title.toLowerCase();
    const titleHits = words.filter((w) => title.includes(w)).length;
    const bodyHits = words.filter((w) => `${item.description} ${item.example}`.toLowerCase().includes(w)).length;
    return { ...item, category: c.title, score: titleHits * 2 + bodyHits };
  }));
  return all.filter((item) => item.title && words.some((w) => item.title.toLowerCase().includes(w)))
    .sort((a, b) => b.score - a.score).slice(0, 3);
}

/** The spoken or shown answer for a showroom question. It repeats only the states the view holds. */
export function showroomReply(view, intent) {
  const c = view.counts;
  const overall = `I can do ${view.total} things across ${view.categories.length} groups. Ready now: ${c.ready}. Partial: ${c.partial}. Needs setup: ${c.needs_setup}. Unavailable: ${c.unavailable}. Planned: ${c.planned}.`;
  if (intent.kind === 'needs_setup') {
    const needs = view.categories.flatMap((cat) => cat.capabilities.filter((item) => item.state === 'needs_setup'));
    if (!needs.length) return `Nothing needs setup right now, sir. ${overall}`;
    return `These need setup, sir: ${needs.slice(0, 8).map((item) => `${item.title} (${item.reason})`).join('; ')}.`;
  }
  if (intent.kind === 'can_render') {
    const hits = matchShowroom(view, intent.query);
    if (!hits.length) return `I cannot find that in my capability list, sir, so I will not claim it. ${overall}`;
    const top = hits[0];
    return `${top.title} is ${top.status_label}, sir. ${top.reason || top.description} ${top.illustrative ? 'Its picture is a concept example, not an output I made.' : ''}`.trim();
  }
  if (intent.kind === 'example') {
    const hits = matchShowroom(view, intent.query);
    if (!hits.length) return `I have no example for "${intent.query}", sir. ${overall}`;
    return `${hits[0].title} (${hits[0].status_label}): ${hits[0].example} ${hits[0].thumbnail_note}`;
  }
  return overall;
}
