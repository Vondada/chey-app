// CHE Creator Studio (owner issue #347): one original series, its pilot, the
// per-platform export profiles and the audience-growth plan, as data, plus
// the checks that keep them honest. Rendering reuses the free GitHub renderer
// through media.generateVideo; YouTube posting reuses youtube_upload.js and
// the owner's existing YouTube OAuth. Nothing here invents a render, an upload
// or a view count: each is reported only from a stored record or a platform's
// own answer.

import { generateVideo, listMedia, readBlob } from './media.js';
import { githubVideoConfigured } from './github_video_renderer.js';
import { uploadYouTube, youtubeVideoStatistics } from './youtube_upload.js';
import { youtubeAccessToken, youtubeStatus } from './youtube_connection.js';
import { classifyOwnerActions, withoutProhibitions, prohibitedText } from './owner_action_gate.js';

export const STUDIO_KEY = 'creator_studio_v1';

// The two reference videos are style direction only. Their names, characters,
// logos, music and scripts never appear in CHE's series (checked below).
export const REFERENCE_TERMS = Object.freeze(['lobby', 'westview', 'west view productions', 'what love made me do']);

export const SOURCES = Object.freeze([
  Object.freeze({
    id: 'S1', label: 'Anthropic research, 2025', publisher: 'Anthropic', published: '2025-03-27', read_on: '2026-10-19',
    title: 'Tracing the thoughts of a large language model',
    url: 'https://www.anthropic.com/research/tracing-thoughts-language-model',
    quotes: Object.freeze([
      'models are trained to output one word at a time',
      'language model training incentivizes hallucination: models are always supposed to give a guess for the next word.',
      'to generate a plausible—but unfortunately untrue—response.',
    ]),
  }),
  Object.freeze({
    id: 'S2', label: 'Claude docs: Reduce hallucinations', publisher: 'Anthropic', published: '', read_on: '2026-10-19',
    title: 'Reduce hallucinations',
    url: 'https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations',
    quotes: Object.freeze([
      'Explicitly give Claude permission to admit uncertainty. This simple technique can drastically reduce false information.',
      'Make Claude\'s response auditable by having it cite quotes and sources for each of its claims.',
    ]),
  }),
]);

export const SERIES_BIBLE = Object.freeze({
  id: 'street-smart-explainers',
  // A working name from the owner's own issue; he can rename it.
  title: 'Street Smart Explainers',
  format_label: 'Neighborhood Science',
  logline: 'On one corner block, the crew at a phone-repair shop and barbershop argues about everyday tech and money, and a chalkboard cutaway shows the real science behind each argument.',
  style: Object.freeze({
    look: 'Flat 2D line-drawn figures with round heads and simple limbs, bold outlines and a night-time city palette. Story scenes cut to chalkboard and diagram cutaways.',
    references: 'Style direction only: a simple illustrated science explainer, and a serialized neighborhood drama. No character, name, logo, music, voice, footage or script from any reference video is used.',
    capability: 'Phase 1 renders still illustrated scenes with burned-in captions and one narrator voice. It is not animation, not photoreal and not lip-synced.',
  }),
  tone: Object.freeze({
    voice: 'Warm, quick and funny. Natural neighborhood talk, specific and written with respect.',
    rules: Object.freeze([
      'Humor comes from character and situation, never from race, poverty, crime or dialect.',
      'No slurs, weapons, gang imagery or drug jokes.',
      'Story scenes are labeled STORY, facts FACT with a source, and comparisons ANALOGY.',
      'Every on-screen fact cites a source the team actually read.',
      'No promises of money, health or results, and no fake urgency.',
    ]),
  }),
  setting: Object.freeze({
    name: 'Reggie\'s Fix-It & Fades',
    description: 'A phone-repair counter and two barber chairs on a busy corner, the stoop next door, and Ms. Odette\'s chalkboard.',
  }),
  // Colors and props drive the renderer's figures; looks describe them in words.
  cast: Object.freeze([
    Object.freeze({ id: 'nia', name: 'Nia Brooks', role: 'The explainer', age: 24, bio: 'A community-college coding student who fixes phones at the shop. Patient, sharp and allergic to rumors.', look: 'Teal hoodie, high puff, big round glasses.', color: '#2EC4B6', accent: '#FFE66D', skin: '#8D5A3B', prop: 'glasses' }),
    Object.freeze({ id: 'reggie', name: 'Uncle Reggie', role: 'The skeptic', age: 56, bio: 'Owns the shop. Old-school and funny; trusts his gut and his clippers.', look: 'Gray beard, flat cap, barber apron.', color: '#3A506B', accent: '#F4A261', skin: '#5C3A21', prop: 'cap' }),
    Object.freeze({ id: 'tay', name: 'Tay Simmons', role: 'The believer', age: 17, bio: 'Nia\'s cousin. Wants to go viral and believes whatever his phone says first.', look: 'Red windbreaker, phone always up.', color: '#E63946', accent: '#A8DADC', skin: '#A0673F', prop: 'phone' }),
    Object.freeze({ id: 'odette', name: 'Ms. Odette', role: 'The chalkboard', age: 70, bio: 'A retired science teacher from the stoop next door. She runs the chalkboard cutaways.', look: 'Purple cardigan, chalk in hand, glasses on a chain.', color: '#7B2CBF', accent: '#E0AAFF', skin: '#6B4226', prop: 'chalk' }),
    Object.freeze({ id: 'bolt', name: 'BOLT', role: 'The shop bot', age: null, bio: 'The shop\'s chatbot on a cracked tablet. Always confident, sometimes wrong. Fictional; not any real product.', look: 'A tablet with a simple face on the screen.', color: '#4CC9F0', accent: '#F72585', skin: '#4CC9F0', prop: 'tablet' }),
  ]),
  episode_format: Object.freeze({
    aspect: '9:16', min_seconds: 30, max_seconds: 45,
    beats: Object.freeze([
      Object.freeze({ id: 'hook', purpose: 'The first 3 seconds: the argument starts.' }),
      Object.freeze({ id: 'setup', purpose: 'Who believes what, in one exchange.' }),
      Object.freeze({ id: 'explainer', purpose: 'Chalkboard cutaway: the real science, each fact sourced.' }),
      Object.freeze({ id: 'analogy', purpose: 'One everyday comparison, labeled ANALOGY.' }),
      Object.freeze({ id: 'payoff', purpose: 'Someone changes their mind, or the joke lands.' }),
      Object.freeze({ id: 'cliffhanger', purpose: 'A tease for next time and one honest call to action.' }),
    ]),
    continuity: 'Each episode starts where the last tease ended, and BOLT appears in every episode.',
  }),
  // Ideas only: each needs sources read before it is scripted.
  next_ideas: Object.freeze(['Why your phone battery drains faster in the cold', 'What compound interest really does', 'How a free app can know where you are']),
});

