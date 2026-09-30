# CHE ML studio — supervised & unsupervised learning

Not chat memorization. CHE runs **classification** and **clustering** on the Worker with **real metrics**, shown on the phone Projects board.

## Capabilities

| Mode | Algorithm (on-Worker) | Metrics |
|------|------------------------|---------|
| Supervised classification | Nearest-centroid on embeddings (Workers AI) or hashed bag-of-words | Accuracy, macro precision / recall / F1, per-label |
| Unsupervised clustering | k-means | Silhouette, inertia, cluster sizes |
| Hosted fine-tune (optional) | LoRA via VMware / Hugging Face endpoints | Requires owner `approved: true` (`fine_tuning.js`) |

## APIs (paired)

- `POST /api/ml/run` `{ "kind": "classification"|"clustering", "examples": [{ "text", "label"? }], "k"?: 3, "holdout"?: 0.25 }`
- `GET /api/ml/readiness`
- Results create a **project** (`ml_classification` / `ml_clustering`) with `metrics` + an **office_goal** (`kind: ml_studio`).

## Voice phrases

- `Run classification on my labels`
- `Start clustering` / `Run unsupervised clustering`
- `Evaluate classification` / `ML classify…`

Demo seed examples are used when the spoken command has no uploaded dataset yet.

## Phone

- **Office → Projects → filter ML** — live metrics on cards / detail sheet  
- **More → ML studio** — kicks a classification demo via chat phrase  
- Poll: existing `/api/state` (~15s)

## Owner confirm

- Local Worker ML eval: no spend gate.  
- External fine-tune / paid APIs: owner `approved: true` still required.
