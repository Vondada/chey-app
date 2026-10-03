// CHE Markets Room: a premium trading desk. Dark grid, live ticker tape,
// index panels and a candlestick chart, all from real quotes (owner market
// connector when configured, otherwise labeled public/delayed sources). Every
// card either runs real work with CHE or shows exactly which connector it needs.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_app_portal.dart';
import '../che_ui/che_rooms.dart';
import '../che_ui/che_theme.dart';
import '../widgets/che_native_scene_world.dart';

class CheQuote {
  const CheQuote({required this.symbol, required this.name, this.price, this.changePct, required this.status, this.note});
  final String symbol;
  final String name;
  final double? price;
  final double? changePct;
  final String status; // live | delayed | unavailable
  final String? note;

  bool get available => price != null && status != 'unavailable';

  static CheQuote fromJson(Map<String, dynamic> j) => CheQuote(
        symbol: '${j['symbol'] ?? ''}',
        name: '${j['name'] ?? j['symbol'] ?? ''}',
        price: (j['price'] as num?)?.toDouble(),
        changePct: (j['change_pct'] as num?)?.toDouble(),
        status: '${j['status'] ?? 'unavailable'}',
        note: j['note']?.toString(),
      );
}

class CheCandle {
  const CheCandle(this.date, this.open, this.high, this.low, this.close);
  final String date;
  final double open, high, low, close;
}

/// One capability on the desk (Analyze, Backtesting, Indicators, Broker…).
class CheDeskAction {
  const CheDeskAction({
    required this.icon,
    required this.title,
    required this.body,
    required this.connected,
    required this.connectorName,
    required this.onRun,
  });
  final IconData icon;
  final String title;
  final String body;
  final bool connected;
  final String connectorName;
  final VoidCallback onRun;
}