export const PILOT = Object.freeze({
  id: 'pilot', series: SERIES_BIBLE.id, episode: 'S1E1',
  title: 'Confident, Not Correct',
  topic: 'Why AI can sound confident when it is wrong',
  audience: 'Teens and adults who use chatbots and like a quick, funny science lesson.',
  width: 1080, height: 1920, aspect: '9:16', seconds: 40,
  sources: Object.freeze(['S1', 'S2']),
  scenes: Object.freeze([
    Object.freeze({ id: 's1', beat: 'hook', seconds: 3, kind: 'story', location: 'counter', shot: 'close-up', cast: Object.freeze(['tay', 'bolt']), speaker: 'tay',
      caption: '"BOLT said it, so it\'s facts."', narration: 'Tay swears the shop bot is never wrong.' }),
    Object.freeze({ id: 's2', beat: 'setup', seconds: 6, kind: 'story', location: 'counter', shot: 'two-shot', cast: Object.freeze(['tay', 'reggie']), speaker: 'reggie',
      caption: 'Sure ain\'t the same as right.', narration: '"It sounded so sure, Unc." Uncle Reggie laughs. "Sure ain\'t the same as right."' }),
    Object.freeze({ id: 's3', beat: 'explainer', seconds: 12, kind: 'fact', location: 'chalkboard', shot: 'cutaway-diagram', cast: Object.freeze(['odette']), speaker: 'odette',
      caption: 'AI writes one word at a time, always guessing the next.',
      narration: 'At the chalkboard, Ms. Odette explains. AI models are trained to write one word at a time, always guessing the next word. So an answer can sound right and still be untrue.',
      facts: Object.freeze([
        Object.freeze({ text: 'AI models are trained to output one word at a time.', sources: Object.freeze(['S1']) }),
        Object.freeze({ text: 'Their training pushes them to always guess the next word.', sources: Object.freeze(['S1']) }),
        Object.freeze({ text: 'That can produce a plausible answer that is untrue.', sources: Object.freeze(['S1']) }),
      ]),
      diagram: Object.freeze({ type: 'next-word', prompt: 'The shop bot is', options: Object.freeze(['sure', 'right', 'wrong']) }) }),
    Object.freeze({ id: 's4', beat: 'analogy', seconds: 6, kind: 'analogy', location: 'counter', shot: 'medium', cast: Object.freeze(['nia', 'tay']), speaker: 'nia',
      caption: 'Like autocomplete: it finishes the sentence, true or not.', narration: '"Think autocomplete," says Nia. "It finishes your sentence, true or not."' }),
    Object.freeze({ id: 's5', beat: 'payoff', seconds: 8, kind: 'fact', location: 'counter', shot: 'wide', cast: Object.freeze(['nia', 'reggie', 'tay']), speaker: 'nia',
      caption: 'Let it say "I don\'t know." Ask for sources. Check them.',
      narration: '"So let it say I don\'t know, and ask for sources. Then check them." Reggie nods. "Trust, then verify."',
      facts: Object.freeze([
        Object.freeze({ text: 'Letting the AI say "I don\'t know" can reduce false answers.', sources: Object.freeze(['S2']) }),
        Object.freeze({ text: 'Asking it to cite sources makes its answers checkable.', sources: Object.freeze(['S2']) }),
      ]) }),
    Object.freeze({ id: 's6', beat: 'cliffhanger', seconds: 5, kind: 'story', location: 'counter', shot: 'close-up', cast: Object.freeze(['bolt', 'tay']), speaker: 'bolt',
      caption: 'Next: BOLT vs. Ms. Odette. Follow for part 2.', narration: '"I am one hundred percent sure," says BOLT. Part two, next time.' }),
  ]),
  title_variants: Object.freeze(['Why AI Sounds Sure When It\'s Wrong', 'Confident Is Not Correct', 'The Shop Bot Was SO Sure']),
  description: 'Tay trusts the shop bot. Ms. Odette shows why AI can sound sure and still be wrong. The story is fiction; the facts are sourced: anthropic.com/research/tracing-thoughts-language-model and Claude\'s docs on reducing hallucinations. Illustrated still scenes, one narrator voice.',
  hashtags: Object.freeze(['#AI', '#ScienceExplained', '#StreetSmartExplainers']),
  disclosure: 'Fiction with sourced facts. Illustrated characters, not real people.',
});

// Where text may sit in a 1080x1920 frame. This is CHE's own conservative
// margin, not an official platform number: it keeps captions out of the top
// 15%, the bottom 35% and the right-hand button rail that these apps draw over
// a vertical video. The renderer draws text only inside these boxes.
export const SAFE_ZONE = Object.freeze({ top: 288, bottom: 672, left: 64, right: 144, basis: 'CHE conservative margin, not an official platform number' });
export const LAYOUT = Object.freeze({
  badge: Object.freeze([72, 300, 700, 364]),
  headline: Object.freeze([72, 380, 930, 580]),
  diagram: Object.freeze([300, 600, 930, 990]),
  caption: Object.freeze([72, 1030, 930, 1240]),
});

// Limits come from CHE's integration notes and were NOT re-checked against
// the official pages in this session (their hosts were unreachable). Each
// says so, and posting re-checks the live platform where an API exists.
const UNCHECKED = 'From CHE\'s integration notes; not re-checked against the official page on 2026-10-19.';
export const EXPORT_PROFILES = Object.freeze({
  youtube_shorts: Object.freeze({
    id: 'youtube_shorts', label: 'YouTube Shorts', aspect: '9:16', width: 1080, height: 1920, min_seconds: 1, max_seconds: 180,
    title_max: 100, text_max: 5000, text_name: 'description', hashtags_max: 5, extra_hashtags: Object.freeze(['#Shorts']),
    connector: 'youtube', visibility: 'unlisted', limits_checked: false, limits_basis: UNCHECKED,
    docs: 'https://developers.google.com/youtube/v3/docs/videos',
    authorize: 'Open Mailbox, Keys, YouTube and sign in with Google, approving the upload permission.',
  }),
  tiktok: Object.freeze({
    id: 'tiktok', label: 'TikTok', aspect: '9:16', width: 1080, height: 1920, min_seconds: 3, max_seconds: 180,
    title_max: 0, text_max: 2200, text_name: 'caption', hashtags_max: 5, extra_hashtags: Object.freeze([]),
    connector: '', visibility: 'private draft', limits_checked: false, limits_basis: `${UNCHECKED} TikTok also caps length per account at post time.`,
    docs: 'https://developers.tiktok.com/docs/en/content-posting-api-get-started',
    authorize: 'Register a TikTok developer app with the Content Posting API, get it approved (an unaudited app can post only privately), and then CHE needs a TikTok sign-in connector, which is not built yet.',
  }),
  instagram_reels: Object.freeze({
    id: 'instagram_reels', label: 'Instagram Reels', aspect: '9:16', width: 1080, height: 1920, min_seconds: 3, max_seconds: 900,
    title_max: 0, text_max: 2200, text_name: 'caption', hashtags_max: 5, extra_hashtags: Object.freeze([]),
    connector: '', visibility: 'not posted', limits_checked: false, limits_basis: UNCHECKED,
    docs: 'https://developers.facebook.com/documentation/instagram-platform',
    authorize: 'Use an Instagram professional account linked to a Facebook Page, get a Meta app approved for Instagram content publishing, and then CHE needs a Meta sign-in connector, which is not built yet.',
  }),
  facebook_reels: Object.freeze({
    id: 'facebook_reels', label: 'Facebook Reels', aspect: '9:16', width: 1080, height: 1920, min_seconds: 3, max_seconds: 90,
    title_max: 0, text_max: 2200, text_name: 'description', hashtags_max: 5, extra_hashtags: Object.freeze([]),
    connector: '', visibility: 'not posted', limits_checked: false, limits_basis: UNCHECKED,
    docs: 'https://developers.facebook.com/docs/video-api/guides/reels-publishing',
    authorize: 'Post from a Facebook Page, get a Meta app approved for Page Reels publishing, and then CHE needs a Meta sign-in connector, which is not built yet.',
  }),
});

export const GROWTH_PLAN = Object.freeze({
  rules: Object.freeze([
    'No bots, bought followers, bought views or fake engagement.',
    'No spam: at most one post per platform per day, and each post needs your yes.',
    'Results come only from a platform\'s own statistics; with nothing connected the answer is no data.',
    'A test with too few views is reported as too small to decide.',
  ]),
  experiments: Object.freeze([
    Object.freeze({ id: 'hook', name: 'Three hooks', change: 'The same episode with three different first-3-second lines.', measure: 'Views and average view duration per version.' }),
    Object.freeze({ id: 'caption', name: 'Platform captions', change: 'A caption written for each platform versus one shared caption.', measure: 'Views and shares per platform.' }),
    Object.freeze({ id: 'series', name: 'Part two tease', change: 'Episodes that end on a "part two" tease versus a closed ending.', measure: 'Follows per thousand views, and views of the next episode.' }),
    Object.freeze({ id: 'cadence', name: 'Posting days', change: 'Two posts a week on fixed days versus irregular posting.', measure: 'Views per post over four weeks.' }),
  ]),
});

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const words = (text) => clean(text).split(' ').filter(Boolean).length;
const castById = (bible) => new Map(bible.cast.map((c) => [c.id, c]));
const sourceById = (sources) => new Map(sources.map((s) => [s.id, s]));

