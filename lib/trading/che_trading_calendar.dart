// The Trading P&L calendar (owner, 2026-10-24): one month of closed trades, day by day, from
// GET /api/trading/calendar (server/cloudflare/che_calendars.js). Simulation (R), forward paper and broker are
// separate tabs and never added together. Tapping a day lists that day's real trades, journal skips and
// strategy results, and each trade opens its replay by its ledger ID. Below the month, "Is CHE improving?"
// reads GET /api/trading/learning. Nothing here is sample data, and the page is silent until Read This is pressed.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_calendar_grid.dart';
import '../rooms/che_strategy_learning.dart';
import 'che_account_stats.dart';
import 'che_my_trades.dart';
import 'che_trade_compare.dart';
import 'che_trade_replay.dart';

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : {};

const cheTradingCalendarSources = <(String, String)>[('paper', 'Forward paper'), ('sim', 'Simulation (R)'), ('broker', 'Broker')];

/// "+$15.00", "−$1,016.00" or "+1.50 R"; null reads "no trades".
String cheCalendarAmount(Object? v, Object? unit, {bool short = false}) {
  if (v is! num) return short ? '' : 'no trades';
  final sign = v < 0 ? '−' : '+';
  if (unit == 'R') return '$sign${v.abs().toStringAsFixed(short ? 1 : 2)}R';
  final abs = v.abs();
  final whole = abs.truncate().toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return short ? '$sign\$$whole' : '$sign\$$whole.${((abs - abs.truncate()) * 100).round().toString().padLeft(2, '0')}';
}

class CheTradingCalendarPage extends StatefulWidget {
  const CheTradingCalendarPage({super.key, required this.baseUrl, required this.headers, this.client, this.onRead, this.initialMonth = '', this.initialSource = 'paper', this.initialDay = '', this.basis = 'owner'});

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final void Function(String words)? onRead;
  final String initialMonth;
  final String initialSource;
  final String initialDay;
  /// 'owner' (calendar day by exit time) or 'cme' (6 PM New York rollover); the same basis the spoken answer used.
  final String basis;

  static Route<void> route({required String Function() baseUrl, required Map<String, String> Function() headers, void Function(String words)? onRead, String month = '', String source = 'paper', String day = '', String basis = 'owner'}) =>
      MaterialPageRoute(builder: (_) => CheTradingCalendarPage(baseUrl: baseUrl, headers: headers, onRead: onRead, initialMonth: month, initialSource: source, initialDay: day, basis: basis));

  @override
  State<CheTradingCalendarPage> createState() => _CheTradingCalendarPageState();
}

class _CheTradingCalendarPageState extends State<CheTradingCalendarPage> {
  late String _source = cheTradingCalendarSources.any((s) => s.$1 == widget.initialSource) ? widget.initialSource : 'paper';
  late String _month = widget.initialMonth;
  Map<String, dynamic>? _view;
  Map<String, dynamic>? _learning;
  String _error = '';
  bool _loading = true;
  bool _showLearning = false;

