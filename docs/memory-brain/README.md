# Memory Brain room

Phone UI room matching mockup **01** (neural constellation, dark teal).

## Behavior

- Every learned thought is a **glowing teal dot** — saved memories, Worker `memory_notes`, personality traits, knowledge lines.
- **No Flutter capacity limit** on dots (shows everything the Worker returns).
- Related memories draw thin edges when they share tokens.
- Tap a dot → detail sheet + voice actions (Read / Related / Close).
- Pinch-zoom / pan via `InteractiveViewer`; cheap `CustomPaint` (no WebView/3D).

## Entry points

- **More → Memory Brain**
- **World hub → Memory** tab (constellation replaces the old list)

## Worker feed

`/api/state` → `memories`, `memory_notes`, `learned_personality`, `learned_knowledge`.  
`listMemoryNotes` returns the full note list (optional `limit` only when callers ask). Durable Object soft safety cap remains for storage, not UI display.
