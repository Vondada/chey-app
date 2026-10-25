// The live chart card (owner, 2026-10-23: "The Home screen must default to the live chart"): a compact candle chart
// over the Rithmic feed on this phone, shared by Home and usable by the Trading Room.
//
// - Live by default, always: the source is never persisted. Only the timeframe is remembered.
// - The state says exactly what the data is (lib/trading/che_live_status.dart). Candles from a dropped session stay on
//   screen, dimmed and marked not current, while the feed reconnects.
// - Delayed data appears only after the owner taps "Show delayed data", is labelled DELAYED, and is never called live.
//   Nothing switches to it on its own.
// - Stable: the card has a fixed height, prices use fixed-width figures, and live ticks never reset zoom or pan.
// - Pinch to zoom, drag to pan, plus Zoom and timeframe buttons for VoiceOver and voice. Silent: it never speaks.
// - Read only: no orders.
// - Ticker switching on Home (owner, 2026-10-25): MNQ and NQ on the Rithmic feed (the contract Rithmic is subscribed to;
//   another contract says so instead of drawing the wrong one), BTC and ETH on the exchange's public trade stream
//   (che_crypto_stream.dart, no account). One status model for both (CheLiveStatus: LIVE, DELAYED, WAITING, STALE,
//   DISCONNECTED). The chosen ticker is remembered; the source is not.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../che_ui/che_hud.dart';
import 'che_crypto_candles.dart';
import 'che_crypto_stream.dart';
import 'che_live_feed_hub.dart';
import 'che_live_status.dart';
import 'che_market_feed.dart';

const kLiveChartMinutesPref = 'che_live_chart_minutes';
const kLiveChartTickerPref = 'che_live_chart_ticker';

/// The primary symbols Home switches between.
const kLiveChartTickers = ['MNQ', 'NQ', 'BTC', 'ETH'];
bool cheIsCryptoTicker(String t) => t == 'BTC' || t == 'ETH';

class CheLiveChartCard extends StatefulWidget {
  const CheLiveChartCard({
    super.key,
    this.hub,
    this.now,
    this.onConnect,
    this.onOpen,
    this.delayedBuilder,
    this.chartHeight = 150,
    this.recheckEvery = const Duration(seconds: 20),
    this.cryptoHub,
    this.initialTicker = 'MNQ',
  });

  /// Null uses [CheLiveFeedHub.instance].
  final CheLiveFeedHub? hub;

  /// The BTC and ETH streams. Null uses [CheCryptoStreamHub.appWide] (none under flutter test).
  final CheCryptoStreamHub? cryptoHub;
  final String initialTicker;
  final DateTime Function()? now;

  /// Opens the Rithmic connection screen.
  final VoidCallback? onConnect;

  /// Opens the Trading Room.
  final VoidCallback? onOpen;

  /// The delayed view, shown only after the owner asks for it. It must label itself DELAYED.
  final WidgetBuilder? delayedBuilder;
  final double chartHeight;

  /// How often the state is re-read without a new trade (a quiet market turns from LIVE to NO TRADES on its own).
  final Duration recheckEvery;

  @override
  State<CheLiveChartCard> createState() => CheLiveChartCardState();
}

class CheLiveChartCardState extends State<CheLiveChartCard> {
  int _minutes = 1;
  late String _ticker = kLiveChartTickers.contains(widget.initialTicker) ? widget.initialTicker : 'MNQ';
  CheCryptoStream? _crypto;
  CheCryptoStreamHub? get _cryptoHub => widget.cryptoHub ?? CheCryptoStreamHub.appWide;
  String get ticker => _ticker;
  CheLiveLease? _lease;
  Timer? _recheck;
  bool _showDelayed = false;

  /// Candles across the width, and how many of the newest are scrolled off to the right.
  int visible = 48;
  int _panFromRight = 0;

  /// While scrolled back: the start time of the rightmost candle in view. New candles and the oldest dropping off the
  /// end move the index, never the view (tracked by time, not by count).
  DateTime? _anchor;
  int _scaleStartVisible = 48;
  double _dragCarry = 0;