/** Reference names, characters or titles that must never appear in CHE's series. */
export function referenceTermsIn(value) {
  const text = JSON.stringify(value).toLowerCase();
  return REFERENCE_TERMS.filter((term) => new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}\\b`).test(text));
}

export function validateBible(bible = SERIES_BIBLE) {
  const errors = [];
  for (const field of ['id', 'title', 'logline']) if (!clean(bible[field])) errors.push(`The bible has no ${field}.`);
  const ids = (bible.cast || []).map((c) => c.id);
  if (ids.length < 3) errors.push('A recurring cast needs at least three characters.');
  if (new Set(ids).size !== ids.length) errors.push('Two characters share an id.');
  for (const c of bible.cast || []) {
    for (const field of ['name', 'role', 'bio', 'look']) if (!clean(c[field])) errors.push(`${c.id || 'A character'} has no ${field}.`);
    for (const field of ['color', 'accent', 'skin']) if (!/^#[0-9A-Fa-f]{6}$/.test(String(c[field] || ''))) errors.push(`${c.id} has no valid ${field} color.`);
    if (!['glasses', 'cap', 'phone', 'chalk', 'tablet'].includes(c.prop)) errors.push(`${c.id} has no prop the renderer can draw.`);
  }
  if (!(bible.tone?.rules || []).length) errors.push('The bible has no tone rules.');
  const beats = (bible.episode_format?.beats || []).map((b) => b.id);
  if (beats[0] !== 'hook' || beats.length < 4) errors.push('The episode format must open with a hook and have at least four beats.');
  const borrowed = referenceTermsIn(bible);
  if (borrowed.length) errors.push(`The bible uses reference material: ${borrowed.join(', ')}.`);
  return { ok: errors.length === 0, errors };
}

/**
 * The pilot's own checks: 30-45 s vertical, scenes that add up, a hook in the
 * first 3 seconds, every shot's cast from the bible, every fact sourced, and
 * narration that fits its scene when spoken (at most 3 words a second).
 */
export function validateEpisode(episode = PILOT, bible = SERIES_BIBLE, sources = SOURCES) {
  const errors = [];
  const warnings = [];
  const cast = castById(bible);
  const known = sourceById(sources);
  const fmt = bible.episode_format || {};
  if (episode.aspect !== '9:16' || episode.width * 16 !== episode.height * 9) errors.push('The pilot must be vertical 9:16.');
  if (!(episode.seconds >= (fmt.min_seconds || 30) && episode.seconds <= (fmt.max_seconds || 45))) errors.push(`The pilot must last ${fmt.min_seconds || 30} to ${fmt.max_seconds || 45} seconds.`);
  const scenes = episode.scenes || [];
  if (scenes.length < 3 || scenes.length > 10) errors.push('The pilot needs 3 to 10 scenes.');
  const total = scenes.reduce((n, s) => n + Number(s.seconds || 0), 0);
  if (total !== episode.seconds) errors.push(`The scenes add up to ${total} seconds, not ${episode.seconds}.`);
  if (scenes[0]?.beat !== 'hook' || Number(scenes[0]?.seconds) > 3) errors.push('The first scene must be a hook of at most 3 seconds.');
  for (const s of scenes) {
    const label = `Scene ${s.id}`;
    if (!Number.isInteger(s.seconds) || s.seconds < 2 || s.seconds > 20) errors.push(`${label} must last 2 to 20 whole seconds.`);
    if (!['story', 'fact', 'analogy'].includes(s.kind)) errors.push(`${label} must be labeled story, fact or analogy.`);
    if (!s.cast?.length || s.cast.length > 3) errors.push(`${label} needs one to three characters in the shot.`);
    for (const id of s.cast || []) if (!cast.has(id)) errors.push(`${label} uses ${id}, who is not in the series cast.`);
    if (!(s.cast || []).includes(s.speaker)) errors.push(`${label}'s speaker is not in the shot.`);
    if (!clean(s.caption) || clean(s.caption).length > 90) errors.push(`${label} needs a caption of at most 90 characters.`);
    if (!clean(s.narration)) errors.push(`${label} has no narration.`);
    const pace = words(s.narration) / Math.max(1, Number(s.seconds));
    if (pace > 3) errors.push(`${label} narration is too fast to speak (${pace.toFixed(1)} words a second).`);
    if (s.kind === 'fact' && !(s.facts || []).length) errors.push(`${label} is labeled fact but states no sourced fact.`);
    for (const f of s.facts || []) {
      if (!(f.sources || []).length) errors.push(`${label} states "${f.text}" without a source.`);
      for (const id of f.sources || []) if (!known.has(id)) errors.push(`${label} cites ${id}, which is not a source the team read.`);
    }
    if (s.kind !== 'fact' && (s.facts || []).length) errors.push(`${label} states facts but is labeled ${s.kind}.`);
  }
  const used = new Set(scenes.flatMap((s) => (s.facts || []).flatMap((f) => f.sources || [])));
  for (const id of episode.sources || []) if (!used.has(id)) warnings.push(`Source ${id} is listed but no fact cites it.`);
  if (!clean(episode.title) || clean(episode.title).length > 100) errors.push('The pilot needs a title of at most 100 characters.');
  const borrowed = referenceTermsIn(episode);
  if (borrowed.length) errors.push(`The pilot uses reference material: ${borrowed.join(', ')}.`);
  return { ok: errors.length === 0, errors, warnings, seconds: total, scenes: scenes.length, words: scenes.reduce((n, s) => n + words(s.narration), 0) };
}

/**
 * The storyboard the free GitHub renderer draws (tools/che_video_render.py
 * validate_spec checks it again). Only what the renderer needs: frame, scene
 * timing, captions, narration, cast colors, the text layout and the source
 * labels that fact scenes show on screen.
 */
export function studioRenderSpec(episode = PILOT, bible = SERIES_BIBLE, sources = SOURCES) {
  const cast = castById(bible);
  const ids = [...new Set(episode.scenes.flatMap((s) => s.cast))];
  const cited = new Set(episode.scenes.flatMap((s) => (s.facts || []).flatMap((f) => f.sources)));
  return {
    v: 1, width: episode.width, height: episode.height, seconds: episode.seconds,
    series: bible.title, episode: episode.episode, title: episode.title, description: clean(episode.description).slice(0, 700),
    sources: sources.filter((s) => cited.has(s.id)).map((s) => ({ id: s.id, label: s.label })),
    cast: ids.map((id) => { const c = cast.get(id); return { id, name: c.name, color: c.color, accent: c.accent, skin: c.skin, prop: c.prop }; }),
    layout: { badge: [...LAYOUT.badge], headline: [...LAYOUT.headline], diagram: [...LAYOUT.diagram], caption: [...LAYOUT.caption] },
    scenes: episode.scenes.map((s) => ({
      seconds: s.seconds, kind: s.kind, shot: s.shot, location: s.location, cast: [...s.cast], speaker: s.speaker,
      caption: s.caption, narration: s.narration,
      sources: [...new Set((s.facts || []).flatMap((f) => f.sources))],
      diagram: s.diagram ? { type: s.diagram.type, prompt: s.diagram.prompt, options: [...s.diagram.options] } : null,
    })),
  };
}

/** Whether a text box sits inside a platform's caption-safe zone. */
export function boxInSafeZone(box, zone = SAFE_ZONE, width = 1080, height = 1920) {
  const [x0, y0, x1, y1] = box;
  return x0 >= zone.left && y0 >= zone.top && x1 <= width - zone.right && y1 <= height - zone.bottom;
}

// ─── Platforms ─────────────────────────────────────────────────────────────

