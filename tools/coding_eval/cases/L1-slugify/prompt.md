Write `slugify.mjs`, an ES module with a named export `slugify(text)`.

- Lowercase the text. Remove accents first (NFD, then drop combining marks), so `Café Crème` becomes `cafe-creme`.
- Keep `a-z` and `0-9`. Any run of other characters becomes one `-`.
- No leading or trailing `-`.
- `slugify('!!!')` and `slugify('')` return `''`.
- A non-string argument throws `TypeError`.

Examples: `Hello World` -> `hello-world`; `  a -- b__c!! ` -> `a-b-c`; `CHE 2 v10` -> `che-2-v10`.
