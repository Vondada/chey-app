// The universal ticker selector (owner, 2026-10-24): quick-switch chips (MNQ | NQ | ES | MES | BTC | ETH |
// DOGE | SOL) that scroll sideways, and a search sheet over every market the Worker discovered
// (GET /api/markets/universe: Coinbase and Kraken spot pairs, the CME futures catalog), with Crypto and
// Futures filters, favorites and recents. The choice, favorites and recents stay on this phone.
//
// Every chip and row is a VoiceOver button that names the market and its exchange; choosing one is
// quiet (the chart's own feed line shows what loaded), and the sheet reads nothing aloud unless asked.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../che_ui/che_theme.dart';

/// The quick-switch chips, in the owner's order: label → universe id.
const kQuickTickers = <String, String>{
  'MNQ': 'futures:MNQ',
  'NQ': 'futures:NQ',
  'ES': 'futures:ES',
  'MES': 'futures:MES',
  'BTC': 'coinbase:BTC-USD',
  'ETH': 'coinbase:ETH-USD',
  'DOGE': 'coinbase:DOGE-USD',
  'SOL': 'coinbase:SOL-USD',
};

/// A short chip label for any universe id: "futures:ES" → "ES", "coinbase:BTC-USD" → "BTC", "coinbase:BTC-USDT" → "BTC-USDT".
String tickerLabel(String id) {
  for (final e in kQuickTickers.entries) {
    if (e.value == id) return e.key;
  }
  final sym = id.contains(':') ? id.split(':').last : id;
  return sym.endsWith('-USD') ? sym.substring(0, sym.length - 4) : sym;
}

/// The owner's ticker choice, favorites, recents, chart timeframe and indicators, kept on this phone.
class CheTickerPrefs {
  CheTickerPrefs._();
  static final instance = CheTickerPrefs._();
  static const _kLast = 'trading_ticker_last', _kFav = 'trading_ticker_favorites', _kRecent = 'trading_ticker_recents', _kTf = 'trading_ticker_tf', _kInd = 'trading_chart_indicators';

  String last = 'futures:MNQ';
  List<String> favorites = [];
  List<String> recents = [];
  String? timeframe;
  Set<String> indicators = {};
  bool _loaded = false;

  Future<void> load() async {
    if (_loaded) return;
    try {
      final p = await SharedPreferences.getInstance();
      last = p.getString(_kLast) ?? last;
      favorites = p.getStringList(_kFav) ?? favorites;
      recents = p.getStringList(_kRecent) ?? recents;
      timeframe = p.getString(_kTf);
      indicators = (p.getStringList(_kInd) ?? const []).toSet();
    } catch (_) {
      // No storage (a test, a locked keychain): the defaults stand and nothing breaks.
    }
    _loaded = true;
  }

  Future<void> _save() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_kLast, last);
      await p.setStringList(_kFav, favorites);
      await p.setStringList(_kRecent, recents);
      if (timeframe != null) await p.setString(_kTf, timeframe!);
      await p.setStringList(_kInd, indicators.toList()..sort());
    } catch (_) {}
  }

  Future<void> choose(String id) {
    last = id;
    recents = [id, ...recents.where((r) => r != id)].take(8).toList();
    return _save();
  }

  Future<bool> toggleFavorite(String id) async {
    final on = !favorites.contains(id);
    favorites = on ? [...favorites, id] : favorites.where((f) => f != id).toList();
    await _save();
    return on;
  }

  Future<void> setTimeframe(String tf) {
    timeframe = tf;
    return _save();
  }

  Future<void> setIndicators(Set<String> on) {
    indicators = {...on};
    return _save();
  }

  /// Tests start from a clean slate.
  @visibleForTesting
  void reset() {
    last = 'futures:MNQ';
    favorites = [];
    recents = [];
    timeframe = null;
    indicators = {};
    _loaded = false;
  }
}

/// The quick chips plus a Search button that opens the full market list.
class CheTickerSelector extends StatelessWidget {
  const CheTickerSelector({super.key, required this.selected, required this.onSelect, required this.baseUrl, required this.headers, this.client});
  final String selected;
  final ValueChanged<String> onSelect;
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;

