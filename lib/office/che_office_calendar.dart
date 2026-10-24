// CHE's Office calendar (owner, 2026-10-24): what was done, what is active, what waits and what failed, day by day,
// from GET /api/office/calendar (server/cloudflare/che_calendars.js). Green: everything recorded succeeded; yellow:
// pending or mixed; red: something failed or is blocked. Tapping a day opens its real jobs with their receipts.
// Separate from the trading calendar. Nothing here is sample data, and the page is silent until Read This is pressed.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_calendar_grid.dart';

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : {};

const _stateWords = {'done': 'done', 'active': 'active', 'pending': 'pending', 'failed': 'failed'};

String _countsLine(Map<String, dynamic> c) =>
    '${c['done'] ?? 0} done, ${c['active'] ?? 0} active, ${c['pending'] ?? 0} pending, ${c['failed'] ?? 0} failed';

class CheOfficeCalendarPage extends StatefulWidget {
  const CheOfficeCalendarPage({super.key, required this.baseUrl, required this.headers, this.client, this.onRead, this.onOpenLink, this.initialMonth = '', this.initialDay = ''});

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final void Function(String words)? onRead;

  /// Opens a job, task, objective or approval where the app shows it ({screen, id}); null shows its details here.
  final void Function(Map<String, dynamic> link)? onOpenLink;
  final String initialMonth;
  final String initialDay;

  static Route<void> route({required String Function() baseUrl, required Map<String, String> Function() headers, void Function(String words)? onRead, String month = '', String day = ''}) =>
      MaterialPageRoute(builder: (_) => CheOfficeCalendarPage(baseUrl: baseUrl, headers: headers, onRead: onRead, initialMonth: month, initialDay: day));

  @override
  State<CheOfficeCalendarPage> createState() => _CheOfficeCalendarPageState();
}

class _CheOfficeCalendarPageState extends State<CheOfficeCalendarPage> {
  late String _month = widget.initialMonth;
  Map<String, dynamic>? _view;
  String _error = '';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    if (widget.initialDay.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _openDay(widget.initialDay); });
    }
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = ''; });
    try {
      final res = await (widget.client ?? http.Client()).get(Uri.parse('${widget.baseUrl()}/api/office/calendar${_month.isEmpty ? '' : '?month=$_month'}'), headers: widget.headers()).timeout(const Duration(seconds: 25));
      final body = _map(jsonDecode(res.body));
      if (res.statusCode != 200 || body['ok'] != true) throw Exception('${body['detail'] ?? 'The Worker answered ${res.statusCode}.'}');
      if (!mounted) return;
      setState(() { _view = body; _month = '${body['month'] ?? _month}'; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _error = 'The Office calendar could not be read: ${'$e'.replaceFirst('Exception: ', '')}'; _loading = false; });
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
    if (v == null) return _error.isEmpty ? 'The Office calendar is loading.' : _error;
    if (v['empty'] == true) return 'No Office work is recorded in ${cheMonthLabel('${v['month']}')}.';
    return 'Office, ${cheMonthLabel('${v['month']}')}: ${v['summary']}';
  }

  void _openDay(String date) {
    unawaited(Navigator.of(context).push(MaterialPageRoute(builder: (_) => CheOfficeDayPage(
          baseUrl: widget.baseUrl, headers: widget.headers, client: widget.client, onRead: widget.onRead, onOpenLink: widget.onOpenLink, date: date,
        ))));
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final weeks = cheCalendarRows(v?['weeks']);
    return Scaffold(
      backgroundColor: const Color(0xFF070B0E),
      appBar: AppBar(
        backgroundColor: const Color(0xFF070B0E),
        foregroundColor: Colors.white,
        title: const Text('Office Calendar'),
        actions: [
          IconButton(tooltip: 'Read this', onPressed: widget.onRead == null ? null : () => widget.onRead!(_summary()), icon: const Icon(Icons.record_voice_over_rounded)),
          IconButton(tooltip: 'Refresh', onPressed: _load, icon: const Icon(Icons.refresh_rounded)),
        ],
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Green: all succeeded · Yellow: pending or mixed · Red: failed or blocked', style: TextStyle(color: Colors.white70, fontSize: 14)),
        CheMonthNav(month: _month.isEmpty ? '${v?['month'] ?? ''}' : _month, onPrev: () => _shift('prev'), onNext: () => _shift('next')),
        if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
        if (_error.isNotEmpty) Text(_error, key: const Key('office_calendar_error'), style: const TextStyle(color: cheCalendarRed, fontSize: 16)),
        if (!_loading && v != null) ...[
          Text(_summary(), key: const Key('office_calendar_summary'), style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          CheCalendarGrid(
            weeks: weeks,
            cellText: (d) => (d['total'] ?? 0) == 0 ? '' : '${d['done']}✓ ${d['failed'] ?? 0}✗\n${(d['active'] ?? 0) + (d['pending'] ?? 0)} open',
            cellLabel: (d) => (d['total'] ?? 0) == 0
                ? '${cheDayLabel('${d['date']}')}: nothing recorded.'
                : '${cheDayLabel('${d['date']}')}: ${_countsLine(d)}${(d['approvals'] ?? 0) > 0 ? ', ${d['approvals']} approvals' : ''}${(d['milestones'] ?? 0) > 0 ? ', ${d['milestones']} milestones' : ''}.',
            onTapDay: _openDay,
          ),
          const SizedBox(height: 10),
          for (final w in weeks)
            if ((w['total'] ?? 0) > 0)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Text('Week of ${cheDayLabel('${cheCalendarRows(w['days']).first['date']}')}: ${w['summary']}', style: const TextStyle(color: Colors.white, fontSize: 15)),
              ),
          const SizedBox(height: 6),
          Text('Read from: ${(v['sources'] as List? ?? const []).join('; ')}.', style: const TextStyle(color: Colors.white54, fontSize: 13)),
        ],
      ]),
    );
  }
}

