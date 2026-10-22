# CHE Invention Studio (concept to breakdown)

Owner request, 2026-10-22. Engineered designs (a powered suit, an exoskeleton, a robot, a device) are planned as
projects, not just pictures.

## What it does now
- **Chat** (`server/cloudflare/invention_studio.js`, routed in `worker.js` before `project_plan.js`):
  "Design me an Iron Man-style suit" creates a project; "Show me how it assembles", "Tell me piece by piece what it costs",
  "Where can I get the parts", "What parts are real versus conceptual" reopen the latest project. Follow-ups without a
  project fall through to the ordinary routes. A weapon or safety-bypass request is refused and creates nothing.
- **Concept picture**: the existing media engine (`media.js generateImage`). When no engine answers, the project says so.
- **Project store**: `invention_projects` (newest 20) and `invention_last` in Durable Object storage. Owner-only endpoints:
  `GET /api/inventions` (list) and `GET /api/inventions/:id` (one project).
- **Creation Room**: an "Invention Studio" row opens `CheInventionStudioPage` (`lib/rooms/che_invention_studio.dart`):
  saved projects, then the concept, cost tiers, subsystem costs, every part with its sourcing label, feasibility notes,
  stages and the testing checklist.

## Truth rules (enforced in code and tests)
- Every part has one label: `verified source`, `estimated source`, `conceptual`, `custom fabrication required`, or
  `unavailable / unknown`.
- No vendor, link, lead time or exact price is written. `sourcing.verified_sources` is 0 and `live_lookup` is
  `not connected`. Costs are planning bands in USD per tier, never quotes.
- Conceptual items are listed and never costed.

## Not built yet
- A rotatable 3D preview and a drawn exploded view (the breakdown is text layers and subsystem cards).
- Live supplier lookup (no source is verified).
- Per-subsystem staged build cards in the UI beyond the list in the page.
- The Invention Studio is not yet linked to Office agents or the coding crew.