  CheLiveFeedHub get _hub => widget.hub ?? CheLiveFeedHub.instance;
  int get minutes => _minutes;
  bool get showingDelayed => _showDelayed;

  int get panFromRight => _panFromRight;
  set panFromRight(int v) {
    final candles = _lease == null ? const <CheCandle>[] : _candles;
    _panFromRight = v.clamp(0, math.max(0, candles.length - 1));
    final end = candles.length - _panFromRight;
    _anchor = _panFromRight == 0 || end <= 0 ? null : candles[end - 1].start;
  }

  @override
  void initState() {
    super.initState();
    _attach(_minutes);
    _attachCrypto();
    unawaited(_restoreMinutes());
    _hub.noteState(status.state); // the first reading: no haptic
    _recheck = Timer.periodic(widget.recheckEvery, (_) {
      if (!mounted || !TickerMode.valuesOf(context).enabled) return;
      _hub.noteState(status.state); // a quiet market turns from LIVE to NO TRADES without a new trade
      setState(() {});
    });
  }

  Future<void> _restoreMinutes() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getInt(kLiveChartMinutesPref);
      if (mounted && saved != null && kCheFeedMinutes.contains(saved) && saved != _minutes) _setMinutes(saved, save: false);
      final tick = prefs.getString(kLiveChartTickerPref);
      if (mounted && tick != null && kLiveChartTickers.contains(tick) && tick != _ticker) setTicker(tick, save: false);
    } catch (_) {
      // No saved timeframe: 1 minute.
    }
  }

  void _attach(int minutes) {
    _lease?.channel.removeListener(_onChannel);
    _lease?.release();
    _lease = _hub.acquire(minutes);
    _lease!.channel.addListener(_onChannel);
  }

  /// The public stream for BTC or ETH, shared with the Trading Room's chart; released when leaving crypto.
  void _attachCrypto() {
    final hub = _cryptoHub;
    if (_crypto != null) {
      _crypto!.removeListener(_onCrypto);
      hub?.release(_crypto!);
      _crypto = null;
    }
    if (!cheIsCryptoTicker(_ticker) || hub == null) return;
    _crypto = hub.acquire('$_ticker-USD')..addListener(_onCrypto);
  }

  void _onCrypto() {
    if (mounted) setState(() {});
  }

  /// Switches the card to [t] (MNQ, NQ, BTC or ETH) by tap or voice; remembered for next time.
  void setTicker(String t, {bool save = true}) {
    if (t == _ticker || !kLiveChartTickers.contains(t)) return;
    setState(() {
      _ticker = t;
      panFromRight = 0;
      _showDelayed = false;
      _attachCrypto();
    });
    if (save) unawaited(SharedPreferences.getInstance().then((p) => p.setString(kLiveChartTickerPref, t)).catchError((_) => false));
  }

  void _onChannel() {
    if (!mounted) return;
    final anchor = _anchor;
    if (anchor != null) {
      // Scrolled back: keep the same candles in view. If the anchor itself dropped off, hold the oldest.
      final candles = _lease!.channel.candles;
      final i = candles.lastIndexWhere((c) => !c.start.isAfter(anchor));
      _panFromRight = i < 0 ? math.max(0, candles.length - 1) : candles.length - 1 - i;
    }
    _hub.noteState(status.state);
    setState(() {});
  }

  void _setMinutes(int m, {bool save = true}) {
    if (m == _minutes) return;
    setState(() {
      _minutes = m;
      panFromRight = 0;
      _attach(m);
    });
    if (save) {
      unawaited(SharedPreferences.getInstance().then((p) => p.setInt(kLiveChartMinutesPref, m)).catchError((_) => false));
    }
  }

  void zoom(double factor) => setState(() => visible = (visible / factor).round().clamp(12, CheLiveFeedHub.maxCandles));

  @override
  void dispose() {
    _recheck?.cancel();
    _lease?.channel.removeListener(_onChannel);
    _lease?.release();
    if (_crypto != null) {
      _crypto!.removeListener(_onCrypto);
      _cryptoHub?.release(_crypto!);
    }
    super.dispose();
  }

  CheLiveStatus get status {
    final now = (widget.now ?? DateTime.now)();
    if (cheIsCryptoTicker(_ticker)) {
      final c = _crypto;
      if (c == null) {
        return CheLiveStatus(state: CheLiveState.disconnected, word: 'DISCONNECTED', detail: 'The $_ticker public stream is not available here', source: 'Coinbase public', symbol: '$_ticker-USD');
      }
      return CheLiveStatus.fromCrypto(c.describe(restAvailable: false), symbol: '$_ticker-USD', lastPrice: c.lastTrade?.price, lastTradeAt: c.lastTrade?.time);
    }
    final ch = _lease!.channel;
    final s = CheLiveStatus.fromFeed(ch.current, hasCandles: ch.candles.isNotEmpty, now: now);
    // Rithmic streams one contract; a different futures ticker says so instead of drawing the wrong market.
    final subscribed = ch.current.symbol;
    if (subscribed.isNotEmpty && !subscribed.startsWith(_ticker)) {
      return CheLiveStatus(state: CheLiveState.connecting, word: 'WAITING', detail: 'Rithmic is streaming $subscribed, not $_ticker. Choose $_ticker on the Rithmic screen to stream it.', source: 'Rithmic', symbol: _ticker);
    }
    return s;
  }

  /// The candles for the chosen ticker: Rithmic for futures, the public stream for crypto. Empty for a contract
  /// Rithmic is not streaming.
  List<CheCandle> get _candles {
    if (cheIsCryptoTicker(_ticker)) {
      final now = (widget.now ?? DateTime.now)().toUtc();
      return [
        for (final c in _crypto?.candles(_minutes) ?? const <CryptoCandle>[])
          CheCandle(start: c.start, minutes: c.minutes, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume.round(), trades: c.trades,
              closed: !now.isBefore(c.end), source: 'coinbase', symbol: '$_ticker-USD'),
      ];
    }
    final ch = _lease!.channel;
    final subscribed = ch.current.symbol;
    return subscribed.isNotEmpty && !subscribed.startsWith(_ticker) ? const [] : ch.candles;
  }

  @override
  Widget build(BuildContext context) {
    final s = status;
    final candles = _candles;
    final canAct = !cheIsCryptoTicker(_ticker) && !s.isLive && s.state != CheLiveState.quiet && s.state != CheLiveState.connecting;
    return CheGlass(
      radius: 22,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        _header(s),
        _tickers(),
        const SizedBox(height: 6),
        SizedBox(
          height: widget.chartHeight,
          child: Stack(children: [
            Positioned.fill(child: _showDelayed && widget.delayedBuilder != null ? widget.delayedBuilder!(context) : _chart(s, candles)),
            // The choices sit inside the chart's fixed box, so the card keeps its height whatever the state.
            Positioned(
              right: 0,
              bottom: 0,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (_showDelayed)
                  _button('Back to live', 'Back to the live Rithmic chart.', () => setState(() => _showDelayed = false))
                else ...[
                  if (canAct && widget.onConnect != null) _button('Connect', 'Connect Rithmic for live data.', widget.onConnect!),
                  if (canAct && widget.delayedBuilder != null)
                    _button('Delayed', 'Show delayed data. It is not live.', () => setState(() => _showDelayed = true)),
                ],
              ]),
            ),
          ]),
        ),
        const SizedBox(height: 8),
        CheLiveStatusBadge(status: _showDelayed ? CheLiveStatus.delayed(symbol: s.symbol.isEmpty ? 'MNQ' : s.symbol) : s),
      ]),
    );
  }

  Widget _header(CheLiveStatus s) {
    final price = s.lastPrice == null || _showDelayed ? '—' : _fmt(s.lastPrice!);
    final symbol = s.symbol.isEmpty ? _ticker : s.symbol;
    return Row(children: [
      Expanded(
        child: Semantics(
          header: true,
          button: widget.onOpen != null,
          // The real state, never "live" unless it is: delayed, disconnected and quiet say so.
          label: 'Trading. $symbol chart, ${_showDelayed ? 'delayed data, not live' : '${s.word.toLowerCase()}${s.isCurrent ? '' : ', not current'}'}. Double tap to open.',
          excludeSemantics: true,
          child: InkWell(
            onTap: widget.onOpen,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('$symbol · ${_showDelayed ? 'DELAYED' : s.source.toUpperCase()}', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label),
              ),
            ),
          ),
        ),
      ),
      // Fixed width so a longer price never moves the controls.
      SizedBox(
        width: 92,
        child: Semantics(
          label: price == '—' ? 'No current price' : 'Last price $price${s.isCurrent ? '' : ', not current'}',
          excludeSemantics: true,
          child: Align(
            alignment: Alignment.centerRight,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Opacity(
                opacity: s.isCurrent ? 1 : 0.55,
                child: CheChromeText(price, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()])),
              ),
            ),
          ),
        ),
      ),
      const SizedBox(width: 6),
      for (final m in kCheFeedMinutes) _tf(m),
    ]);
  }

  /// MNQ · NQ · BTC · ETH, one tap each (44 points tall for VoiceOver).
  Widget _tickers() => Row(children: [
        for (final t in kLiveChartTickers)
          Expanded(
            child: Semantics(
              button: true,
              selected: t == _ticker,
              label: '$t chart${t == _ticker ? ', selected' : ''}',
              excludeSemantics: true,
              child: InkWell(
                key: ValueKey('che-live-ticker-$t'),
                borderRadius: BorderRadius.circular(10),
                onTap: () => setTicker(t),
                child: SizedBox(
                  height: 44,
                  child: Center(
                    child: Text(t,
                        style: CheHud.label.copyWith(fontSize: 12, color: t == _ticker ? CheHud.ice : CheHud.chromeLo, fontWeight: t == _ticker ? FontWeight.w800 : FontWeight.w400)),
                  ),
                ),
              ),
            ),
          ),
      ]);

  Widget _tf(int m) {
    final on = m == _minutes;
    return Semantics(
      button: true,
      selected: on,
      label: '$m minute candles',
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey('che-live-tf-$m'),
        onTap: () => _setMinutes(m),
        borderRadius: BorderRadius.circular(10),
        child: SizedBox(
          width: 44,
          height: 44,
          child: Center(
            child: Text('${m}m', style: CheHud.label.copyWith(fontSize: 11, color: on ? CheHud.ice : CheHud.chromeLo, fontWeight: on ? FontWeight.w700 : FontWeight.w400)),
          ),
        ),
      ),
    );
  }

  Widget _button(String text, String semantics, VoidCallback onTap) => Semantics(
        button: true,
        label: semantics,
        excludeSemantics: true,
        child: TextButton(
          onPressed: onTap,
          style: TextButton.styleFrom(foregroundColor: CheHud.ice, minimumSize: const Size(44, 44), padding: const EdgeInsets.symmetric(horizontal: 10)),
          child: Text(text, style: CheHud.label.copyWith(fontSize: 11, color: CheHud.ice)),
        ),
      );

  Widget _chart(CheLiveStatus s, List<CheCandle> candles) {
    final end = math.max(0, candles.length - panFromRight);
    final start = math.max(0, end - visible);
    final shown = candles.sublist(start, end);
    final summary = shown.isEmpty
        ? (s.state == CheLiveState.disconnected ? 'No live candles. ${s.detail}.' : 'No candles yet.')
        : '${shown.length} $_minutes-minute candles, ${s.isCurrent ? 'live' : 'not current'}, from ${_fmt(shown.map((c) => c.low).reduce(math.min))} to ${_fmt(shown.map((c) => c.high).reduce(math.max))}.';
    return Semantics(
      label: summary,
      customSemanticsActions: {
        const CustomSemanticsAction(label: 'Zoom in'): () => zoom(1.5),
        const CustomSemanticsAction(label: 'Zoom out'): () => zoom(1 / 1.5),
      },
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onScaleStart: (_) {
          _scaleStartVisible = visible;
          _dragCarry = 0;
        },
        onScaleUpdate: (d) {
          final width = context.size?.width ?? 300;
          setState(() {
            if (d.pointerCount > 1) {
              visible = (_scaleStartVisible / d.scale).round().clamp(12, CheLiveFeedHub.maxCandles);
            } else {
              _dragCarry += d.focalPointDelta.dx / (width / visible);
              final step = _dragCarry.truncate();
              if (step != 0) {
                _dragCarry -= step;
                panFromRight = (panFromRight + step).clamp(0, math.max(0, candles.length - 12)).toInt();
              }
            }
          });
        },
        onDoubleTap: () => setState(() => panFromRight = 0),
        child: Stack(children: [
          Positioned.fill(
            child: RepaintBoundary(
              child: CustomPaint(painter: CheLiveCandlePainter(shown, current: s.isCurrent)),
            ),
          ),
          if (shown.isEmpty)
            Center(
              child: Text(
                s.state == CheLiveState.disconnected ? 'No live candles' : (s.state == CheLiveState.quiet ? 'No trades yet' : 'Waiting for live candles'),
                textAlign: TextAlign.center,
                style: CheHud.label.copyWith(fontSize: 10.5, color: CheHud.chromeMid),
              ),
            )
          else if (!s.isCurrent)
            Positioned(
              left: 0,
              top: 0,
              child: Text('NOT CURRENT', style: CheHud.label.copyWith(fontSize: 9, letterSpacing: 1.4, color: CheLiveTone.color(s.state))),
            ),
        ]),
      ),
    );
  }

  static String _fmt(double v) {
    final fixed = v.toStringAsFixed(2);
    final parts = fixed.split('.');
    final whole = parts[0].replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
    return '$whole.${parts[1]}';
  }
}

