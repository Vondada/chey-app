# CHE Chat-to-Creation audit

Scope: a normal Chat request for an image, a video or a 3D object, from routing to the saved asset, the Gallery and the
Creation Room. Branch `wt/chat-to-creation` (worktree), based on `origin/main` at 60ba3a08.

Method: static reading of the code with file:line receipts. Nothing was run against a live Worker, Modal, GitHub or a
paid engine. The only executed evidence is the offline test output listed at the end.

Tags: **verified-by-reading** = the cited lines say this. **not-verified** = needs a live run, a device, a binding or
an owner check that this audit could not do.

Line numbers refer to the tree at this commit.

## Summary

| Media | Chat route | Saved where | Gallery (`/api/media`) lists it | Creation Room opens it |
|---|---|---|---|---|
| Image, default engine | Yes (worker.js:13595, 13600) | media index + R2 or Durable Object key | Yes | Yes, as a picture |
| Image, Modal GPU (explicit ask, flag on) | Yes (chat_image_provider.js:84-87) | media index, after a later result check | Yes, once saved | Yes, once saved |
| Video | Yes (worker.js:13626, 13740) | media index; R2 when bound, else CHE store, or an external URL / GitHub artifact | Yes | Yes, with video playback |
| 3D object | **No generative 3D route in chat** | Creation Studio projects, not the media index | No | Only the Creation Studio, not the Gallery |

## 1. Image

### 1a. Route from Chat (default engine)

- **Gate.** A turn with `image_generation` and no `video_generation` and no attachment goes to `chatPictureTurn`
  (worker.js:13595-13601). Owner only (worker.js:13596), and manufacturing requests are refused (worker.js:13598).
  [verified-by-reading]
- **Engine choice.** `chatImageProvider` picks Modal only when `CHE_MODAL_TXT2IMG=enabled`, a Modal credential exists and the
  call cap is not used (chat_image_provider.js:10-19). Anything else, including `count > 1`, is Workers AI
  (chat_image_provider.js:11-17). [verified-by-reading]
- **Count.** `requestedImageCount` reads "two", "3" and so on, capped at 4 (chat_images.js:15-21). [verified-by-reading]
- **Making.** `makeChatImages` calls `generateImage` once per picture and records a success or a reason
  (chat_images.js:27-41). `generateImage` tries engines in order: owner connector (media.js:533), paid OpenAI and Gemini
  only when paid media is enabled (media.js:534-545), then the CHE Workers AI engine FLUX.1 schnell (media.js:536-541).
  [verified-by-reading]
- **Reply.** `chatImageReply` is built only from the results (chat_images.js:44-59). The Workers AI note names the engine
  and the reason (chat_image_provider.js:43-45). [verified-by-reading]

### 1b. Where the asset is saved

- `generateImage` builds the record at media.js:514-523. The record has **no `kind` field** (it has `mime_type`, set later).
  The bytes are sniffed as PNG/JPEG/WebP before saving (media.js:582-586). [verified-by-reading]
- `storeBlob` (media.js:61-76): R2 under `media/<id>.<ext>` when `CHE_DATA_BUCKET` is bound (media.js:62-65), else the
  Durable Object key `media:<id>` (media.js:74). [verified-by-reading]
- The index entry is written at media.js:588 (`saveIndex`, capped at 200 items, media.js:20 and 30-32).
  [verified-by-reading]

### 1c. Gallery and chat

- Gallery: `GET /api/media` returns the whole index (worker.js:8013-8032). The app's Gallery strip keeps an item when
  `kind` is video or image, or when `mime_type` starts with `image/` (lib/che_creations.dart:25-27), so the missing `kind`
  is tolerated. [verified-by-reading]
- Chat: the reply carries `media_type: 'image'` and `media_url` = `/api/media/<id>/image` (chat_images.js:65-68, and
  chat_image_provider.js:90). [verified-by-reading]
- Creation Room: the "My Creations" tile strip is `CheCreationsStrip` (lib/create/che_creative_studio.dart:774,
  lib/home_state/hub_rooms.dart:615), which reads `/api/media` (lib/che_creations.dart:75). Tapping opens
  `CheCreationViewer` (lib/home_state/hub_rooms.dart:999; lib/che_creations.dart:206-220). [verified-by-reading]
- Not-verified: that the chat bubble and the viewer actually render the image on a device.

### 1d. Modal GPU picture (explicit ask only, behind a flag)

- Routing: explicit "on Modal" asks are never answered by another engine. If Modal is not chosen the reply says so and
  nothing is made (chat_image_provider.js:78-83, `explicitModalAsk` at 47-53). [verified-by-reading]
