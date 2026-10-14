#!/usr/bin/env node
// Validates a faceless-video package before any render or upload: sourced
// script, YouTube metadata limits, CHE's own uploader limits, thumbnail
// honesty and the owner's publish approval. It never renders or uploads.
//
//   check_package.mjs package.json [--json]
//
// Format: .claude/skills/che-youtube/reference/package-format.md
import { readFileSync } from 'node:fs';

const WPM = 150; // narration pace used for the duration estimate
// A sentence that states a checkable fact must cite a source: numbers, years,
// percentages, records, studies and attributions.
const FACTUAL = /\d|%|\b(?:percent|million|billion|thousand|hundred|first|largest|smallest|biggest|oldest|fastest|tallest|deepest|most|least|only|record|according to|stud(?:y|ies)|research(?:ers)?|scientists?|survey|report(?:ed|s)?|discovered|invented|founded|died|born)\b/i;
const HYPE = /\b(?:guaranteed|100% (?:true|real|proven)|you won'?t believe|doctors hate|shocking truth|exposed|banned|secret they)\b/i;

export function checkPackage(pkg = {}) {
  const errors = [];
  const warnings = [];
  const str = (v) => (typeof v === 'string' ? v : '');
  const title = str(pkg.title).trim();
  const description = str(pkg.description);
  const tags = Array.isArray(pkg.tags) ? pkg.tags.map(String) : [];
  const sources = Array.isArray(pkg.sources) ? pkg.sources : [];
  const lines = Array.isArray(pkg.script) ? pkg.script.map((s) => str(s?.say ?? s)) : str(pkg.script).split(/\n+/);
  const sentences = lines.flatMap((l) => l.match(/[^.!?]+[.!?]*(?:\s*\[[\d,\s]+\])*/g) || []).map((s) => s.trim()).filter(Boolean);

  if (str(pkg.topic).trim().length < 3) errors.push('topic: name the topic');
  if (!title) errors.push('title: missing');
  if (title.length > 100) errors.push(`title: ${title.length} characters; YouTube and CHE's uploader allow 100`);
  else if (title.length > 70) warnings.push(`title: ${title.length} characters; search results cut titles near 70`);
  if (/[<>]/.test(title + description)) errors.push('title/description: "<" and ">" are not allowed by YouTube');
  if (description.length > 5000) errors.push(`description: ${description.length} characters; YouTube allows 5000`);
  else if (description.length > 500) warnings.push(`description: ${description.length} characters; CHE's uploader (youtube_upload.js) keeps only the first 500`);
  const tagChars = tags.reduce((n, t) => n + t.length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
  if (tagChars > 500) errors.push(`tags: ${tagChars} characters; YouTube allows 500`);
  if (HYPE.test(`${title} ${description} ${str(pkg.thumbnail_text)}`)) warnings.push('metadata: hype wording reads as misleading; say what the video actually shows');

  // Sources: real https links with an id the script can cite.
  const ids = new Map();
  for (const [i, s] of sources.entries()) {
    const id = Number(s?.id);
    if (!Number.isInteger(id)) errors.push(`sources[${i}]: needs a numeric id`);
    else if (!/^https:\/\/[^\s/]+\.[^\s]+/.test(str(s?.url))) errors.push(`source ${id}: needs an https URL that was actually opened`);
    else ids.set(id, s);
  }
  const cited = new Set();
  let uncited = 0;
  for (const sentence of sentences) {
    const refs = [...sentence.matchAll(/\[([\d,\s]+)\]/g)].flatMap((m) => m[1].split(',').map((n) => Number(n.trim())));
    for (const n of refs) {
      if (!ids.has(n)) errors.push(`script cites [${n}] but there is no source ${n}: "${sentence.slice(0, 80)}"`);
      cited.add(n);
    }
    if (!refs.length && FACTUAL.test(sentence.replace(/\[[\d,\s]+\]/g, ''))) {
      uncited += 1;
      if (uncited <= 5) errors.push(`unsourced factual claim: "${sentence.slice(0, 100)}"`);
    }
  }
  if (uncited > 5) errors.push(`…and ${uncited - 5} more unsourced factual claims`);
  for (const id of ids.keys()) if (!cited.has(id)) warnings.push(`source ${id} is never cited`);
  if (!sentences.length) errors.push('script: empty');

  // Duration at a steady narration pace.
  const words = sentences.join(' ').replace(/\[[\d,\s]+\]/g, '').split(/\s+/).filter(Boolean).length;
  const seconds = Math.round((words / WPM) * 60);
  const target = Number(pkg.target_seconds) || 0;
  if (target && Math.abs(seconds - target) > target * 0.15) warnings.push(`length: about ${seconds} s of narration for a ${target} s target`);
  if (target > 90) warnings.push(`length: CHE's free GitHub renderer makes 5–90 s videos; ${target} s needs another renderer`);

  // The thumbnail may not promise what the video does not say.
  const thumb = str(pkg.thumbnail_text).trim();
  if (!thumb) warnings.push('thumbnail_text: empty');
  else {
    if (thumb.split(/\s+/).length > 6) warnings.push(`thumbnail_text: ${thumb.split(/\s+/).length} words; keep it to 6 or fewer`);
    const body = sentences.join(' ').toLowerCase();
    for (const n of thumb.match(/\d[\d,.]*%?/g) || []) {
      if (!body.includes(n.toLowerCase())) errors.push(`thumbnail_text: "${n}" does not appear in the script`);
    }
  }

  // Publishing is the owner's decision, every time.
  const privacy = str(pkg.privacy) || 'unlisted';
  const approval = pkg.owner_publish_approval;
  const approved = Boolean(approval && str(approval.quote).trim() && str(approval.at).trim());
  if (!['private', 'unlisted', 'public'].includes(privacy)) errors.push(`privacy: "${privacy}" is not private, unlisted or public`);
  if (privacy === 'public' && !approved) errors.push('privacy: public needs owner_publish_approval with his own words and the time');
  if (privacy !== 'unlisted') warnings.push(`privacy: CHE's uploader currently always uploads unlisted; "${privacy}" must be set by hand on YouTube`);

  return {
    ok: errors.length === 0,
    ready_to_render: errors.length === 0,
    ready_to_publish: errors.length === 0 && approved,
    errors,
    warnings,
    stats: { sentences: sentences.length, words, narration_seconds: seconds, sources: ids.size, cited: cited.size, uncited_factual: uncited },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`check_package: ${file ? `cannot read ${file}: ${error.message}` : 'usage: check_package.mjs package.json [--json]'}`);
    process.exit(2);
  }
  const r = checkPackage(pkg);
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.ok ? 'OK' : 'NOT READY'}: ${r.errors.length} error(s), ${r.warnings.length} warning(s); ~${r.stats.narration_seconds} s narration, ${r.stats.cited}/${r.stats.sources} sources cited`);
    for (const e of r.errors) console.log(`ERROR ${e}`);
    for (const w of r.warnings) console.log(`warn  ${w}`);
    console.log(`render: ${r.ready_to_render ? 'ready' : 'not ready'}; publish: ${r.ready_to_publish ? 'owner approved' : 'needs the owner\'s direct yes'}`);
  }
  process.exit(r.ok ? 0 : 1);
}
