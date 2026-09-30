# CHE ML learning + multilingual + Brain map

Agents **learn and retrieve** (metrics + memory_notes), not only memorize chat text. Secrets stay on the Worker — never in Flutter.

## Supervised / unsupervised (Worker)

| Mode | Algorithm | Metrics |
|------|-----------|---------|
| Classification (`ml_eval`) | Nearest-centroid on Workers AI embeddings or hashed bag-of-words | Accuracy, precision, recall, F1, **confusion matrix summary** |
| Clustering (`ml_eval`) | k-means | Silhouette, inertia, cluster sizes |

- Module: `server/cloudflare/ml_studio.js`
- APIs: `POST /api/ml/run`, `GET /api/ml/readiness`
- Voice: `Run classification…`, `Start clustering`, `ML eval…`
- Results → project (`ml_classification` / `ml_clustering`) + office goal `kind: ml_eval` + **memory_notes** (Brain nodes)

## Translation / multilingual

- Module: `server/cloudflare/translate.js`
- APIs: `POST /api/translate`, `GET /api/languages`
- Voice: `Translate to Spanish: …`, `Set my language to fr`
- Optional `reference: …` → Token F1 quality metrics on Projects board
- Locale-tagged memory notes (`kind: translate`, `locale`) for Brain retrieval
- Chat system addon uses `reply_language` from DO / request body

## Brain room — unlimited neural dots

- `memory_notes` are **not artificially capped** for Brain (soft DO safety only)
- `GET /api/state` includes `memory_notes` + **`brain_graph`** `{ nodes, links, counts }`
- `GET /api/brain/graph` — same graph
- Clustering jobs emit per-cluster notes with shared `cluster_id` → related links
- Phone: **Memory** tab (`CheMemoryBrainRoom`) + Insights **Map** — dots + related lines
- Links = Worker `brain_graph.links` + same `cluster_id` + token overlap

## How the owner kicks a job and sees metrics

1. Pair the phone (prod pair code).
2. Say to CHE: **“Run classification”** or **“Start clustering”** (or `POST /api/ml/run` with examples).
3. Open **Office → Projects → ML** — accuracy / F1 / silhouette on the card.
4. Open **Memory / Insights Map** — new neural dots; cluster mates are linked.
5. Translate: **“Translate to Spanish: good morning”** — reply + optional Projects metrics if you add `reference: …`.

## Related docs

- `docs/ml-studio/PLAYBOOK.md` (short studio card)
- `docs/translate/README.md`
