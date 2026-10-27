Write `lru.mjs`, an ES module with a named export class `LruCache`.

- `constructor(capacity)`: `capacity` must be a positive integer, otherwise throw `RangeError`.
- `get(key)`: return the value, or `undefined` on a miss. A hit makes the key the most recently used.
- `has(key)`: return a boolean. It does not change recency.
- `set(key, value)`: insert or update. Updating an existing key evicts nothing and makes it the most recently used. Inserting past capacity evicts the least recently used key.
- `delete(key)`: return `true` if the key was present, otherwise `false`.
- `size`: a getter for the number of entries.
- Any value can be a key, including `0`, `''` and `null`.
