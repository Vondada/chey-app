# CHE Create Studio: requirements (owner, 2026-10-28)

Adds to the Universal Creation Engine (`docs/CHE_UNIVERSAL_CREATION_AUDIT.md`). Every template loads real, editable 3D
geometry and materials, never a static image. Built on the scene document (`server/cloudflare/scene_document.js`, M2a).

## 1. Start screen (Create Studio)

The owner picks one of seven starts:

1. Blank Canvas
2. Person / Character
3. Room / Building
4. Landscape / Environment
5. Object / Vehicle
6. Game World
7. Custom saved template

## 2. Three ways to control everything (same project, same state)

- **Voice:** the owner says what to create, sculpt, paint, move, resize or change. CHE uses the actual editing tools and
  shows the result. Voice and manual controls work on the same project at any time.
- **Touch:** pinch, rotate, zoom, drag, sculpt, paint and manipulate objects directly.
- **Apple Pencil (supported iPads only):** draw, sculpt and paint, with brush size, pressure and other supported Pencil
  features.

## 3. Professional tool palette

Brushes, spray paint, sculpting tools, sliders, colour controls, material editors, lighting controls, layers, undo/redo,
and precision controls (numbers typed, snapping, symmetry).

## 4. Adaptive interface

- **iPhone:** compact, full-screen editing with collapsible tool panels.
- **iPad:** expanded workspace, dockable tool panels, larger canvas, multitouch editing.

## 5. Saving and reuse

- Every edit is saved and stays editable.
- Templates are customizable, reusable, and use the same asset system as CHE's Office World (one asset system, one
  scene document).

## 6. Approachability

Usable by someone who has never used Blender. Powerful enough for advanced professional editing (advanced panel).

## 7. Testing bar

Build and test the actual editing functions. A mockup or a screen with controls is not a completed feature.

## 8. Milestone mapping

| Requirement | Milestone | Status |
|---|---|---|
| Editable scene, saved and versioned | M2a (scene document) | built, PR #731 |
| Save a character or object into a scene; read it back | M2b | next |
| Start screen with the seven templates, each loading real geometry | M2c (after M2b) | not started |
| Touch: pinch, rotate, zoom, drag an object | M3 | not started |
| Brushes: sculpt, spray and paint with size, strength and falloff | M4 | not started |
| Voice to editor operations (through the existing command path) | M5 | not started |
| Apple Pencil pressure and tilt on iPad | M6 (needs an iPad) | not started, blocked on device |
| Adaptive layout: iPhone compact, iPad dockable panels | M7 | not started |
| Layers, undo/redo, precision, lighting, material editor | M3 to M5 | not started |

## 9. Technical notes

- Apple Pencil pressure and tilt need the touch-force and stylus data from iOS. Flutter exposes it through pointer
  events; verify on a real iPad before claiming it.
- Template assets need a license check at source before they ship (see the character tools doc).

## 10. Blockers

- A real iPhone and iPad for every touch and Pencil test. Without them, nothing here is called complete.
