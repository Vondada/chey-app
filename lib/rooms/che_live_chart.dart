// Trading Room live chart: TradingView's free Advanced Chart (live candles,
// streamed by TradingView) on a page CHE's Worker hosts, with symbol and
// timeframe switching by tap, typing or voice ("show me the E-mini",
// "switch to Tesla on the 1 minute"), and a spoken price readout, because a
// chart canvas cannot be read by VoiceOver.
//
// Data honesty: stocks and crypto are live or near-live on the free widget;
// CME futures are usually delayed about 10 minutes. Real-time futures come
// later from the owner's broker feed.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:webview_flutter/webview_flutter.dart';

import '../browser/che_embedded_app_shell.dart';
import '../che_ui/che_theme.dart';

class CheLiveSymbol {
  const CheLiveSymbol(this.id, this.name, this.tv, {this.kind = 'stock', this.aliases = const []});

  /// Short id used for quotes ("ES", "TSLA").
  final String id;
  final String name;

  /// TradingView symbol ("CME_MINI:ES1!").
  final String tv;
  final String kind; // future | stock | etf | crypto
  final List<String> aliases;

  bool get delayed => kind == 'future';
}

const List<CheLiveSymbol> cheLiveSymbols = [
  CheLiveSymbol('ES', 'E-mini S&P 500 futures', 'CME_MINI:ES1!', kind: 'future', aliases: ['e-mini s&p', 'e mini s&p', 'emini s&p', 'e-mini', 'e mini', 'emini', 's&p futures', 's and p futures', 'spoos', 'es']),
  CheLiveSymbol('NQ', 'E-mini Nasdaq 100 futures', 'CME_MINI:NQ1!', kind: 'future', aliases: ['nasdaq futures', 'nasdaq 100 futures', 'e-mini nasdaq', 'emini nasdaq', 'nq']),
  CheLiveSymbol('YM', 'E-mini Dow futures', 'CBOT_MINI:YM1!', kind: 'future', aliases: ['dow futures', 'e-mini dow', 'ym']),
  CheLiveSymbol('RTY', 'E-mini Russell 2000 futures', 'CME_MINI:RTY1!', kind: 'future', aliases: ['russell futures', 'russell 2000', 'russell', 'rty']),
  CheLiveSymbol('CL', 'Crude oil futures', 'NYMEX:CL1!', kind: 'future', aliases: ['crude oil', 'crude', 'oil futures', 'oil', 'cl']),
  CheLiveSymbol('GC', 'Gold futures', 'COMEX:GC1!', kind: 'future', aliases: ['gold futures', 'gold', 'gc']),
  CheLiveSymbol('SI', 'Silver futures', 'COMEX:SI1!', kind: 'future', aliases: ['silver futures', 'silver']),
  CheLiveSymbol('SPY', 'S&P 500 ETF', 'AMEX:SPY', kind: 'etf', aliases: ['spy', 's&p 500', 's and p 500', 's&p']),
  CheLiveSymbol('QQQ', 'Nasdaq 100 ETF', 'NASDAQ:QQQ', kind: 'etf', aliases: ['qqq', 'nasdaq']),
  CheLiveSymbol('AAPL', 'Apple', 'NASDAQ:AAPL', aliases: ['apple']),
  CheLiveSymbol('TSLA', 'Tesla', 'NASDAQ:TSLA', aliases: ['tesla']),
  CheLiveSymbol('NVDA', 'Nvidia', 'NASDAQ:NVDA', aliases: ['nvidia']),
  CheLiveSymbol('MSFT', 'Microsoft', 'NASDAQ:MSFT', aliases: ['microsoft']),
  CheLiveSymbol('AMZN', 'Amazon', 'NASDAQ:AMZN', aliases: ['amazon']),
  CheLiveSymbol('META', 'Meta', 'NASDAQ:META', aliases: ['meta', 'facebook']),
  CheLiveSymbol('GOOGL', 'Alphabet', 'NASDAQ:GOOGL', aliases: ['google', 'alphabet']),
  CheLiveSymbol('BTC', 'Bitcoin', 'BITSTAMP:BTCUSD', kind: 'crypto', aliases: ['bitcoin', 'btc']),
  CheLiveSymbol('ETH', 'Ethereum', 'BITSTAMP:ETHUSD', kind: 'crypto', aliases: ['ethereum', 'ether', 'eth']),
];

/// Timeframes: TradingView interval code → spoken name.
const Map<String, String> cheChartIntervals = {
  '1': '1-minute',
  '5': '5-minute',
  '15': '15-minute',
  '60': '1-hour',
  'D': 'daily',
};

