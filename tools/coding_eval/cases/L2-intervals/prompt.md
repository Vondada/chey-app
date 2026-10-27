Write `intervals.mjs`, an ES module with a named export `mergeIntervals(intervals)`.

- Each interval is a pair `[start, end]` of numbers.
- Return a new array of the merged intervals, sorted by start.
- Overlapping intervals merge, and touching intervals merge too: `[1,2]` and `[2,3]` become `[1,3]`. A contained interval is absorbed.
- Do not change the input array or its inner pairs.
- An empty input returns `[]`.
- An interval with `start > end` throws `RangeError`.
- An item that is not an array of two finite numbers throws `TypeError`.

Example: `[[1,3],[2,6],[8,10],[15,18]]` returns `[[1,6],[8,10],[15,18]]`.
