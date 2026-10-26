Write `chunk.mjs`, an ES module with a named export `chunk(list, size)`.

- Return an array of arrays. Each inner array holds at most `size` items, in the original order. The last one may be shorter.
- `chunk([], 3)` returns `[]`.
- Do not change the input array.
- `size` must be a positive integer, otherwise throw `RangeError` (this covers 0, -1, 1.5 and NaN).
- `list` must be an array, otherwise throw `TypeError`.

Example: `chunk([1,2,3,4,5], 2)` returns `[[1,2],[3,4],[5]]`.