- Start: `startModalImage` checks the flag (media.js:369-371), the cap (media.js:375), the credential, reserves the $5 test
  budget worst case and sends one `/txt2img` call (media.js:368-407). The chat gets a 202 started reply
  (chat_image_provider.js:25-29), and the meta says `saved: false` (chat_image_provider.js:59-68). [verified-by-reading]
- Finish: `finishModalImage` (media.js:411-467) saves only when the model revision, the PNG type and the SHA-256 all match
  (media.js:444-451), then stores the bytes (media.js:458) and writes the index (media.js:459). The result is recorded as
  `state: 'saved'` and the budget is settled (media.js:461-464). [verified-by-reading]
- Who calls finish: the app polls `POST /api/media/modal/result` (worker.js:8067-8069; lib/chat_modal_picture.dart:87-96;
  lib/home_state/send.dart:1752), and the Durable Object alarm also runs `reconcileModalImages` (worker.js:14605,
  4211; media.js:473-488). [verified-by-reading]
- Gallery: the saved Modal item has `mime_type: 'image/png'` and no `kind`, so the Gallery keeps it (lib/che_creations.dart:27).
  [verified-by-reading]
- Cap: `CHE_MODAL_TXT2IMG_MAX` counts every record with a `call_id` (default 1, media.js:375 and
  chat_image_provider.js:17). This is a lifetime cap, as the comment at media.js:51 says. [verified-by-reading]
- **Defect found and fixed (see section 4):** a started Modal picture that ended in `failed` (Modal's own failure, a
  revision or hash mismatch, or the timeout) left its budget reservation `reserved` for ever. It counted against the $5 cap.

## 2. Video

### 2a. Route from Chat

- Gate: `videoAsk` is a `video_generation` capability that is not merely imagined or quoted (worker.js:13626; the
  capability itself is inferred at cognitive_capabilities.js:57-64). [verified-by-reading]
- Start: `generateVideo` at worker.js:13740 with a topic, thumbnail on. A queued job is kept in `che_video_pending` and
  checked on the next "status" turn (worker.js:13644, 13666). [verified-by-reading]
- Reply: a verified video returns `media_type: 'video'` and `media_url` = `/api/media/<id>/video` (worker.js:13688 and
  13769). [verified-by-reading]
- Engines (media.js:607-855): a `gha_` task is the free GitHub renderer (media.js:617); a storyboard needs GitHub
  (media.js:694-697); `CHE_VIDEO_GEN_URL` is MoneyPrinter (media.js:706-708); `CHE_VIDEO_RENDER_URL` is the faceless renderer
  (media.js:709). [verified-by-reading]

### 2b. Where the video is saved

- GitHub renderer (media.js:633-675): with `CHE_DATA_BUCKET` the MP4 and thumbnail are copied to R2 (media.js:658-670).
  Without it the item stays `blob: 'github-artifact'` (media.js:649), its durability is `github-artifact-30-days`
  (media.js:637), and the bytes are fetched from the GitHub artifact on each read (media.js:85-98). Index written at media.js:675.
  [verified-by-reading]
- MoneyPrinter (media.js:810-830): with R2 the MP4 is archived (media.js:821). Without R2 the record keeps the provider's
  URL as `record.url`, marked `durable = false` with a storage warning (media.js:828-830). The `/video` route redirects to
  that URL (worker.js:8088). [verified-by-reading]
- Video bytes with no URL go through `storeBlob` with `kind = 'video'`, which uses CHE's own store (media.js:67-73) when R2
  is not bound. Index written at media.js:854. [verified-by-reading]

### 2c. Gallery and Creation Room

- Gallery: the video item is in `/api/media` (worker.js:8013-8032) with `kind: 'video'` (media.js:686-687).
  The app builds the `/video` URL and the thumbnail from `thumbnail_media_id` (lib/che_creations.dart:33, 38-40).
  [verified-by-reading]
- Creation Room: the viewer uses `isVideo` from `kind` to play or view (lib/che_creations.dart:137, 215). [verified-by-reading]
- Not-verified: whether a GitHub render, a MoneyPrinter job or a video playback works in production. No live run was made.

## 3. 3D object

- **Chat has no 3D route.** The chat capability inference has no 3D id (cognitive_capabilities.js:19-97; the ids are
  web_research, cross_reference, image_generation, video_generation, multimodal, data_recognition, market_data,
  backtesting, self_development, multitasking, public_records, fine_tuning). [verified-by-reading]
- **Invention turn (chat) opens a procedural 3D view, not generated 3D.** A design turn makes a concept picture from
  `makeConcept` (worker.js:11242) and says "open it in 3D" (worker.js:11249). A visual turn can set `open_invention_3d`
  (worker.js:11258). The concept is a procedural sheet or the owner's image model, not a mesh (creation_freeform.js:6:
  "It is not text-to-3D: no model guesses a mesh."; creation_objects.js:3 and 60). [verified-by-reading]
