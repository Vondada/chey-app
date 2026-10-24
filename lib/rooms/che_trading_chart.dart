// The Trading Room chart (owner, 2026-10-20, Build 1): one interactive chart for Alpaca PAPER
// stocks and CHE's MNQ futures paper research, read from the Worker's /api/trading/chart
// (server/cloudflare/trading_chart.js).
//
// - Symbol search, timeframes, pinch to zoom, drag to scroll, plus buttons for each of these so
//   VoiceOver and voice can do the same.
// - Markers by source, drawn differently and never merged: CHE forward paper, CHE strategy
//   simulation, Alpaca PAPER orders and Alpaca PAPER fills. Tapping one shows its receipt.
// - The owner's drawings (lines, levels, boxes, notes), saved on the Worker per account and symbol.
// - Feed health: provider, status, last bar and its age. New entries are blocked when the Worker
//   says the feed is stale or unavailable.
// - Tapping a price opens a PAPER order ticket. Preview shows cost, buying power after and any
//   limit that blocks it; only the explicit "Yes, place paper order" sends it. Open orders can be
//   cancelled, and every answer is the broker's record.
// - MNQ PAPER with Rithmic connected (owner, 2026-10-23): 1- and 5-minute candles built on this phone from real
//   Rithmic trades (lib/rithmic/rithmic_candles.dart) replace the Worker's delayed Yahoo bars from the first Rithmic
//   candle on; earlier Yahoo history stays, drawn dimmer and labelled delayed. Every bar keeps its source.
// - Markets (owner, 2026-10-24): any crypto pair or CME future from the Worker's market universe on public data
//   (Coinbase, Kraken fallback, Yahoo delayed futures), research only, with indicators (lib/rooms/che_chart_indicators.dart)
//   and a long-press crosshair. The ticker, timeframe and indicators stay on this phone (CheTickerPrefs).
// The chart is silent on open; "Read chart" reads its summary only when asked.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import '../che_ui/che_chrome_status.dart';
import '../che_ui/che_hud.dart';
import '../che_ui/che_ui_preferences.dart';
import '../rithmic/rithmic_candles.dart';
import '../rithmic/rithmic_live.dart';
import '../trading/che_trade_replay.dart';
import '../che_ui/che_theme.dart';
import 'che_chart_indicators.dart';
import 'che_live_chart.dart';
import 'che_ticker_selector.dart';
import 'che_trading_hud.dart';

const _up = Color(0xFF3DDC97);
const _down = Color(0xFFFF5C7A);
const _gold = CheColors.markets;
final _dim = CheColors.textDim;
final _panel = CheColors.surface;
final _stroke = CheColors.stroke;
const _draw = Color(0xFF7FD3FF);
const _level = Color(0xFFFFC857); // 86-style overnight levels

/// The four marker sources, in the order the legend shows them.
const kMarkerSources = <String, String>{
  'che_forward': 'CHE forward paper',
  'che_sim': 'CHE simulation',
  'alpaca_order': 'Alpaca order',
  'alpaca_fill': 'Alpaca fill',
  'che_signal': 'CHE signal (paper)',
};
const kMarkerColors = <String, Color>{
  'che_forward': _gold,
  'che_sim': Color(0xFFB794F6),
  'alpaca_order': Color(0xFF7FD3FF),
  'alpaca_fill': _up,
  'che_signal': Color(0xFFFFA94D),
};
const kChartAccounts = <String, String>{'alpaca_paper': 'Alpaca PAPER', 'futures_paper': 'MNQ PAPER', 'market': 'Markets'};
/// The Alpaca PAPER chart account is hidden from the owner's Trading Room (owner, 2026-10-23: "I don't want to see the
/// alpaca at all. I just want to see mine and Che's paper trades"). Set to true to show it again; the data path stays.
bool kShowAlpacaPaper = false; // not const, so tests can show it again
/// The chart account to open: the requested one when it is visible, otherwise the MNQ PAPER chart while Alpaca is hidden.
String visibleChartAccount(String id) {
  if (!kChartAccounts.containsKey(id) || (id == 'alpaca_paper' && !kShowAlpacaPaper)) return kShowAlpacaPaper ? 'alpaca_paper' : 'futures_paper';
  return id;
}
const kQuickSymbols = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA'];

DateTime? _time(Object? v) {
  if (v is num) return DateTime.fromMillisecondsSinceEpoch(v > 1e12 ? v.toInt() : (v * 1000).toInt(), isUtc: true);
  if (v is String && v.isNotEmpty) return DateTime.tryParse(v)?.toUtc();
  return null;
}

double? _num(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}');

class ChartBar {
  const ChartBar(this.t, this.o, this.h, this.l, this.c, {this.source = kBarHistory, this.v = 0});
  final DateTime t;
  final double o, h, l, c;

  /// Volume when the source reports it (VWAP needs it); 0 otherwise.
  final double v;

  /// Where the bar came from: [kBarRithmic] (built on this phone from Rithmic trades) or [kBarHistory] (the Worker).
  final String source;
}

const kBarRithmic = 'rithmic';
const kBarHistory = 'history';

class ChartMarker {
  ChartMarker(this.raw)
      : source = '${raw['source'] ?? ''}',
        kind = '${raw['kind'] ?? ''}',
        time = _time(raw['time']),
        price = _num(raw['price']);
  final Map<String, dynamic> raw;
  final String source, kind;
  final DateTime? time;
  final double? price;
  String get side => '${raw['side'] ?? ''}';
  String get strategy => '${raw['strategy'] ?? ''}';
  String get status => '${raw['status'] ?? ''}';
  bool get isBuy => side == 'buy' || side == 'long';

  /// The record this marker belongs to (a CHE journal trade, a simulation trade or an Alpaca order).
  String get tradeId => '${raw['id'] ?? raw['order_id'] ?? ''}';

  /// CHE's simulation (never a paper or broker execution).
  bool get isSim => source == 'che_sim';

  /// What the recorded trade says about its result: 'win' or 'loss' only on an exit with a recorded R or net P&L,
  /// 'open' for an open position, '' otherwise. Never inferred from the chart.
  String get outcome {
    if (kind == 'open' || (kind == 'entry' && status == 'open')) return 'open';
    if (kind != 'exit') return '';
    final r = _num(raw['r']) ?? _num(raw['net_pnl']);
    if (r == null || r == 0) return '';
    return r > 0 ? 'win' : 'loss';
  }

  /// The entry of a closed CHE trade, whose exit carries the W or L.
  bool get isClosedCheEntry => source.startsWith('che_') && kind == 'entry' && status == 'closed';
}

/// The chart's marker filters (owner, 2026-10-23): Wins, Losses, Open, Paper, Simulation, and one strategy.
class CheMarkerFilter {
  const CheMarkerFilter({this.wins = true, this.losses = true, this.open = true, this.paper = true, this.sim = true, this.strategy});
  final bool wins, losses, open, paper, sim;
  final String? strategy;

  CheMarkerFilter copyWith({bool? wins, bool? losses, bool? open, bool? paper, bool? sim}) => CheMarkerFilter(
      wins: wins ?? this.wins, losses: losses ?? this.losses, open: open ?? this.open, paper: paper ?? this.paper, sim: sim ?? this.sim, strategy: strategy);

  /// The markers to draw from [all]: a closed CHE entry is left out only when its own exit (same record) is there.
  List<ChartMarker> apply(Iterable<ChartMarker> all) {
    final exits = {for (final m in all) if (m.kind == 'exit' && m.tradeId.isNotEmpty) '${m.source}|${m.tradeId}'};
    return [for (final m in all) if (admits(m, exitShown: exits.contains('${m.source}|${m.tradeId}'))) m];
  }

  bool admits(ChartMarker m, {bool exitShown = false}) {
    if (!(m.isSim ? sim : paper)) return false;
    final st = strategy;
    if (st != null && st.isNotEmpty && m.source.startsWith('che_') && !m.strategy.toLowerCase().contains(st.toLowerCase())) return false;
    return switch (m.outcome) {
      'win' => wins,
      'loss' => losses,
      'open' => open,
      _ => !(m.isClosedCheEntry && exitShown),
    };
  }
}

/// A marker's one-line name for lists, receipts and VoiceOver: its recorded outcome first, then where it came from.
String cheMarkerTitle(ChartMarker m) {
  final from = kMarkerSources[m.source] ?? m.source;
  return switch (m.outcome) {
    'win' => 'Win · $from',
    'loss' => 'Loss · $from',
    'open' => 'Open position · $from',
    _ => '$from · ${m.kind}',
  };
}

/// A marker as Trade Replay's summary: the record it names, shown at once while the full record loads. Only what the
/// marker itself recorded; an entry marker carries no exit.
Map<String, dynamic> cheMarkerSummary(ChartMarker m) {
  final r = m.raw;
  final exit = m.kind == 'exit';
  return {
    'id': m.tradeId,
    'label': m.isSim ? 'SIMULATION' : 'CHE FORWARD PAPER',
    if (m.strategy.isNotEmpty) 'strategy': m.strategy,
    if (r['symbol'] != null) 'symbol': '${r['symbol']}',
    if (m.side.isNotEmpty) 'side': m.side,
    if (!exit && m.time != null) 'entry_time': m.time!.toIso8601String(),
    if (!exit && m.price != null) 'entry_price': m.price,
    if (exit && m.time != null) 'exit_time': m.time!.toIso8601String(),
    if (exit && m.price != null) 'exit_price': m.price,
    if (r['stop'] != null) 'stop': r['stop'],
    if (r['target'] != null) 'target': r['target'],
    if (m.outcome == 'win' || m.outcome == 'loss') 'result': m.outcome,
    if (r['r'] != null) 'r': r['r'],
    if (r['net_pnl'] != null) 'net': r['net_pnl'],
  };
}

/// Markers close together on screen, drawn as one counted badge at low zoom so they never pile up.
class CheMarkerCluster {
  CheMarkerCluster(this.at, this.members);
  final Offset at;
  final List<ChartMarker> members;
}

/// Groups placed markers whose centres lie within [radius] pixels of a cluster's first marker. Pure, for tests.
List<CheMarkerCluster> cheClusterMarkers(Iterable<(ChartMarker, Offset)> placed, {double radius = 16}) {
  final sorted = placed.toList()..sort((a, b) => a.$2.dx.compareTo(b.$2.dx));
  final out = <CheMarkerCluster>[];
  for (final (m, p) in sorted) {
    CheMarkerCluster? hit;
    for (var i = out.length - 1; i >= 0; i--) {
      final c = out[i];
      if (p.dx - c.at.dx > radius) break;
      if ((c.at - p).distance <= radius) {
        hit = c;
        break;
      }
    }
    if (hit == null) {
      out.add(CheMarkerCluster(p, [m]));
    } else {
      hit.members.add(m);
    }
  }
  return out;
}

class ChartDrawing {
  ChartDrawing({required this.id, required this.kind, required this.points, this.text});
  final String id, kind;
  final List<(DateTime?, double)> points;
  final String? text;

  static ChartDrawing? fromJson(Object? j) {
    if (j is! Map) return null;
    final pts = [
      for (final p in (j['points'] is List ? j['points'] as List : const []))
        if (p is Map && _num(p['price']) != null) (_time(p['time']), _num(p['price'])!),
    ];
    if (pts.isEmpty) return null;
    return ChartDrawing(id: '${j['id'] ?? ''}', kind: '${j['kind'] ?? ''}', points: pts, text: j['text']?.toString());
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'kind': kind,
        'points': [
          for (final (t, p) in points) {'price': p, if (t != null) 'time': t.toIso8601String()},
        ],
        if (text != null) 'text': text,
      };

