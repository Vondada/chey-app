# CHE Coding Library

The Coding Library is the coding shelf of CHE's existing library (`server/cloudflare/library.js`, SQLite FTS5 in her Durable Object). It holds three kinds of entries:

- **Official documentation.** CHE reads it from the public repository that publishes it, at one exact commit.
- **CHE's own coding outcomes.** Each finished coding job leaves one.
- **REA investigations.** These are saved on request.

Coding jobs get the matching passages automatically. It adds no second memory, index, planner or coding engine. Code: `server/cloudflare/coding_library.js`.

## What an entry records

| Field | Meaning |
|---|---|
| `repo`, `path`, `url` | The source repository and file, and a GitHub link pinned to the commit that was read |
| `docs_url` | The published page (for example https://docs.flutter.dev/cookbook/navigation/named-routes) |
| `version`, `blob_sha` | The repository commit, and the file's git hash at that commit |
| `license` | What GitHub reports for the repository (`NOASSERTION` is kept as is), plus a link to the licence file at that commit. Licences are never written by hand. |
| `framework`, `language`, `topic` | What the page is about |
| `trust` | `official-docs`, `che-run` (CHE's own job outcome) or `rea-evidence` |
| `retrieved_at`, `verified_at`, `status` | When it was read and last confirmed unchanged; `current`, `superseded` or `removed_upstream` |

An entry not confirmed for 30 days is reported as possibly out of date. Superseded versions are kept but never cited.

## Sources (wave 1)

| Source | Repository | Folder |
|---|---|---|
| Flutter | flutter/website | `sites/docs/src/content` |
| Dart | dart-lang/site-www | `src/content` |
| TypeScript | microsoft/TypeScript-Website | `packages/documentation/copy/en` |
| React | reactjs/react.dev | `src/content` |
| Python | python/cpython | `Doc` |
| Cloudflare | cloudflare/cloudflare-docs | `src/content/docs` |
| GitHub | github/docs | `content` |

The folders were checked against each repository's tree on 2026-10-17.

## How it works

- **Learn.** "Learn the Flutter docs about navigation" works like this:
  - One head read and one tree listing of the docs folder, at that commit.
  - The pages whose paths name the topic are chosen (3 by default, at most 6).
  - Only those are downloaded from `raw.githubusercontent.com`.
  - A page whose file hash is unchanged is confirmed from the tree and not downloaded again.
- **Search.** "Search your coding library for go_router deep links" runs a keyword search over the shelf. A framework name ranks results; it does not match every page. Each passage cites its page, commit, licence and confirmation date.
- **Coding jobs.** `prepareSelfUpdate` gives the planners and engineers the best passages for the request. These are bounded to 1,800 characters, labelled as data rather than instructions, and never override the owner's request or the repository source. The job's result lists the passage titles the team used. An empty shelf leaves the job exactly as before.
- **Outcomes.** Every finished coding job records its state, pull request link, changed files and the passages it used, so the next similar request finds what worked and what failed.
- **REA.** "Save that investigation to your coding library" stores a finished investigation with its observed, inferred and unknown labels.
- **Refresh.** "Refresh your coding library" re-checks pages not confirmed for 30 days against their source:
  - unchanged pages are re-confirmed without downloading;
  - changed pages are read again, and the old version is marked superseded;
  - deleted pages are marked removed upstream.

## Commands

| Command | Mode | What it does |
|---|---|---|
| `/library-search` (`/library`) | Read-only | Cited search |
| `/library-learn` | Saves reference text | Reads official pages on a topic |
| `/library-status` | Read-only | Counts, and what is out of date |
| `/library-refresh` | Saves reference text | Re-checks pages against their sources |
| `/library-save` | Saves reference text | Saves a REA investigation |

Routes: `GET /api/coding-library` (status), `GET /api/coding-library?q=` (search), `POST /api/coding-library/learn`, `/refresh` and `/save-rea`. Chat turns are owner-device only and answer with no model call (`done.source = che_coding_library`).

## Limits, said plainly

- Saving a page stores reference text. It does not change CHE's code, does not authorize a change, deploy or spending, and is not new training.
- Search is keyword search (FTS5). No vector index is used; one would be added only if measured recall needed it.
- The iPhone Coding Library page is a separate Flutter change. Until it ships, the library is used by voice and typing in chat and through the Command Center catalog.
