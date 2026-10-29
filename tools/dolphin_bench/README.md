# Dolphin bench: metrics and device record

Status: this is the metric definition and record format only. No harness code exists yet, and no device run has been
recorded. Every value in a record must come from a real run on a named device. Do not copy numbers from elsewhere.

Scope: the on-device offline model (see `docs/CHE_DOLPHIN_READINESS.md`). The model file, runtime and hash are not
approved yet, so a run cannot start until they are.

## Metrics

| Metric | What is measured | How | Unit |
|---|---|---|---|
| Speed: time to first token | Time from sending a prompt to the first generated token | Timestamp at send and at first streamed chunk, after the model is loaded | ms |
| Speed: tokens per second | Generated tokens divided by generation time | Count tokens from the runtime, not characters | tokens/s |
| Speed: load time | Time from load call to ready | Timestamp around `loadModel` | ms |
| Memory: peak resident memory | Highest app memory during one answer | Xcode Instruments (Allocations or Memory) on the same build, or the runtime's own counter if it has one | MB |
| Memory: model footprint | Memory after load, with no answer running | Same tool, after load settles | MB |
| Accuracy | Share of fixed test prompts answered correctly | A fixed prompt set with expected answers, scored by a stated rule; the set and the rule are saved with the run | % correct, with n |
| Battery | Battery percent used for a fixed workload | Start level, run N answers (stated count), end level, same screen brightness and Low Power Mode setting noted | % per run |
| Storage | Size of the model file on the phone | File size from the app's storage | bytes |

Accuracy and battery need a stated sample size. A result with a small n is reported as small, not as a rate.

## Procedure for one device run

1. Record: device model, iOS version, app build (commit SHA and IPA or build number), model filename, model SHA-256,
   runtime name and version, and whether Low Power Mode and Airplane Mode were on.
2. Put the phone in Airplane Mode for the offline runs. Note the time and the Wi-Fi and cellular state.
3. Load the model and record load time and footprint.
4. Run the fixed prompt set. Record time to first token, tokens per second and each answer's score.
5. Run the battery workload from the same start level, and record the end level.
6. Save the raw measurements (not only summaries) with the run.

## Record format

One JSON file per run, saved under the owner's chosen location, with these keys:

```json
{
  "run_id": "<unique id from the run, not made up>",
  "date": "<ISO date of the run>",
  "device": {"model": "", "ios": "", "build": "", "commit": ""},
  "model": {"filename": "", "sha256": "", "bytes": null, "runtime": "", "runtime_version": ""},
  "conditions": {"airplane_mode": null, "low_power_mode": null, "brightness": ""},
  "speed": {"load_ms": null, "first_token_ms": [], "tokens_per_s": []},
  "memory": {"footprint_mb": null, "peak_mb": null, "tool": ""},
  "accuracy": {"prompt_set": "", "n": null, "correct": null, "rule": ""},
  "battery": {"workload": "", "n_answers": null, "start_pct": null, "end_pct": null},
  "raw_files": []
}
```

Leave a field `null` when it was not measured. A null field means "not measured", not zero.

## Rules

- No number is entered without a run that produced it.
- A record that does not name its build, model file and hash is not valid.
- Results are for the device and build named in the record. They do not transfer to other phones.
- Do not upload model files or raw logs that contain private conversations.