  String get spoken => switch (kind) {
        'hline' => 'level at ${_fmt(points.first.$2)}',
        'line' => 'line from ${_fmt(points.first.$2)} to ${_fmt(points.last.$2)}',
        'box' => 'box from ${_fmt(points.first.$2)} to ${_fmt(points.last.$2)}',
        _ => 'note "${text ?? ''}" at ${_fmt(points.first.$2)}',
      };
}

/// One level from CHE's 86-style overnight range model (an independent approximation, not the P2P indicator):
/// the overnight high and low, and the entry, stop and target only when the written rules produced a signal.
class ChartLevel {
  const ChartLevel(this.kind, this.price, this.label);
  final String kind; // overnight_high, overnight_low, entry, stop, target
  final double price;
  final String label;
}

/// The chart's overnight levels and a plain-language line for Read Aloud and VoiceOver.
/// Says "approximation" every time: the original P2P indicator is closed source and not reproduced.
class CheOvernightLevels {
  const CheOvernightLevels(this.levels, this.spoken);
  final List<ChartLevel> levels;
  final String spoken;

  static const none = CheOvernightLevels([], '');

  static CheOvernightLevels fromJson(Object? j) {
    if (j is! Map) return none;
    final hi = _num(j['onHigh']), lo = _num(j['onLow']);
    if (hi == null || lo == null) {
      final why = j['reason']?.toString() ?? '';
      return CheOvernightLevels(const [], why.isEmpty ? '' : '86-style overnight range (approximation): $why');
    }
    final out = <ChartLevel>[
      ChartLevel('overnight_high', hi, 'ON high ${_fmt(hi)} · 86-style approx.'),
      ChartLevel('overnight_low', lo, 'ON low ${_fmt(lo)} · 86-style approx.'),
    ];
    final sig = j['signal'];
    if (sig is Map) {
      for (final (k, name) in const [('ref', 'entry'), ('stop', 'stop'), ('target', 'target')]) {
        final v = _num(sig[k]);
        if (v != null) out.add(ChartLevel(name, v, '${name[0].toUpperCase()}${name.substring(1)} ${_fmt(v)}'));
      }
    }
    final bias = j['bias']?.toString() ?? 'none';
    final stage = '${j['stage'] ?? ''}'.replaceAll('_', ' ');
    final reason = j['reason']?.toString() ?? '';
    return CheOvernightLevels(out,
        '86-style overnight range (CHE approximation, not the P2P indicator): high ${_fmt(hi)}, low ${_fmt(lo)}, bias $bias, stage $stage. $reason'.trim());
  }
}

String _fmt(double v) => v >= 1000 ? v.toStringAsFixed(2).replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (m) => ',') : v.toStringAsFixed(2);
String _clock(DateTime t) {
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}';
}

/// Voice and other screens ask the chart for an account, symbol, strategy filter or a level here.
class CheTradingChartController extends ChangeNotifier {
  String? account, symbol, strategy;
  double? level;
  void show({String? account, String? symbol, String? strategy}) {
    this.account = account ?? this.account;
    this.symbol = symbol ?? this.symbol;
    this.strategy = strategy;
    notifyListeners();
  }

  void addLevel(double price) {
    level = price;
    notifyListeners();
  }

  /// The side-by-side view keeps two charts on one timeframe and zoom when synced (owner, 2026-10-23).
  String? timeframe;
  double? zoomFactor;
  void showTimeframe(String tf) {
    timeframe = tf;
    notifyListeners();
  }

  void zoomBy(double factor) {
    zoomFactor = factor;
    notifyListeners();
  }
}

enum _Tool { none, line, hline, box, text }

class CheTradingChart extends StatefulWidget {
  const CheTradingChart({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.client,
    this.onSpeak,
    this.controller,
    this.initialAccount = 'alpaca_paper',
    this.initialSymbol = '',
    this.initialStrategy,
    this.initialTimeframe,
    this.height = 340,
    this.signalMarkers,
    this.live,
    this.compact = false,
    this.onExpand,
    this.onMarkers,
  });

  /// The recorded markers after each load (the expanded chart lists the recent trades from them).
  final void Function(List<ChartMarker> markers)? onMarkers;

  /// The compact preview (owner, 2026-10-23): symbol, timeframe, feed line, the chart and the marker filters, with
  /// fixed heights so live ticks never move the page. Drawing, orders and the full legend live in the expanded chart.
  final bool compact;

  /// Opens the expanded (portrait) chart. Never rotates the phone.
  final VoidCallback? onExpand;

  /// Opens a CHE trade's full record. The app opens Trade Replay (`/trade-replay?id=`, route `trade_replay/<id>`);
  /// tests replace it to see which record was asked for.
  static void Function(BuildContext context, ChartMarker marker)? openTradeRecord;

  /// CHE PAPER ACCOUNT signals from the setup desk on this phone (source 'che_signal'), drawn on
  /// the MNQ PAPER chart only.
  final ValueListenable<List<Map<String, dynamic>>>? signalMarkers;

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;

  /// Reads explicit requests and user-initiated action results. Passive loads stay silent.
  final void Function(String text)? onSpeak;
  final CheTradingChartController? controller;
  final String initialAccount, initialSymbol;

  /// "CHE, show EMA trades": only CHE's markers for this strategy (Alpaca markers stay).
  final String? initialStrategy;

  /// "And the 15 minute?": the bar size CHE named when she opened this chart by voice ('15m'). It wins over the saved
  /// timeframe, so the chart shows what CHE said; null keeps the default.
  final String? initialTimeframe;
  final double height;

  /// The shared Rithmic session (lib/rithmic/rithmic_live.dart); tests pass their own.
  final CheRithmicLive? live;

  @override
  State<CheTradingChart> createState() => CheTradingChartState();
}

class CheTradingChartState extends State<CheTradingChart> {
  late final http.Client _http = widget.client ?? http.Client();
  late String _account = visibleChartAccount(widget.initialAccount);
  late String _symbol = widget.initialSymbol.toUpperCase();
  late String _tf = (widget.initialTimeframe ?? '').isNotEmpty ? widget.initialTimeframe! : '5m';
  List<String> _timeframes = const ['1m', '5m', '15m', '1h', '1d'];
  List<ChartBar> _bars = const [];
  List<ChartBar> _history = const [];
  String _historyTf = '';
  Timer? _liveRebuild;
  List<ChartMarker> _markers = const [];
  List<ChartDrawing> _drawings = [];
  CheOvernightLevels _levels = CheOvernightLevels.none;
  List<Map<String, dynamic>> _openOrders = const [];
  Map<String, dynamic> _feed = const {};
  String _state = 'loading';
  String? _error;
  bool _entriesAllowed = false, _marketAllowed = false;
  String _blocked = '';
  final Set<String> _hidden = {};
  CheMarkerFilter _filter = const CheMarkerFilter();
  late String? _strategy = widget.initialStrategy;
  _Tool _tool = _Tool.none;
  (DateTime?, double)? _first;
  int _visible = 80; // bars on screen
  int _endOffset = 0; // bars hidden to the right of the window
  int _scaleStartVisible = 80;
  double _dragCarry = 0;
  int _seq = 0;
  Timer? _timer;
  final _symbolField = TextEditingController();
  String _status = '';

  /// The universe item the Markets chart shows (exchange, market, front month), from the Worker.
  Map<String, dynamic> _ticker = const {};
  String _builtFrom = '';
  bool _fallback = false;
  final _prefs = CheTickerPrefs.instance;
  Set<String> _indicators = {};

  /// The bar index (in the visible window) under a long press: the crosshair.
  int? _cross;

