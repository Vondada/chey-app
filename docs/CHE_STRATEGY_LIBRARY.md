# CHE Strategy Library

The owner wants to see every strategy CHE knows, every one she can execute, and every one she is testing, and to add more without an app update.

## Pieces

| File | Role |
|---|---|
| `server/cloudflare/strategy_library.js` | The registry: built-ins from the code, seeds, and the owner's entries. It holds the evidence lifecycle, approval, versions, an append-only audit, the budget and the chat intent |
| `server/cloudflare/library_seeds/*.js` | Entries contributed as code, one file per lane. Each file is listed in `library_seeds/index.js` |
| `lib/trading/che_strategy_dsl.dart` | The `che.strategy/1` validator and evaluator. It is a `CheSetupStrategy` for the phone's setup engine, and the only evaluator |
| `lib/trading/che_strategy_runner.dart` | Chooses which strategies the engine follows within the budget, and admits paper orders |
| `lib/trading/che_strategy_library.dart` | Typed entries and the API client |
| `lib/rooms/che_strategy_library_page.dart` | The Strategy Library page: search, filters, stages, detail, approve, compare, add |
| `docs/CHE_STRATEGY_AUDIT.md` | The audit counts and the 86/AMD investigation |

## API (owner device only)

- `GET /api/trading/library?q=&category=&kind=&lifecycle=` returns entries, counts and the budget.
- `GET /api/trading/library/active` returns the approved, enabled `che.strategy/1` documents, capped at `max_active`. The rest come back as `paused_budget`.
- `GET /api/trading/library/audit` returns the append-only audit, newest first.
- `POST /api/trading/library/{action}` performs one change:

  | Action | Body | Effect |
  |---|---|---|
  | `register` | `{entry}` | A new version; any definition waits for approval |
  | `approve` | `{id, confirm: true}` | Approves the current version |
  | `enable`, `disable` | `{id}` | Built-in research strategies go through the Strategy Control Center |
  | `favorite`, `unfavorite` | `{id}` | Marks or unmarks a favorite |
  | `duplicate` | `{id, new_id}` | Copies an entry under a new id |
  | `results` | `{id, kind: backtest\|forward, summary, source}` | The harness hook |
  | `draft` | `{text}` | Plain language → `che.strategy/1`, at most 10 a day |

- Chat:
  - "Show the strategy library", "how many strategies can you execute"
  - "Compare EMA pullback and VWAP reversion"
  - "Favorite Silver Bullet"
  - "Approve MACD signal cross", then "yes, approve MACD signal-line cross"
  - "Add a strategy that …"
  - `/trade-library`
- Strategy descriptions that contain "buy" or "sell" can trip the owner's money hold first. "Goes long" or "goes short" avoids it. The hold is not changed.

## Entry (`che.library_entry/1`)

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits, dashes and colons, 2–80 characters |
| `kind` | `strategy` or `market_context` |
| `name`, `category` | `category` is one of: trend, momentum, breakout, reversal, scalping, price_action, ict_smc, volatility, volume, other |
| `sources[]` | `{type, title, url?, license?}`. `type` is one of: name, description, tradingview, authorized_script, research_paper, news, economic_calendar, market_event, repo_code, owner, book, website. Script code is never stored; an `authorized_script` names its license |
| `rules[]`, `assumptions[]` | Plain sentences |
| `timeframes` | Bar sizes the entry applies to |
| `data_requirements[]`, `event_dependencies[]`, `limitations[]` | Plain sentences |
| `definition` | Optional `che.strategy/1` document, for executable strategies |
| `lifecycle_requested` | Optional. It can lower the computed stage, never raise it |

## `che.strategy/1`

The language is closed: no code, no network, no look-ahead. An unknown construct is refused by name.

- **Top level:**
  - `schema`, `id`, `name`, `category`, `timeframes` (minutes), `params` (numbers)
  - `series` (named indicators)
  - `long` / `short`
  - `risk {min_points, max_points, max_trades_per_day}`, `or_minutes`, `expiry_bars`
