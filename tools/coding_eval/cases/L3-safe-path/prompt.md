Write `safe_path.mjs`, an ES module with a named export `safeJoinPath(base, userPath)`. This is security code: a file-serving route passes untrusted input here.

- `base` is an absolute POSIX path string, for example `/srv/data`. A relative `base` throws `Error`.
- Return the normalized absolute path that `userPath` names inside `base`.
- Throw `Error` for anything that would leave `base`. That includes:
  - an absolute `userPath`,
  - `..` segments that climb above `base`, including `..` alone, and sibling-prefix tricks such as `../data-evil/x` when `base` is `/srv/data`,
  - backslashes used as separators,
  - percent-encoded dots or slashes (`%2e`, `%2f`, `%5c`, in any letter case),
  - NUL bytes.
- Throw `TypeError` when `base` or `userPath` is not a string.
- `a/../b` stays inside `base` and resolves to `base/b`. `''` and `.` return `base`.
- A trailing slash on `base` is allowed.
- Do not touch the file system.