class CheMarketsRoom extends StatefulWidget {
  const CheMarketsRoom({
    super.key,
    required this.baseUrl,
    required this.headers,
    required this.actions,
    required this.onAsk,
    this.client,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final List<CheDeskAction> actions;

  /// Sends a prompt to CHE (e.g. "Analyze S&P 500 structure").
  final void Function(String prompt) onAsk;
  final http.Client? client;

  @override
  State<CheMarketsRoom> createState() => _CheMarketsRoomState();
}

class _CheMarketsRoomState extends State<CheMarketsRoom> {
  static const _gold = Color(0xFFE8B04A);
  static const _up = Color(0xFF3DDC97);
  static const _down = Color(0xFFFF5C7A);

  late final http.Client _http = widget.client ?? http.Client();
  List<CheQuote> _quotes = const [];
  String _source = '';
  String? _error;
  String _chartSymbol = '^spx';
  String _chartName = 'S&P 500';
  List<CheCandle> _candles = const [];
  String? _chartNote;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(_loadCandles());
    _timer = Timer.periodic(const Duration(seconds: 60), (_) => unawaited(_load()));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<Map<String, dynamic>> _get(String path) async {
    final r = await _http.get(Uri.parse('${widget.baseUrl()}$path'), headers: widget.headers()).timeout(const Duration(seconds: 20));
    final j = jsonDecode(r.body);
    if (r.statusCode != 200 || j is! Map<String, dynamic>) {
      throw Exception(j is Map ? '${j['detail'] ?? 'Markets unavailable'}' : 'Markets unavailable');
    }
    return j;
  }

  Future<void> _load() async {
    try {
      final j = await _get('/api/markets/snapshot');
      _quotes = [for (final q in (j['quotes'] as List? ?? const [])) if (q is Map<String, dynamic>) CheQuote.fromJson(q)];
      _source = '${j['source'] ?? ''}';
      _error = null;
    } catch (e) {
      _error = '$e'.replaceFirst('Exception: ', '');
    }
    if (mounted) setState(() {});
  }

  Future<void> _loadCandles() async {
    final symbol = _chartSymbol;
    try {
      final j = await _get('/api/markets/candles?symbol=${Uri.encodeQueryComponent(symbol)}');
      // A slower response for an index the owner already left is discarded.
      if (symbol != _chartSymbol) return;
      _candles = [
        for (final c in (j['candles'] as List? ?? const []))
          if (c is Map)
            CheCandle('${c['date']}', (c['open'] as num).toDouble(), (c['high'] as num).toDouble(), (c['low'] as num).toDouble(),
                (c['close'] as num).toDouble()),
      ];
      _chartNote = j['error']?.toString() ?? j['source']?.toString();
    } catch (e) {
      if (symbol != _chartSymbol) return;
      _candles = const [];
      _chartNote = '$e'.replaceFirst('Exception: ', '');
    }
    if (mounted) setState(() {});
  }

  Future<void> _openEmbedded(String name, {bool chart = false}) async {
    final app = cheAppForName(name);
    if (app == null) return;
    var url = app.webUrl;
    if (chart && name == 'TradingView') {
      final symbol = _chartSymbol.replaceFirst('^', '').toUpperCase();
      url = 'https://www.tradingview.com/chart/?symbol=${Uri.encodeQueryComponent(symbol)}';
    }
    await CheEmbeddedAppScreen.open(
      context,
      app: CheAppDefinition(name: app.name, webUrl: url, icon: app.icon, aliases: app.aliases),
    );
  }

  String _fmt(double v) => v >= 1000 ? v.toStringAsFixed(0) : v >= 1 ? v.toStringAsFixed(2) : v.toStringAsFixed(4);

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: CheTheme.dark(),
      child: Material(
        color: const Color(0xFF05080A),
        child: RefreshIndicator(
          onRefresh: () async {
            await Future.wait([_load(), _loadCandles()]);
          },
          child: ListView(
            padding: const EdgeInsets.only(bottom: CheSpace.xxl),
            children: [
              _TickerTape(quotes: _quotes, fmt: _fmt),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  CheSpace.gutter,
                  CheSpace.md,
                  CheSpace.gutter,
                  0,
                ),
                child: ValueListenableBuilder<CheSceneQuality>(
                  valueListenable: CheSceneQualityStore.value,
                  builder: (context, quality, _) => CheNativeSceneWorld(
                    mode: CheSceneMode.markets,
                    quality: quality,
                    height: 250,
                    semanticsLabel: 'Immersive Markets Room',
                    entities: [
                      for (final quote in _quotes.take(12))
                        CheSceneEntity(
                          id: quote.symbol,
                          label: quote.name,
                          description: quote.available
                              ? '${_fmt(quote.price!)}. ${quote.changePct == null ? quote.status : '${quote.changePct!.toStringAsFixed(2)} percent. ${quote.status}'}'
                              : (quote.note ?? quote.status),
                          color: quote.changePct == null
                              ? _gold
                              : (quote.changePct! >= 0 ? _up : _down),
                          state: quote.status,
                        ),
                    ],
                    onEntityTap: (id) {
                      final matches = _quotes.where((q) => q.symbol == id);
                      if (matches.isEmpty) return;
                      final quote = matches.first;
                      if (quote.symbol.startsWith('^')) {
                        setState(() {
                          _chartSymbol = quote.symbol;
                          _chartName = quote.name;
                          _candles = const [];
                        });
                        unawaited(_loadCandles());
                      } else {
                        widget.onAsk(
                          'Give me a quick structure read on ${quote.name} (${quote.symbol}) using live data if connected: trend, key levels, catalysts and risk.',
                        );
                      }
                    },
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.md, CheSpace.gutter, 0),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  if (_error != null)
                    Text('Market data: $_error', style: CheType.caption.copyWith(color: CheColors.warning)),
                  SizedBox(
                    height: 84,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: _quotes.length,
                      separatorBuilder: (_, _) => const SizedBox(width: CheSpace.sm),
                      itemBuilder: (context, i) => _IndexPanel(
                        quote: _quotes[i],
                        fmt: _fmt,
                        selected: _quotes[i].symbol == _chartSymbol,
                        onTap: _quotes[i].symbol.startsWith('^')
                            ? () {
                                HapticFeedback.selectionClick();
                                setState(() {
                                  _chartSymbol = _quotes[i].symbol;
                                  _chartName = _quotes[i].name;
                                  _candles = const [];
                                });
                                unawaited(_loadCandles());
                              }
                            : () => widget.onAsk('Give me a quick structure read on ${_quotes[i].name} (${_quotes[i].symbol}) using live data if connected: trend, key levels, catalysts and risk.'),
                      ),
                    ),
                  ),
                  const SizedBox(height: CheSpace.md),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(CheRadius.lg),
                    child: CheRoomBackdrop(
                      room: CheRoom.markets,
                      scrim: 0.6,
                      child: Padding(
                        padding: const EdgeInsets.all(CheSpace.md),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          Row(children: [
                            Expanded(
                              child: Text('$_chartName · daily',
                                  maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: Colors.white)),
                            ),
                            TextButton.icon(
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              onPressed: () => widget.onAsk(
                                  'Analyze $_chartName: structure, VWAP context, order blocks, catalysts, volatility, invalidation and risk. Separate live facts from assumptions.'),
                              icon: const Icon(Icons.auto_awesome_rounded, size: 16, color: _gold),
                              label: Text('Ask CHE', style: CheType.label.copyWith(color: _gold)),
                            ),
                          ]),
                          const SizedBox(height: CheSpace.sm),
                          SizedBox(
                            height: 180,
                            child: _candles.isEmpty
                                ? Center(
                                    child: Text(_chartNote ?? 'Loading…',
                                        textAlign: TextAlign.center, style: CheType.caption.copyWith(color: Colors.white60)),
                                  )
                                : CustomPaint(painter: _CandlePainter(_candles, up: _up, down: _down)),
                          ),
                          if (_candles.isNotEmpty && _chartNote != null)
                            Padding(
                              padding: const EdgeInsets.only(top: CheSpace.xs),
                              child: Text('${_chartNote!} · last ${_candles.last.date}',
                                  style: CheType.caption.copyWith(color: Colors.white54, fontSize: 10)),
                            ),
                        ]),
                      ),
                    ),
                  ),
                  if (_source.isNotEmpty) ...[
                    const SizedBox(height: CheSpace.xs),
                    Text(_source, style: CheType.caption.copyWith(fontSize: 10)),
                  ],
                  const SizedBox(height: CheSpace.lg),
                  Text('CHARTS INSIDE CHE', style: CheType.overline.copyWith(color: _gold)),
                  const SizedBox(height: CheSpace.sm),
                  const Text(
                    'Opens in CHE. Official app or Safari only if you choose that from More.',
                    style: CheType.caption,
                  ),
                  const SizedBox(height: CheSpace.sm),
                  Wrap(
                    spacing: CheSpace.sm,
                    runSpacing: CheSpace.sm,
                    children: [
                      _EmbeddedAppChip(
                        label: 'TradingView',
                        onTap: () => _openEmbedded('TradingView', chart: true),
                      ),
                      _EmbeddedAppChip(
                        label: 'NinjaTrader',
                        onTap: () => _openEmbedded('NinjaTrader'),
                      ),
                      _EmbeddedAppChip(
                        label: 'TradeSea',
                        onTap: () => _openEmbedded('TradeSea'),
                      ),
                    ],
                  ),
                  const SizedBox(height: CheSpace.lg),
                  Text('TRADING DESK', style: CheType.overline.copyWith(color: _gold)),
                  const SizedBox(height: CheSpace.sm),
                  for (final a in widget.actions) _DeskCard(action: a),
                  const SizedBox(height: CheSpace.sm),
                  Text(
                    'CHE never claims an order executed unless the broker confirms it. Trading needs a connected account, your authorization and risk limits.',
                    style: CheType.caption,
                  ),
                ]),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmbeddedAppChip extends StatelessWidget {
  const _EmbeddedAppChip({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Open $label inside CHE',
      child: ActionChip(
        avatar: const Icon(Icons.open_in_new_rounded, size: 16, color: Color(0xFFE8B04A)),
        label: Text(label),
        onPressed: () {
          HapticFeedback.selectionClick();
          onTap();
        },
      ),
    );
  }
}