String _norm(String text) => text.toLowerCase().replaceAll(RegExp(r'[^a-z0-9& ]+'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();

/// A catalog symbol by name or alias, or a typed stock ticker ("AMD").
CheLiveSymbol? cheResolveLiveSymbol(String input, {bool allowTicker = true}) {
  final text = _norm(input).replaceFirst(RegExp(r'^the '), '').replaceAll(RegExp(r' (?:chart|stock|shares|futures contract|ticker)$'), '').trim();
  if (text.isEmpty) return null;
  CheLiveSymbol? best;
  var bestLength = 0;
  for (final s in cheLiveSymbols) {
    for (final alias in [s.id.toLowerCase(), _norm(s.name), ...s.aliases.map(_norm)]) {
      if (text == alias && alias.length > bestLength) {
        best = s;
        bestLength = alias.length;
      }
    }
  }
  if (best != null) return best;
  final ticker = input.trim().replaceFirst(RegExp(r'^\$'), '');
  if (allowTicker && RegExp(r'^[A-Za-z]{1,5}$').hasMatch(ticker)) {
    final id = ticker.toUpperCase();
    return CheLiveSymbol(id, id, id);
  }
  return null;
}

/// What a spoken or typed chart command asks for.
class CheChartCommand {
  const CheChartCommand({this.symbol, this.interval, this.readPrice = false});
  final CheLiveSymbol? symbol;
  final String? interval;
  final bool readPrice;

  static String? _interval(String t) {
    if (RegExp(r'\b(?:1|one) ?(?:minute|min|m)\b').hasMatch(t)) return '1';
    if (RegExp(r'\b(?:5|five) ?(?:minute|min|m)\b').hasMatch(t)) return '5';
    if (RegExp(r'\b(?:15|fifteen) ?(?:minute|min|m)\b').hasMatch(t)) return '15';
    if (RegExp(r'\b(?:hourly|1 ?hour|one hour|60 ?minute)\b').hasMatch(t)) return '60';
    if (RegExp(r'\b(?:daily|day chart|1 ?day)\b').hasMatch(t)) return 'D';
    return null;
  }

  /// "show me the E-mini", "switch to Tesla on the 1 minute", "chart gold",
  /// "put Nvidia on the chart", "5 minute candles", "read the chart".
  /// Returns null for anything that is not about the live chart.
  static CheChartCommand? parse(String words) {
    var t = words.toLowerCase().trim().replaceAll(RegExp(r'[.!?]+$'), '').trim();
    t = t.replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chey|chay|shay)[,:]?\s+'), '').replaceFirst(RegExp(r'^(?:please|can you|could you)\s+'), '').trim();
    if (t.length > 80) return null;
    if (RegExp(r"^(?:read|say|what'?s|what is|tell me)(?: me)? (?:the )?(?:chart|price|quote)(?: (?:on|of|for) .+)?$").hasMatch(t)) {
      final on = RegExp(r' (?:on|of|for) (.+)$').firstMatch(t);
      if (on == null) return const CheChartCommand(readPrice: true);
      // A named target must resolve; never read a different symbol instead.
      final named = cheResolveLiveSymbol(on.group(1)!);
      return named == null ? null : CheChartCommand(symbol: named, readPrice: true);
    }
    final interval = _interval(t);
    final cleaned = t
        .replaceAll(RegExp(r'\b(?:on|to|with) (?:the |a )?(?:1|one|5|five|15|fifteen|60) ?(?:minute|min|m)(?: chart| candles?)?\b'), '')
        .replaceAll(RegExp(r'\b(?:on|to|with) (?:the |a )?(?:hourly|daily|1 ?hour|one hour|1 ?day)(?: chart| candles?)?\b'), '')
        .trim();
    final m = RegExp(r'^(?:show(?: me)?|switch(?: the chart)? to|change(?: the chart)? to|chart|pull up|bring up|put (.+?) on the chart)\s*(.*)$').firstMatch(cleaned);
    if (m != null) {
      final target = (m.group(1) ?? m.group(2) ?? '').replaceAll(RegExp(r'\s+(?:chart|candles|live)$'), '').trim();
      final explicitChart = RegExp(r'\b(?:chart|candles|futures|stock|ticker)\b').hasMatch(t) || cleaned.startsWith('switch') || cleaned.startsWith('change');
      final symbol = target.isEmpty ? null : cheResolveLiveSymbol(target, allowTicker: explicitChart);
      // A catalog name or an explicit chart word: never hijack "show me my photos".
      if (symbol != null) return CheChartCommand(symbol: symbol, interval: interval);
      // Only timeframe words left ("show me 15 minute candles", "switch to the daily").
      final rest = target.replaceAll(RegExp(r'\b(?:the|a|1|one|5|five|15|fifteen|60|minute|minutes|min|m|hour|hourly|daily|day|chart|candles?)\b'), '').trim();
      if (interval != null && rest.isEmpty) return CheChartCommand(interval: interval);
      return null;
    }
    if (interval != null && RegExp(r'\b(?:candles?|chart|timeframe)\b').hasMatch(t)) return CheChartCommand(interval: interval);
    return null;
  }
}

/// What the Trading Room chart shows. Voice commands from anywhere in CHE
/// change it.
class CheLiveChart {
  CheLiveChart._();
  static final ValueNotifier<CheLiveSymbol> symbol = ValueNotifier<CheLiveSymbol>(cheLiveSymbols.first);
  static final ValueNotifier<String> interval = ValueNotifier<String>('5');

  static String pageUrl(String baseUrl, CheLiveSymbol s, String interval) =>
      '$baseUrl/markets/chart?symbol=${Uri.encodeQueryComponent(s.tv)}&interval=${Uri.encodeQueryComponent(interval)}';

  /// What CHE says when the chart changes.
  static String describe(CheLiveSymbol s, String interval) =>
      'Showing ${s.name}, ${cheChartIntervals[interval] ?? interval} candles${s.delayed ? '. Futures on this free chart are about 10 minutes delayed' : ', live'}.';

  /// Spoken price readout from CHE's Worker. Never invents a number.
  static Future<String> readPrice(String baseUrl, Map<String, String> headers, CheLiveSymbol s, {http.Client? client}) async {
    try {
      final c = client ?? http.Client();
      final r = await c.get(Uri.parse('$baseUrl/api/markets/quote?symbol=${Uri.encodeQueryComponent(s.id)}'), headers: headers).timeout(const Duration(seconds: 15));
      final j = jsonDecode(r.body);
      if (j is! Map || j['price'] is! num) {
        return 'I could not get a price for ${s.name} right now${j is Map && j['error'] != null ? ': ${j['error']}' : '.'} The chart itself is still live.';
      }
      final price = (j['price'] as num).toDouble();
      final change = (j['change_pct'] as num?)?.toDouble();
      final dir = change == null ? '' : change >= 0 ? ', up ${change.toStringAsFixed(2)} percent since the open' : ', down ${(-change).toStringAsFixed(2)} percent since the open';
      return '${s.name}: ${price.toStringAsFixed(price >= 100 ? 2 : 4)}$dir. Delayed quote${j['as_of'] != null ? ' as of ${j['as_of']}' : ''}.';
    } catch (_) {
      return 'I could not reach the price source for ${s.name} right now. The chart itself is still live.';
    }
  }
}

typedef CheChartViewBuilder = Widget Function(BuildContext context, String url);

/// The live chart with its symbol and timeframe controls.
class CheLiveChartPanel extends StatefulWidget {
  const CheLiveChartPanel({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.height = 460,
    this.chartBuilder,
    this.client,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final double height;

  /// Tests replace the web view.
  final CheChartViewBuilder? chartBuilder;
  final http.Client? client;

  @override
  State<CheLiveChartPanel> createState() => _CheLiveChartPanelState();
}

class _CheLiveChartPanelState extends State<CheLiveChartPanel> {
  final _typed = TextEditingController();

  @override
  void dispose() {
    _typed.dispose();
    super.dispose();
  }

  void _say(String message) {
    CheEmbeddedAppAnnouncer.say(context, message);
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message, style: const TextStyle(fontSize: 18))));
  }

  // Success or failure is announced when the chart page actually loads.
  void _pick(CheLiveSymbol s) {
    HapticFeedback.selectionClick();
    CheLiveChart.symbol.value = s;
  }

  void _interval(String code) {
    HapticFeedback.selectionClick();
    CheLiveChart.interval.value = code;
  }

  void _loaded(bool ok) {
    final s = CheLiveChart.symbol.value;
    if (ok) {
      HapticFeedback.lightImpact();
      _say(CheLiveChart.describe(s, CheLiveChart.interval.value));
    } else {
      HapticFeedback.heavyImpact();
      _say('The chart for ${s.name} could not load. Check the connection; say "read the price" for the latest quote.');
    }
  }

  void _submitTyped(String text) {
    final s = cheResolveLiveSymbol(text);
    if (s == null) {
      HapticFeedback.heavyImpact();
      _say('I do not know the symbol "$text". Try a ticker like TSLA or a name like gold futures.');
      return;
    }
    _typed.clear();
    _pick(s);
  }

  Future<void> _read() async {
    HapticFeedback.lightImpact();
    _say(await CheLiveChart.readPrice(widget.baseUrl(), widget.headers(), CheLiveChart.symbol.value, client: widget.client));
  }

  Widget _chart(BuildContext context, String url) {
    if (widget.chartBuilder != null) return widget.chartBuilder!(context, url);
    if (kIsWeb || WebViewPlatform.instance == null) {
      return const Center(child: Text('The live chart runs in the CHE iPhone app.', style: CheType.caption));
    }
    return _CheChartWebView(url: url, onLoaded: _loaded);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([CheLiveChart.symbol, CheLiveChart.interval]),
      builder: (context, _) {
        final s = CheLiveChart.symbol.value;
        final interval = CheLiveChart.interval.value;
        final url = CheLiveChart.pageUrl(widget.baseUrl(), s, interval);
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text('${s.name} · ${cheChartIntervals[interval] ?? interval}${s.delayed ? ' · ~10 min delayed' : ' · live'}',
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label.copyWith(color: Colors.white)),
              ),
            ),
            Semantics(
              button: true,
              label: 'Read the price of ${s.name} aloud',
              excludeSemantics: true,
              child: TextButton.icon(
                onPressed: _read,
                icon: const Icon(Icons.record_voice_over_rounded, size: 18),
                label: const Text('Read price'),
              ),
            ),
          ]),
          const SizedBox(height: CheSpace.xs),
          SizedBox(
            height: 40,
            child: ListView(scrollDirection: Axis.horizontal, children: [
              for (final item in cheLiveSymbols)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Semantics(
                    button: true,
                    selected: item.id == s.id,
                    label: 'Chart ${item.name}${item.id == s.id ? ', showing now' : ''}',
                    excludeSemantics: true,
                    child: ChoiceChip(label: Text(item.id), selected: item.id == s.id, onSelected: (_) => _pick(item)),
                  ),
                ),
            ]),
          ),
          const SizedBox(height: CheSpace.xs),
          Row(children: [
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: [
                  for (final e in cheChartIntervals.entries)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: Semantics(
                        button: true,
                        selected: e.key == interval,
                        label: '${e.value} candles${e.key == interval ? ', selected' : ''}',
                        excludeSemantics: true,
                        child: ChoiceChip(label: Text(e.key == 'D' ? '1D' : e.key == '60' ? '1h' : '${e.key}m'), selected: e.key == interval, onSelected: (_) => _interval(e.key)),
                      ),
                    ),
                ]),
              ),
            ),
            SizedBox(
              width: 120,
              child: TextField(
                controller: _typed,
                textInputAction: TextInputAction.go,
                textCapitalization: TextCapitalization.characters,
                onSubmitted: _submitTyped,
                decoration: const InputDecoration(isDense: true, hintText: 'Symbol', labelText: 'Type a symbol', prefixIcon: Icon(Icons.search, size: 18)),
              ),
            ),
          ]),
          const SizedBox(height: CheSpace.sm),
          Semantics(
            label: 'Live candlestick chart of ${s.name}, ${cheChartIntervals[interval] ?? interval} candles. Use Read price to hear the latest price.',
            child: ClipRRect(
              borderRadius: BorderRadius.circular(CheRadius.lg),
              child: SizedBox(height: widget.height, child: KeyedSubtree(key: ValueKey(url), child: _chart(context, url))),
            ),
          ),
          const SizedBox(height: CheSpace.xs),
          Text(
            'Chart by TradingView. Stocks and crypto are live; futures on the free chart are about 10 minutes delayed until your broker feed is connected.',
            style: CheType.caption.copyWith(fontSize: 10),
          ),
        ]);
      },
    );
  }
}

