# Verified market feeds

The existing market-data adapter, trading engine and owner-only Worker dispatcher now support outgoing Tradovate CME and Alpaca stock/PAPER order streams. No order automation is enabled by these changes.

Tradovate requires the existing OAuth client configuration, owner sign-in and existing CME/API permissions. The adapter checks the exact front-month contract, authentication, quote acknowledgement, chart IDs, closed five-minute bars, quote timestamps and socket liveness. New forward-paper entries require LIVE authenticated subscriptions, quote latency at most 15 seconds and a recently closed bar. Delayed Yahoo history remains research-only; existing positions retain their source evidence. Missing setup never purchases access or claims a live connection.

Alpaca uses existing PAPER credentials. IEX, SIP and delayed SIP retain distinct coverage labels; permission denial never upgrades or substitutes a feed. The stock terminal endpoint reads official five-minute history, current positions, account equity and broker order receipts. Unattributed/manual orders are never assigned a strategy. PAPER trade_updates require authenticated subscriptions and consistent quantities; stale events cannot regress an observed order. UI clients must reconcile against the REST receipts after reconnection.

Owner-only endpoints:

- GET /api/trading/alpaca/terminal?symbol=AAPL&feed=iex
- GET /api/trading/market/stream?asset=stocks&symbol=AAPL&feed=iex
- GET /api/trading/market/stream?symbol=MNQ

The NDJSON stream expires after 55 seconds; clients reconnect, show source timestamps and never infer continued freshness from an open HTTP connection. At most eight views connect per owner runtime. Stock sockets expire without an active view. Credentials remain private to adapters, absent from snapshots and events.

Validation uses controlled provider sockets and actual engine boundaries, not claimed production account access. Before release: exact-head full CI, independent review, production health and probes. Account entitlements and physical iPhone behavior require separate evidence.