class _TickerTape extends StatefulWidget {
  const _TickerTape({required this.quotes, required this.fmt});
  final List<CheQuote> quotes;
  final String Function(double) fmt;
  @override
  State<_TickerTape> createState() => _TickerTapeState();
}

class _TickerTapeState extends State<_TickerTape> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 30))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final items = widget.quotes.where((q) => q.available).toList();
    final text = items.isEmpty
        ? 'Waiting for market data…'
        : items
            .map((q) =>
                '${q.name} ${widget.fmt(q.price!)} ${q.changePct == null ? '' : '${q.changePct! >= 0 ? '▲' : '▼'}${q.changePct!.abs().toStringAsFixed(2)}%'}')
            .join('     •     ');
    final reduced = CheMotion.reduced(context);
    return Container(
      height: 30,
      color: const Color(0xFF0B1014),
      child: ClipRect(
        child: LayoutBuilder(builder: (context, constraints) {
          return AnimatedBuilder(
            animation: _c,
            builder: (context, _) {
              final shift = reduced ? 0.0 : -_c.value * (text.length * 7.0 + constraints.maxWidth);
              return OverflowBox(
                maxWidth: double.infinity,
                alignment: Alignment.centerLeft,
                child: Transform.translate(
                  offset: Offset(reduced ? CheSpace.gutter : constraints.maxWidth + shift, 0),
                  child: Text(text,
                      maxLines: 1,
                      softWrap: false,
                      style: const TextStyle(color: Color(0xFFE8B04A), fontSize: 12, fontWeight: FontWeight.w600)),
                ),
              );
            },
          );
        }),
      ),
    );
  }
}