- **A side:**
  - `conditions[{id, label, group, required, when}]`
  - `stop` (required), `target` (`{"r": 2}` or an operand)
  - `entry` (defaults to the close; the fill is at the next bar open), `near`, `invalidation[{label, when}]`
- **Indicators:**
  - `{"fn": "ema|sma|rsi|atr|vol_sma|highest|lowest", "period": n, "of": "close"}`
  - `{"fn": "macd", "fast", "slow", "signal", "part": "line|signal|hist"}`
  - `{"fn": "bb", "period", "k", "part": "upper|mid|lower"}`
  - `{"fn": "vwap_band", "k": ±2}`
- **Operands:**
  - A number, or a bar field: `open high low close volume price`
  - A declared series name, `{"series": x, "ago": n}`, `{"bar": f, "ago": n}`, `{"param": p}`
  - `{"level": prior_day_high|prior_day_low|prior_rth_high|prior_rth_low|overnight_high|overnight_low|day_high|day_low|rth_high|rth_low|or_high|or_low|swing_high|swing_low|vwap}`
  - `{"window_high|window_low": window, "day": 0|-1}`
  - `{"add|sub|mul|div": [a, b]}`, `{"max|min": [...]}`, `{"abs": a}`
- **Conditions:**
  - Comparisons and crosses: `{"gt|lt|gte|lte|cross_above|cross_below": [a, b]}`
  - Logic: `{"all|any": [...]}`, `{"not": c}`
  - Time: `{"in_window": name | {"start": "HH:MM", "end": "HH:MM"}}`, in New York time
  - Direction: `{"rising|falling": x, "bars": n}`
  - Price action:
    - `{"sweep": "low|high", "of": level, "within": n}`
    - `{"fvg": "bull|bear", "within": n, "retest": true}`
    - `{"order_block": "bull|bear", "within": n, "displacement_atr": 1.5}`
    - `{"structure_break": "bull|bear"}`
    - `{"bar": "bull|bear"}`
  - Always met: `{"true": true}`
- **Windows** (New York time, with US daylight-saving rules):

  | Window | Hours |
  |---|---|
  | `overnight` | 18:00–09:30 |
  | `asia` | 20:00–00:00 |
  | `london`, `london_killzone` | 02:00–05:00 |
  | `ny_am_killzone` | 07:00–10:00 |
  | `ny_open` | 09:30–10:00 |
  | `rth` | 09:30–16:00 |
  | `london_silver_bullet` | 03:00–04:00 |
  | `silver_bullet_am` | 10:00–11:00 |
  | `silver_bullet_pm` | 14:00–15:00 |
  | `ny_lunch` | 12:00–13:30 |
  | `ny_pm` | 13:30–16:00 |

- **No look-ahead:** every value at bar i uses bars 0..i only.
  - Swings are confirmed three bars later.
  - The opening range and window extremes count only bars already closed.
  - Tests prove that a bar's result is the same with or without the bars after it.

## Budget

| Limit | Value |
|---|---|
| Active strategies | 60, the rest wait as "paused: budget" |
| Evaluation time per candle | 250 ms |
| Model calls per candle | 0 |
| Plain-language drafts | 10 a day |
| Paper trades per strategy per day | 5 |
| Paper trades per day, all strategies | 60 |
| Open CHE paper positions per symbol | 1 |
| Library entries | 2,000 |

Indicators are computed once per candle and shared by every strategy. Measured on CI-class hardware: 300 strategies over a fixture day averaged well under the 250 ms budget (`test/che_strategy_dsl_test.dart`).

## Adding entries from a lane

Add `server/cloudflare/library_seeds/<lane>.js` exporting `ENTRIES`, plus one import line in `library_seeds/index.js`. `strategy_library.test.mjs` checks every seed with `entryProblems`. If a seed carries a definition, run `node tool/dump_strategy_seeds.mjs` so the Dart validator test covers it.