- **Creation Studio builds 3D models, but over HTTP, not chat.** `CreationStudio` (creation_studio.js:725) queues
  "3D model and previews" jobs (creation_studio.js:934, 951) on the GPU queue. The routes are owner-only
  (worker.js:7594-7595, `/api/gpu|creations`; creation_studio.js:1190-1200). [verified-by-reading]
- Gallery: 3D models are not in the media index, so `/api/media` does not list them. Creation projects are stored under
  `creations:projects` (creation_studio.js:30); the project list uses `model_url` (project_library.js:136).
  [verified-by-reading]
- Creation Room: the app reads `/api/creations` for the Creation Studio list (lib/home_state/hub_rooms.dart:688). That is the
  project list, not the Gallery. [verified-by-reading the URL only]
- The catalog command `create-3d` only sends the text "Build a Roblox game: {input}" (command_catalog.js:1117-1122). It
  is not a 3D generator. [verified-by-reading; the command router was not traced]
- Not-verified: the Creation Studio's 3D jobs run on a GPU queue that was not exercised. Whether a chat turn can reach it
  through a command was not traced.

## 4. Defect fixed

**Open budget reservation for a Modal picture that failed (media.js).** `startModalImage` reserves the worst case in the
$5 test budget (media.js:390-391) and stores `budget_hold_id` on the record (media.js:399). `finishModalImage` and
`reconcileModalImages` then marked the picture `failed` on Modal's terminal failure, a revision or hash mismatch, or the
timeout, but never settled the reservation (before the fix, media.js:421 and 475-479). The reservation stayed `reserved`
and was counted in `reserved_usd` and `remaining_usd` (gpu_test_budget.js:35-45).

- Test first: `modal_image_route.test.mjs`, "a picture Modal reports failed settles its budget reservation instead of
  leaving it open". It failed before the fix (`the reservation for a started call is still open`).
- Fix: the `failed` closure settles the hold at the reserved maximum (media.js:422-426). The timeout branch of
  `reconcileModalImages` does the same (media.js:485). The reservation is settled at the maximum, not released, because
  the call did start and Modal may have billed it.
- Coverage: the new test covers the `failed` closure. The timeout branch in `reconcileModalImages` has the same fix but no
  test of its own, which is not-verified for the ledger value.

## 5. Other observations (not changed)

1. Image records from `generateImage` and the Modal path have no `kind` (media.js:514-523, 453-458). The Gallery copes by
   MIME type, but the field is inconsistent with video and upload records. Not a visible bug.
2. `creations()` labels every media item `kind: 'image'` with an image URL (activity.js:25-34). It is used only for the
   chat's "made across rooms" context (worker.js:14006), not for the Gallery or the Creation Room. A video shows as an
   image in that context text only.
3. Without R2, a MoneyPrinter video is an external, temporary URL (media.js:828-830), and a GitHub-artifact video expires
   after 30 days (media.js:637). Both are said in the record, but the owner should bind R2 for a durable file.
4. A Modal picture reaches the chat only by the app poll or the alarm (send.dart:1752, worker.js:14605). The chat reply
   itself says "started" with no picture. If the app is closed, the alarm still saves it to the Gallery.

## 6. Not verified

- Live behaviour of any route: Workers AI, the owner connector, OpenAI, Gemini, Modal, MoneyPrinter, GitHub renderer, the
  faceless renderer. No network or paid call was made, by instruction.
- Whether `CHE_DATA_BUCKET` is bound in production, which decides R2 or the fallback for every asset type.
- Whether `CHE_MODAL_TXT2IMG` is enabled in production (the default is off, media.js:369-371).
- Device behaviour: whether the chat bubble, the Gallery tile and the Creation Room viewer render an image or video. No
  Flutter build was run, by instruction.
- The `che_media_store.js` store internals (`mediaStore`) and the GitHub artifact download.
- The agent-side `/api/creations` (cheAgentBaseUrl), which may not be the Worker.
- The command router that maps `create-3d` and similar catalog commands to a 3D build.
- Whether the owner's session-start checks in CLAUDE.md (GitHub PR and checks, `main` SHA, `continuity_check`) were run.
  They were not, because this audit was scoped to the worktree and the task said no network calls.

## 7. Tests run

Command: `cd server/cloudflare && NODE_OPTIONS="--import ./test_offline_guard.mjs" node --test chat_image_provider.test.mjs chat_images.test.mjs modal_image_route.test.mjs media.test.mjs gpu_test_budget.test.mjs modal_budget_route.test.mjs`

- Before the fix, with the new regression test: `modal_image_route.test.mjs` 22 pass, 1 fail (the new test).
- After the fix: 71 tests, 71 pass, 0 fail.
