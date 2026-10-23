// Library entries contributed as code (docs/CHE_STRATEGY_LIBRARY.md). Each lane owns one file and adds one
// import line here; entries are checked by strategy_library.entryProblems in strategy_library.test.mjs.
// An id must be unique across files; the first file listed wins on a clash (the test fails on one).
import { ENTRIES as CORE } from './core.js';
import { ENTRIES as MARKET_CONTEXT } from './market_context.js';

export const LIBRARY_SEEDS = Object.freeze([
  ...CORE,
  ...MARKET_CONTEXT,
]);