/// Candles in the available box. Dimmed when not current.
class CheLiveCandlePainter extends CustomPainter {
  CheLiveCandlePainter(this.candles, {required this.current});

  final List<CheCandle> candles;
  final bool current;

  static const up = Color(0xFF3DDC97);
  static const down = Color(0xFFFF5C7A);

  @override
  void paint(Canvas canvas, Size size) {
    if (candles.isEmpty || size.isEmpty) return;
    var lo = candles.first.low, hi = candles.first.high;
    for (final c in candles) {
      lo = math.min(lo, c.low);
      hi = math.max(hi, c.high);
    }
    final span = hi - lo == 0 ? 1.0 : hi - lo;
    double y(double p) => size.height - 4 - (p - lo) / span * (size.height - 8);
    final slot = size.width / candles.length;
    final body = math.max(1.0, slot * 0.62);
    final alpha = current ? 1.0 : 0.45;
    for (var i = 0; i < candles.length; i++) {
      final c = candles[i];
      final color = (c.close >= c.open ? up : down).withValues(alpha: alpha * (c.closed ? 1 : 0.85));
      final x = slot * i + slot / 2;
      final paint = Paint()..color = color;
      canvas.drawLine(Offset(x, y(c.high)), Offset(x, y(c.low)), paint..strokeWidth = 1);
      final top = y(math.max(c.open, c.close)), bottom = y(math.min(c.open, c.close));
      canvas.drawRect(Rect.fromLTRB(x - body / 2, top, x + body / 2, math.max(bottom, top + 1)), paint);
    }
    // The last price as a thin line.
    final lastY = y(candles.last.close);
    canvas.drawLine(Offset(0, lastY), Offset(size.width, lastY), Paint()
      ..color = CheHud.ice.withValues(alpha: current ? 0.45 : 0.2)
      ..strokeWidth = 0.8);
  }

  @override
  bool shouldRepaint(CheLiveCandlePainter old) => !identical(old.candles, candles) || old.current != current || old.candles.length != candles.length;
}