  @override
  Widget build(BuildContext context) {
    final prefs = CheTickerPrefs.instance;
    // Quick chips, then the owner's favorites, then the current ticker when it is none of those.
    final ids = <String>[...kQuickTickers.values, ...prefs.favorites.where((f) => !kQuickTickers.containsValue(f))];
    if (!ids.contains(selected)) ids.add(selected);
    return SizedBox(
      height: 48,
      child: Row(children: [
        Semantics(
          button: true,
          label: 'Search every market: crypto and futures',
          excludeSemantics: true,
          child: IconButton(
            key: const Key('ticker_search'),
            tooltip: 'Search markets',
            icon: const Icon(Icons.search_rounded, color: Colors.white),
            onPressed: () => unawaited(_openSearch(context)),
          ),
        ),
        Expanded(
          child: ListView(scrollDirection: Axis.horizontal, children: [
            for (final id in ids) Padding(padding: const EdgeInsets.only(right: 6), child: Center(child: _chip(id))),
          ]),
        ),
      ]),
    );
  }

  Widget _chip(String id) {
    final label = tickerLabel(id);
    final on = id == selected;
    final what = id.startsWith('futures:') ? 'futures' : 'crypto';
    return Semantics(
      container: true,
      button: true,
      selected: on,
      label: '$label market${on ? ', selected' : ''}',
      hint: 'Chart $label $what',
      excludeSemantics: true,
      child: ChoiceChip(
        key: Key('market_$label'),
        label: Text(label, style: TextStyle(fontWeight: FontWeight.w800, color: on ? Colors.black : Colors.white)),
        selected: on,
        selectedColor: CheColors.markets,
        onSelected: (_) {
          if (on) return;
          HapticFeedback.selectionClick();
          onSelect(id);
        },
      ),
    );
  }

  Future<void> _openSearch(BuildContext context) async {
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      builder: (_) => CheTickerSearchSheet(baseUrl: baseUrl, headers: headers, client: client, selected: selected),
    );
    if (id != null && id != selected) onSelect(id);
  }
}

/// Search, Crypto/Futures filters, favorites and recents over the Worker's market universe.
class CheTickerSearchSheet extends StatefulWidget {
  const CheTickerSearchSheet({super.key, required this.baseUrl, required this.headers, required this.selected, this.client});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final String selected;

  @override
  State<CheTickerSearchSheet> createState() => _CheTickerSearchSheetState();
}