  @override
  void initState() {
    super.initState();
    _symbolField.text = _symbol;
    widget.controller?.addListener(_onController);
    widget.signalMarkers?.addListener(_onSignals);
    _live.addListener(_onLive);
    CheLiveChart.indicators.addListener(_onVoiceIndicators);
    unawaited(_restore());
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => unawaited(load(quiet: true)));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _liveRebuild?.cancel();
    _live.removeListener(_onLive);
    CheLiveChart.indicators.removeListener(_onVoiceIndicators);
    widget.controller?.removeListener(_onController);
    widget.signalMarkers?.removeListener(_onSignals);
    _symbolField.dispose();
    super.dispose();
  }

  /// The saved ticker, timeframe and indicators first, so the chart opens where the owner left it.
  /// Only the Markets chart waits for them; the other charts load at once and pick up the indicators when read.
  Future<void> _restore() async {
    final market = _account == 'market';
    if (!market) unawaited(load());
    await _prefs.load();
    if (!mounted) return;
    if (_prefs.indicators.isNotEmpty) setState(() => _indicators = {..._prefs.indicators});
    if (!setEquals(CheLiveChart.indicators.value, _indicators)) CheLiveChart.indicators.value = {..._indicators};
    if (market) {
      if (_symbol.isEmpty) _symbol = _prefs.last;
      final tf = _prefs.timeframe;
      if (tf != null && (widget.initialTimeframe ?? '').isEmpty) _tf = tf;
      await load();
    }
  }

  bool get _futures => _account == 'futures_paper' || '${_ticker['category'] ?? ''}' == 'futures';

  /// What the header shows for the symbol: "BTC" for coinbase:BTC-USD, the ticker itself otherwise.
  String get symbolLabel => _account == 'market' && _symbol.isNotEmpty ? tickerLabel(_symbol) : _symbol;

  /// Shows a universe ticker ("futures:ES", "coinbase:BTC-USD") on the Markets chart, and remembers it.
  void showTicker(String id) {
    if (id.isEmpty) return;
    setState(() {
      _account = 'market';
      _symbol = id;
      _bars = const [];
      _markers = const [];
      _endOffset = 0;
      _cross = null;
    });
    unawaited(_prefs.choose(id));
    unawaited(load());
  }

  void _onController() {
    final c = widget.controller!;
    if (c.level != null) {
      final price = c.level!;
      c.level = null;
      _addDrawing(ChartDrawing(id: 'hline-${DateTime.now().millisecondsSinceEpoch}', kind: 'hline', points: [(null, price)]));
      return;
    }
    if (c.zoomFactor != null) {
      final factor = c.zoomFactor!;
      c.zoomFactor = null;
      if (_bars.isNotEmpty) zoom(factor);
      return;
    }
    if (c.timeframe != null) {
      final tf = c.timeframe!;
      c.timeframe = null;
      if (tf != _tf) {
        setState(() => _tf = tf);
        if (_account == 'market') unawaited(_prefs.setTimeframe(tf));
        unawaited(load());
      }
      return;
    }
    setState(() {
      if (c.account != null && kChartAccounts.containsKey(c.account)) _account = c.account!;
      // A universe id keeps its case ("coinbase:BTC-USD"); stock and futures symbols are upper case.
      if (c.symbol != null && c.symbol!.isNotEmpty) _symbol = _account == 'market' ? c.symbol! : c.symbol!.toUpperCase();
      _strategy = c.strategy;
      _symbolField.text = _symbol;
    });
    unawaited(load());
  }

  String get accountLabel => kChartAccounts[_account] ?? _account;

  /// The account and symbol on screen (the expanded chart opens on the same ones).
  String get account => _account;
  String get symbol => _symbol;
  String get timeframe => _tf;

  // ─── Rithmic live candles (MNQ PAPER only) ────────────────────────────

  CheRithmicLive get _live => widget.live ?? CheRithmicLive.instance;

  /// Rithmic candles can be drawn: MNQ PAPER, and a Rithmic session that is connected or already recorded trades.
  bool get _rithmicChart => _account == 'futures_paper' && (_live.attached || !_live.book.isEmpty);

  /// The Rithmic source and status lines show once Rithmic is in play (connecting, connected, dropped or recorded).
  /// Before that the feed line already names the delayed provider, and the layout stays as it was.
  bool get _rithmicHeader => _account == 'futures_paper' && (_live.status != RithmicLiveStatus.off || !_live.book.isEmpty);

  /// Trades arrive many times a second; the chart redraws at most four times a second.
  void _onLive() {
    if (!mounted || _account != 'futures_paper' || _liveRebuild != null) return;
    _liveRebuild = Timer(const Duration(milliseconds: 250), () {
      _liveRebuild = null;
      if (!mounted) return;
      setState(() {
        _offerOneMinute();
        _bars = _merged();
      });
    });
  }

  void _offerOneMinute() {
    if (_rithmicChart && !_timeframes.contains('1m')) _timeframes = ['1m', ..._timeframes];
  }

  /// The bars to draw: Worker history, then Rithmic candles from the first one on. History of another
  /// timeframe (the Worker answers 5m for a 1m request) is never stretched into this one.
  List<ChartBar> _merged() {
    final history = _historyTf == _tf ? _history : const <ChartBar>[];
    final minutes = _tf == '1m' ? 1 : _tf == '5m' ? 5 : 0;
    if (!_rithmicChart || minutes == 0) return history;
    final live = [
      for (final c in _live.book.candles(minutes)) ChartBar(c.t, c.o, c.h, c.l, c.c, source: kBarRithmic),
    ];
    if (live.isEmpty) return history;
    final from = live.first.t;
    return [...history.where((b) => b.t.isBefore(from)), ...live];
  }

  /// "Rithmic live — MNQZ6", or what the history really is: never "live" for delayed bars.
  String get sourceLabel {
    final provider = '${_feed['provider'] ?? ''}';
    final history = provider.toLowerCase().contains('yahoo') ? 'Yahoo Finance (delayed)' : (provider.isEmpty ? 'Worker history' : provider);
    if (_account != 'futures_paper') return provider.isEmpty ? 'Feed' : provider;
    final rithmicBars = _bars.where((b) => b.source == kBarRithmic).length;
    final historyBars = _bars.length - rithmicBars;
    if (rithmicBars == 0) return 'Source: $history';
    final live = _live.isLive ? 'Rithmic live — ${_live.symbol}' : 'Rithmic ${_live.symbol} (recorded on this phone)';
    return historyBars == 0 ? 'Source: $live' : 'Source: $live from ${_clock(_bars.firstWhere((b) => b.source == kBarRithmic).t)}; earlier bars $history';
  }

  String _seconds(DateTime t) {
    final l = t.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(l.hour)}:${two(l.minute)}:${two(l.second)}';
  }

  /// Connection status and last update for the Rithmic line in the header.
  String get rithmicLine {
    final parts = [_live.statusLabel, CheRithmicLive.backgroundNote.replaceFirst(RegExp(r'\.$'), '')];
    final at = _live.lastTradeAt;
    if (at != null) parts.add('last trade ${_seconds(at)}');
    final got = _live.lastReceivedAt;
    if (got != null) parts.add('updated ${_seconds(got)}');
    final minutes = _tf == '1m' ? 1 : _tf == '5m' ? 5 : 0;
    if (_bars.isNotEmpty && _bars.last.source == kBarRithmic && minutes > 0 && RithmicCandleBook.forming(_live.book.candles(minutes).last, minutes, DateTime.now())) {
      parts.add('last candle forming');
    }
    return parts.join(' · ');
  }

  Future<void> load({bool quiet = false}) async {
    final seq = ++_seq;
    if (!quiet) setState(() => _state = 'loading');
    final q = {'account': _account, 'tf': _tf, if ((_account == 'alpaca_paper' || _account == 'market') && _symbol.isNotEmpty) 'symbol': _symbol};
    try {
      final r = await _http
          .get(Uri.parse('${widget.baseUrl()}/api/trading/chart').replace(queryParameters: q), headers: widget.headers())
          .timeout(const Duration(seconds: 25));
      if (seq != _seq || !mounted) return; // a newer request (another symbol or timeframe) wins
      final j = jsonDecode(r.body);
      if (j is! Map<String, dynamic>) throw const FormatException('The chart answer was not readable.');
      if (r.statusCode != 200 || j['ok'] == false) throw Exception('${j['error'] ?? j['detail'] ?? 'The chart is unavailable.'}');
      setState(() => _apply(j));

    } catch (e) {
      if (seq != _seq || !mounted) return;
      setState(() {
        _state = 'error';
        _error = '$e'.replaceFirst('Exception: ', '');
        _feed = {..._feed, 'status': 'UNAVAILABLE', 'stale': true};
        _entriesAllowed = false;
        _marketAllowed = false;
        _blocked = 'Feed freshness could not be verified: $_error';
      });
    }
  }

  void _apply(Map<String, dynamic> j) {
    _state = '${j['state'] ?? 'verified'}';
    _error = j['error']?.toString();
    final sym = j['symbol']?.toString();
    if (sym != null && sym.isNotEmpty && _account == 'alpaca_paper' && _symbol.isEmpty) {
      _symbol = sym;
      _symbolField.text = sym;
    }
    if (_account == 'futures_paper') _symbol = sym ?? 'MNQ';
    _ticker = _account == 'market' && j['ticker'] is Map<String, dynamic> ? j['ticker'] as Map<String, dynamic> : const {};
    if (_ticker['id'] is String) _symbol = _ticker['id'] as String;
    _builtFrom = '${j['built_from'] ?? ''}';
    _fallback = j['fallback'] == true;
    final served = '${j['timeframe'] ?? _tf}';
    // The Worker has no 1-minute MNQ bars; with Rithmic, 1m stays chosen and is drawn from Rithmic candles alone.
    if (!(_tf == '1m' && _rithmicChart)) _tf = served;
    _timeframes = [for (final t in (j['timeframes'] is List ? j['timeframes'] as List : _timeframes)) '$t'];
    _offerOneMinute();
    _historyTf = served;
    _history = [
      for (final b in (j['bars'] is List ? j['bars'] as List : const []))
        if (b is Map && _time(b['t']) != null && _num(b['o']) != null && _num(b['h']) != null && _num(b['l']) != null && _num(b['c']) != null)
          ChartBar(_time(b['t'])!, _num(b['o'])!, _num(b['h'])!, _num(b['l'])!, _num(b['c'])!, v: _num(b['v']) ?? 0),
    ];
    _bars = _merged();
    _markers = [
      for (final m in (j['markers'] is List ? j['markers'] as List : const []))
        if (m is Map<String, dynamic>) ChartMarker(m),
    ];
    final markers = _markers;
    if (widget.onMarkers != null) scheduleMicrotask(() => widget.onMarkers?.call(markers));
    _drawings = [for (final d in (j['drawings'] is List ? j['drawings'] as List : const [])) ?ChartDrawing.fromJson(d)];
    _levels = CheOvernightLevels.fromJson(j['levels']);
    _openOrders = [for (final o in (j['open_orders'] is List ? j['open_orders'] as List : const [])) if (o is Map<String, dynamic>) o];
    _feed = j['feed'] is Map<String, dynamic> ? j['feed'] as Map<String, dynamic> : const {};
    _entriesAllowed = j['entries_allowed'] == true;
    _marketAllowed = j['market_orders_allowed'] == true;
    _blocked = '${j['entries_blocked_reason'] ?? ''}';
    _endOffset = _endOffset.clamp(0, math.max(0, _bars.length - 10));
  }

  // ─── The visible window ───────────────────────────────────────────────

  int get _count => math.min(_visible, _bars.length);
  int get _end => _bars.length - _endOffset;
  int get _start => math.max(0, _end - _count);
  List<ChartBar> get _window => _bars.isEmpty ? const [] : _bars.sublist(_start, _end);

  void zoom(double factor) => setState(() => _visible = (_visible / factor).round().clamp(15, math.max(15, _bars.length)));
  void scroll(int bars) => setState(() => _endOffset = (_endOffset + bars).clamp(0, math.max(0, _bars.length - 10)));

  void _onSignals() {
    if (mounted) setState(() {});
  }

  List<ChartMarker> get _allMarkers => [
        ..._markers,
        if (_account == 'futures_paper')
          for (final m in widget.signalMarkers?.value ?? const <Map<String, dynamic>>[]) ChartMarker(m),
      ];

  List<ChartMarker> get _shownMarkers {
    final f = CheMarkerFilter(wins: _filter.wins, losses: _filter.losses, open: _filter.open, paper: _filter.paper, sim: _filter.sim, strategy: _strategy);
    return f.apply([for (final m in _allMarkers) if (!_hidden.contains(m.source)) m]);
  }

  // ─── Drawings ─────────────────────────────────────────────────────────

  Future<void> _addDrawing(ChartDrawing d) async {
    setState(() => _drawings = [..._drawings, d]);
    await _saveDrawings('Saved the ${d.spoken}.');
  }

  Future<void> _saveDrawings(String done) async {
    if (_symbol.isEmpty) {
      setState(() => _status = 'Choose a symbol first; drawings are kept per symbol. Nothing was saved.');
      return;
    }
    try {
      final r = await _http
          .put(Uri.parse('${widget.baseUrl()}/api/trading/chart/drawings'),
              headers: {...widget.headers(), 'Content-Type': 'application/json'},
              body: jsonEncode({'account': _account, 'symbol': _symbol, 'drawings': [for (final d in _drawings) d.toJson()]}))
          .timeout(const Duration(seconds: 20));
      final j = jsonDecode(r.body);
      final ok = r.statusCode == 200 && j is Map && j['ok'] == true;
      if (ok) {
        _drawings = [for (final d in (j['drawings'] is List ? j['drawings'] as List : const [])) ?ChartDrawing.fromJson(d)];
      }
      _setStatus(ok ? done : 'The drawing was not saved: ${j is Map ? j['error'] ?? j['detail'] : r.statusCode}.', ok: ok);
    } catch (e) {
      _setStatus('The drawing was not saved: $e', ok: false);
    }
  }

  Future<void> _clearDrawings() async {
    if (_drawings.isEmpty) return;
    // Removing the owner's drawings is a delete: ask first.
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove every drawing?'),
        content: Text('This removes ${_drawings.length} drawing${_drawings.length == 1 ? '' : 's'} from $_symbol on $accountLabel.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep them')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Yes, remove them')),
        ],
      ),
    );
    if (yes != true) return;
    setState(() => _drawings = []);
    await _saveDrawings('Removed the drawings.');
  }

  void _setStatus(String text, {bool ok = true}) {
    if (!mounted) return;
    setState(() => _status = text);
    widget.onSpeak?.call(text);
    unawaited(HapticFeedback.mediumImpact());
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text, style: const TextStyle(fontSize: 16)), backgroundColor: ok ? const Color(0xFF14332A) : const Color(0xFF3A1720)));
  }

  // ─── Taps on the chart ────────────────────────────────────────────────

  _Geometry? _geometry(Size size) => _window.isEmpty ? null : _Geometry(_window, size);

  Future<void> _onTap(Offset at, Size size) async {
    final g = _geometry(size);
    if (g == null) return;
    final price = g.priceAt(at.dy);
    final time = g.timeAt(at.dx);
    if (_tool != _Tool.none) return _drawAt(time, price);
    // A marker (or a cluster of them) near the tap opens its trade record.
    CheMarkerCluster? best;
    var bestD = 22.0;
    for (final c in _ChartPainter.clustersFor(g, _shownMarkers)) {
      final d = (c.at - at).distance;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best != null) return best.members.length == 1 ? openRecord(best.members.single) : _showCluster(best);
    await openTicket(price: double.parse(price.toStringAsFixed(2)));
  }

  Future<void> _drawAt(DateTime time, double price) async {
    final p = double.parse(price.toStringAsFixed(2));
    final id = '${_tool.name}-${DateTime.now().millisecondsSinceEpoch}';
    switch (_tool) {
      case _Tool.hline:
        setState(() => _tool = _Tool.none);
        await _addDrawing(ChartDrawing(id: id, kind: 'hline', points: [(null, p)]));
      case _Tool.text:
        final text = await _askNote();
        setState(() => _tool = _Tool.none);
        if (text == null || text.trim().isEmpty) return;
        await _addDrawing(ChartDrawing(id: id, kind: 'text', points: [(time, p)], text: text.trim()));
      case _Tool.line || _Tool.box:
        if (_first == null) {
          setState(() {
            _first = (time, p);
            _status = 'First point at ${_fmt(p)}. Tap the second point.';
          });
          return;
        }
        final kind = _tool == _Tool.line ? 'line' : 'box';
        final first = _first!;
        setState(() {
          _first = null;
          _tool = _Tool.none;
        });
        await _addDrawing(ChartDrawing(id: id, kind: kind, points: [first, (time, p)]));
      case _Tool.none:
        break;
    }
  }

  Future<String?> _askNote() {
    final c = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Note on the chart'),
        content: TextField(controller: c, autofocus: true, maxLength: 140, decoration: const InputDecoration(labelText: 'Note text')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Save note')),
        ],
      ),
    );
  }

  String _markerText(ChartMarker m) {
    final r = m.raw;
    final parts = <String>[
      cheMarkerTitle(m),
      if (m.tradeId.isNotEmpty) 'Record: ${m.tradeId}',
      if (m.side.isNotEmpty) 'Side: ${m.side}',
      if (r['qty'] != null) 'Quantity: ${r['qty']}',
      if (m.price != null) 'Price: ${_fmt(m.price!)}',
      if (m.time != null) 'Time: ${_clock(m.time!)}',
      if (m.status.isNotEmpty) 'Status: ${m.status}',
      if (m.strategy.isNotEmpty) 'Strategy: ${m.strategy}${r['variant'] != null ? ' (${r['variant']})' : ''}',
      if (r['stop'] != null) 'Stop: ${r['stop']}',
      if (r['target'] != null) 'Target: ${r['target']}',
      if (r['reason'] != null) 'Exit reason: ${r['reason']}',
      if (r['net_pnl'] != null) 'Net P&L: \$${r['net_pnl']}',
      if (r['r'] != null) 'R: ${r['r']}',
      if (r['order_id'] != null) 'Alpaca order id: ${r['order_id']}',
      if (r['account'] != null) 'Account: ${r['account']}',
      if (r['timeframe'] != null) 'Timeframe: ${r['timeframe']}',
      if (r['data_source'] != null) 'Data: ${r['data_source']}',
      if (r['evidence'] != null) 'Evidence: ${r['evidence']}',
    ];
    return parts.join('\n');
  }

  /// Where [m] is drawn inside a chart area of [size], or null when it is off screen (tests tap it there).
  @visibleForTesting
  Offset? markerOffset(ChartMarker m, Size size) => _geometry(size)?.markerPoint(m);

  /// The markers currently drawn (REPLAY picks the latest closed CHE trade from them).
  List<ChartMarker> get shownMarkers => _shownMarkers;

  /// Opens a marker's trade record: Trade Replay when installed, otherwise the recorded receipt.
  Future<void> openRecord(ChartMarker m) async {
    if (m.source.startsWith('che_') && m.tradeId.isNotEmpty) {
      final open = CheTradingChart.openTradeRecord;
      if (open != null) {
        open(context, m);
        return;
      }
      // The marker is the summary, so the record shows at once while its bars load.
      await Navigator.of(context).push(CheTradeReplayPage.route(
          tradeId: m.tradeId, baseUrl: widget.baseUrl, headers: widget.headers, onRead: widget.onSpeak, summary: cheMarkerSummary(m)));
      return;
    }
    // Alpaca orders and fills are broker records, not CHE trades: their receipt.
    await _showMarker(m);
  }

  Future<void> _showCluster(CheMarkerCluster c) => showModalBottomSheet<void>(
        context: context,
        backgroundColor: _panel,
        builder: (ctx) => SafeArea(
          child: ListView(shrinkWrap: true, padding: const EdgeInsets.all(12), children: [
            Text('${c.members.length} markers here', style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800)),
            for (final m in c.members)
              ListTile(
                minTileHeight: 52,
                title: Text(cheMarkerTitle(m), style: const TextStyle(color: Colors.white, fontSize: 16)),
                subtitle: Text([if (m.time != null) _clock(m.time!), if (m.price != null) _fmt(m.price!)].join(' · '), style: TextStyle(color: _dim)),
                onTap: () {
                  Navigator.pop(ctx);
                  unawaited(openRecord(m));
                },
              ),
          ]),
        ),
      );

  Future<void> _showMarker(ChartMarker m) => showModalBottomSheet<void>(
        context: context,
        backgroundColor: _panel,
        builder: (ctx) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Receipt', style: TextStyle(color: kMarkerColors[m.source] ?? Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 8),
              Text(_markerText(m), style: const TextStyle(color: Colors.white, fontSize: 17, height: 1.4)),
              const SizedBox(height: 12),
              Row(children: [
                if (widget.onSpeak != null)
                  TextButton.icon(onPressed: () => widget.onSpeak!(_markerText(m).replaceAll('\n', '. ')), icon: const Icon(Icons.volume_up_rounded), label: const Text('Read receipt')),
                const Spacer(),
                if (m.source == 'alpaca_order' && !['filled', 'canceled', 'cancelled', 'expired', 'rejected'].contains(m.status))
                  FilledButton(
                    onPressed: () {
                      Navigator.pop(ctx);
                      unawaited(cancelOrder('${m.raw['order_id'] ?? m.raw['id']}', what: '${m.side.toUpperCase()} ${m.raw['qty'] ?? ''} ${m.raw['symbol'] ?? ''}'));
                    },
                    child: const Text('Cancel this order'),
                  ),
              ]),
            ]),
          ),
        ),
      );

  // ─── Orders ───────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final r = await _http
        .post(Uri.parse('${widget.baseUrl()}$path'), headers: {...widget.headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body))
        .timeout(const Duration(seconds: 25));
    final j = jsonDecode(r.body);
    if (j is! Map<String, dynamic>) throw const FormatException('The answer was not readable.');
    return {...j, '_status': r.statusCode};
  }

  /// The PAPER ticket for a price on the chart. Nothing is sent until the owner presses "Yes".
  Future<void> openTicket({double? price, String side = 'buy', int qty = 1}) async {
    if (_account != 'alpaca_paper') {
      _setStatus(_blocked.isNotEmpty ? _blocked : 'No futures paper broker is connected, so CHE takes no manual futures orders. Nothing was sent.', ok: false);
      return;
    }
    if (_symbol.isEmpty) {
      _setStatus('Choose a stock symbol first. Nothing was sent.', ok: false);
      return;
    }
    if (!_entriesAllowed) {
      _setStatus('New entries are blocked: ${_blocked.isEmpty ? 'the feed is unavailable' : _blocked} Nothing was sent.', ok: false);
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: _panel,
      builder: (ctx) => _OrderTicket(
        symbol: _symbol,
        price: price ?? (_bars.isEmpty ? null : _bars.last.c),
        side: side,
        qty: qty,
        marketAllowed: _marketAllowed,
        blockedReason: _blocked,
        preview: (order) => _post('/api/trading/alpaca/order/preview', order),
        place: (order) => _post('/api/trading/alpaca/order', order),
        onDone: (text, ok) {
          _setStatus(text, ok: ok);
          unawaited(load(quiet: true));
        },
      ),
    );
  }

  /// Cancelling removes an order, so the owner is asked first; only "Yes, cancel it" sends it.
  Future<void> cancelOrder(String id, {String what = 'this paper order'}) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel this order?'),
        content: Text('Cancel $what on Alpaca PAPER?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Yes, cancel it')),
        ],
      ),
    );
    if (yes != true) {
      _setStatus('Kept the order; nothing was cancelled.');
      return;
    }
    try {
      final j = await _post('/api/trading/alpaca/order/cancel', {'id': id, 'confirm': true});
      final receipt = j['receipt'] is Map ? j['receipt'] as Map : const {};
      final ok = j['ok'] == true;
      _setStatus(ok
          ? 'Alpaca reports the order ${receipt['status'] ?? 'cancel requested'}.'
          : 'Not cancelled: ${j['detail'] ?? 'Alpaca refused'}.', ok: ok);
    } catch (e) {
      _setStatus('Not cancelled: $e', ok: false);
    }
    unawaited(load(quiet: true));
  }

  // ─── Summary for "Read chart" and VoiceOver ───────────────────────────

  String get summary {
    if (_state == 'loading' && _bars.isEmpty) return '$accountLabel chart is loading.';
    if (_bars.isEmpty) return '$accountLabel ${_symbol.isEmpty ? '' : '$_symbol '}chart has no bars. ${_error ?? _blocked}'.trim();
    final last = _bars.last;
    final counts = <String, int>{};
    for (final m in _shownMarkers) {
      counts[m.source] = (counts[m.source] ?? 0) + 1;
    }
    final marks = counts.isEmpty ? 'No markers.' : 'Markers: ${counts.entries.map((e) => '${e.value} ${kMarkerSources[e.key] ?? e.key}').join(', ')}.';
    final feed = _account == 'futures_paper'
        ? '$sourceLabel. $rithmicLine.'
        : '${_feed['provider'] ?? 'Feed'} is ${_feed['status'] ?? 'unknown'}${_feed['age_s'] is num ? ', last bar ${_age(_feed['age_s'] as num)} old' : ''}${_fallback ? ', Kraken fallback because Coinbase did not answer' : ''}${_builtFrom.isNotEmpty ? ', built from $_builtFrom bars' : ''}.';
    final market = _ticker['market'] != null ? ' ${_ticker['market']}.' : '';
    final ind = indicatorSummary(_indicatorBars, _indicators, futures: _futures, fmt: _fmt);
    return '$accountLabel, $symbolLabel, $_tf candles.$market Last close ${_fmt(last.c)} at ${_clock(last.t)}. $marks $feed ${ind.isEmpty ? '' : '$ind '}'
        '${_drawings.isEmpty ? '' : '${_drawings.length} drawing${_drawings.length == 1 ? '' : 's'}: ${_drawings.map((d) => d.spoken).join('; ')}. '}'
        '${_levels.spoken.isEmpty ? '' : '${_levels.spoken} '}'
        '${_entriesAllowed ? (_marketAllowed ? 'Paper entries allowed.' : 'Limit orders only: $_blocked') : 'New entries blocked: $_blocked'}';
  }

  String _age(num s) => s < 120 ? '${s.round()} seconds' : s < 7200 ? '${(s / 60).round()} minutes' : s < 172800 ? '${(s / 3600).round()} hours' : '${(s / 86400).round()} days';

  // ─── UI ───────────────────────────────────────────────────────────────

  Widget _chip(String label, bool selected, VoidCallback onTap, {String? semantics}) => Semantics(
        button: true,
        selected: selected,
        label: semantics ?? label,
        excludeSemantics: true,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(18),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: selected ? cheTradingSelect.withValues(alpha: 0.22) : Colors.transparent,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: selected ? cheTradingSelect : (cheHudActive ? CheHud.ice.withValues(alpha: 0.28) : _stroke)),
            ),
            child: Text(label, style: TextStyle(color: selected ? cheTradingSelect : Colors.white, fontWeight: FontWeight.w700, fontSize: 14)),
          ),
        ),
      );

  Widget _iconButton(IconData icon, String label, VoidCallback? onTap) => IconButton(
        tooltip: label,
        onPressed: onTap,
        icon: Icon(icon, color: onTap == null ? _dim : Colors.white),
      );

  void _setAccount(String a) {
    if (a == _account || visibleChartAccount(a) != a) return;
    setState(() {
      _account = a;
      _symbol = a == 'futures_paper' ? 'MNQ' : a == 'market' ? _prefs.last : (_symbolField.text.trim().toUpperCase());
      _bars = const [];
      _markers = const [];
      _endOffset = 0;
    });
    unawaited(load());
  }

  void _setSymbol(String s) {
    final sym = s.trim().toUpperCase();
    if (!RegExp(r'^[A-Z]{1,5}(\.[A-Z])?$').hasMatch(sym)) {
      _setStatus('Type a stock symbol such as AAPL.', ok: false);
      return;
    }
    setState(() {
      _symbol = sym;
      _symbolField.text = sym;
      _bars = const [];
      _endOffset = 0;
    });
    unawaited(load());
  }

  /// The feed's provider, status, last bar and age on one line.
  String get feedLine => [
        '${_feed['provider'] ?? 'Feed'}${_fallback ? ' (fallback)' : ''}: ${_feed['status'] ?? (_state == 'loading' ? 'checking' : 'UNAVAILABLE')}${_feed['stale'] == true ? ' · STALE' : ''}',
        if (_builtFrom.isNotEmpty) 'built from $_builtFrom',
        if (_feed['last_bar_time'] != null && _time(_feed['last_bar_time']) != null) 'last bar ${_clock(_time(_feed['last_bar_time'])!)}',
        if (_feed['age_s'] is num) '${_age(_feed['age_s'] as num)} old',
      ].join(' · ');

  /// Wins, Losses, Open, Paper, Simulation: one row of filter chips (the strategy filter comes from voice or a card).
  Widget _filterChips() => SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, children: [
          // The strategy filter first, so it is never scrolled out of sight.
          if (_strategy != null)
            Center(
              child: TextButton(
                onPressed: () => setState(() => _strategy = null),
                child: Text('${_strategy!.toUpperCase()} only · show all', semanticsLabel: 'Showing ${_strategy!} trades only. Show all strategies'),
              ),
            ),
          for (final (label, on, next, say) in [
            ('Wins', _filter.wins, _filter.copyWith(wins: !_filter.wins), 'winning trades'),
            ('Losses', _filter.losses, _filter.copyWith(losses: !_filter.losses), 'losing trades'),
            ('Open', _filter.open, _filter.copyWith(open: !_filter.open), 'open positions'),
            ('Paper', _filter.paper, _filter.copyWith(paper: !_filter.paper), 'paper and broker markers'),
            ('Simulation', _filter.sim, _filter.copyWith(sim: !_filter.sim), 'simulation markers'),
          ])
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Center(
                child: Semantics(
                  button: true,
                  toggled: on,
                  label: '$label filter, ${on ? 'showing' : 'hiding'} $say',
                  excludeSemantics: true,
                  child: InkWell(
                    key: Key('marker_filter_${label.toLowerCase()}'),
                    borderRadius: BorderRadius.circular(18),
                    onTap: () => setState(() => _filter = next),
                    child: Container(
                      constraints: const BoxConstraints(minHeight: 40),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: on ? cheTradingSelect.withValues(alpha: 0.18) : Colors.transparent,
                        borderRadius: BorderRadius.circular(18),
                        border: Border.all(color: on ? cheTradingSelect : _stroke),
                      ),
                      child: Text(label, style: TextStyle(color: on ? Colors.white : _dim, fontWeight: FontWeight.w700, fontSize: 13)),
                    ),
                  ),
                ),
              ),
            ),
        ]),
      );

  /// The compact preview: every row has a fixed height, so a live tick changes pixels inside the chart and nothing else.
  Widget _buildCompact() {
    final stale = _feed['stale'] == true;
    final feedColor = (_feed['status'] == 'REALTIME' || _feed['status'] == 'LIVE') && !stale ? _up : (_feed['status'] == 'UNAVAILABLE' || _feed['status'] == 'DISCONNECTED') ? _down : _gold;
    final live = _rithmicHeader ? rithmicLine : feedLine;
    final liveColor = _rithmicHeader
        ? switch (_live.status) {
            RithmicLiveStatus.connected => _up,
            RithmicLiveStatus.disconnected || RithmicLiveStatus.loginFailed => _down,
            _ => _gold,
          }
        : feedColor;
    final tfs = _timeframes.where((t) => t == '1m' || t == '5m').toList();
    return CheTradingPanel(
      key: const Key('chart_compact'),
      color: _panel,
      borderColor: _stroke,
      radius: 16,
      padding: const EdgeInsets.fromLTRB(10, 4, 4, 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // Header and feed line: their size depends only on the text scale, never on prices, so ticks cannot move them.
        ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Row(children: [
            Expanded(
              child: Wrap(spacing: 8, runSpacing: 2, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Semantics(
                  header: true,
                  child: CheChromeText(_symbol.isEmpty ? accountLabel : symbolLabel, maxLines: 1, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(border: Border.all(color: _gold), borderRadius: BorderRadius.circular(6)),
                  child: Text('PAPER', semanticsLabel: 'Paper mode. Live trading is off.', style: CheHud.label.copyWith(color: _gold, fontSize: 11)),
                ),
              ]),
            ),
            for (final t in tfs)
              Padding(
                padding: const EdgeInsets.only(left: 4),
                child: _chip(t, _tf == t, () {
                  if (_tf == t) return;
                  setState(() => _tf = t);
                  if (_account == 'market') unawaited(_prefs.setTimeframe(t));
                  unawaited(load());
                }, semantics: 'Timeframe $t'),
              ),
            if (widget.onExpand != null) _iconButton(Icons.open_in_full_rounded, 'Expand the chart', widget.onExpand),
          ]),
        ),
        SizedBox(
          height: MediaQuery.textScalerOf(context).scale(11) * 1.45,
          child: Semantics(
            liveRegion: false,
            child: Text(live, key: const ValueKey('chart-feed-line'), maxLines: 1, overflow: TextOverflow.ellipsis,
                style: CheHud.label.copyWith(color: liveColor, fontSize: 11, fontFeatures: const [FontFeature.tabularFigures()])),
          ),
        ),
        const SizedBox(height: 6),
        SizedBox(key: const Key('chart_area'), height: widget.height, child: _chartArea()),
        _filterChips(),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.compact) return _buildCompact();
    final stale = _feed['stale'] == true;
    final feedColor = (_feed['status'] == 'REALTIME' || _feed['status'] == 'LIVE') && !stale ? _up : (_feed['status'] == 'UNAVAILABLE' || _feed['status'] == 'DISCONNECTED') ? _down : _gold;
    return CheTradingPanel(
      color: _panel,
      borderColor: _stroke,
      radius: 16,
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          // The title and PAPER badge wrap on a narrow screen or with large text instead of pushing the buttons off.
          Expanded(
            child: Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text('CHART', style: cheTradingLabel(const TextStyle(color: _gold, fontWeight: FontWeight.w800, letterSpacing: 1.4, fontSize: 13))),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: _gold, borderRadius: BorderRadius.circular(6)),
                child: const Text('PAPER', style: TextStyle(color: Colors.black, fontWeight: FontWeight.w900, fontSize: 12)),
              ),
            ]),
          ),
          if (widget.onSpeak != null) _iconButton(Icons.volume_up_rounded, 'Read chart aloud', () => widget.onSpeak!(summary)),
          _iconButton(Icons.refresh_rounded, 'Refresh chart', () => unawaited(load())),
        ]),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final e in kChartAccounts.entries) if (kShowAlpacaPaper || e.key != 'alpaca_paper') _chip(e.value, _account == e.key, () => _setAccount(e.key), semantics: 'Show the ${e.value} chart'),
        ]),
        if (_account == 'alpaca_paper') ...[
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _symbolField,
                textCapitalization: TextCapitalization.characters,
                style: const TextStyle(color: Colors.white, fontSize: 16),
                decoration: const InputDecoration(isDense: true, labelText: 'Symbol search', hintText: 'AAPL', prefixIcon: Icon(Icons.search_rounded)),
                onSubmitted: _setSymbol,
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(onPressed: () => _setSymbol(_symbolField.text), child: const Text('Show')),
          ]),
          const SizedBox(height: 6),
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final s in kQuickSymbols) _chip(s, _symbol == s, () => _setSymbol(s), semantics: 'Chart $s'),
          ]),
        ],
        if (_account == 'market') ...[
          const SizedBox(height: 8),
          CheTickerSelector(selected: _symbol, onSelect: showTicker, baseUrl: widget.baseUrl, headers: widget.headers, client: widget.client),
          if (_ticker['market'] != null)
            Text('${_ticker['market']}', key: const ValueKey('chart-market'), maxLines: 2, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700)),
        ],
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final t in _timeframes)
            _chip(t, _tf == t, () {
              setState(() => _tf = t);
              if (_account == 'market') unawaited(_prefs.setTimeframe(t));
              unawaited(load());
            }, semantics: 'Timeframe $t'),
        ]),
        const SizedBox(height: 8),
        // MNQ PAPER: the active source, the Rithmic connection and its last update. Visible, never spoken unless asked.
        if (_rithmicHeader) ...[
          Text(sourceLabel, key: const ValueKey('chart-source'), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(
            rithmicLine,
            key: const ValueKey('chart-rithmic'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: switch (_live.status) {
                RithmicLiveStatus.connected => _up,
                RithmicLiveStatus.disconnected || RithmicLiveStatus.loginFailed => _down,
                _ => _gold,
              },
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 2),
        ],
        // Feed health: always visible, never spoken unless asked.
        Semantics(
          liveRegion: false,
          child: Text(feedLine, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: feedColor, fontSize: 13, fontWeight: FontWeight.w700)),
        ),
        if (_blocked.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(_entriesAllowed ? 'Limit orders only: $_blocked' : 'New entries blocked: $_blocked', style: const TextStyle(color: _gold, fontSize: 13)),
          ),
        const SizedBox(height: 8),
        // The owner's chart size and portrait preference (Owner Improvements), applied live with no new build.
        ListenableBuilder(
          listenable: CheUiPreferences.instance,
          builder: (context, child) => SizedBox(
            key: const Key('chart_area'),
            height: CheUiPreferences.instance.chartHeightFor(widget.height, screen: MediaQuery.maybeSizeOf(context)),
            child: child,
          ),
          child: _chartArea(),
        ),
        if (_indicators.contains('rsi') && _bars.isNotEmpty) SizedBox(key: const Key('chart_rsi'), height: 56, child: _rsiStrip()),
        if (crosshairLine.isNotEmpty)
          Semantics(liveRegion: false, child: Text(crosshairLine, key: const ValueKey('chart-crosshair'), style: const TextStyle(color: _draw, fontSize: 13, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()]))),
        _filterChips(),
        _indicatorChips(),
        const SizedBox(height: 6),
        Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
          _iconButton(Icons.zoom_in_rounded, 'Zoom in', _bars.isEmpty ? null : () => zoom(1.5)),
          _iconButton(Icons.zoom_out_rounded, 'Zoom out', _bars.isEmpty ? null : () => zoom(1 / 1.5)),
          _iconButton(Icons.chevron_left_rounded, 'Scroll to earlier bars', _bars.isEmpty ? null : () => scroll(math.max(5, _count ~/ 3))),
          _iconButton(Icons.chevron_right_rounded, 'Scroll to later bars', _endOffset == 0 ? null : () => scroll(-math.max(5, _count ~/ 3))),
          _iconButton(Icons.last_page_rounded, 'Jump to the latest bar', _endOffset == 0 ? null : () => setState(() => _endOffset = 0)),
          if (_account == 'alpaca_paper')
            FilledButton.icon(
              onPressed: () => unawaited(openTicket()),
              icon: const Icon(Icons.receipt_long_rounded, size: 18),
              label: const Text('Order ticket'),
            ),
        ]),
        // Drawing tools
        Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('Draw:', style: TextStyle(color: _dim, fontSize: 13)),
          _chip('Line', _tool == _Tool.line, () => _pickTool(_Tool.line), semantics: 'Draw a line: tap two points on the chart'),
          _chip('Level', _tool == _Tool.hline, () => _pickTool(_Tool.hline), semantics: 'Draw a horizontal level: tap a price'),
          _chip('Box', _tool == _Tool.box, () => _pickTool(_Tool.box), semantics: 'Draw a box: tap two corners'),
          _chip('Note', _tool == _Tool.text, () => _pickTool(_Tool.text), semantics: 'Add a text note: tap where it goes'),
          if (_drawings.isNotEmpty) _chip('Clear', false, () => unawaited(_clearDrawings()), semantics: 'Remove every drawing on this chart'),
        ]),
        const SizedBox(height: 8),
        // Legend: one toggle per source, with how many markers it has.
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final e in kMarkerSources.entries)
            if (kShowAlpacaPaper || !e.key.startsWith('alpaca_')) _legend(e.key, e.value, _allMarkers.where((m) => m.source == e.key).length),
        ]),
        if (_openOrders.isNotEmpty) ...[
          const SizedBox(height: 10),
          const Text('OPEN PAPER ORDERS', style: TextStyle(color: _gold, fontWeight: FontWeight.w800, letterSpacing: 1.2, fontSize: 12)),
          for (final o in _openOrders)
            Row(children: [
              Expanded(
                child: Text(
                  '${'${o['side'] ?? ''}'.toUpperCase()} ${o['qty'] ?? ''} ${o['symbol'] ?? ''} · ${o['type'] ?? ''}${o['limit_price'] != null ? ' @ ${o['limit_price']}' : ''} · ${o['status'] ?? ''}',
                  style: const TextStyle(color: Colors.white, fontSize: 14),
                ),
              ),
              TextButton(onPressed: () => unawaited(cancelOrder('${o['id']}', what: '${'${o['side'] ?? ''}'.toUpperCase()} ${o['qty'] ?? ''} ${o['symbol'] ?? ''}')), child: Text('Cancel', semanticsLabel: 'Cancel the ${o['side']} ${o['qty']} ${o['symbol']} order')),
            ]),
        ],
        if (_status.isNotEmpty)
          Padding(padding: const EdgeInsets.only(top: 8), child: Text(_status, style: const TextStyle(color: Colors.white70, fontSize: 14))),
      ]),
    );
  }

  // ─── Indicators and the crosshair ───────────────────────────────────

  List<CheIndicatorBar> get _indicatorBars => [for (final b in _bars) CheIndicatorBar(b.t, b.o, b.h, b.l, b.c, b.v)];

  /// The switched-on line indicators over the visible window, computed on every loaded bar so an EMA is warm.
  Map<String, List<double?>> get _overlays {
    if (_indicators.isEmpty || _bars.isEmpty) return const {};
    return {for (final e in overlaySeries(_indicatorBars, _indicators, futures: _futures).entries) e.key: e.value.sublist(_start, _end)};
  }

  /// Session high/low and the opening range as dashed levels, beside CHE's overnight levels.
  List<ChartLevel> get _indicatorLevels {
    final bars = _indicatorBars;
    return [
      if (_indicators.contains('session'))
        if (sessionHighLow(bars, futures: _futures) case final s?) ...[ChartLevel('session_high', s.high, 'Session high ${_fmt(s.high)}'), ChartLevel('session_low', s.low, 'Session low ${_fmt(s.low)}')],
      if (_indicators.contains('orb'))
        if (openingRange(bars, futures: _futures) case final r?) ...[ChartLevel('orb_high', r.high, 'Opening range high ${_fmt(r.high)}'), ChartLevel('orb_low', r.low, 'Opening range low ${_fmt(r.low)}')],
    ];
  }

  void toggleIndicator(String id) {
    if (!kChartIndicators.containsKey(id)) return;
    setState(() => _indicators.contains(id) ? _indicators.remove(id) : _indicators.add(id));
    unawaited(_prefs.setIndicators(_indicators));
    CheLiveChart.indicators.value = {..._indicators};
  }

  /// A spoken or typed "turn on VWAP" (CheChartCommand → CheLiveChart.indicators) or a tap on another chart.
  void _onVoiceIndicators() {
    final next = CheLiveChart.indicators.value.where(kChartIndicators.containsKey).toSet();
    if (!mounted || setEquals(next, _indicators)) return;
    setState(() => _indicators = next);
    unawaited(_prefs.setIndicators(_indicators));
  }

  Set<String> get indicators => {..._indicators};

  Widget _indicatorChips() => SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, children: [
          for (final e in kChartIndicators.entries)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Center(
                child: Semantics(
                  button: true,
                  toggled: _indicators.contains(e.key),
                  label: '${e.value} indicator, ${_indicators.contains(e.key) ? 'on' : 'off'}',
                  excludeSemantics: true,
                  child: InkWell(
                    key: Key('indicator_${e.key}'),
                    borderRadius: BorderRadius.circular(18),
                    onTap: () => toggleIndicator(e.key),
                    child: Container(
                      constraints: const BoxConstraints(minHeight: 40),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: _indicators.contains(e.key) ? (kIndicatorColors[e.value] ?? _draw).withValues(alpha: 0.18) : Colors.transparent,
                        borderRadius: BorderRadius.circular(18),
                        border: Border.all(color: _indicators.contains(e.key) ? (kIndicatorColors[e.value] ?? _draw) : _stroke),
                      ),
                      child: Text(e.value, style: TextStyle(color: _indicators.contains(e.key) ? Colors.white : _dim, fontWeight: FontWeight.w700, fontSize: 13)),
                    ),
                  ),
                ),
              ),
            ),
        ]),
      );

  Widget _rsiStrip() {
    final values = rsi([for (final b in _bars) b.c]).sublist(_start, _end);
    final last = values.lastWhere((v) => v != null, orElse: () => null);
    return Semantics(
      label: last == null ? 'RSI 14 needs more bars' : 'RSI 14 is ${last.toStringAsFixed(1)}',
      excludeSemantics: true,
      child: RepaintBoundary(child: CustomPaint(painter: _RsiPainter(values), size: Size.infinite)),
    );
  }

  /// The crosshair's bar: time, open, high, low, close, read out under the chart and to VoiceOver.
  String get crosshairLine {
    final i = _cross;
    final w = _window;
    if (i == null || i < 0 || i >= w.length) return '';
    final b = w[i];
    return '${_clock(b.t)} · O ${_fmt(b.o)} H ${_fmt(b.h)} L ${_fmt(b.l)} C ${_fmt(b.c)}';
  }

  void _pickTool(_Tool t) => setState(() {
        _tool = _tool == t ? _Tool.none : t;
        _first = null;
        _status = _tool == _Tool.none ? '' : 'Tap the chart to place it.';
      });

  Widget _legend(String source, String label, int n) {
    final on = !_hidden.contains(source);
    final color = kMarkerColors[source]!;
    return Semantics(
      button: true,
      toggled: on,
      label: '$label markers, $n, ${on ? 'shown' : 'hidden'}',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => setState(() => on ? _hidden.add(source) : _hidden.remove(source)),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), border: Border.all(color: on ? color : _stroke)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            CustomPaint(size: const Size(12, 12), painter: _MarkerGlyph(source, color, on)),
            const SizedBox(width: 6),
            // Wraps instead of overflowing on a 320-point screen or with large text.
            Flexible(child: Text('$label $n', style: TextStyle(color: on ? Colors.white : _dim, fontSize: 13))),
          ]),
        ),
      ),
    );
  }

  void _crossAt(Offset at, Size size) {
    final g = _geometry(size);
    if (g == null) return;
    final i = (at.dx / g.barW).floor().clamp(0, _window.length - 1);
    if (i != _cross) {
      HapticFeedback.selectionClick();
      setState(() => _cross = i);
    }
  }

  Widget _chartArea() {
    if (_bars.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            _state == 'loading'
                ? 'Loading the $accountLabel chart…'
                : _state == 'not_configured'
                    ? 'Alpaca PAPER is not connected. Add the paper keys in Account.'
                    : (_error ?? (_blocked.isNotEmpty ? _blocked : 'No bars to show yet.')),
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white70, fontSize: 15),
          ),
        ),
      );
    }
    return LayoutBuilder(builder: (context, box) {
      final size = Size(box.maxWidth, box.maxHeight);
      return Semantics(
        label: summary,
        hint: 'Pinch to zoom, drag to scroll, tap a price for an order ticket, tap a marker for its receipt.',
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapUp: (d) {
            if (_cross != null) {
              setState(() => _cross = null);
              return;
            }
            unawaited(_onTap(d.localPosition, size));
          },
          // Long press shows the crosshair on the bar under the finger; a tap clears it.
          onLongPressStart: (d) => _crossAt(d.localPosition, size),
          onLongPressMoveUpdate: (d) => _crossAt(d.localPosition, size),
          onScaleStart: (_) {
            _scaleStartVisible = _visible;
            _dragCarry = 0;
          },
          onScaleUpdate: (d) {
            if (d.pointerCount > 1) {
              setState(() => _visible = (_scaleStartVisible / d.horizontalScale).round().clamp(15, math.max(15, _bars.length)));
              return;
            }
            final perBar = size.width / math.max(1, _count);
            _dragCarry += d.focalPointDelta.dx;
            final moved = (_dragCarry / perBar).truncate();
            if (moved != 0) {
              _dragCarry -= moved * perBar;
              scroll(moved);
            }
          },
          // The chart repaints on its own layer: a tick never repaints the page around it.
          child: RepaintBoundary(
           child: CustomPaint(
            size: size,
            painter: _ChartPainter(
              bars: _window,
              markers: _shownMarkers,
              drawings: _drawings,
              levels: [..._levels.levels, ..._indicatorLevels],
              pending: _first,
              overlays: _overlays,
              cross: _cross,
            ),
           ),
          ),
        ),
      );
    });
  }
}

