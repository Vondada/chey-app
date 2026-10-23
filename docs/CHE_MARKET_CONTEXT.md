# CHE market context (owner, 2026-10-23)

Scheduled and unscheduled events that may move NQ/MNQ. CHE treats each one as a possible catalyst, never as a
predictor. Code: `server/cloudflare/market_context.js` (Worker), `lib/trading/che_market_context.dart` (app),
`server/cloudflare/library_seeds/market_context.js` (strategy-library entries). Live trading stays disabled; nothing here
places an order, calls a model or runs on a schedule.

## Rules the code enforces

- **Two times per event.** `event_time` is when it happened. `first_available` is when the information first became
  public. It is never earlier than `event_time`. For a post seen through a news or wire report, `reported_at` and
  `report_url` are kept too, and `first_available` is the later of the post and report times unless the post itself is cited.
- **Cited or refused.** Every event has an https source (or a repo rule reference). An unscheduled item dated in the
  future of its ingestion is refused.
- **Append-only.** Re-ingesting an event never rewrites it. A correction is a new record with `supersedes`, and the old
  record stays stored.
- **No look-ahead.** A study's base price is the close of the last bar that had *ended* by `first_available`, and its
  pre-event features use only earlier bars. A test changes every bar after the release and checks that the base and
  features stay the same.
- **Association, not causation.** Every study says so, and same-day news is not separated out. Below 10 measured events
  a study reports "Insufficient sample" and no statistics.
- **Costs.** The economic check compares the average absolute move with one round trip under CHE's NORMAL cost profile
  (NQ: 0.95 points = $19). It is labelled an upper bound, because capturing it needs the direction in advance.

## Where events come from

| Kind | Source | How CHE reads it | Status |
|---|---|---|---|
| Quarterly NQ/MNQ expiration (third Friday, 9:30 a.m. ET) | CME contract specs | published rule | rule-derived |
| Monthly NDX options expiration (third Friday; prior business day on a holiday) | CME rulebook (2012 chapter found; confirm current) | published rule, **date only** | rule-derived |
| Nasdaq-100 quarterly rebalance / December reconstitution (after the close, third Friday) | Nasdaq NDX methodology | published rule | rule-derived; exceptions (Dec 2024) are not known to the rule |
| CME holidays and early halts | `trading_research.js cmeCalendar` | CHE's own rules | rule-derived; confirm yearly |
| FOMC decisions (2:00 p.m. ET) and press conferences (2:30 p.m. ET) | federalreserve.gov FOMC calendars | HTML parser; fails loudly on a redesign | fetched on request |
| CPI, PPI, Employment Situation, GDP | bls.gov release calendar (iCalendar) | RFC 5545 parser | fetched on request |
| Fed cycle (hiking / cutting / holding) | FRED DFEDTARU CSV | CSV parser | fetched on request |
| PCE (BEA), weekly claims (DOL), earnings | none ingested | owner adds an iCalendar source or cited events | not automatic |
| Political posts, geopolitical developments | owner-cited link, or a news or wire report quoting the original with its timestamp | owner entry | never automatic |

Truth Social has no free official API and the X API is paid. So CHE does not collect posts automatically, does not
scrape against either site's terms, and spends nothing.

Fetching happens only when the owner asks ("refresh the market calendar", or the Refresh button). There are at most 6
fetches per refresh and at most one per source per 6 hours. Every attempt is logged with its outcome, and a failed fetch
is reported as failed, never as "no events".

## Event study

`eventStudy({ events, bars, tf, market, kind })` runs on CHE's verified dataset bars (`trading_research.loadDataset`,
provider shown).

- **Intraday:** returns at +5 min, +30 min, +2 h and to the 16:00 ET close, from the price known at `first_available`.
- **Daily:** the event's trading day and the next day, against the prior settled close.
- **Baseline:** the same measurement at the same New York clock time (intraday), or on every trading day (daily),
  excluding days with an event of the kind or any high-impact scheduled event.
- **Tests:** Welch's t-test on absolute moves against the baseline, and a one-sample t-test on the signed move.
- **Persistence:** persistent, reversed or faded (whether the later move keeps at least half the early move).

When a study has a sufficient sample, the result is recorded to the strategy library as that context model's backtest
evidence. Otherwise the model stays at IMPLEMENTED, with the reason.

## Regimes (for breaking results down)

`dayRegimes(dailyBars, { events, fedSeries })` gives each day's regime as known **before the session**:

- volatility: 20-day realized volatility against its trailing year, low / normal / high
- liquidity: prior-day volume against its trailing year
- event day: only events known in advance
- Fed cycle

`sessionOf(time)` uses the shared CHE session table. A test checks that a day's own bar never sets its regime.

## API (owner only)

- `GET /api/trading/context`: counts by kind and stage, models, sources, fetch log, upcoming events.
- `GET /api/trading/context/events?from&to&kind`
- `GET /api/trading/context/annotations?market&from&to`: chart markers, each with source, verification and observed reaction.
- `GET /api/trading/context/upcoming?minutes`: plus a spoken line.
- `GET /api/trading/context/regimes?market&days`
- `GET /api/trading/context/study?kind&market`
- `POST /api/trading/context/event`: owner-cited event (validated).
- `POST /api/trading/context/source`: an iCalendar, calendar, news or other source.
- `POST /api/trading/context/refresh`
- `POST /api/trading/context/study`: `{ kind, timeframe, market }`. Refused with 409 when no verified dataset is stored.

Voice: "what market events are coming up", "is there a CPI today", "refresh the market calendar". These answer with no
model call.

## In the app

- **Trading Room → CHART → MARKET EVENTS:** upcoming-event warnings ("HIGH IMPACT · CPI in 25 min"), a line saying they
  apply to every intraday strategy, Read aloud on request, and the Market context page.
- **The futures chart:** an amber dotted line with a text tag (CPI, FED, EXP …) at each event. Tapping a tag opens its
  receipt (source, verification, observed reaction). The chart summary names the events.
- **Market context page:**
  - each context model with its stage as text and an icon, the reason it is not running, its rules, sources and limits
  - regime tags
  - events stored per kind with their sources
  - studies
  - Refresh, Add event and Add source

## What is not verified

- The live official pages were not reachable from the development sandbox. The FOMC HTML parser is written against the
  known page layout and tested on a fixture, and the BLS parser on RFC 5545 fixtures. They are verified only when the
  first production refresh reports its counts.
- No event study has been run on real bars yet, so no reaction is claimed.