const PLATFORM_WORDS = [
  ['youtube_shorts', /\b(?:you\s?tube|yt)(?:\s+shorts?)?\b|\bshorts\b/i],
  ['tiktok', /\btik\s?toks?\b/i],
  ['instagram_reels', /\b(?:instagram|insta|ig)\b(?:\s+reels?)?/i],
  ['facebook_reels', /\b(?:facebook|fb)\b(?:\s+reels?)?/i],
];

/** The platforms a request names, in the order the profiles list them. */
export function platformsIn(text) {
  const t = String(text || '').replace(/_/g, ' ');
  if (/\b(?:all|every|each)\s+(?:the\s+|four\s+)?(?:platforms?|apps?|sites?)\b/i.test(t)) return Object.keys(EXPORT_PROFILES);
  const found = PLATFORM_WORDS.filter(([, re]) => re.test(t)).map(([id]) => id);
  // A bare "Reels" is Instagram's, as most people mean it; Facebook Reels is asked for by name.
  if (/\breels?\b/i.test(t) && !found.some((id) => id.endsWith('_reels'))) found.push('instagram_reels');
  return Object.keys(EXPORT_PROFILES).filter((id) => found.includes(id));
}

/** The pilot's package for one platform, checked against that platform's profile. */
export function exportPackage(platform, { episode = PILOT, bible = SERIES_BIBLE } = {}) {
  const profile = EXPORT_PROFILES[platform];
  if (!profile) return { ok: false, platform, errors: [`I have no export profile for ${platform}.`], warnings: [] };
  const errors = [];
  const warnings = [];
  const hashtags = [...new Set([...episode.hashtags, ...profile.extra_hashtags])].slice(0, profile.hashtags_max);
  const title = profile.title_max ? clean(episode.title) : '';
  const text = clean(`${profile.title_max ? '' : `${episode.title}. `}${episode.description} ${episode.disclosure} ${hashtags.join(' ')}`);
  if (episode.aspect !== profile.aspect || episode.width !== profile.width || episode.height !== profile.height) errors.push(`${profile.label} needs ${profile.aspect} at ${profile.width} by ${profile.height}.`);
  if (episode.seconds < profile.min_seconds || episode.seconds > profile.max_seconds) errors.push(`${profile.label} takes ${profile.min_seconds} to ${profile.max_seconds} seconds; the pilot is ${episode.seconds}.`);
  if (profile.title_max && (!title || title.length > profile.title_max)) errors.push(`The ${profile.label} title must be 1 to ${profile.title_max} characters.`);
  if (text.length > profile.text_max) errors.push(`The ${profile.label} ${profile.text_name} is ${text.length} characters; the limit is ${profile.text_max}.`);
  if ([...episode.hashtags, ...profile.extra_hashtags].length > profile.hashtags_max) warnings.push(`Only ${profile.hashtags_max} hashtags are kept for ${profile.label}.`);
  for (const [name, box] of Object.entries(LAYOUT)) if (!boxInSafeZone(box, SAFE_ZONE, profile.width, profile.height)) errors.push(`The ${name} text sits outside the caption-safe zone.`);
  const check = validateEpisode(episode, bible);
  if (!check.ok) errors.push(...check.errors);
  if (!profile.limits_checked) warnings.push(profile.limits_basis);
  return {
    ok: errors.length === 0, platform, label: profile.label, errors, warnings,
    package: { title, text, text_name: profile.text_name, hashtags, aspect: profile.aspect, width: profile.width, height: profile.height,
      seconds: episode.seconds, captions: 'burned-in captions plus a captions.srt file', safe_zone: SAFE_ZONE, visibility: profile.visibility },
  };
}

// ─── Natural words ─────────────────────────────────────────────────────────
// A studio request is a verb acting on the series itself: "render the pilot",
// "export it for TikTok", "post the pilot to YouTube Shorts". A sentence that
// only names the pilot while it is about something else (its code, a test, an
// account, a thumbnail) is not one, and keeps its own route (review of #353).