class CheOfficeDayPage extends StatefulWidget {
  const CheOfficeDayPage({super.key, required this.baseUrl, required this.headers, required this.date, this.client, this.onRead, this.onOpenLink});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final String date;
  final http.Client? client;
  final void Function(String words)? onRead;
  final void Function(Map<String, dynamic> link)? onOpenLink;

  @override
  State<CheOfficeDayPage> createState() => _CheOfficeDayPageState();
}

class _CheOfficeDayPageState extends State<CheOfficeDayPage> {
  Map<String, dynamic>? _view;
  String _error = '';
  String _filter = 'all';

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final res = await (widget.client ?? http.Client()).get(Uri.parse('${widget.baseUrl()}/api/office/calendar?day=${widget.date}'), headers: widget.headers()).timeout(const Duration(seconds: 25));
      final body = _map(jsonDecode(res.body));
      if (res.statusCode != 200 || body['ok'] != true) throw Exception('${body['detail'] ?? 'The Worker answered ${res.statusCode}.'}');
      if (mounted) setState(() => _view = body);
    } catch (e) {
      if (mounted) setState(() => _error = 'This day could not be read: ${'$e'.replaceFirst('Exception: ', '')}');
    }
  }

  void _details(Map<String, dynamic> it) {
    final link = _map(it['link']);
    if (widget.onOpenLink != null && link.isNotEmpty) {
      widget.onOpenLink!(link);
      return;
    }
    unawaited(showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF0E1418),
      isScrollControlled: true,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${it['title']}', style: const TextStyle(color: Colors.white, fontSize: 19, fontWeight: FontWeight.w800)),
            Text('${it['agent']} · ${it['type']} · ${it['status']} · ${it['at']}', style: const TextStyle(color: Colors.white70, fontSize: 14)),
            const SizedBox(height: 8),
            Text('Receipt: ${('${it['receipt'] ?? ''}').isEmpty ? 'none recorded' : it['receipt']}', style: const TextStyle(color: Colors.white, fontSize: 15)),
            if ('${it['error'] ?? ''}'.isNotEmpty) Text('Error: ${it['error']}', style: const TextStyle(color: cheCalendarRed, fontSize: 15)),
            for (final o in cheCalendarRows(it['outputs'])) Text('Output: ${o['label'] ?? o['kind']} ${o['url'] ?? o['media_id'] ?? ''}', style: const TextStyle(color: Colors.white70, fontSize: 14)),
            Text('Record: ${it['source']} ${it['id']}', style: const TextStyle(color: Colors.white54, fontSize: 13)),
          ]),
        ),
      ),
    ));
  }

  String _spoken() {
    final v = _view;
    if (v == null) return _error.isEmpty ? 'Loading.' : _error;
    return '${cheDayLabel(widget.date)}: ${v['summary']}';
  }

  @override
  Widget build(BuildContext context) {
    final v = _view;
    final items = cheCalendarRows(v?['items']).where((it) => _filter == 'all' || it['state'] == _filter).toList();
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
              Text(_spoken(), key: const Key('office_day_summary'), style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
              if (v['reliability'] is Map) Text('Reliability ledger: ${_map(v['reliability'])['completed']} completed, ${_map(v['reliability'])['failed']} failed.', style: const TextStyle(color: Colors.white70, fontSize: 14)),
              for (final a in cheCalendarRows(v['accomplishments']))
                Text('${a['agent']} finished ${a['done']}: ${(a['titles'] as List? ?? const []).join('; ')}', style: const TextStyle(color: cheCalendarGreen, fontSize: 15)),
              const SizedBox(height: 8),
              Wrap(spacing: 6, children: [
                for (final f in ['all', ..._stateWords.keys])
                  ChoiceChip(key: Key('office_filter_$f'), label: Text(f), selected: _filter == f, onSelected: (_) => setState(() => _filter = f)),
              ]),
              if (items.isEmpty) const Padding(padding: EdgeInsets.all(12), child: Text('Nothing recorded here.', style: TextStyle(color: Colors.white70, fontSize: 16))),
              for (final it in items)
                Card(
                  color: cheCalendarPanel,
                  child: ListTile(
                    key: Key('office_item_${it['id']}'),
                    onTap: () => _details(it),
                    leading: Icon(
                      it['state'] == 'done' ? Icons.check_circle_rounded : it['state'] == 'failed' ? Icons.error_outline_rounded : Icons.schedule_rounded,
                      color: it['state'] == 'done' ? cheCalendarGreen : it['state'] == 'failed' ? cheCalendarRed : cheCalendarYellow,
                      semanticLabel: '${_stateWords[it['state']] ?? it['state']}',
                    ),
                    title: Text('${it['title']}', style: const TextStyle(color: Colors.white, fontSize: 16)),
                    subtitle: Text('${it['agent']} · ${it['type']} · ${it['status']}${'${it['receipt'] ?? ''}'.isEmpty ? '' : '\n${it['receipt']}'}',
                        maxLines: 3, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70, fontSize: 13)),
                  ),
                ),
            ]),
    );
  }
}
