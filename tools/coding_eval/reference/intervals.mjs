export function mergeIntervals(intervals) {
  const pairs = intervals.map((item) => {
    if (!Array.isArray(item) || item.length !== 2 || !item.every(Number.isFinite)) throw new TypeError('interval must be [start, end] numbers');
    const [start, end] = item;
    if (start > end) throw new RangeError('start is after end');
    return [start, end];
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of pairs) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
