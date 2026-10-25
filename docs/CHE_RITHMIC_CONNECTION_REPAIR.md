# Rithmic connection repair, 2026-10-25

The owner's device showed a refused login (`13, permission denied`), followed by discovery handshake/reset failures on both Wi-Fi and cellular. These are different stages; neither establishes an incorrect password.

## Confirmed code defects

- Automatic discovery always used `rituz00100.rithmic.com`, the developer **Rithmic Test** endpoint. Ordinary accounts now discover through `rprotocol.rithmic.com`; explicitly choosing `Rithmic Test` uses UAT. Manual gateway overrides remain available.
- `_WebSocketChannel` sent and parsed raw protobuf. R | Protocol carries a four-byte big-endian payload length **inside** each binary WebSocket message. A real local WebSocket reproduction sent heartbeat `98b64b12` before the fix, rather than `0000000498b64b12`. The corrected transport adds/removes the envelope and rejects mismatched lengths. Protobuf encoders and fake channels continue to handle payloads only.
- An Advanced system override was applied **after** discovery had selected another system's gateway. The chosen system now participates in discovery and is checked against the server's system list before any login.
- Connect and Diagnose now clear prior displayed errors/diagnoses, so an earlier refusal is not presented beside a newer connection failure as if both describe one attempt.

## Protocol evidence

The original licensed vendor kit is not in this checkout. Public reference implementations were inspected, rather than claimed to be vendor documentation:

- `rundef/async_rithmic` at `a985931ed1fb608d416ddf23ad92d789102bef47`, `async_rithmic/plants/base.py`, `_convert_request_to_bytes` / `_convert_bytes_to_response`: four-byte length and payload. Its connection documentation explicitly labels `rituz00100` a test-only example.
  - https://github.com/rundef/async_rithmic/blob/a985931ed1fb608d416ddf23ad92d789102bef47/async_rithmic/plants/base.py
  - https://async-rithmic.readthedocs.io/en/latest/connection.html
- `hugodemenez/deltalytix` at `9be0f4f080cd0d67550c0d850f0733354c86bede`, `lib/rithmic-protocol/systems.ts`: production Core Chicago `rprotocol.rithmic.com`, separate UAT `rituz00100`.
  - https://github.com/hugodemenez/deltalytix/blob/9be0f4f080cd0d67550c0d850f0733354c86bede/lib/rithmic-protocol/systems.ts
- `parbhatc/Rithmic` at `bc5d2774b7d1db4be40fa3c499ba15a60f34495d`, `src/rithmicClient.js` and `src/listSystems.js`: independently corroborate the envelope and production discovery host.

TLS certificate and hostname validation remain enabled. No alternate application identity is substituted, no account permission is bypassed, and credentials stay in the existing on-device vault.

## Verification and limits

Regression coverage includes a real local WebSocket exchange (outgoing **and incoming** envelope), malformed lengths, production versus explicit UAT selection, chosen-system gateway lookup, and refusal of an unlisted system before login. Existing screen/auth fakes implement the extended finder contract.

A credential-free local reproduction was run before and after the transport fix. Full Flutter analysis/tests run in GitHub CI; local Flutter tooling was unavailable for safe complete-suite verification. No claim of real Rithmic authorization or iPhone reconnection is made. Direct public-host checks from this sandbox failed DNS resolution, so the screenshot's TLS reset cannot be independently attributed to the remote server here. A remaining code-13 refusal must still be resolved against the firm's system/account and CHE's registered API identity.

Delivery is Dart-only through the existing Shorebird pipeline; a Worker deployment cannot deliver this client fix. Patch publication is not proof of installation.
