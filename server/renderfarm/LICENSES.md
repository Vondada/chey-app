# Film Studio models and their licenses

Recorded 2026-10-22 from each project's model card or repository. Check the card again before commercial use at scale;
licenses change. CHE uses only free, open-weight models or the free Workers AI allowance.

| Used for | Model | Where it runs | License (as recorded) | In this release |
|---|---|---|---|---|
| Stills (FAST) | FLUX.1 [schnell] | Workers AI | Apache-2.0; Workers AI terms | yes |
| Stills with a character reference | FLUX.2 [klein] 4B | Workers AI | Apache-2.0; Workers AI terms | yes (off by default; about twice the neurons) |
| Dialogue (FAST) | MeloTTS | Workers AI | MIT; Workers AI terms | yes (one voice for every character) |
| Moving clips | LTX-Video (Lightricks) | Kaggle T4 / HF ZeroGPU | LTXV Open Weights license (commercial use has conditions) | yes (farm workers) |
| Moving clips, fallback | Wan 2.2 + lightx2v LoRA | farm GPU | Apache-2.0 | not yet |
| Per-character voices | Kokoro-82M | farm GPU or runner CPU | Apache-2.0 | not yet |
| Expressive voices | Chatterbox (Resemble AI) | farm GPU | MIT | not yet |
| Lip sync | MuseTalk / LatentSync | farm GPU | MIT / Apache-2.0 | not yet |
| Upscale | Real-ESRGAN | farm GPU | BSD-3-Clause | not yet |
| Frame smoothing | RIFE (Practical-RIFE) | farm GPU | MIT | not yet |
| Sound effects and music | Stable Audio Open 1.0 | farm GPU | Stability AI Community License (free under a revenue limit) | not yet |
| Assembly | ffmpeg | GitHub Actions runner | LGPL/GPL (static build from BtbN or Ubuntu's apt package) | yes |

"Not yet" means the model is planned for the farm workers and is not in this release: CHE never says a film has
lip-sync, per-character voices, upscaling or generated sound effects until a worker that makes them ships.