  http.Client get _http => widget.client ?? http.Client();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    if (widget.initialDay.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _openDay(widget.initialDay); });
    }
  }

  Future<Map<String, dynamic>> _get(String path) async {
    final res = await _http.get(Uri.parse('${widget.baseUrl()}$path'), headers: widget.headers()).timeout(const Duration(seconds: 25));
    final body = _map(jsonDecode(res.body));
    if (res.statusCode != 200 || body['ok'] != true) throw Exception('${body['detail'] ?? 'The Worker answered ${res.statusCode}.'}');
    return body;
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = ''; });
    try {
      final v = await _get('/api/trading/calendar?source=$_source${_month.isEmpty ? '' : '&month=$_month'}${widget.basis == 'cme' ? '&basis=cme' : ''}');
      if (!mounted) return;
      setState(() { _view = v; _month = '${v['month'] ?? _month}'; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _error = 'The calendar could not be read: ${'$e'.replaceFirst('Exception: ', '')}'; _loading = false; });
    }
  }

  Future<void> _loadLearning() async {
    setState(() => _showLearning = true);
    try {
      final v = await _get('/api/trading/learning');
      if (mounted) setState(() => _learning = v);
    } catch (e) {
      if (mounted) setState(() => _learning = {'rows': [], 'rule': 'The learning windows could not be read: ${'$e'.replaceFirst('Exception: ', '')}'});
    }
  }

  void _shift(String key) {
    final next = '${_view?[key] ?? ''}';
    if (next.isEmpty) return;
    setState(() => _month = next);
    unawaited(_load());
  }

  String _summary() {
    final v = _view;
    if (v == null) return _error.isEmpty ? 'The calendar is loading.' : _error;
    final t = _map(v['totals']);
    if (v['source'] == 'broker') {
      final pnl = (t['trades'] ?? 0) == 0
          ? 'no closing fill'
          : '${t['trades']} closed trades, ${t['wins']} wins, ${t['losses']} losses, realized net ${cheCalendarAmount(t['net'], v['unit'])}';
      return '${v['source_label']}, ${cheMonthLabel('${v['month']}')}: $pnl. ${t['orders'] ?? 0} broker paper orders recorded. ${v['note']}';
    }
    if (v['empty'] == true) return '${v['source_label']}: no trade closed in ${cheMonthLabel('${v['month']}')}.';
    return '${v['source_label']}, ${cheMonthLabel('${v['month']}')}: ${t['trades']} closed trades, ${t['wins']} wins, ${t['losses']} losses, win rate ${t['win_rate']} percent, '
        'net ${cheCalendarAmount(t['net'], v['unit'])}. ${t['green_days']} green days, ${t['red_days']} red, ${t['yellow_days']} near break-even.';
  }

  void _openDay(String date) {
    unawaited(Navigator.of(context).push(MaterialPageRoute(builder: (_) => CheTradingDayPage(
          baseUrl: widget.baseUrl, headers: widget.headers, client: widget.client, onRead: widget.onRead, date: date, source: _source, basis: widget.basis,
        ))));
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final unit = v?['unit'];
    final weeks = cheCalendarRows(v?['weeks']);
    return Scaffold(
      backgroundColor: const Color(0xFF070B0E),
      appBar: AppBar(
        backgroundColor: const Color(0xFF070B0E),
        foregroundColor: Colors.white,
        title: const Text('P&L Calendar'),
        actions: [
          IconButton(tooltip: 'Read this', onPressed: widget.onRead == null ? null : () => widget.onRead!(_summary()), icon: const Icon(Icons.record_voice_over_rounded)),
          IconButton(tooltip: 'Refresh', onPressed: _load, icon: const Icon(Icons.refresh_rounded)),
        ],
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Wrap(spacing: 8, runSpacing: 6, children: [
          for (final (id, label) in cheTradingCalendarSources)
            ChoiceChip(
              key: Key('calendar_source_$id'),
              label: Text(label, style: const TextStyle(fontSize: 15)),
              selected: _source == id,
              onSelected: (_) { setState(() => _source = id); unawaited(_load()); },
            ),
        ]),
        const SizedBox(height: 6),
        if (v != null) Text('${v['note']}', style: const TextStyle(color: Colors.white70, fontSize: 14)),
        if (v != null) Text('${v['basis_label']} · break-even band ±${cheCalendarAmount(_map(v['break_even'])['within'], unit).substring(1)}', style: const TextStyle(color: Colors.white54, fontSize: 13)),
        CheMonthNav(month: _month.isEmpty ? '${v?['month'] ?? ''}' : _month, onPrev: () => _shift('prev'), onNext: () => _shift('next')),
        if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
        if (_error.isNotEmpty) Text(_error, key: const Key('calendar_error'), style: const TextStyle(color: cheCalendarRed, fontSize: 16)),
        if (!_loading && v != null) ...[
          Text(_summary(), key: const Key('calendar_summary'), style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          CheCalendarGrid(
            weeks: weeks,
            cellText: (d) => v['source'] == 'broker' && (d['trades'] ?? 0) == 0
                ? ((d['orders'] ?? 0) == 0 ? '' : '${d['orders']} ord')
                : ((d['trades'] ?? 0) == 0 ? '' : '${cheCalendarAmount(d['net'], unit, short: true)}\n${d['trades']}t'),
            cellLabel: (d) => v['source'] == 'broker' && (d['trades'] ?? 0) == 0
                ? '${cheDayLabel('${d['date']}')}: ${d['orders'] ?? 0} broker paper orders, no closing fill.'
                : (d['trades'] ?? 0) == 0
                    ? '${cheDayLabel('${d['date']}')}: no closed trades.'
                    : '${cheDayLabel('${d['date']}')}: net ${cheCalendarAmount(d['net'], unit)}, ${d['trades']} trades, ${d['wins']} wins, ${d['losses']} losses.',
            onTapDay: _openDay,
          ),
          const SizedBox(height: 10),
          if (v['source'] != 'broker')
            for (final w in weeks)
              if ((w['trades'] ?? 0) > 0)
                Semantics(
                  label: 'Week of ${cheDayLabel('${cheCalendarRows(w['days']).first['date']}')}: net ${cheCalendarAmount(w['net'], unit)}, ${w['trades']} trades, win rate ${w['win_rate']} percent.',
                  excludeSemantics: true,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Text('Week of ${cheDayLabel('${cheCalendarRows(w['days']).first['date']}')}: ${cheCalendarAmount(w['net'], unit)} · ${w['trades']} trades · ${w['wins']}W ${w['losses']}L · ${w['win_rate']}%',
                        style: TextStyle(color: cheCalendarColor((w['net'] is num && (w['net'] as num) < 0) ? 'red' : 'green'), fontSize: 15)),
                  ),
                ),
          if ((v['duplicates_not_counted'] ?? 0) > 0)
            Text('${v['duplicates_not_counted']} duplicate records are kept in storage and not counted.', style: const TextStyle(color: cheCalendarYellow, fontSize: 14)),
        ],
        const Divider(color: cheCalendarStroke, height: 28),
        Semantics(header: true, child: const Text('Is CHE improving?', style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800))),
        if (!_showLearning)
          Align(alignment: Alignment.centerLeft, child: OutlinedButton.icon(key: const Key('calendar_learning'), onPressed: _loadLearning, icon: const Icon(Icons.insights_rounded), label: const Text('Show 7, 30 and 90-day results')))
        else if (_learning == null)
          const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))
        else
          CheLearningWindows(data: _learning!),
      ]),
    );
  }
}