const SUBJECT = /\b(?:pilot|s1\s?e1|series bible|show bible|street smart explainers?|creator studio|growth experiments?|audience[- ]growth)\b/i;
// "A pilot", an airline pilot, a pilot program or another show's pilot is not CHE's series.
const NOT_OURS = /\b(?:a|another|new|your own)\s+pilot\b|\bpilot(?:'s|s)?\s+(?:program|project|study|test|light|scheme|phase|season|license|licence|training|salary|seat)\b|\b(?:flight|plane|airline|aircraft|cockpit|jet|helicopter|airport|drone|co-?pilot|autopilot)\b|\bpilot(?:\s+episode)?\s+of\s+(?!the series|our|my series|street smart)/i;
const PRONOUN = /\b(?:it|that|this|the (?:video|short|reel|clip|episode|mp4))\b/i;
// What a studio verb may act on: the pilot, the episode, its video, or "it" in a studio conversation.
const OBJ = String.raw`(?:(?:the|our|that|this|my)\s+)?(?:pilot(?:\s+(?:episode|video|short|mp4))?|episode(?:\s+one)?|s1\s?e1|video|short|mp4|it)\b`;
const PARTS = String.raw`(?:script|scenes?|storyboard|shot\s+list|shots|narration|captions?|beat\s+sheet|spec)`;
const at = (verbs, tail = '') => new RegExp(String.raw`\b(?:${verbs})\s+(?:me\s+)?${OBJ}${tail}`, 'i');
// The object of a render, export or post ends the request, or is followed only by where, when or a
// new clause. "Make the pilot funnier", "make it 45 seconds", "make the pilot in Spanish" and
// "build the pilot storyboard" ask for an edit, which no studio command does (review of #353).
const PLATFORM_WORD = String.raw`(?:(?:my|our|the)\s+)?(?:you\s?tube|yt|shorts|tik\s?tok|instagram|insta|ig|facebook|fb|reels?|every\s+platform|all\s+(?:the\s+)?platforms)`;
const END = String.raw`(?=\s*(?:$|[.!?,;:]|(?:right\s+)?now\b|tonight\b|today\b|please\b|again\b|first\b|asap\b|soon\b|then\b|and\b|but\b|so\b|for\s+me\b|on\s+github\b|with\s+the\s+free\s+renderer\b|(?:for|to|on|onto|as)\s+(?:a\s+|an\s+)?${PLATFORM_WORD}\b))`;
const DEST_END = String.raw`(?=\s*(?:$|[.!?,;:]|(?:right\s+)?now\b|tonight\b|today\b|please\b|then\b|and\b|but\b|(?:to|on|onto)\s+(?:my|our|the)\b|(?:for|to|on|onto|as)\s+(?:a\s+|an\s+)?${PLATFORM_WORD}\b))`;
// Things a sentence can be about while naming the pilot: CHE's own code and app, an account, another asset.
const OTHER_THING = /\b(?:code|coding|codebase|tests?|testing|bugs?|fix(?:es|ed|ing)?|debug\w*|screens?|features?|pipelines?|prs?|pull\s+requests?|functions?|class(?:es)?|methods?|modules?|files?|repo(?:sitory)?|commits?|deploy\w*|apps?|api|endpoints?|widgets?|flutter|dart|javascript|python|accounts?|profiles?|logins?|passwords?|thumbnails?|logos?|banners?|posters?|cover\s+(?:art|image|photo)s?|websites?|landing\s+pages?|ads?|adverts?|campaigns?|budgets?|merch\w*|playlists?|trailers?|music|songs?|soundtracks?|voice\s*-?overs?|data|spreadsheets?|csv|json|logs?|databases?)\b/i;
// Where a post goes ("to my YouTube account") and the growth plan's own tests are not other things.
const OWN_WORDS = /\b(?:to|on|onto)\s+(?:my|our|the)?\s*(?:[\w-]+\s+){0,2}(?:account|channel|page|profile)s?\b|\b(?:growth|audience|a\/?b|hook)\s+tests?\b/gi;
// "Don't post it unless I say so": the gate keeps a ban with an exception, but the step is still forbidden now.
const BANNED_STEP = /\b(?:do\s+not|don['’]?t|never)\s+(?:(?:ever|even|just|go\s+and)\s+)*(post|publish|upload|share|render|export)\b[^.?!;,]*/gi;
// Buying, botting or faking an audience; "get me more views" with real posts is ordinary growth.
const FAKE_GROWTH = /\b(?:buy|buying|purchas(?:e|ed|ing)|bought|order|pay\s+for)\b[^.?!]{0,40}\b(?:followers|subscribers|subs|views|likes|engagement|comments|plays)\b|\b(?:bots?|botted|fake|purchased|bought)\b[^.?!]{0,40}\b(?:followers|subscribers|subs|views|likes|accounts|engagement|comments|plays)\b/i;
const QUESTION = /^(?:did|does|do|is|are|was|were|how|why|what|who|when|can|could|should)\b/i;
// A sentence that sends something to a person, or to a destination that is not a Studio platform
// (Gmail, Slack, Drive, Dropbox, a contact), keeps its own route: CHE's other routes answer it (review of #353).
const MAIL_VERB = /\b(?:e-?mail|mail|dm|message|forward)\b/i;
const SEND_VERB = /\b(?:post|publish|upload|share|send|put|sync|submit|deliver|transfer)\b/i;
// The destinations that are Studio's own: a platform, or the owner's own channel or account. "All my accountants" is not one.
const OWN_OR_PLATFORM = String.raw`(?:you\s?tube|yt|shorts?|tik\s?toks?|instagram|insta|ig|facebook|fb|reels?|(?:every|all|each)\s+(?:the\s+|four\s+)?platforms?|platforms?|channels?|accounts?|pages?|profiles?)`;
const FOREIGN_DEST = new RegExp(String.raw`\b(?:to|onto|into|for)\s+(?!(?:(?:my|our|the|a|an|his|her|their)\s+)?${OWN_OR_PLATFORM}\b)(?:(?:my|our|the|a|an|his|her|their)\s+)?[a-z]`, 'i');

function studioContext(history) {
  const recent = (Array.isArray(history) ? history : []).slice(-4).map((h) => String(h?.content || h?.text || '')).join(' ');
  return /\b(?:pilot|street smart explainers|series bible|confident, not correct)\b/i.test(recent);
}

export const FAKE_GROWTH_REPLY = 'I won\'t do that, sir: bought or fake followers, views and engagement break every platform\'s rules and can get the channel removed. I grow the audience only with real posts you approve. Nothing was bought or posted.';
export const NO_POST_REPLY = 'Understood, sir: I won\'t post the pilot anywhere until you tell me to, and each post still needs your yes. Nothing was posted.';

/**
 * A Creator Studio request in the owner's words, as the catalog command it
 * runs: { command, input }, or { say } for an answer that needs no command, or
 * null. It reads only what the owner asks for (prohibitions removed), and
 * leaves any money or delete request to the owner gates.
 */
export function studioChatIntent(message, history = []) {
  const raw = String(message || '').replace(/^\W*(?:hey[, ]*)?(?:che|chay|chey|shay)\b[,!:]?\s*/i, '').trim();
  if (!raw || raw.length > 400) return null;
  const series = /\b(?:pilot|s1\s?e1|series bible|show bible|street smart explainers?|creator studio)\b/i.test(raw);
  const subject = SUBJECT.test(raw) || (PRONOUN.test(raw) && studioContext(history));
  const growthWords = /\b(?:followers|subscribers|audience|views|engagement)\b/i.test(raw) && /\b(?:pilot|series|channel|tiktok|reels?|shorts|instagram|youtube)\b/i.test(raw);
  if (FAKE_GROWTH.test(raw) && !QUESTION.test(raw) && (subject || growthWords)) return { say: FAKE_GROWTH_REPLY, refused: 'fake_growth' };
  if (!subject || NOT_OURS.test(raw)) return null;
  // "Growth experiments for my barbershop" is the owner's own business, not the series.
  if (!series && /\bfor\s+(?:my|a|an|his|her|their|the)\b/i.test(raw) && !/\b(?:channel|videos?|shorts|reels?|tiktok|series)\b/i.test(raw)) return null;
  if (classifyOwnerActions(raw).length) return null;
  // Verbs are read from what the owner asks for; the subject may sit anywhere ("don't render the pilot, just write the script").
  const banned = [...raw.matchAll(BANNED_STEP)];
  // Each clause is read on its own: "don't post it on TikTok, post it to YouTube Shorts" bans one platform, not both.
  const asked = raw.split(/[.;!?,]+|\bbut\b/i).map((clause) => withoutProhibitions(clause).replace(BANNED_STEP, ' ')).join(' ').replace(/\s+/g, ' ').trim();
  if (MAIL_VERB.test(raw) || (SEND_VERB.test(asked) && FOREIGN_DEST.test(asked))) return null;
  if (OTHER_THING.test(asked.replace(OWN_WORDS, ' '))) return null;
  const forbidden = `${prohibitedText(raw)} ${banned.map((m) => m[1].toLowerCase()).join(' ')}`;
  // Passed on as the platforms' own names, so a held post reads naturally.
  const platforms = platformsIn(asked).map((id) => EXPORT_PROFILES[id].label).join(', ');
  const pilotNamed = /\bpilot\b|\bepisode\b|\bs1\s?e1\b/i.test(raw);
  if (/\b(?:series|show)\s+bible\b|\b(?:who(?:'s| is| are)|tell me about|introduce)\b[^.?!]*\b(?:cast|characters)\b|\bstreet smart explainers?\b[^.?!]*\b(?:about|premise|cast|characters|tone|format)\b/i.test(asked)) {
    return { command: 'studio-bible', input: '' };
  }
  // A post needs a Studio platform. "Post the pilot" or "post it to my Slack team" names none, so it is not the studio's.
  if (platforms && (at('post|publish|upload', DEST_END).test(asked) || at('share|send|put', String.raw`\s+(?:to|on|onto)\b`).test(asked))) {
    return { command: 'studio-post', input: platforms };
  }
  if (at('export|package|format|prepare|prep|resize|crop|adapt', END).test(asked) || new RegExp(String.raw`\b(?:version|cut|export|package)\s+of\s+${OBJ}${END}`, 'i').test(asked)) {
    return { command: 'studio-export', input: platforms };
  }
  if (/\b(?:growth|audience)\s+(?:experiments?|plan|tests?)\b/i.test(asked) || at('how(?:\'s| is| are)', String.raw`\s+doing\b`).test(asked)
    || (pilotNamed && /\b(?:views|stats|statistics|analytics|performance|numbers|subscribers|followers|likes|comments|audience)\b/i.test(asked))) {
    return { command: 'studio-growth', input: '' };
  }
  if (pilotNamed && (new RegExp(String.raw`\b(?:write|show|read|give|open|send|draft|tell)\s+(?:me\s+)?(?:(?:the|our|that|this)\s+)?(?:pilot(?:'s)?\s+)?${PARTS}\b`, 'i').test(asked)
    || /\b(?:write|show|read|give|open|draft)\s+(?:me\s+)?(?:the\s+|our\s+)?pilot(?:\s+episode)?\b(?!\s+render)/i.test(asked)
    || at('what(?:\'s| is)(?:\\s+in)?', String.raw`(?:\s+about)?\s*[?.!]?\s*$`).test(asked))) {
    return { command: 'studio-pilot', input: '' };
  }
  if (at('is|has', String.raw`\s+(?:render\s+)?(?:ready|done|finished|rendered|rendering)\b`).test(asked) || /\b(?:pilot|render)\s+status\b/i.test(asked)
    || at('status\\s+of|where(?:\'s| is)|how(?:\'s| is)', String.raw`(?:\s+render(?:ing)?)?\b`).test(asked) && /\b(?:status|where|render)/i.test(asked)) {
    return { command: 'studio-render', input: 'status' };
  }
  if (at('render|make|produce|create|build|generate|finish', END).test(asked)
    || (pilotNamed && new RegExp(String.raw`\b(?:start|kick\s+off|run|queue)\s+(?:the\s+)?(?:pilot\s+)?render(?:ing)?${END}`, 'i').test(asked))) {
    return { command: 'studio-render', input: '' };
  }
  // "Don't post the pilot unless I say so": nothing will be posted, and CHE says so, naming a platform the ban names.
  if (/\b(?:post|publish|upload|share)\b/i.test(forbidden)) {
    const named = platformsIn(banned.map((m) => m[0]).join(' ')).map((id) => EXPORT_PROFILES[id].label);
    return { say: named.length ? `Understood, sir: I won't post the pilot to ${named.join(' or ')}. Every post still needs your yes. Nothing was posted.` : NO_POST_REPLY, ok: true, action: 'no_post' };
  }
  // "Don't render the pilot yet": the owner forbade the step, so CHE only reports where it stands.
  if (/\b(?:render|export)\b/i.test(forbidden)) return { command: 'studio-render', input: 'status' };
  return null;
}

// ─── Speech ────────────────────────────────────────────────────────────────

export function bibleSpeech(bible = SERIES_BIBLE) {
  const cast = bible.cast.map((c, i) => `${i + 1}. ${c.name}, ${c.role.toLowerCase()}: ${c.bio}`).join(' ');
  const beats = bible.episode_format.beats.map((b, i) => `${i + 1}. ${b.id}`).join(', ');
  return `The series bible, sir. "${bible.title}" (${bible.format_label}, a working title you can rename). ${bible.logline} `
    + `Cast: ${cast} Setting: ${bible.setting.name}. Tone: ${bible.tone.voice} Episode format: ${bible.episode_format.min_seconds} to ${bible.episode_format.max_seconds} seconds, vertical, in ${bible.episode_format.beats.length} beats: ${beats}. `
    + `${bible.style.capability} Every character and line is original; nothing is taken from the reference videos.`;
}

export function pilotSpeech(episode = PILOT, check = validateEpisode(episode)) {
  const scenes = episode.scenes.map((s, i) => `${i + 1}. ${s.beat}, ${s.seconds} seconds, ${s.kind.toUpperCase()}, ${s.shot} with ${s.cast.join(' and ')}: ${s.narration}${s.facts?.length ? ` Sources: ${[...new Set(s.facts.flatMap((f) => f.sources))].join(', ')}.` : ''}`).join(' ');
  const verdict = check.ok ? `It passes every check: ${check.seconds} seconds, ${check.scenes} scenes, ${check.words} spoken words.` : `It does not pass yet: ${check.errors.join(' ')}`;
  return `The pilot script, sir: ${episode.episode}, "${episode.title}", ${episode.seconds} seconds, vertical. ${scenes} ${verdict} `
    + `Sources: ${SOURCES.map((s) => `${s.id}, ${s.title}, ${s.url}`).join('; ')}. It is a script; nothing was rendered.`;
}

function platformState(id, yt) {
  const profile = EXPORT_PROFILES[id];
  if (profile.connector !== 'youtube') return { state: 'not_connected', detail: `${profile.label} is not connected; you must authorize it first. ${profile.authorize}` };
  if (yt?.connected) return { state: 'connected', detail: `YouTube is connected${yt.channel_title ? ` to ${yt.channel_title}` : ''}.` };
  if (yt?.status === 'needs_reconnect') return { state: 'needs_reconnect', detail: 'YouTube needs to be reconnected. Open Mailbox, Keys, YouTube and sign in again.' };
  return { state: 'not_connected', detail: `YouTube is not connected; you must authorize it first. ${profile.authorize}` };
}

function mediaReceipt(item) {
  if (!item) return null;
  return {
    media_id: item.id, title: item.title, seconds: item.duration_verified ? Number(item.duration_seconds) : null,
    bytes: Number(item.video_bytes) || null, width: Number(item.width) || null, height: Number(item.height) || null,
    video_codec: item.video_codec || '', audio_codec: item.audio_codec || '', thumbnail_media_id: item.thumbnail_media_id || null,
  };
}

function receiptWords(r) {
  return `${r.seconds ? `${Math.round(r.seconds)} seconds` : 'length not verified'}, ${r.width && r.height ? `${r.width} by ${r.height}` : 'size not verified'}, `
    + `${r.video_codec ? r.video_codec.toUpperCase() : 'unknown video'} with ${r.audio_codec ? r.audio_codec.toUpperCase() : 'no'} audio${r.bytes ? `, ${(r.bytes / 1048576).toFixed(1)} MB` : ''}`;
}

// ─── Runner ────────────────────────────────────────────────────────────────

async function loadStudio(storage) {
  return (await storage.get(STUDIO_KEY).catch(() => null)) || {};
}

/** The verified pilot MP4 in the media library, if one exists. */
async function verifiedPilot(storage, state) {
  const task = state.render?.task_id;
  if (!task) return null;
  return (await listMedia(storage)).find((item) => item.render_task_id === task && item.verified && item.kind === 'video') || null;
}

/**
 * Checks or starts the pilot render. A render is reported done only when
 * generateVideo returns a verified media item, which needs the renderer's
 * MP4 to pass mp4Facts (github_video_renderer.js).
 */
async function studioRender(input, ctx) {
  const { env, storage, origin } = ctx;
  const state = await loadStudio(storage);
  const yt = await youtubeStatus(env, ctx.data || {}).catch(() => ({ connected: false }));
  const statusOnly = /\bstatus\b/i.test(input);
  let restart = false;
  if (state.render?.task_id) {
    const checked = await generateVideo(env, storage, { task_id: state.render.task_id, prompt: 'Verified video render', title: PILOT.title, dispatched_at: Number(state.render.at || 0) });
    if (checked.item?.verified) {
      const r = mediaReceipt(checked.item);
      state.render = { ...state.render, status: 'verified', receipt: r };
      await storage.put(STUDIO_KEY, state);
      return { ok: true, studio_action: 'render', render_status: 'verified', task_id: state.render.task_id,
        media_type: 'video', media_url: `${origin}/api/media/${r.media_id}/video`, media_id: r.media_id,
        thumbnail_url: r.thumbnail_media_id ? `${origin}/api/media/${r.thumbnail_media_id}/image` : null,
        text: `The pilot is a verified MP4, sir: "${PILOT.title}", ${receiptWords(r)}. It is in your media library, and nothing was posted.${platformLine(state, yt)}` };
    }
    if (checked.pending) {
      const stage = checked.stage === 'running' ? 'rendering' : checked.stage === 'checking' ? 'checking' : 'queued';
      const where = stage === 'checking' ? 'still on GitHub, but GitHub asked me to wait before checking it again' : `${stage} on GitHub`;
      return { ok: true, studio_action: 'render', render_status: stage, task_id: state.render.task_id,
        text: `The pilot is ${where}, sir (task ${state.render.task_id}). No MP4 exists yet, and I did not start a second one.` };
    }
    state.render = { ...state.render, status: 'failed', error: String(checked.detail || 'No verified MP4 was returned.').slice(0, 300) };
    await storage.put(STUDIO_KEY, state);
    if (statusOnly) {
      return { ok: false, studio_action: 'render', render_status: 'failed', task_id: state.render.task_id,
        text: `The pilot render failed, sir: ${state.render.error} No MP4 exists. Say "render the pilot" to try again.` };
    }
    restart = true;
  }
  if (statusOnly) {
    return { ok: true, studio_action: 'render', render_status: 'not_started',
      text: `The pilot has not been rendered yet, sir. Say "render the pilot" to start it on the free GitHub renderer. Nothing was started or posted.${platformLine(state, yt)}` };
  }
  const check = validateEpisode(PILOT);
  if (!check.ok) return { ok: false, studio_action: 'render', render_status: 'invalid', text: `I did not render the pilot, sir: ${check.errors.join(' ')} Nothing was started.` };
  if (!githubVideoConfigured(env)) {
    return { ok: false, studio_action: 'render', render_status: 'not_configured',
      text: 'I did not render the pilot, sir: the free GitHub renderer is not set up. It needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker. Nothing was started.' };
  }
  const made = await generateVideo(env, storage, {
    prompt: `${SERIES_BIBLE.title} ${PILOT.episode}: ${PILOT.topic}`, topic: `${SERIES_BIBLE.title} ${PILOT.episode} ${PILOT.title}`,
    title: PILOT.title, seconds: PILOT.seconds, spec: studioRenderSpec(), new_job: restart,
  });
  if (!made.pending) {
    return { ok: false, studio_action: 'render', render_status: 'not_started',
      text: `${restart ? 'The earlier pilot render failed, and ' : ''}I could not start the pilot render, sir: ${made.detail || 'the renderer did not accept it.'} Nothing was posted.` };
  }
  const at = Date.now();
  state.render = { task_id: made.job_id, at, status: 'queued' };
  await storage.put(STUDIO_KEY, state);
  // The chat's own video status ("is my video ready?") follows the same job.
  await storage.put('che_video_pending', { task_id: made.job_id, prompt: PILOT.topic, title: PILOT.title, topic: `${SERIES_BIBLE.title} pilot`,
    created_at: new Date(at).toISOString(), dispatched_at: new Date(at).toISOString(), engine: made.engine || '' });
  return { ok: true, studio_action: 'render', render_status: 'queued', task_id: made.job_id,
    text: `${restart ? 'The earlier pilot render failed, so I started a new one. ' : ''}The free GitHub renderer ${made.reused ? 'already has' : 'accepted'} the pilot, sir: "${PILOT.title}", ${PILOT.seconds} seconds, vertical 1080 by 1920, ${PILOT.scenes.length} illustrated still scenes with burned-in captions and one narrator voice. It is not animated and not lip-synced. Task ${made.job_id} is queued. No MP4 exists yet, and nothing will be posted. Ask me "is the pilot ready?" in a few minutes.` };
}

// What is posted where, and which platforms can be posted to at all.
function platformLine(state, yt) {
  const posted = Object.entries(state.posts || {}).filter(([, p]) => p?.link);
  const open = Object.keys(EXPORT_PROFILES).filter((id) => platformState(id, yt).state !== 'connected').map((id) => EXPORT_PROFILES[id].label);
  const connected = Object.keys(EXPORT_PROFILES).filter((id) => platformState(id, yt).state === 'connected').map((id) => EXPORT_PROFILES[id].label);
  return `${posted.length ? ` Posted: ${posted.map(([id, p]) => `${EXPORT_PROFILES[id]?.label || id} ${p.link} (${p.visibility || 'unlisted'})`).join('; ')}.` : ''}`
    + `${connected.length ? ` ${connected.join(', ')}: connected; posting needs your yes.` : ''}${open.length ? ` ${open.join(', ')}: not connected.` : ''}`;
}

async function studioExport(input, ctx) {
  const { storage } = ctx;
  const platforms = platformsIn(input);
  if (!platforms.length) {
    return { ok: false, studio_action: 'export', text: `Which platform, sir? I can export the pilot for ${Object.values(EXPORT_PROFILES).map((p) => p.label).join(', ')}. Nothing was exported.` };
  }
  const state = await loadStudio(storage);
  const yt = await youtubeStatus(ctx.env, ctx.data || {}).catch(() => ({ connected: false }));
  const pilot = await verifiedPilot(storage, state);
  state.exports ||= {};
  const parts = [];
  const results = [];
  for (const id of platforms) {
    const out = exportPackage(id);
    const conn = platformState(id, yt);
    state.exports[id] = { at: Date.now(), ok: out.ok, errors: out.errors, title: out.package?.title || '', text: out.package?.text || '', hashtags: out.package?.hashtags || [] };
    results.push({ platform: id, ok: out.ok, errors: out.errors, connection: conn.state });
    parts.push(out.ok
      ? `${out.label}: the package passes: ${out.package.width} by ${out.package.height}, ${out.package.seconds} seconds, ${out.package.title ? `title "${out.package.title}", ` : ''}a ${out.package.text.length}-character ${out.package.text_name}, hashtags ${out.package.hashtags.join(' ')}, captions burned in plus an SRT file, all text inside the caption-safe zone. ${conn.state === 'connected' ? 'Posting needs your yes.' : conn.detail}`
      : `${out.label}: it does not pass: ${out.errors.join(' ')}`);
  }
  await storage.put(STUDIO_KEY, state);
  const video = pilot ? `The same verified MP4 master (${receiptWords(mediaReceipt(pilot))}) serves every platform.` : 'The video itself is not rendered yet; say "render the pilot" first.';
  return { ok: results.every((r) => r.ok), studio_action: 'export', exports: results,
    text: `Pilot export, sir. ${parts.join(' ')} ${video} The limits come from my notes and were not re-checked with the platforms today. Nothing was posted.` };
}

/** The video's identity: the record CHE made it from, and its GitHub artifact and size. */
function videoKey(item) {
  return { media_id: String(item.id || ''), render_task_id: String(item.render_task_id || ''), github_artifact_id: String(item.github_artifact_id ?? ''), video_bytes: Number(item.video_bytes) || 0 };
}

/** The account and the exact video the owner approved at the ask. A release must match both. */
function postPin(platform, yt, pilot) {
  return { platform, channel_id: String(yt.channel_id || ''), channel_title: String(yt.channel_title || ''), ...videoKey(pilot) };
}

/**
 * What changed since the owner's yes-ask, or '' when the same account and the same video are still
 * connected and rendered. A changed account or video is refused, never re-picked: the owner asks again.
 */
function postPinDrift(pin, pre) {
  const named = (title) => (title ? `"${title}"` : 'an account with no name');
  if (pin.platform !== pre.platform) return `You approved a post to another platform, sir. Nothing was posted. Ask me again to post the pilot.`;
  const yt = pre.yt || {};
  if (!pin.channel_id || String(yt.channel_id || '') !== pin.channel_id) {
    return `The YouTube account changed since you asked, sir. You approved ${named(pin.channel_title)}, and CHE is now connected to ${named(yt.channel_title)}. I did not post to it. Nothing was posted. Ask me again to post the pilot, and check the account it names.`;
  }
  const now = videoKey(pre.pilot);
  if (now.media_id !== pin.media_id || now.render_task_id !== pin.render_task_id || now.github_artifact_id !== pin.github_artifact_id || now.video_bytes !== pin.video_bytes) {
    return 'The pilot video changed since you asked, sir: it was rendered again. I did not post it. Nothing was posted. Ask me again to post the pilot, and check the new video it names.';
  }
  return '';
}

/** Why the pilot cannot be posted to this platform now, or the confirmation to ask. Never posts. */
export async function studioPostPreflight(input, ctx) {
  const platforms = platformsIn(input);
  const labels = Object.values(EXPORT_PROFILES).map((p) => p.label).join(', ');
  if (platforms.length > 1) return { blocked: `One platform at a time, sir: each post needs its own yes. Say, for example, "post the pilot to YouTube Shorts". Nothing was posted.` };
  if (!platforms.length) return { blocked: `Which platform, sir? ${labels}. Only YouTube Shorts can be connected today. Nothing was posted.` };
  const id = platforms[0];
  const profile = EXPORT_PROFILES[id];
  const yt = await youtubeStatus(ctx.env, ctx.data || {}).catch(() => ({ connected: false }));
  const conn = platformState(id, yt);
  if (conn.state !== 'connected') return { blocked: `${conn.detail} Nothing was posted.`, platform: id, connection: conn.state };
  if (!yt.channel_id) return { blocked: `I can't tell which YouTube account to post to, sir, so I won't post. Nothing was posted.`, platform: id };
  const state = await loadStudio(ctx.storage);
  if (state.posts?.[id]?.link) return { blocked: `The pilot is already on ${profile.label}, sir: ${state.posts[id].link} (${state.posts[id].visibility || 'unlisted'}). I did not post it again.`, platform: id, duplicate: true };
  const pilot = await verifiedPilot(ctx.storage, state);
  if (!pilot) return { blocked: `The pilot has no verified MP4 yet, sir, so there is nothing to post. Say "render the pilot" first. Nothing was posted.`, platform: id };
  if (pilot.format !== '9:16' || pilot.frame_size_verified !== true) {
    return { blocked: `The pilot MP4's vertical 9:16 frame was not confirmed from the file itself, sir, so I won't post it. Say "render the pilot" to make a new one. Nothing was posted.`, platform: id };
  }
  const out = exportPackage(id);
  if (!out.ok) return { blocked: `The ${profile.label} package does not pass: ${out.errors.join(' ')} Nothing was posted.`, platform: id };
  return {
    platform: id, pilot, out, yt, pin: postPin(id, yt, pilot),
    ask: `Post the pilot to ${profile.label}, sir? Account: YouTube channel ${yt.channel_title ? `"${yt.channel_title}"` : '(name not known)'}. Video: "${out.package.title}", ${receiptWords(mediaReceipt(pilot))}. Visibility: ${profile.visibility}, not public; making it public stays your choice on YouTube. Say yes to approve.`,
  };
}

async function studioPost(input, ctx) {
  const pre = await studioPostPreflight(input, ctx);
  if (pre.blocked) return { ok: false, studio_action: 'post', platform: pre.platform || '', connection: pre.connection || '', text: pre.blocked };
  // Only the account and video the owner approved at the ask may be posted: no pin, no post.
  const drift = ctx.pin ? postPinDrift(ctx.pin, pre) : 'I need the account and video you approved before I post, sir. Ask me again to post the pilot. Nothing was posted.';
  if (drift) return { ok: false, studio_action: 'post', platform: pre.platform, text: drift };
  const { env, storage, data } = ctx;
  const access = await youtubeAccessToken(env, data, ctx.fetcher);
  if (access.changed) ctx.changed = true;
  if (!access.ok) return { ok: false, studio_action: 'post', platform: pre.platform, text: `${access.error} Nothing was posted.` };
  const bytes = await readBlob(env, storage, pre.pilot);
  if (!bytes) return { ok: false, studio_action: 'post', platform: pre.platform, text: 'The pilot MP4 could not be read from storage (a GitHub artifact expires after 30 days). Nothing was posted.' };
  const uploaded = await uploadYouTube({ media_bytes: bytes, content_type: 'video/mp4', title: pre.out.package.title, description: pre.out.package.text }, access.token, ctx.fetcher);
  if (!uploaded.ok) return { ok: false, studio_action: 'post', platform: pre.platform, text: `YouTube did not take the pilot, sir: ${uploaded.error} Nothing was posted.` };
  const state = await loadStudio(storage);
  state.posts ||= {};
  state.posts[pre.platform] = { video_id: uploaded.video_id, link: uploaded.link, at: Date.now(), visibility: 'unlisted', media_id: pre.pilot.id };
  await storage.put(STUDIO_KEY, state);
  data.youtube_uploads ||= {};
  data.youtube_uploads[`studio:${PILOT.series}:${PILOT.episode}`] = { status: 'uploaded', link: uploaded.link, at: new Date().toISOString() };
  ctx.changed = true;
  return { ok: true, studio_action: 'post', platform: pre.platform, media_url: uploaded.link,
    text: `Uploaded unlisted to YouTube, sir: ${uploaded.link}. It is not public; YouTube decides whether it shows as a Short. Say "how is the pilot doing" later for its real numbers.` };
}

async function studioGrowth(ctx) {
  const state = await loadStudio(ctx.storage);
  const plan = GROWTH_PLAN.experiments.map((e, i) => `${i + 1}. ${e.name}: ${e.change} Measured by ${e.measure.toLowerCase()}`).join(' ');
  const rules = GROWTH_PLAN.rules.join(' ');
  const lines = [];
  const yt = state.posts?.youtube_shorts;
  if (yt?.video_id) {
    const access = await youtubeAccessToken(ctx.env, ctx.data || {}, ctx.fetcher).catch(() => ({ ok: false }));
    if (access.changed) ctx.changed = true;
    const stats = access.ok ? await youtubeVideoStatistics(access.token, [yt.video_id], ctx.fetcher) : { ok: false, error: 'YouTube is not connected.' };
    const row = stats.ok ? stats.videos.find((v) => v.id === yt.video_id) : null;
    if (row) {
      state.measurements = [{ platform: 'youtube_shorts', video_id: yt.video_id, at: Date.now(), ...row.statistics }, ...(state.measurements || [])].slice(0, 50);
      await ctx.storage.put(STUDIO_KEY, state);
      const s = row.statistics;
      // YouTube leaves out a count it does not report (likes hidden, comments off). That is not a zero.
      const counted = (n, noun) => (Number.isFinite(n) ? `${n} ${noun}` : `${noun} not reported`);
      lines.push(`YouTube Shorts, read from YouTube just now: ${counted(s.views, 'views')}, ${counted(s.likes, 'likes')}, ${counted(s.comments, 'comments')}.`);
    } else {
      lines.push(`YouTube Shorts: no data; ${stats.error || 'YouTube returned no statistics for the pilot.'}`);
    }
  } else {
    lines.push('YouTube Shorts: no data; the pilot has not been posted there.');
  }
  for (const id of ['tiktok', 'instagram_reels', 'facebook_reels']) lines.push(`${EXPORT_PROFILES[id].label}: no data; not connected.`);
  return { ok: true, studio_action: 'growth', measured: lines.some((l) => /read from/.test(l)),
    text: `The audience-growth plan, sir. ${plan} Rules: ${rules} Measurements: ${lines.join(' ')} I never estimate or invent views.` };
}

/** Runs one studio command; returns { ok, text, ...done fields }. */
export async function runStudioCommand(local, input, ctx) {
  if (local === 'studio_bible') {
    const check = validateBible();
    return { ok: check.ok, studio_action: 'bible', text: check.ok ? bibleSpeech() : `The series bible does not pass its checks, sir: ${check.errors.join(' ')}` };
  }
  if (local === 'studio_pilot') {
    const check = validateEpisode();
    return { ok: check.ok, studio_action: 'pilot', valid: check.ok, text: pilotSpeech(PILOT, check) };
  }
  if (local === 'studio_render') return studioRender(String(input || ''), ctx);
  if (local === 'studio_export') return studioExport(String(input || ''), ctx);
  if (local === 'studio_post') return studioPost(String(input || ''), ctx);
  if (local === 'studio_growth') return studioGrowth(ctx);
  return { ok: false, text: 'That studio command has no runner, sir. Nothing was run.' };
}


/** What the phone's Studio panel shows; the same records CHE reads aloud. */
export async function studioView(ctx) {
  const state = await loadStudio(ctx.storage);
  const yt = await youtubeStatus(ctx.env, ctx.data || {}).catch(() => ({ connected: false }));
  const pilot = await verifiedPilot(ctx.storage, state);
  const check = validateEpisode();
  return {
    series: { title: SERIES_BIBLE.title, format_label: SERIES_BIBLE.format_label, logline: SERIES_BIBLE.logline, cast: SERIES_BIBLE.cast.map((c) => ({ id: c.id, name: c.name, role: c.role })) },
    pilot: { episode: PILOT.episode, title: PILOT.title, seconds: PILOT.seconds, scenes: PILOT.scenes.length, valid: check.ok, errors: check.errors,
      render: pilot ? 'verified' : state.render?.status || 'not_started', task_id: state.render?.task_id || null, receipt: pilot ? mediaReceipt(pilot) : null },
    platforms: Object.values(EXPORT_PROFILES).map((p) => {
      const conn = platformState(p.id, yt);
      return { id: p.id, label: p.label, connection: conn.state, detail: conn.detail, exported: Boolean(state.exports?.[p.id]?.ok), posted: state.posts?.[p.id]?.link || null };
    }),
    capability: SERIES_BIBLE.style.capability,
  };
}