class _IndexPanel extends StatelessWidget {
  const _IndexPanel({required this.quote, required this.fmt, required this.selected, required this.onTap});
  final CheQuote quote;
  final String Function(double) fmt;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final change = quote.changePct;
    final color = change == null ? CheColors.textDim : (change >= 0 ? const Color(0xFF3DDC97) : const Color(0xFFFF5C7A));
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 118,
        padding: const EdgeInsets.all(CheSpace.sm),
        decoration: BoxDecoration(
          color: const Color(0xFF0E1418),
          borderRadius: BorderRadius.circular(CheRadius.md),
          border: Border.all(color: selected ? const Color(0xFFE8B04A) : CheColors.stroke),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(quote.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption),
          Text(quote.available ? fmt(quote.price!) : 'Unavailable',
              maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(fontSize: 15)),
          Row(children: [
            if (change != null) Icon(change >= 0 ? Icons.arrow_drop_up_rounded : Icons.arrow_drop_down_rounded, color: color, size: 18),
            Flexible(
              child: Text(
                change != null ? '${change.abs().toStringAsFixed(2)}% · ${quote.status}' : (quote.note ?? quote.status),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: CheType.caption.copyWith(color: color, fontSize: 10.5),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}

class _DeskCard extends StatelessWidget {
  const _DeskCard({required this.action});
  final CheDeskAction action;
  @override
  Widget build(BuildContext context) {
    final a = action;
    return Card(
      color: const Color(0xFF0E1418),
      margin: const EdgeInsets.only(bottom: CheSpace.sm),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(CheRadius.md),
        side: const BorderSide(color: CheColors.stroke),
      ),
      child: ListTile(
        onTap: () {
          HapticFeedback.selectionClick();
          a.onRun();
        },
        leading: Icon(a.icon, color: const Color(0xFFE8B04A)),
        title: Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
        subtitle: Text(
          a.connected ? a.body : '${a.body}\nNeeds: ${a.connectorName} (not connected). CHE can still plan it with you.',
          style: CheType.caption,
        ),
        isThreeLine: !a.connected,
        trailing: Text(
          a.connected ? 'CONNECTED' : 'CONNECT',
          style: TextStyle(color: a.connected ? const Color(0xFF3DDC97) : CheColors.warning, fontSize: 10, fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}

class _CandlePainter extends CustomPainter {
  _CandlePainter(this.candles, {required this.up, required this.down});
  final List<CheCandle> candles;
  final Color up;
  final Color down;

  @override
  void paint(Canvas canvas, Size size) {
    // Dark grid
    final grid = Paint()
      ..color = Colors.white.withValues(alpha: 0.06)
      ..strokeWidth = 1;
    for (var i = 1; i < 4; i++) {
      final y = size.height * i / 4;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }
    if (candles.isEmpty) return;
    final hi = candles.map((c) => c.high).reduce(math.max);
    final lo = candles.map((c) => c.low).reduce(math.min);
    final range = (hi - lo) == 0 ? 1 : hi - lo;
    double y(double v) => size.height - (v - lo) / range * size.height;
    final step = size.width / candles.length;
    final body = math.max(2.0, step * 0.6);
    for (var i = 0; i < candles.length; i++) {
      final c = candles[i];
      final color = c.close >= c.open ? up : down;
      final x = step * i + step / 2;
      final p = Paint()
        ..color = color
        ..strokeWidth = 1.2;
      canvas.drawLine(Offset(x, y(c.high)), Offset(x, y(c.low)), p);
      final top = y(math.max(c.open, c.close));
      final bottom = y(math.min(c.open, c.close));
      canvas.drawRect(Rect.fromLTRB(x - body / 2, top, x + body / 2, math.max(bottom, top + 1.5)), p);
    }
    // Last price line
    final last = y(candles.last.close);
    canvas.drawLine(Offset(0, last), Offset(size.width, last), Paint()
      ..color = const Color(0xFFE8B04A).withValues(alpha: 0.5)
      ..strokeWidth = 1);
  }

  @override
  bool shouldRepaint(covariant _CandlePainter old) => old.candles != candles;
}