/// One day: its trades (each opening its replay), journal skips and strategy results, with the audit line.
class CheTradingDayPage extends StatefulWidget {
  const CheTradingDayPage({super.key, required this.baseUrl, required this.headers, required this.date, required this.source, this.client, this.onRead, this.basis = 'owner'});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final String date;
  final String source;
  final String basis;
  final http.Client? client;
  final void Function(String words)? onRead;

  @override
  State<CheTradingDayPage> createState() => _CheTradingDayPageState();
}

class _CheTradingDayPageState extends State<CheTradingDayPage> {
  Map<String, dynamic>? _view;
  String _error = '';

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final res = await (widget.client ?? http.Client()).get(Uri.parse('${widget.baseUrl()}/api/trading/calendar?source=${widget.source}&day=${widget.date}${widget.basis == 'cme' ? '&basis=cme' : ''}'), headers: widget.headers()).timeout(const Duration(seconds: 25));
      final body = _map(jsonDecode(res.body));
      if (res.statusCode != 200 || body['ok'] != true) throw Exception('${body['detail'] ?? 'The Worker answered ${res.statusCode}.'}');
      if (mounted) setState(() => _view = body);
    } catch (e) {
      if (mounted) setState(() => _error = 'This day could not be read: ${'$e'.replaceFirst('Exception: ', '')}');
    }
  }

  String _spoken() {
    final v = _view;
    if (v == null) return _error.isEmpty ? 'Loading.' : _error;
    final t = _map(v['totals']);
    if (v['source'] == 'broker') {
      final orders = (v['orders'] as List? ?? []).length;
      final pnl = (t['trades'] ?? 0) == 0
          ? 'no closing fill'
          : '${t['trades']} closed trades, ${t['wins']} wins, ${t['losses']} losses, realized net ${cheCalendarAmount(t['net'], v['unit'])}';
      return '${cheDayLabel(widget.date)}, ${v['source_label']}: $pnl. $orders broker paper orders. ${v['note']}';
    }
    if ((t['trades'] ?? 0) == 0) return '${cheDayLabel(widget.date)}: no trade closed.';
    return '${cheDayLabel(widget.date)}, ${v['source_label']}: ${t['trades']} trades, ${t['wins']} wins, ${t['losses']} losses, net ${cheCalendarAmount(t['net'], v['unit'])}.';
  }

  void _replay(Map<String, dynamic> t) {
    if (t['replay'] == false) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${t['replay_note']}')));
      widget.onRead?.call('${t['replay_note']}');
      return;
    }
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(
      settings: RouteSettings(name: 'trade_replay/${t['id']}'),
      builder: (_) => CheTradeReplayPage(tradeId: '${t['id']}', baseUrl: widget.baseUrl, headers: widget.headers, onRead: widget.onRead, client: widget.client),
    )));
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final unit = v?['unit'];
    final trades = cheCalendarRows(v?['trades']);
    final audit = _map(v?['audit']);
    return Scaffold(
      backgroundColor: const Color(0xFF070B0E),
      appBar: AppBar(
        backgroundColor: const Color(0xFF070B0E),
        foregroundColor: Colors.white,
        title: Text(cheDayLabel(widget.date)),
        actions: [IconButton(tooltip: 'Read this', onPressed: widget.onRead == null ? null : () => widget.onRead!(_spoken()), icon: const Icon(Icons.record_voice_over_rounded))],
      ),
      body: v == null
          ? Center(child: _error.isEmpty ? const CircularProgressIndicator() : Text(_error, style: const TextStyle(color: cheCalendarRed, fontSize: 16)))
          : ListView(padding: const EdgeInsets.all(12), children: [
              Text(_spoken(), key: const Key('day_summary'), style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
              if (v['source'] != 'broker' && audit.isNotEmpty)
                Text('Audit: ${audit['rows']} rows add up to ${cheCalendarAmount(audit['sum'], unit)}; ${audit['duplicates_not_counted']} duplicates not counted. '
                    'By the ${_map(audit['other_basis'])['basis'] == 'cme' ? 'CME trading day' : 'calendar day'}: ${_map(audit['other_basis'])['rows']} rows, ${cheCalendarAmount(_map(audit['other_basis'])['sum'], unit)}.',
                    key: const Key('day_audit'), style: const TextStyle(color: Colors.white70, fontSize: 14)),
              for (final o in cheCalendarRows(v['orders']))
                ListTile(title: Text('${o['side']} ${o['qty']} ${o['symbol']} (${o['type']})', style: const TextStyle(color: Colors.white)), subtitle: Text('${o['status']} · ${o['at']}', style: const TextStyle(color: Colors.white70))),
              if (cheCalendarRows(v['strategies']).isNotEmpty) ...[
                const SizedBox(height: 10),
                Semantics(header: true, child: const Text('Strategies', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
                for (final s in cheCalendarRows(v['strategies']))
                  Text('${s['strategy']}: ${s['trades']} trades, ${s['wins']}W ${s['losses']}L, ${cheCalendarAmount(s['net'], unit)}', style: const TextStyle(color: Colors.white, fontSize: 15)),
              ],
              if (trades.isNotEmpty) ...[
                const SizedBox(height: 10),
                Semantics(header: true, child: const Text('Trades', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
                for (final t in trades)
                  Card(
                    color: cheCalendarPanel,
                    child: ListTile(
                      key: Key('day_trade_${t['id']}'),
                      onTap: () => _replay(t),
                      title: Text('${t['symbol']} ${t['side']} · ${t['strategy']}', style: const TextStyle(color: Colors.white, fontSize: 16)),
                      subtitle: Text('${t['entry_time']} → ${t['exit_time']} · ${t['exit_reason'] ?? ''} · ${t['evidence_label'] ?? ''}\nID ${t['id']}', style: const TextStyle(color: Colors.white70, fontSize: 13)),
                      trailing: Text(unit == 'R' ? cheCalendarAmount(t['r'], 'R') : cheCalendarAmount(t['net'], 'USD'),
                          style: TextStyle(color: cheCalendarColor(t['result'] == 'win' ? 'green' : t['result'] == 'loss' ? 'red' : 'yellow'), fontSize: 16, fontWeight: FontWeight.w700)),
                    ),
                  ),
              ],
              if (cheCalendarRows(v['journal']).isNotEmpty) ...[
                const SizedBox(height: 10),
                Semantics(header: true, child: const Text('Journal: signals skipped', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
                for (final j in cheCalendarRows(v['journal'])) Text('${j['time']} ${j['strategy']}: ${j['reason']}', style: const TextStyle(color: Colors.white70, fontSize: 14)),
              ],
            ]),
    );
  }
}

// ─── The unified P&L calendar (owner, 2026-10-25, Trading Room v3) ──────────────────────────────────────────────
// One month for every market, filtered ALL | FUTURES | CRYPTO over the same dates, from
// GET /api/trading/calendar?view=unified (server/cloudflare/trading_accounts.js), plus the trades the owner entered on
// this phone (MY TRADES). Each day keeps its kinds apart: forward paper and owner trades in dollars, the simulation in
// R; they are never added together. One time zone on screen, New York: futures count on their CME trading date (the
// session opens 6:00 PM New York the evening before), crypto on its New York calendar date. Selecting a date opens
// that day's actual records, each with its replay. Nothing here is sample data.

const cheUnifiedMarkets = <(String, String)>[('all', 'ALL'), ('futures', 'FUTURES'), ('crypto', 'CRYPTO')];
const _kindOrder = ['forward_paper', 'owner', 'simulation'];
const _kindLabel = {'forward_paper': 'Forward paper', 'owner': 'My trades', 'simulation': 'Simulation'};

String _marketOfSymbol(String s) => RegExp(r'^(BTC|XBT|ETH)', caseSensitive: false).hasMatch(s) ? 'crypto' : 'futures';

/// Adds the owner's own closed trades to the Worker's month or day, under their own kind. Returns a new map.
Map<String, dynamic> cheMergeOwnerTrades(Map<String, dynamic> view, List<CheTradeView> mine) {
  final market = '${view['market'] ?? 'all'}';
  final rows = <Map<String, dynamic>>[
    for (final t in mine)
      if (t.closedAt != null && (market == 'all' || _marketOfSymbol(t.symbol) == market))
        {
          'id': t.id, 'kind': 'owner', 'kind_label': 'My trades', 'unit': 'USD', 'symbol': cheContractRoot(t.symbol).isEmpty ? t.symbol : cheContractRoot(t.symbol),
          'market': _marketOfSymbol(t.symbol), 'strategy': t.setup.isEmpty ? 'entered by you' : t.setup, 'side': t.side,
          'entry_time': t.openedAt?.toUtc().toIso8601String(), 'exit_time': t.closedAt!.toUtc().toIso8601String(), 'net': t.realized, 'r': null,
          'result': (t.realized ?? 0) > 0 ? 'win' : ((t.realized ?? 0) < 0 ? 'loss' : 'flat'),
          'date': cheTradeDate(t.closedAt!, _marketOfSymbol(t.symbol)), 'date_basis': _marketOfSymbol(t.symbol) == 'futures' ? 'CME trading date' : 'New York calendar date',
          'replay': false,
        },
  ];
  if (rows.isEmpty) return view;
  final out = jsonDecode(jsonEncode(view)) as Map<String, dynamic>;
  void add(Map<String, dynamic> day, Map<String, dynamic> r) {
    final kinds = day['kinds'] is Map ? Map<String, dynamic>.from(day['kinds'] as Map) : <String, dynamic>{};
    final k = kinds['owner'] is Map ? Map<String, dynamic>.from(kinds['owner'] as Map) : {'label': 'My trades', 'unit': 'USD', 'trades': 0, 'wins': 0, 'losses': 0, 'net': null};
    k['trades'] = (k['trades'] as num) + 1;
    if (r['result'] == 'win') k['wins'] = (k['wins'] as num) + 1;
    if (r['result'] == 'loss') k['losses'] = (k['losses'] as num) + 1;
    if (r['net'] is num) k['net'] = ((((k['net'] as num?) ?? 0) + (r['net'] as num)) * 100).round() / 100;
    kinds['owner'] = k;
    day['kinds'] = kinds;
    day['trades'] = ((day['trades'] as num?) ?? 0) + 1;
    if (r['result'] == 'win') day['wins'] = ((day['wins'] as num?) ?? 0) + 1;
    if (r['result'] == 'loss') day['losses'] = ((day['losses'] as num?) ?? 0) + 1;
    day['instruments'] = ({...((day['instruments'] as List?) ?? const []).map((e) => '$e'), '${r['symbol']}'}.toList()..sort());
    day['strategies'] = ({...((day['strategies'] as List?) ?? const []).map((e) => '$e'), '${r['strategy']}'}.toList()..sort());
  }

  if (out['day'] != null) {
    final list = rows.where((r) => r['date'] == out['day']).toList();
    out['trades'] = [...cheCalendarRows(out['trades']), ...list];
    final totals = out['totals'] is Map ? Map<String, dynamic>.from(out['totals'] as Map) : <String, dynamic>{};
    for (final r in list) {
      add(totals, r);
    }
    out['totals'] = totals;
    return out;
  }
  final weeks = cheCalendarRows(out['weeks']);
  final totals = out['totals'] is Map ? Map<String, dynamic>.from(out['totals'] as Map) : <String, dynamic>{};
  for (final w in weeks) {
    final days = cheCalendarRows(w['days']);
    for (final d in days) {
      for (final r in rows.where((r) => r['date'] == d['date'])) {
        add(d, r);
        add(totals, r);
      }
    }
    w['days'] = days;
  }
  out['weeks'] = weeks;
  out['totals'] = totals;
  if (((totals['trades'] as num?) ?? 0) > 0) out['empty'] = false;
  return out;
}

String _kindAmount(Map<String, dynamic> k) => k['net'] is num ? cheCalendarAmount(k['net'], k['unit']) : 'no result recorded';

/// Each kind on its own line, never summed: "Forward paper: 2 trades, 1W 1L, −$10.00".
List<String> cheKindLines(Object? kinds) {
  final m = kinds is Map ? Map<String, dynamic>.from(kinds) : const <String, dynamic>{};
  return [
    for (final id in _kindOrder)
      if (m[id] is Map)
        '${_kindLabel[id]}: ${(m[id] as Map)['trades']} trade${(m[id] as Map)['trades'] == 1 ? '' : 's'}, ${(m[id] as Map)['wins']}W ${(m[id] as Map)['losses']}L, ${_kindAmount(Map<String, dynamic>.from(m[id] as Map))}',
  ];
}

/// The short text in a day cell: the dollar kinds' first amount, else the R amount, and the trade count.
String cheUnifiedCellText(Map<String, dynamic> d) {
  if (((d['trades'] as num?) ?? 0) == 0) return '';
  final kinds = d['kinds'] is Map ? Map<String, dynamic>.from(d['kinds'] as Map) : const <String, dynamic>{};
  final k = kinds['forward_paper'] ?? kinds['owner'] ?? kinds['simulation'];
  final amount = k is Map && k['net'] is num ? cheCalendarAmount(k['net'], k['unit'], short: true) : '';
  return '$amount\n${d['trades']}t';
}

/// The unified calendar as a card in the Trading Room.
class CheUnifiedCalendar extends StatefulWidget {
  const CheUnifiedCalendar({super.key, required this.baseUrl, required this.headers, this.client, this.onRead, this.myTrades, this.initialMarket = 'all'});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final void Function(String words)? onRead;
  final CheMyTradesStore? myTrades;
  final String initialMarket;

  @override
  State<CheUnifiedCalendar> createState() => _CheUnifiedCalendarState();
}

class _CheUnifiedCalendarState extends State<CheUnifiedCalendar> {
  late String _market = widget.initialMarket;
  String _month = '';
  Map<String, dynamic>? _view;
  String _error = '';
  bool _loading = true;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final seq = ++_seq;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final q = {'view': 'unified', 'market': _market, if (_month.isNotEmpty) 'month': _month};
      final res = await (widget.client ?? http.Client()).get(Uri.parse('${widget.baseUrl()}/api/trading/calendar').replace(queryParameters: q), headers: widget.headers()).timeout(const Duration(seconds: 25));
      final body = _map(jsonDecode(utf8.decode(res.bodyBytes)));
      if (res.statusCode != 200 || body['ok'] != true || body['weeks'] is! List) throw Exception('${body['detail'] ?? 'CHE answered ${res.statusCode}.'}');
      final mine = await (widget.myTrades ?? CheMyTradesStore()).load();
      if (!mounted || seq != _seq) return;
      setState(() {
        _view = cheMergeOwnerTrades(body, mine);
        _month = '${body['month'] ?? _month}';
        _loading = false;
      });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _view = null;
        _error = 'Data unavailable (${'$e'.replaceFirst('Exception: ', '')})';
        _loading = false;
      });
    }
  }

  void _shift(String key) {
    final next = '${_view?[key] ?? ''}';
    if (next.isEmpty) return;
    _month = next;
    unawaited(_load());
  }

  String _summary() {
    final v = _view;
    if (v == null) return _error.isEmpty ? 'The calendar is loading.' : _error;
    final where = cheUnifiedMarkets.firstWhere((m) => m.$1 == _market).$2.toLowerCase();
    final t = _map(v['totals']);
    if (((t['trades'] as num?) ?? 0) == 0) return '${cheMonthLabel('${v['month']}')}, $where: no trade closed. Nothing is shown as a sample.';
    return '${cheMonthLabel('${v['month']}')}, $where, New York time. ${cheKindLines(t['kinds']).join('. ')}. Instruments: ${(t['instruments'] as List? ?? const []).join(', ')}.';
  }

  void _openDay(String date) {
    HapticFeedback.selectionClick();
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(
      settings: RouteSettings(name: 'trading_day/$date'),
      builder: (_) => CheUnifiedDayPage(baseUrl: widget.baseUrl, headers: widget.headers, client: widget.client, onRead: widget.onRead, date: date, market: _market, myTrades: widget.myTrades),
    )));
  }

  String _cellLabel(Map<String, dynamic> d) {
    final n = (d['trades'] as num?) ?? 0;
    if (n == 0) return '${cheDayLabel('${d['date']}')}: no closed trades.';
    return '${cheDayLabel('${d['date']}')}: ${cheKindLines(d['kinds']).join('. ')}. Instruments ${(d['instruments'] as List? ?? const []).join(', ')}. Strategies ${(d['strategies'] as List? ?? const []).join(', ')}. Double tap to open the trades.';
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    return Column(key: const Key('unified_calendar'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Expanded(child: Wrap(spacing: 6, children: [
          for (final (id, label) in cheUnifiedMarkets)
            Semantics(
              button: true,
              selected: _market == id,
              label: 'Calendar filter $label${_market == id ? ', selected' : ''}',
              excludeSemantics: true,
              child: ChoiceChip(
                key: Key('unified_market_$id'),
                label: Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                selected: _market == id,
                onSelected: (_) {
                  if (_market == id) return;
                  HapticFeedback.selectionClick();
                  _market = id;
                  unawaited(_load());
                },
              ),
            ),
        ])),
        if (widget.onRead != null)
          IconButton(key: const Key('unified_read'), tooltip: 'Read the calendar month aloud', onPressed: () => widget.onRead!(_summary()), icon: const Icon(Icons.record_voice_over_rounded, color: Colors.white70)),
      ]),
      Text('New York time · futures by CME trading date (6 PM ET start) · crypto by calendar date · dollars and R never added',
          style: const TextStyle(color: Colors.white60, fontSize: 12.5)),
      CheMonthNav(month: _month.isEmpty ? '${v?['month'] ?? ''}' : _month, onPrev: () => _shift('prev'), onNext: () => _shift('next')),
      if (_loading) const Padding(padding: EdgeInsets.all(16), child: Center(child: SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)))),
      if (!_loading && _error.isNotEmpty) Text(_error, key: const Key('unified_error'), style: const TextStyle(color: cheCalendarRed, fontSize: 15)),
      if (!_loading && v != null) ...[
        Text(_summary(), key: const Key('unified_summary'), style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        CheCalendarGrid(weeks: cheCalendarRows(v['weeks']), cellText: cheUnifiedCellText, cellLabel: _cellLabel, onTapDay: _openDay),
      ],
    ]);
  }
}