/// Maps bars to pixels: x by bar index, y by the visible price range.
class _Geometry {
  _Geometry(this.bars, this.size) {
    var lo = double.infinity, hi = -double.infinity;
    for (final b in bars) {
      lo = math.min(lo, b.l);
      hi = math.max(hi, b.h);
    }
    final pad = math.max((hi - lo) * 0.08, hi.abs() * 0.0005);
    min = lo - pad;
    max = hi + pad;
  }
  final List<ChartBar> bars;
  final Size size;
  static const axis = 58.0;
  late final double min, max;
  double get plotW => size.width - axis;
  double get barW => plotW / bars.length;
  double y(double price) => (max - price) / (max - min) * size.height;
  double priceAt(double dy) => max - dy / size.height * (max - min);
  double x(int i) => (i + 0.5) * barW;
  DateTime timeAt(double dx) => bars[(dx / barW).floor().clamp(0, bars.length - 1)].t;

  /// The bar a time falls in (the last bar that started at or before it); null when outside.
  double? xOfTime(DateTime? t) {
    if (t == null || bars.isEmpty || t.isBefore(bars.first.t)) return null;
    var lo = 0, hi = bars.length - 1;
    while (lo < hi) {
      final mid = (lo + hi + 1) >> 1;
      if (!bars[mid].t.isAfter(t)) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    if (lo == bars.length - 1 && bars.length > 1) {
      final step = bars.last.t.difference(bars[bars.length - 2].t);
      if (t.isAfter(bars.last.t.add(step * 2))) return null;
    }
    return x(lo);
  }

  Offset? markerPoint(ChartMarker m) {
    final px = xOfTime(m.time);
    if (px == null || m.price == null) return null;
    return Offset(px, y(m.price!));
  }
}

/// True when a marker's point lies inside the chart box, so its glyph can be drawn there.
bool markerOnChart(Offset p, Size size) => p.dx >= 0 && p.dx <= size.width && p.dy >= 0 && p.dy <= size.height;

class _ChartPainter extends CustomPainter {
  _ChartPainter({required this.bars, required this.markers, required this.drawings, this.levels = const [], required this.pending, this.overlays = const {}, this.cross});
  final Map<String, List<double?>> overlays;
  final int? cross;
  final List<ChartBar> bars;
  final List<ChartMarker> markers;
  final List<ChartDrawing> drawings;
  final List<ChartLevel> levels;
  final (DateTime?, double)? pending;