class _CheChartWebView extends StatefulWidget {
  const _CheChartWebView({required this.url, required this.onLoaded});
  final String url;
  final void Function(bool ok) onLoaded;

  @override
  State<_CheChartWebView> createState() => _CheChartWebViewState();
}

class _CheChartWebViewState extends State<_CheChartWebView> {
  late final WebViewController _controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..setBackgroundColor(const Color(0xFF05080A))
    ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: (_) {
          if (!_failed) widget.onLoaded(true);
        },
        onWebResourceError: (error) {
          if (error.isForMainFrame != false && !_failed) {
            _failed = true;
            widget.onLoaded(false);
          }
        },
        onNavigationRequest: (request) {
      // The chart page and TradingView's own frames only; links in the
      // widget (e.g. "chart by TradingView") never take the room away.
      final host = Uri.tryParse(request.url)?.host ?? '';
      final start = Uri.parse(widget.url).host;
      final allowed = host == start || host.endsWith('tradingview.com') || host.endsWith('tradingview-widget.com') || request.url == 'about:blank';
      return allowed && (request.isMainFrame ? host == start : true) ? NavigationDecision.navigate : NavigationDecision.prevent;
    }))
    ..loadRequest(Uri.parse(widget.url));

  bool _failed = false;

  // Parent-friendly: the room's page scroll wins vertical drags over the
  // chart; the chart still gets taps and horizontal pans nobody else claims.
  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _controller, gestureRecognizers: cheEmbeddedParentFriendlyGestures());
}
