# Replay case format (`replay_chat.mjs`)

```json
{
  "about": "what this reproduces",
  "owner": true,
  "model": "one reply for every model call",
  "records": [{ "text": "My favorite food is pizza", "source": "owner_chat", "verification_status": "owner_attested" }],
  "history": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  "turns": [
    "a plain owner message",
    { "message": "…", "history": [/* replaces the running history for this turn only */],
      "body": { "screen_context": "…" },
      "expect": { "route": "che_memory_provenance", "model_calls": 0, "match": "regex", "not": "regex" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `model` | A string (every call), an array (one per call, the last one repeats), or `{ "rules": [{ "when": "regex on the last user message", "reply": "…" }], "default": "…" }`. |
| `owner` | `false` replays as an unpaired guest. |
| `records` | Memory records planted before the first turn. Use `source` and `verification_status` exactly as CHE stores them. |
| `history` | Earlier turns, for example copied from a screenshot. Turns without their own `history` append to it as the replay runs. |
| `expect.route` | `done.source`, `model` (the language model answered), or `none`. |

## Flags

| Flag | Effect |
|---|---|
| `--json` | Full rows as JSON. |
| `--network` | Allow real outbound requests. By default they are refused, and the refused hosts are listed. |
| `--verbose` | Show the Worker's own logs. |

Storage is in memory and starts empty on every run. Nothing touches the owner's CHE.