  @override
  void paint(Canvas canvas, Size size) {
    if (bars.isEmpty) return;
    final g = _Geometry(bars, size);
    final grid = Paint()..color = _stroke;
    final label = TextStyle(color: _dim, fontSize: 11, fontFeatures: const [FontFeature.tabularFigures()]);
    for (var i = 0; i <= 4; i++) {
      final p = g.min + (g.max - g.min) * i / 4;
      final y = g.y(p);
      canvas.drawLine(Offset(0, y), Offset(g.plotW, y), grid);
      _text(canvas, _fmt(p), Offset(g.plotW + 4, y - 7), label);
    }
    final w = math.max(1.0, g.barW * 0.7);
    // With Rithmic candles on screen, the delayed history candles are drawn dimmer so the two never look alike.
    final mixed = bars.any((b) => b.source == kBarRithmic);
    for (var i = 0; i < bars.length; i++) {
      final b = bars[i];
      final base = b.c >= b.o ? _up : _down;
      final color = mixed && b.source != kBarRithmic ? base.withValues(alpha: 0.4) : base;
      final x = g.x(i);
      canvas.drawLine(Offset(x, g.y(b.h)), Offset(x, g.y(b.l)), Paint()..color = color..strokeWidth = 1);
      final top = g.y(math.max(b.o, b.c)), bottom = g.y(math.min(b.o, b.c));
      canvas.drawRect(Rect.fromLTRB(x - w / 2, top, x + w / 2, math.max(bottom, top + 1)), Paint()..color = color);
    }
    // Last price line.
    final last = bars.last.c;
    final ly = g.y(last);
    canvas.drawLine(Offset(0, ly), Offset(g.plotW, ly), Paint()..color = Colors.white24..strokeWidth = 1);
    canvas.drawRect(Rect.fromLTWH(g.plotW, ly - 9, _Geometry.axis, 18), Paint()..color = Colors.white);
    _text(canvas, _fmt(last), Offset(g.plotW + 4, ly - 7), const TextStyle(color: Colors.black, fontSize: 11, fontWeight: FontWeight.w700));

    // Indicator lines over the candles, each in its own colour and labelled at the right edge.
    canvas.save();
    canvas.clipRect(Rect.fromLTWH(0, 0, g.plotW, size.height));
    for (final e in overlays.entries) {
      final color = kIndicatorColors[e.key] ?? Colors.white70;
      final path = Path();
      var open = false;
      for (var i = 0; i < e.value.length && i < bars.length; i++) {
        final v = e.value[i];
        if (v == null) {
          open = false;
          continue;
        }
        final pt = Offset(g.x(i), g.y(v));
        open ? path.lineTo(pt.dx, pt.dy) : path.moveTo(pt.dx, pt.dy);
        open = true;
      }
      canvas.drawPath(path, Paint()
        ..color = color
        ..strokeWidth = e.key.startsWith('BB') ? 1 : 1.6
        ..style = PaintingStyle.stroke);
    }
    canvas.restore();
    var labelY = 4.0;
    for (final e in overlays.entries) {
      if (e.key == 'BB mid' || e.value.isEmpty || e.value.last == null) continue;
      _text(canvas, e.key, Offset(4, labelY), TextStyle(color: kIndicatorColors[e.key] ?? Colors.white70, fontSize: 10, fontWeight: FontWeight.w700));
      labelY += 13;
    }

    // The owner's drawings.
    final ink = Paint()
      ..color = _draw
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    for (final d in drawings) {
      // A time outside the window is not the latest candle. Hide drawings until their points are visible.
      if (d.points.any((point) => point.$1 != null && g.xOfTime(point.$1) == null)) continue;
      final pts = [for (final (t, p) in d.points) Offset(g.xOfTime(t) ?? 0, g.y(p))];
      switch (d.kind) {
        case 'hline':
          canvas.drawLine(Offset(0, pts.first.dy), Offset(g.plotW, pts.first.dy), ink);
          _text(canvas, _fmt(d.points.first.$2), Offset(4, pts.first.dy - 16), const TextStyle(color: _draw, fontSize: 11, fontWeight: FontWeight.w700));
        case 'line':
          if (pts.length == 2) canvas.drawLine(pts[0], pts[1], ink);
        case 'box':
          if (pts.length == 2) {
            final r = Rect.fromPoints(pts[0], pts[1]);
            canvas.drawRect(r, Paint()..color = _draw.withValues(alpha: 0.12));
            canvas.drawRect(r, ink);
          }
        case 'text':
          _text(canvas, d.text ?? '', pts.first + const Offset(4, -16), const TextStyle(color: _draw, fontSize: 13, fontWeight: FontWeight.w700));
          canvas.drawCircle(pts.first, 3, Paint()..color = _draw);
      }
    }
    // CHE's 86-style overnight levels (approximation): dashed, labelled, only when inside the visible prices.
    for (final lv in levels) {
      if (lv.price < g.min || lv.price > g.max) continue;
      final color = switch (lv.kind) { 'stop' => _down, 'target' => _up, 'entry' => Colors.white, 'session_high' || 'session_low' => const Color(0xFF9AE6B4), 'orb_high' || 'orb_low' => const Color(0xFFF6AD55), _ => _level };
      final y = g.y(lv.price);
      final dash = Paint()
        ..color = color
        ..strokeWidth = 1.2;
      for (var x = 0.0; x < g.plotW; x += 10) {
        canvas.drawLine(Offset(x, y), Offset(math.min(x + 6, g.plotW), y), dash);
      }
      _text(canvas, lv.label, Offset(g.plotW - 150, y - 15), TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w700));
    }
    if (cross != null && cross! >= 0 && cross! < bars.length) {
      final b = bars[cross!];
      final cx = g.x(cross!), cy = g.y(b.c);
      final hair = Paint()
        ..color = Colors.white70
        ..strokeWidth = 1;
      canvas.drawLine(Offset(cx, 0), Offset(cx, size.height), hair);
      canvas.drawLine(Offset(0, cy), Offset(g.plotW, cy), hair);
      canvas.drawRect(Rect.fromLTWH(g.plotW, cy - 9, _Geometry.axis, 18), Paint()..color = _draw);
      _text(canvas, _fmt(b.c), Offset(g.plotW + 4, cy - 7), const TextStyle(color: Colors.black, fontSize: 11, fontWeight: FontWeight.w700));
    }
    if (pending != null) {
      final px = g.xOfTime(pending!.$1);
      if (px != null) canvas.drawCircle(Offset(px, g.y(pending!.$2)), 5, ink);
    }

