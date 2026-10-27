Write `duration.mjs`, an ES module with a named export `parseDuration(text)`.

- Accept parts with the units `d` (days), `h`, `m` (minutes) and `s`, such as `1h 30m 5s`, `2d`, `90s` or `1.5h`. Each part may be fractional.
- Units are case-insensitive. Spaces between parts are optional (`1h30m` is valid).
- Return the total number of seconds as a number.
- Empty text, text with no unit (`10`), or unknown text (`abc`, `-5s`) throws `Error`.

Examples: `1h 30m 5s` -> `5405`; `1.5h` -> `5400`; `1H 2M` -> `3720`.