class _CheTickerSearchSheetState extends State<CheTickerSearchSheet> {
  late final http.Client _http = widget.client ?? http.Client();
  final _field = TextEditingController();
  String _category = '';
  List<Map<String, dynamic>> _results = const [];
  List<String> _problems = const [];
  String _state = 'loading';
  Timer? _debounce;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_search());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _field.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    final seq = ++_seq;
    setState(() => _state = 'loading');
    try {
      final q = {'q': _field.text.trim(), if (_category.isNotEmpty) 'category': _category, 'limit': '60'};
      final r = await _http.get(Uri.parse('${widget.baseUrl()}/api/markets/universe').replace(queryParameters: q), headers: widget.headers()).timeout(const Duration(seconds: 20));
      if (seq != _seq || !mounted) return;
      final j = jsonDecode(r.body);
      if (r.statusCode != 200 || j is! Map || j['ok'] != true) throw Exception(j is Map ? '${j['error'] ?? j['detail'] ?? r.statusCode}' : '${r.statusCode}');
      setState(() {
        _results = [for (final x in (j['results'] as List? ?? const [])) if (x is Map<String, dynamic>) x];
        _problems = [for (final p in (j['problems'] as List? ?? const [])) '$p'];
        _state = 'ready';
      });
    } catch (e) {
      if (seq != _seq || !mounted) return;
      setState(() {
        _state = 'error';
        _problems = ['The market list could not be loaded: ${'$e'.replaceFirst('Exception: ', '')}'];
      });
    }
  }

  void _typed(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () => unawaited(_search()));
  }

  Widget _filter(String id, String label) {
    final on = _category == id;
    return Semantics(
      button: true,
      selected: on,
      label: '$label${on ? ', selected' : ''}',
      excludeSemantics: true,
      child: ChoiceChip(
        key: Key('ticker_category_${id.isEmpty ? 'all' : id}'),
        label: Text(label),
        selected: on,
        onSelected: (_) {
          setState(() => _category = id);
          unawaited(_search());
        },
      ),
    );
  }

  Widget _row(Map<String, dynamic> m, [String section = '']) {
    final id = '${m['id']}';
    final prefs = CheTickerPrefs.instance;
    final fav = prefs.favorites.contains(id);
    final futures = m['category'] == 'futures';
    final title = '${m['symbol']} · ${m['name']}';
    final sub = futures ? '${m['exchange']} · front month ${m['contract'] ?? 'unknown'} · delayed research data' : '${m['market']}';
    return ListTile(
      key: Key('ticker_row_$section$id'),
      selected: id == widget.selected,
      title: Text(title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 16)),
      subtitle: Text(sub, style: TextStyle(color: CheColors.textDim, fontSize: 13)),
      onTap: () {
        HapticFeedback.selectionClick();
        Navigator.of(context).pop(id);
      },
      trailing: IconButton(
        tooltip: fav ? 'Remove ${m['symbol']} from favorites' : 'Add ${m['symbol']} to favorites',
        icon: Icon(fav ? Icons.star_rounded : Icons.star_border_rounded, color: fav ? CheColors.markets : Colors.white70),
        onPressed: () async {
          await prefs.toggleFavorite(id);
          if (mounted) setState(() {});
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final prefs = CheTickerPrefs.instance;
    final byId = {for (final r in _results) '${r['id']}': r};
    final recents = _field.text.trim().isEmpty && _category.isEmpty ? prefs.recents.where(byId.containsKey).toList() : const <String>[];
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(left: 16, right: 16, top: 12, bottom: MediaQuery.viewInsetsOf(context).bottom + 12),
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.8,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Semantics(header: true, child: const Text('Choose a market', style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800))),
            const SizedBox(height: 8),
            TextField(
              key: const Key('ticker_query'),
              controller: _field,
              autofocus: false,
              textCapitalization: TextCapitalization.characters,
              style: const TextStyle(color: Colors.white, fontSize: 17),
              decoration: const InputDecoration(labelText: 'Search by ticker or name', hintText: 'BTC, gold, ES', prefixIcon: Icon(Icons.search_rounded)),
              onChanged: _typed,
              onSubmitted: (_) => unawaited(_search()),
            ),
            const SizedBox(height: 8),
            Wrap(spacing: 8, children: [_filter('', 'All'), _filter('crypto', 'Crypto'), _filter('futures', 'Futures')]),
            if (_problems.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(_problems.join(' · '), key: const Key('ticker_problems'), style: const TextStyle(color: CheColors.markets, fontSize: 13)),
              ),
            const SizedBox(height: 6),
            Expanded(
              child: _state == 'loading' && _results.isEmpty
                  ? const Center(child: Text('Loading markets…', style: TextStyle(color: Colors.white70, fontSize: 15)))
                  : _results.isEmpty
                      ? const Center(child: Text('No market matches.', style: TextStyle(color: Colors.white70, fontSize: 15)))
                      : ListView(children: [
                          if (prefs.favorites.any(byId.containsKey) && _field.text.trim().isEmpty) ...[
                            const _SheetHeader('FAVORITES'),
                            for (final id in prefs.favorites) if (byId[id] != null) _row(byId[id]!, 'favorite_'),
                          ],
                          if (recents.isNotEmpty) ...[
                            const _SheetHeader('RECENT'),
                            for (final id in recents) _row(byId[id]!, 'recent_'),
                          ],
                          _SheetHeader(_field.text.trim().isEmpty ? 'ALL MARKETS' : 'RESULTS'),
                          for (final r in _results) _row(r),
                        ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _SheetHeader extends StatelessWidget {
  const _SheetHeader(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 10, bottom: 4),
        child: Semantics(header: true, child: Text(text, style: const TextStyle(color: CheColors.markets, fontWeight: FontWeight.w800, letterSpacing: 1.2, fontSize: 12))),
      );
}