    // Markers: W and L for recorded wins and losses, OPEN for open positions, a counted badge where they crowd.
    // A marker whose price is outside the visible range is not drawn: unclipped, it stacked a column of glyphs
    // down the screen over the text above and below the chart.
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    for (final c in clustersFor(g, markers)) {
      final p = c.at;
      if (!markerOnChart(p, size)) continue;
      if (c.members.length > 1) {
        _paintCount(canvas, p, c.members);
        continue;
      }
      final m = c.members.single;
      final color = kMarkerColors[m.source] ?? Colors.white;
      if (m.outcome == 'win' || m.outcome == 'loss') {
        _paintOutcome(canvas, p, m);
        continue;
      }
      if (m.outcome == 'open') {
        _paintOpen(canvas, p, m);
        continue;
      }
      if (m.source == 'alpaca_order') {
        // A working order is a dashed line at its price, with its side.
        final dash = Paint()
          ..color = color
          ..strokeWidth = 1.2;
        for (var x = p.dx; x < g.plotW; x += 8) {
          canvas.drawLine(Offset(x, p.dy), Offset(math.min(x + 4, g.plotW), p.dy), dash);
        }
      }
      canvas.save();
      canvas.translate(p.dx, p.dy);
      _MarkerGlyph.paintGlyph(canvas, m.source, color, true, buy: m.isBuy, exit: m.kind == 'exit', size: 12);
      canvas.restore();
    }
    canvas.restore();
  }

