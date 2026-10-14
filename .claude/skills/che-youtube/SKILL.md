---
name: che-youtube
description: Plan, research, script and package a faceless YouTube video for CHE's video line, and validate the package before any render or upload. The package holds the sourced script, title, description, tags and thumbnail text. Use when asked to make, script, research or publish a YouTube video, Short or thumbnail, or to change CHE's video pipeline (topic_scout.js, faceless_video.js, video_line.js, youtube_upload.js, tools/che_video_render.py). Publishing always waits for the owner's direct yes.
---

# CHE YouTube (reusable workflow, future-ready)
Status: the package format and the validator work today. Rendering and upload reuse CHE's existing pipeline. Nothing in this skill uploads.

## The existing pipeline: reuse it, never rebuild it
1. **Topic:** `topic_scout.js`.
2. **Plan:** `faceless_video.js` `planFacelessVideo`.
3. **Render**, with one of:
   - the free GitHub renderer: `github_video_renderer.js` with `che-video-render.yml` and `tools/che_video_render.py`. It makes 5–90 s MP4s, kept as an artifact and never uploaded;
   - MoneyPrinter (`moneyprinter.js`).
4. **Upload:** `youtube_upload.js`. It uploads unlisted, keeps a title of up to 100 characters, and clips the description to 500.
5. **Orchestration:** `video_line.js`. It reserves the topic first, so a topic is never produced twice.

## Steps
1. **Research** with che-fact-check's tiers.
   - Use only pages actually opened in this session.
   - Every factual sentence cites a source id, like `[1]`.
   - No invented statistics, quotes or dates.
2. **Write the package JSON**: format in `reference/package-format.md`, example in `examples/package.example.json`.
3. **Validate:** `node .claude/skills/che-youtube/scripts/check_package.mjs package.json`.
   - Errors must be zero. Explain each warning plainly.
   - The validator checks:
     - unsourced claims and missing sources;
     - YouTube's title, description and tag limits, and CHE's 500-character description clip;
     - whether numbers in the thumbnail appear in the script;
     - narration length against the target;
     - privacy and publish approval.
4. **Render** only when the owner asks. The free renderer is CHE's own tool and needs no extra approval.
5. **Publish** only with `owner_publish_approval`: his own words and the time, from this conversation. The default stays unlisted.

## Rules
- Faceless means no impersonation: no real person's face, voice or brand.
- Follow YouTube's altered or synthetic content disclosure when realistic synthetic media shows real people, places or events.
- The title and thumbnail may not promise anything the video does not show.
- Spending money (stock media, paid voices) needs the owner's yes first.

## Lessons (append dated entries)
- **2026-10-14, measured with `tests/measure.mjs`.** Checking a package by hand means reading 11,216 bytes of uploader and pipeline code. `check_package.mjs` answers in 738 bytes. It cannot judge whether a claim is true, only whether it is sourced, so still read the sources.
- **2026-10-14: CHE's uploader silently clips descriptions to 500 characters.** The validator warns before that happens.
