# CHE render farm workers

Code CHE runs on free GPU sessions for Film Studio (server/cloudflare/film_farm.js embeds these files byte for byte;
`film_studio.test.mjs` fails if they drift).

- `kaggle_worker.py`: pushed as a private Kaggle kernel (T4, internet on) with a film-scoped farm token. It asks CHE
  for one moving clip at a time, makes it with LTX-Video from the shot's picture, uploads it, and exits before the
  session limit. Kaggle stops the session at `sessionTimeoutSeconds`, which CHE sets below the free weekly quota.
- `hf_space/`: a private Gradio Space with ZeroGPU CHE creates in the owner's Hugging Face account. Each call spends
  the account's free daily ZeroGPU minutes.

Google Colab is not here: it has no official way to start a notebook without a person opening it, so CHE does not
use it. The owner's own computer is never part of the farm.

The owner sets nothing up beyond pasting tokens in Keys: Kaggle as `username:token`, Hugging Face with write access.