  /// The on-screen clusters for [markers]: the same grouping the painter draws and a tap hits.
  static List<CheMarkerCluster> clustersFor(_Geometry g, List<ChartMarker> markers) => cheClusterMarkers([
        for (final m in markers)
          if (g.markerPoint(m) case final p?) (m, p),
      ]);

  // The shared chrome status tones (lib/che_ui/che_chrome_status.dart): green success, red failure. The letter W or L
  // always carries the meaning too, so colour is never the only signal.
  static Color get _win => CheStatusPalette.success.base;
  static Color get _loss => CheStatusPalette.failure.base;

  void _paintOutcome(Canvas canvas, Offset p, ChartMarker m) {
    final win = m.outcome == 'win';
    final color = win ? _win : _loss;
    // Recorded paper trades are solid; simulation is an outline, so the two never look alike.
    canvas.drawCircle(p, 8, Paint()..color = m.isSim ? Colors.black.withValues(alpha: 0.6) : color);
    canvas.drawCircle(p, 8, Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6);
    _centred(canvas, win ? 'W' : 'L', p, TextStyle(color: m.isSim ? color : Colors.black, fontSize: 10, fontWeight: FontWeight.w900));
  }

  void _paintOpen(Canvas canvas, Offset p, ChartMarker m) {
    final tp = TextPainter(
      text: const TextSpan(text: 'OPEN', style: TextStyle(color: Colors.white, fontSize: 9, fontWeight: FontWeight.w900, letterSpacing: 0.8)),
      textDirection: TextDirection.ltr,
    )..layout();
    final r = RRect.fromRectAndRadius(Rect.fromCenter(center: p, width: tp.width + 10, height: tp.height + 4), const Radius.circular(4));
    canvas.drawRRect(r, Paint()..color = Colors.black.withValues(alpha: 0.75));
    canvas.drawRRect(r, Paint()
      ..color = m.isSim ? kMarkerColors['che_sim']! : const Color(0xFFD9E2EC)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2);
    tp.paint(canvas, Offset(p.dx - tp.width / 2, p.dy - tp.height / 2));
  }

  void _paintCount(Canvas canvas, Offset p, List<ChartMarker> members) {
    final wins = members.where((m) => m.outcome == 'win').length, losses = members.where((m) => m.outcome == 'loss').length;
    final ring = wins > losses ? _win : losses > wins ? _loss : const Color(0xFFD9E2EC);
    canvas.drawCircle(p, 10, Paint()..color = Colors.black.withValues(alpha: 0.8));
    canvas.drawCircle(p, 10, Paint()
      ..color = ring
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6);
    _centred(canvas, '${members.length}', p, const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w900, fontFeatures: [FontFeature.tabularFigures()]));
  }

  void _centred(Canvas canvas, String s, Offset c, TextStyle style) {
    final tp = TextPainter(text: TextSpan(text: s, style: style), textDirection: TextDirection.ltr)..layout();
    tp.paint(canvas, Offset(c.dx - tp.width / 2, c.dy - tp.height / 2));
  }

  void _text(Canvas canvas, String s, Offset at, TextStyle style) {
    final tp = TextPainter(text: TextSpan(text: s, style: style), textDirection: TextDirection.ltr)..layout(maxWidth: 160);
    tp.paint(canvas, at);
  }

  @override
  bool shouldRepaint(covariant _ChartPainter old) =>
      old.bars != bars || old.markers != markers || old.drawings != drawings || old.levels != levels || old.pending != pending || old.overlays != overlays || old.cross != cross;
}

