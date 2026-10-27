# CHE accessibility audit: unlabeled tap targets

Reliability lane, 2026-10-25, at `main` `0c43197`. Read-only: no production file was changed.

AGENTS.md: every button needs a VoiceOver label and a voice route. `test/che_icon_button_label_test.dart` already requires a `tooltip:` on every `IconButton` in `lib/` (it passes: no unlabeled IconButton exists). This audit covers the other tap targets: `GestureDetector`, `InkWell` and `InkResponse` with `onTap`, `onLongPress`, `onDoubleTap`, `onTapUp` or `onTapDown`.

## Method
A tap target counts as labelled when its own arguments contain `Semantics(`, `semanticsLabel:`, `semanticLabel:`, `Tooltip(`, `tooltip:`, `Text(` or `label:`, or when `Semantics(`, `Tooltip(` or `MergeSemantics(` appears in the six lines above it. Pan/zoom-only detectors are not buttons and are skipped.

| Count | |
|---|---|
| Tap targets scanned | 113 |
| Labelled by Semantics/Tooltip | 65 |
| Labelled by visible text only (VoiceOver reads the text, but does not announce a button unless a Semantics wrapper says so) | 33 |
| **Flagged: no label found** | **15** |

The same scanner runs in `test/e2e_a11y_tap_targets_test.dart` as a **ratchet**: each file may keep at most today's count, so a new unlabeled tap target fails CI. Fix one, then lower that file's number in the test. A justified exception carries `// a11y-label-ok: <reason>` on a line above.

## Flagged tap targets (file:line at `0c43197`)

| # | file:line | Widget | What it is | Finding | Suggested fix |
|---|---|---|---|---|---|
| 1 | `lib/che_ui/che_plugins.dart:935` | GestureDetector `onTap: _openPlugin(p)` | Icon tile that opens a plugin | **Unlabeled.** Icon only; the plugin's name is a sibling Text outside the tap target, so VoiceOver reads nothing for the tile | `Semantics(button: true, label: 'Open ${p.name}')` |
| 2 | `lib/insights_brain_scene.dart:321` | GestureDetector `onTap: _openNode(nodes[i])` | Brain-scene node | **Unlabeled.** A scaled icon dot with no text | `Semantics(button: true, label: '<node title>, open')` (brain lane owns this file) |
| 3 | `lib/che_voice_ui.dart:65` | GestureDetector `onTap: widget.onTap` | `CheVoiceOrb` animated orb | **Unlabeled** inside the widget; no caller in `lib/` constructs this class today (the live orb is `lib/che_voice_orb.dart`), so it is latent | Label inside the widget, from the voice phase, like `che_home_chat.dart:41` |
| 4 | `lib/devices_hub_scene.dart:459` | GestureDetector `onTap: _openDevice` | Device badge | Text inside `_DeviceBadge` (device name) is read, but nothing says it is a button | `Semantics(button: true, label: 'Open ${node.name}')` |
| 5 | `lib/brain/che_knowledge_atlas.dart:815` | InkWell `onTap: _open(...)` | Card name line in the Atlas list | Child `_line()` renders Text, so it is read; no button role. An "Open" control also exists for each card (`_controls`) | `Semantics(button: true, ...)` or mark `excludeSemantics` and rely on the Open button |
| 6 | `lib/che_ui/che_widgets.dart:360` | GestureDetector in `ChePressable` | Shared pressable (35 uses) | No label of its own: depends on each caller's child/Semantics | Add an optional `semanticLabel` to `ChePressable` and wrap in `Semantics(button: true)` |
| 7 | `lib/che_theme.dart:106` | InkWell in `CheGlassPanel` | Shared tappable panel | No label of its own; no caller in `lib/` passes `onTap` today | As 6, when a caller adds `onTap` |
| 8 | `lib/conversations/che_conversations_screen.dart:292` | GestureDetector `onLongPress: copy` | Long-press to copy a chat bubble | Bubble text is read, but **copy has no VoiceOver route** (long press is awkward with VoiceOver) | `Semantics(customSemanticsActions: {CustomSemanticsAction(label: 'Copy'): copy})` |
| 9 | `lib/home/che_home_chat.dart:138` | GestureDetector `onLongPress` | Long-press on an owner bubble | As 8 | As 8 |
| 10 | `lib/che_ui/che_agent_chat.dart:805` | GestureDetector `onTap: _focus.unfocus()` | Tap the chat list to dismiss the keyboard | Not a button (keyboard dismiss); acceptable | `// a11y-label-ok: dismisses the keyboard only` |
| 11 | `lib/main.dart:1825` | GestureDetector `onTap: _composerFocus.unfocus()` | Same as 10 on the main chat | Not a button; acceptable | as 10 |
| 12 | `lib/visual/che_image_canvas.dart:109` | GestureDetector `onTap: onSelect(null)` | Tap empty canvas to deselect | Background deselect; the layers need their own labels (each layer's selection route should be checked) | `// a11y-label-ok` plus labelled layers |
| 13 | `lib/widgets/che_native_scene_world.dart:1011` | GestureDetector `onTapUp` + scale | 3D scene picking | A 3D scene cannot be labelled per hit; needs a voice/typed route to each object | Confirm a voice command reaches each pickable object; then `a11y-label-ok` |
| 14 | `lib/world/che_plan_room.dart:493` | GestureDetector `onTapUp` hit-testing a CustomPaint | Plan map items | **CustomPaint items are invisible to VoiceOver** | Add a list of the plan items (or `CustomPainter.semanticsBuilder`) with one action per item |
| 15 | `lib/home/che_home_chat.dart:49` | GestureDetector `onTap: onOrbTap` | Home orb | **False positive**: `Semantics(button: true, label: …)` wraps it at line 41, eight lines above the scanner's window | `// a11y-label-ok: Semantics at line 41` |

**Real unlabeled buttons: 1, 2 (and 3 when used). Missing button role: 4, 5, 6. No VoiceOver route for an action: 8, 9, 14 (and 13 to confirm). Acceptable or false positive: 10, 11, 12, 15. Latent: 3, 7.**

## Not covered here
- Whether each screen has a **voice route** to every action (AGENTS.md). That needs the command catalog (`server/cloudflare/command_catalog.js`) mapped against each screen's controls.
- Labels on `ElevatedButton`/`TextButton`/`ListTile` (labelled by their Text children) and on custom `Semantics` strings (whether the wording says what happens).
- Real VoiceOver behavior, which only the device shows.