/// One day of the unified calendar: its actual records, each labelled with instrument and kind, each opening its replay.
class CheUnifiedDayPage extends StatefulWidget {
  const CheUnifiedDayPage({super.key, required this.baseUrl, required this.headers, required this.date, this.market = 'all', this.client, this.onRead, this.myTrades});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final String date, market;
  final http.Client? client;
  final void Function(String words)? onRead;
  final CheMyTradesStore? myTrades;

  @override
  State<CheUnifiedDayPage> createState() => _CheUnifiedDayPageState();
}

class _CheUnifiedDayPageState extends State<CheUnifiedDayPage> {
  Map<String, dynamic>? _view;
  String _error = '';

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final res = await (widget.client ?? http.Client())
          .get(Uri.parse('${widget.baseUrl()}/api/trading/calendar').replace(queryParameters: {'view': 'unified', 'market': widget.market, 'day': widget.date}), headers: widget.headers())
          .timeout(const Duration(seconds: 25));
      final body = _map(jsonDecode(utf8.decode(res.bodyBytes)));
      if (res.statusCode != 200 || body['ok'] != true) throw Exception('${body['detail'] ?? 'CHE answered ${res.statusCode}.'}');
      final mine = await (widget.myTrades ?? CheMyTradesStore()).load();
      if (mounted) setState(() => _view = cheMergeOwnerTrades(body, mine));
    } catch (e) {
      if (mounted) setState(() => _error = 'This day could not be read: ${'$e'.replaceFirst('Exception: ', '')}');
    }
  }

  String _spoken() {
    final v = _view;
    if (v == null) return _error.isEmpty ? 'Loading.' : _error;
    final t = _map(v['totals']);
    if (((t['trades'] as num?) ?? 0) == 0) return '${cheDayLabel(widget.date)}: no trade closed.';
    return '${cheDayLabel(widget.date)}, New York time. ${cheKindLines(t['kinds']).join('. ')}.';
  }

  void _replay(Map<String, dynamic> t) {
    if (t['replay'] == false) {
      final why = t['kind'] == 'owner' ? 'Trades you entered yourself have no recorded bars to replay.' : 'This trade has no replay.';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(why)));
      widget.onRead?.call(why);
      return;
    }
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(
      settings: RouteSettings(name: 'trade_replay/${t['id']}'),
      builder: (_) => CheTradeReplayPage(tradeId: '${t['id']}', baseUrl: widget.baseUrl, headers: widget.headers, onRead: widget.onRead, client: widget.client),
    )));
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final trades = cheCalendarRows(v?['trades']);
    return Scaffold(
      backgroundColor: const Color(0xFF070B0E),
      appBar: AppBar(
        backgroundColor: const Color(0xFF070B0E),
        foregroundColor: Colors.white,
        title: Text(cheDayLabel(widget.date)),
        leading: IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
        actions: [IconButton(tooltip: 'Read this day aloud', onPressed: widget.onRead == null ? null : () => widget.onRead!(_spoken()), icon: const Icon(Icons.record_voice_over_rounded))],
      ),
      body: v == null
          ? Center(child: _error.isEmpty ? const CircularProgressIndicator() : Text(_error, style: const TextStyle(color: cheCalendarRed, fontSize: 16)))
          : ListView(padding: const EdgeInsets.all(12), children: [
              Text(_spoken(), key: const Key('unified_day_summary'), style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
              const Text('New York time. Futures count on their CME trading date; crypto on the New York calendar date.', style: TextStyle(color: Colors.white60, fontSize: 13)),
              if (trades.isEmpty) const Padding(padding: EdgeInsets.only(top: 12), child: Text('No recorded trades on this date.', style: TextStyle(color: Colors.white70, fontSize: 16))),
              for (final t in trades)
                Card(
                  color: cheCalendarPanel,
                  child: Semantics(
                    button: true,
                    label: '${t['symbol']} ${t['side']}, ${t['kind_label'] ?? t['kind']}, ${t['strategy']}, '
                        '${t['unit'] == 'R' ? cheCalendarAmount(t['r'], 'R') : cheCalendarAmount(t['net'], 'USD')}, ${t['date_basis']}. ${t['replay'] == false ? 'No replay.' : 'Double tap to replay.'}',
                    excludeSemantics: true,
                    child: ListTile(
                      key: Key('unified_trade_${t['id']}'),
                      onTap: () => _replay(t),
                      title: Text('${t['symbol']} · ${(t['kind_label'] ?? t['kind']).toString().toUpperCase()}', style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
                      subtitle: Text('${t['side']} · ${t['strategy']}\n${t['entry_time'] ?? '—'} → ${t['exit_time']}\n${t['date_basis']}${t['exit_reason'] == null ? '' : ' · ${t['exit_reason']}'}',
                          style: const TextStyle(color: Colors.white70, fontSize: 13)),
                      isThreeLine: true,
                      trailing: Text(t['unit'] == 'R' ? cheCalendarAmount(t['r'], 'R') : cheCalendarAmount(t['net'], 'USD'),
                          style: TextStyle(color: cheCalendarColor(t['result'] == 'win' ? 'green' : t['result'] == 'loss' ? 'red' : 'yellow'), fontSize: 16, fontWeight: FontWeight.w800)),
                    ),
                  ),
                ),
            ]),
    );
  }
}