/// Indicator line colours; the label beside each line names it too, so colour is never the only signal.
const kIndicatorColors = <String, Color>{
  'VWAP': Color(0xFFFFD166),
  'EMA 9': Color(0xFF7FD3FF),
  'EMA 20': Color(0xFF63B3ED),
  'EMA 50': Color(0xFFB794F6),
  'EMA 200': Color(0xFFF687B3),
  'Bollinger': Color(0xFFA0AEC0),
  'BB upper': Color(0xFFA0AEC0),
  'BB mid': Color(0xFF718096),
  'BB lower': Color(0xFFA0AEC0),
  'RSI 14': Color(0xFF68D391),
  'Session high/low': Color(0xFF9AE6B4),
  'Opening range': Color(0xFFF6AD55),
};

/// RSI 14 under the chart, with the 30 and 70 guides.
class _RsiPainter extends CustomPainter {
  _RsiPainter(this.values);
  final List<double?> values;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width - _Geometry.axis;
    double y(double v) => size.height - v / 100 * size.height;
    final guide = Paint()
      ..color = _stroke
      ..strokeWidth = 1;
    for (final v in const [30.0, 70.0]) {
      canvas.drawLine(Offset(0, y(v)), Offset(w, y(v)), guide);
    }
    if (values.isEmpty) return;
    final step = w / values.length;
    final path = Path();
    var open = false;
    for (var i = 0; i < values.length; i++) {
      final v = values[i];
      if (v == null) {
        open = false;
        continue;
      }
      final pt = Offset((i + 0.5) * step, y(v));
      open ? path.lineTo(pt.dx, pt.dy) : path.moveTo(pt.dx, pt.dy);
      open = true;
    }
    canvas.drawPath(path, Paint()
      ..color = kIndicatorColors['RSI 14']!
      ..strokeWidth = 1.4
      ..style = PaintingStyle.stroke);
    final last = values.lastWhere((v) => v != null, orElse: () => null);
    final tp = TextPainter(
      text: TextSpan(text: last == null ? 'RSI —' : 'RSI ${last.toStringAsFixed(1)}', style: TextStyle(color: kIndicatorColors['RSI 14'], fontSize: 11, fontWeight: FontWeight.w700)),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, Offset(w + 4, size.height / 2 - tp.height / 2));
  }

  @override
  bool shouldRepaint(covariant _RsiPainter old) => old.values != values;
}

/// One glyph per source so they never look alike: CHE forward a triangle, CHE simulation a hollow
/// circle, an Alpaca order a hollow square, an Alpaca fill a solid diamond.
class _MarkerGlyph extends CustomPainter {
  _MarkerGlyph(this.source, this.color, this.on);
  final String source;
  final Color color;
  final bool on;

  static void paintGlyph(Canvas canvas, String source, Color color, bool on, {bool buy = true, bool exit = false, double size = 12}) {
    final c = on ? color : _dim;
    final h = size / 2;
    final fill = Paint()..color = c;
    final line = Paint()
      ..color = c
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    switch (source) {
      case 'che_forward':
        final path = buy != exit
            ? (Path()..moveTo(0, -h)..lineTo(h, h)..lineTo(-h, h)..close())
            : (Path()..moveTo(0, h)..lineTo(h, -h)..lineTo(-h, -h)..close());
        canvas.drawPath(path, exit ? line : fill);
      case 'che_sim':
        canvas.drawCircle(Offset.zero, h * 0.85, line);
      case 'alpaca_order':
        canvas.drawRect(Rect.fromCenter(center: Offset.zero, width: size * 0.8, height: size * 0.8), line);
      case 'che_signal':
        // A crosshair in a ring: a planned paper entry, not a fill.
        canvas.drawCircle(Offset.zero, h * 0.9, line);
        canvas.drawLine(Offset(-h, 0), Offset(h, 0), line);
        canvas.drawLine(Offset(0, -h), Offset(0, h), line);
      default:
        canvas.drawPath(Path()..moveTo(0, -h)..lineTo(h, 0)..lineTo(0, h)..lineTo(-h, 0)..close(), fill);
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.translate(size.width / 2, size.height / 2);
    paintGlyph(canvas, source, color, on, size: size.width);
  }

  @override
  bool shouldRepaint(covariant _MarkerGlyph old) => old.on != on;
}

/// The PAPER order ticket: buy or sell, market or limit, quantity, then a preview from the Worker
/// (cost, buying power after, risk limits). Only "Yes, place paper order" sends it.
class _OrderTicket extends StatefulWidget {
  const _OrderTicket({
    required this.symbol,
    required this.price,
    required this.side,
    required this.qty,
    required this.marketAllowed,
    required this.blockedReason,
    required this.preview,
    required this.place,
    required this.onDone,
  });
  final String symbol;
  final double? price;
  final String side;
  final int qty;
  final bool marketAllowed;
  final String blockedReason;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic>) preview, place;
  final void Function(String text, bool ok) onDone;

  @override
  State<_OrderTicket> createState() => _OrderTicketState();
}

class _OrderTicketState extends State<_OrderTicket> {
  late String _side = widget.side;
  // A price tapped on the chart is a limit price; market is one tap away when the feed allows it.
  String _type = 'limit';
  late int _qty = widget.qty;
  late final _limit = TextEditingController(text: widget.price?.toStringAsFixed(2) ?? '');
  Map<String, dynamic>? _preview;
  String? _error;
  bool _busy = false;
  // One request id per ticket, so a repeated press can never send it twice.
  final _clientId = 'che-${DateTime.now().microsecondsSinceEpoch}';

  Map<String, dynamic> get _order => {
        'symbol': widget.symbol,
        'qty': _qty,
        'side': _side,
        'type': _type,
        if (_type == 'limit') 'limit_price': double.tryParse(_limit.text.replaceAll(',', '')),
      };

  void _changed() => setState(() {
        _preview = null;
        _error = null;
      });

  Future<void> _doPreview() async {
    setState(() => _busy = true);
    try {
      final p = await widget.preview(_order);
      if (!mounted) return;
      setState(() {
        if (p['ok'] == true) {
          _preview = p;
          _error = null;
        } else {
          _error = '${p['detail'] ?? 'The preview failed.'}';
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'The preview failed: $e');
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _doPlace() async {
    setState(() => _busy = true);
    try {
      final r = await widget.place({..._order, 'client_order_id': _clientId});
      final receipt = r['receipt'] is Map ? r['receipt'] as Map : const {};
      final ok = r['ok'] == true;
      final text = ok
          ? 'Alpaca PAPER ${r['repeated'] == true ? 'already has' : 'accepted'} ${_side.toUpperCase()} $_qty ${widget.symbol}${_type == 'limit' ? ' limit ${_limit.text}' : ' at market'}. Status: ${receipt['status'] ?? 'not reported'}. Order ${receipt['id'] ?? ''}.'
          : 'Nothing was sent: ${r['detail'] ?? 'Alpaca refused it'}.';
      if (mounted) Navigator.of(context).pop();
      widget.onDone(text, ok);
    } catch (e) {
      if (mounted) setState(() => _error = 'Nothing was confirmed: $e');
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final p = _preview;
    final blocked = '${p?['blocked'] ?? ''}';
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text('${widget.symbol} order ticket', style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: _gold, borderRadius: BorderRadius.circular(6)),
                child: const Text('PAPER · no real money', style: TextStyle(color: Colors.black, fontWeight: FontWeight.w900, fontSize: 12)),
              ),
            ]),
            const SizedBox(height: 12),
            SegmentedButton<String>(
              segments: const [ButtonSegment(value: 'buy', label: Text('Buy')), ButtonSegment(value: 'sell', label: Text('Sell'))],
              selected: {_side},
              onSelectionChanged: (s) => setState(() {
                _side = s.first;
                _changed();
              }),
            ),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: [
                ButtonSegment(value: 'market', label: const Text('Market'), enabled: widget.marketAllowed),
                const ButtonSegment(value: 'limit', label: Text('Limit')),
              ],
              selected: {_type},
              onSelectionChanged: (s) => setState(() {
                _type = s.first;
                _changed();
              }),
            ),
            if (!widget.marketAllowed && widget.blockedReason.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 4), child: Text(widget.blockedReason, style: const TextStyle(color: _gold, fontSize: 13))),
            const SizedBox(height: 8),
            Row(children: [
              const Text('Shares', style: TextStyle(color: Colors.white, fontSize: 16)),
              const Spacer(),
              IconButton(tooltip: 'Fewer shares', onPressed: _qty > 1 ? () => setState(() { _qty--; _changed(); }) : null, icon: const Icon(Icons.remove_circle_outline, color: Colors.white)),
              Semantics(label: '$_qty shares', excludeSemantics: true, child: Text('$_qty', style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
              IconButton(tooltip: 'More shares', onPressed: _qty < 1000 ? () => setState(() { _qty++; _changed(); }) : null, icon: const Icon(Icons.add_circle_outline, color: Colors.white)),
            ]),
            if (_type == 'limit')
              TextField(
                controller: _limit,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                style: const TextStyle(color: Colors.white, fontSize: 16),
                decoration: const InputDecoration(labelText: 'Limit price'),
                onChanged: (_) => _changed(),
              ),
            const SizedBox(height: 12),
            if (p != null) ...[
              Text(
                [
                  'Estimated ${_side == 'buy' ? 'cost' : 'proceeds'}: ${p['estimated_cost'] == null ? 'unknown (no latest trade)' : '\$${_fmt(_num(p['estimated_cost'])!)}'}',
                  'Buying power: ${p['buying_power'] == null ? 'not reported' : '\$${_fmt(_num(p['buying_power'])!)}'}',
                  if (_side == 'buy' && p['buying_power_after'] != null) 'Buying power after: \$${_fmt(_num(p['buying_power_after'])!)}',
                  if (p['last_trade'] != null) 'Last trade: \$${_fmt(_num(p['last_trade'])!)}${_time(p['last_trade_time']) != null ? ' at ${_clock(_time(p['last_trade_time'])!)}' : ''}',
                  'Risk: paper account, no real money.',
                ].join('\n'),
                style: const TextStyle(color: Colors.white, fontSize: 16, height: 1.4),
              ),
              if (blocked.isNotEmpty)
                Padding(padding: const EdgeInsets.only(top: 6), child: Text('Blocked by your limits: $blocked', style: const TextStyle(color: _down, fontSize: 15, fontWeight: FontWeight.w700))),
              const SizedBox(height: 12),
            ],
            if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: const TextStyle(color: _down, fontSize: 15))),
            if (p == null)
              FilledButton(onPressed: _busy ? null : () => unawaited(_doPreview()), child: Text(_busy ? 'Checking…' : 'Preview order'))
            else
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: _side == 'buy' ? _up : _down, foregroundColor: Colors.black, minimumSize: const Size.fromHeight(52)),
                onPressed: _busy || blocked.isNotEmpty ? null : () => unawaited(_doPlace()),
                child: Text('Yes, place paper order: ${_side.toUpperCase()} $_qty ${widget.symbol}${_type == 'limit' ? ' @ ${_limit.text}' : ''}',
                    style: const TextStyle(fontWeight: FontWeight.w800)),
              ),
            TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('No, cancel. Nothing is sent.')),
          ]),
        ),
      ),
    );
  }
}
