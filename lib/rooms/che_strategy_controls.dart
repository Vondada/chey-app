// Strategy Control Center (owner, 2026-10-20): the owner's limits on CHE's forward-paper
// strategies, read from and changed through the Worker's /api/trading/controls
// (server/cloudflare/trading_controls.js), which enforces them where entries happen.
//
// PAPER only. Every change goes to the Worker, which audits it; a change that raises risk comes
// back as a confirmation sheet with its impact and is sent again only on the owner's confirm.
// Emergency Stop acts at once and shows what it stopped and what remains open. The screen is
// silent on open; every control has a spoken label and a voice route ("pause the ICT strategy").
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_help.dart';
import '../che_ui/che_theme.dart';

const _up = Color(0xFF3DDC97);
const _down = Color(0xFFFF5C7A);
const _gold = CheColors.markets;
final _dim = CheColors.textDim;
final _panel = CheColors.surface;
final _stroke = CheColors.stroke;

const kReadControlsAloud = 'What are my trading limits?';

/// The Control Center's help, from what its controls really do (trading_controls.js).
const kStrategyControlsHelp = CheHelpTopic(
  title: 'Strategy Control Center',
  summary: 'Your limits on CHE\'s paper strategies. Paper only; live trading is off.',
  items: [
    CheControlHelp(name: 'Emergency Stop', does: 'Blocks new entries for every strategy at once, cancels unfilled paper orders in CHE\'s simulations and on Alpaca PAPER, and lists the positions that stay open', caution: 'It does not close positions; Flatten does that, after you confirm', say: 'emergency stop'),
    CheControlHelp(name: 'Pause all', does: 'Pauses every strategy: no new entries. Open positions keep their stops and targets', say: 'pause every strategy'),
    CheControlHelp(name: 'Stop new entries', does: 'Stops new entries for every strategy while leaving each one\'s settings as they are', say: 'stop all new entries'),
    CheControlHelp(name: 'Flatten', does: 'Closes every open paper position and cancels unfilled paper orders', caution: 'It asks you to confirm first', say: 'flatten my paper positions'),
    CheControlHelp(name: 'Restore previous settings', does: 'Puts back the settings from before your last change', say: 'restore the previous settings'),
    CheControlHelp(name: 'Strategy switch', does: 'Pauses or resumes one strategy', caution: 'Resuming lets it trade again, so CHE confirms first', say: 'pause the ICT strategy'),
    CheControlHelp(name: 'Maximum trades per day', does: 'The most entries a strategy may take in one CME trading day; the default is 30. It is a ceiling, never a target: CHE never trades to fill it', caution: 'Raising it shows the impact and needs your confirmation', say: 'set every strategy to 30 per day'),
    CheControlHelp(name: 'Contracts per trade', does: 'The size of each new entry in MNQ contracts, applied from the next entry', caution: 'Raising it raises dollar risk per trade and needs your confirmation'),
    CheControlHelp(name: 'Skip reasons', does: 'Shows a strategy\'s rules, its paper and backtest results, and why recent signals were skipped or blocked', say: 'why did this strategy skip that trade'),
    CheControlHelp(name: 'Audit trail', does: 'Every change: who made it, when, and what it did'),
  ],
);

/// The ranges the Worker accepts (trading_controls.js RANGES); the steppers stay inside them.
const kControlRanges = <String, (int, int)>{
  'max_per_day': (0, 200),
  'qty': (1, 10),
  'max_daily_loss': (50, 20000),
  'max_open_positions': (1, 60),
  'max_order_qty': (1, 1000),
  'cooldown_min': (0, 240),
};
const kControlLabels = <String, String>{
  'max_per_day': 'Maximum trades per day',
  'qty': 'Contracts per trade',
  'max_daily_loss': 'Maximum daily loss, dollars',
  'max_open_positions': 'Maximum open positions',
  'max_order_qty': 'Maximum order size',
  'cooldown_min': 'Cooldown after a trade, minutes',
};
const _steps = <String, int>{'max_per_day': 1, 'qty': 1, 'max_daily_loss': 50, 'max_open_positions': 1, 'max_order_qty': 10, 'cooldown_min': 5};

Color _stateColor(String s) => switch (s) {
      'running' => _up,
      'paused' || 'entries stopped' || 'waiting for data' || 'engine off' => _gold,
      _ => _down,
    };

class CheStrategyControlsPanel extends StatefulWidget {
  const CheStrategyControlsPanel({super.key, required this.baseUrl, required this.headers, required this.onAsk, this.client, this.refresh = const Duration(seconds: 30)});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;
  final http.Client? client;
  final Duration refresh;

  @override
  State<CheStrategyControlsPanel> createState() => _CheStrategyControlsPanelState();
}

class _CheStrategyControlsPanelState extends State<CheStrategyControlsPanel> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _v;
  String _error = '';
  String _result = '';
  bool _busy = false;
  final Set<String> _open = {};
  Timer? _timer;
  Object? _help;

  @override
  void initState() {
    super.initState();
    _help = CheHelp.register(context, () => kStrategyControlsHelp);
    _load();
    _timer = Timer.periodic(widget.refresh, (_) => _load());
  }

  @override
  void dispose() {
    CheHelp.unregister(_help);
    _timer?.cancel();
    super.dispose();
  }

  Uri get _uri => Uri.parse('${widget.baseUrl()}/api/trading/controls');

  Future<void> _load() async {
    try {
      final r = await _http.get(_uri, headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map) {
        setState(() => _error = j is Map ? '${j['detail'] ?? 'HTTP ${r.statusCode}'}' : 'HTTP ${r.statusCode}');
        return;
      }
      setState(() { _v = j.cast<String, dynamic>(); _error = ''; });
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not reach CHE ($e)');
    }
  }

  /// Sends one change. A risk increase comes back as needs_confirmation and is sent again only
  /// after the owner confirms in the sheet.
  Future<void> _change(Map<String, dynamic> change, {bool confirm = false}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await _http
          .post(_uri, headers: {...widget.headers(), 'Content-Type': 'application/json'}, body: jsonEncode({'change': change, 'confirm': confirm, 'who': 'owner (iPhone)'}))
          .timeout(const Duration(seconds: 30));
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (!mounted || j is! Map) return;
      final m = j.cast<String, dynamic>();
      if (m['view'] is Map) _v = (m['view'] as Map).cast<String, dynamic>();
      setState(() { _busy = false; _result = '${m['spoken'] ?? m['error'] ?? ''}'; });
      if (m['needs_confirmation'] == true) {
        final yes = await _confirm(m);
        if (yes == true) await _change(change, confirm: true);
        return;
      }
      if (change['kind'] == 'emergency_stop') {
        HapticFeedback.heavyImpact();
      } else {
        HapticFeedback.selectionClick();
      }
      if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(_result)));
    } catch (e) {
      if (mounted) setState(() { _busy = false; _result = 'Nothing changed: CHE could not be reached ($e).'; });
    } finally {
      if (mounted && _busy) setState(() => _busy = false);
    }
  }

  Future<bool?> _confirm(Map<String, dynamic> m) => showModalBottomSheet<bool>(
        context: context,
        backgroundColor: _panel,
        builder: (ctx) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Semantics(header: true, child: const Text('This raises risk', style: TextStyle(color: _gold, fontSize: 20, fontWeight: FontWeight.w800))),
              const SizedBox(height: 8),
              for (final s in (m['summary'] as List? ?? const [])) Text('$s', style: const TextStyle(color: Colors.white, fontSize: 16)),
              const SizedBox(height: 8),
              Text('Impact', style: TextStyle(color: _dim, fontWeight: FontWeight.w700)),
              for (final s in (m['impact'] as List? ?? const [])) Text('• $s', style: const TextStyle(color: Colors.white, fontSize: 16)),
              const SizedBox(height: 6),
              Text('Paper only. Nothing has changed yet.', style: TextStyle(color: _dim)),
              const SizedBox(height: 14),
              Row(children: [
                Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep as is'))),
                const SizedBox(width: 12),
                Expanded(child: FilledButton(style: FilledButton.styleFrom(backgroundColor: _gold, foregroundColor: Colors.black), onPressed: () => Navigator.pop(ctx, true), child: const Text('Confirm change'))),
              ]),
            ]),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final v = _v;
    return Material(
      color: _panel,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: _stroke)),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Semantics(header: true, child: const Text('Strategy Control Center', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800)))),
            Semantics(label: 'Paper only. Live trading is off.', excludeSemantics: true, child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: _gold.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(6), border: Border.all(color: _gold)),
              child: const Text('PAPER ONLY', style: TextStyle(color: _gold, fontWeight: FontWeight.w800, fontSize: 12)),
            )),
            CheHelpButton(color: _dim, dense: true),
            IconButton(tooltip: 'Read aloud', onPressed: () => widget.onAsk(kReadControlsAloud), icon: Icon(Icons.volume_up, color: _dim)),
          ]),
          if (v == null && _error.isEmpty) Padding(padding: EdgeInsets.all(12), child: Text('Reading your strategy controls…', style: TextStyle(color: _dim))),
          if (_error.isNotEmpty) Text('I could not read the strategy controls: $_error', style: const TextStyle(color: _down)),
          if (v != null) ..._body(v),
        ]),
      ),
    );
  }

  List<Widget> _body(Map<String, dynamic> v) {
    final c = (v['controls'] as Map? ?? const {}).cast<String, dynamic>();
    final rows = (v['strategies'] as List? ?? const []).whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
    final emergency = c['emergency'] is Map;
    final stopped = c['stop_new_entries'] == true;
    final pausedAll = c['paused_all'] == true;
    final status = emergency ? 'Emergency Stop is on: no new entries anywhere.' : stopped ? 'New entries are stopped.' : pausedAll ? 'All strategies are paused.' : 'Strategies enter only on their own valid signals.';
    return [
      const SizedBox(height: 6),
      Semantics(liveRegion: false, label: 'Status: $status', excludeSemantics: true,
          child: Text(status, style: TextStyle(color: emergency ? _down : (stopped || pausedAll) ? _gold : _up, fontWeight: FontWeight.w700))),
      const SizedBox(height: 4),
      Text('A daily maximum is a ceiling, never a target: CHE never trades to fill it.', style: TextStyle(color: _dim, fontSize: 12)),
      const SizedBox(height: 10),
      Wrap(spacing: 8, runSpacing: 8, children: [
        _button(emergency ? 'Emergency Stop is on' : 'Emergency Stop', Icons.stop_circle, _down, emergency ? null : () => _change({'kind': 'emergency_stop'}),
            hint: 'Blocks new entries, cancels unfilled paper orders, and lists the positions that stay open.', help: 'Emergency Stop'),
        _button(pausedAll ? 'Resume all' : 'Pause all', pausedAll ? Icons.play_arrow : Icons.pause, _gold, () => _change({'kind': pausedAll ? 'resume' : 'pause', 'scope': 'all'}), help: 'Pause all'),
        _button(stopped || emergency ? 'Allow new entries' : 'Stop new entries', Icons.block, _gold, () => _change({'kind': stopped || emergency ? 'allow_entries' : 'stop_entries'}), help: 'Stop new entries'),
        _button('Flatten', Icons.horizontal_rule, _down, () => _change({'kind': 'flatten'}), hint: 'Closes every open paper position after you confirm.'),
        if (v['can_restore'] == true) _button('Restore previous settings', Icons.undo, _dim, () => _change({'kind': 'restore'})),
      ]),
      if (_result.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_result, style: const TextStyle(color: Colors.white, fontSize: 15))),
      const SizedBox(height: 12),
      const Text('Strategies', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
      for (final r in rows) _strategy(r),
      if ((v['ict_concepts'] as List? ?? const []).isNotEmpty) ...[
        const SizedBox(height: 12),
        const Text('ICT concepts', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
        for (final k in (v['ict_concepts'] as List).whereType<Map>())
          Semantics(
            label: '${k['name']}: ${k['implemented'] == true ? 'implemented in ${(k['strategies'] as List).length} strategies' : 'not implemented'}',
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text('${k['implemented'] == true ? 'Implemented' : 'Not implemented'} · ${k['name']}${k['implemented'] == true ? '' : ' — ${k['note']}'}',
                  style: TextStyle(color: k['implemented'] == true ? _up : _gold, fontSize: 13)),
            ),
          ),
      ],
      const SizedBox(height: 12),
      const Text('Account limits', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
      for (final f in ['max_daily_loss', 'max_open_positions', 'max_order_qty', 'cooldown_min'])
        _stepper(kControlLabels[f]!, (c['account'] as Map? ?? const {})[f], f, null),
      const SizedBox(height: 12),
      const CheHelpTarget(name: 'Audit trail', child: Text('Audit trail', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700))),
      if ((v['audit'] as List? ?? const []).isEmpty) Text('No changes yet: every strategy is at its default.', style: TextStyle(color: _dim)),
      for (final a in (v['audit'] as List? ?? const []).whereType<Map>().take(12))
        Semantics(
          label: '${a['at']}, ${a['who']}: ${a['summary']}',
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text('${_when(a['at'])} · ${a['who']} · ${a['summary']}', style: TextStyle(color: _dim, fontSize: 13)),
          ),
        ),
    ];
  }

  String _when(Object? iso) {
    final t = DateTime.tryParse('${iso ?? ''}')?.toLocal();
    if (t == null) return '—';
    String two(int n) => n.toString().padLeft(2, '0');
    return '${t.month}/${t.day} ${two(t.hour)}:${two(t.minute)}';
  }

  Widget _button(String label, IconData icon, Color color, VoidCallback? onTap, {String? hint, String? help}) => CheHelpTarget(name: help ?? label, child: Semantics(
        button: true,
        label: label,
        hint: hint,
        excludeSemantics: true,
        child: OutlinedButton.icon(
          onPressed: _busy ? null : onTap,
          style: OutlinedButton.styleFrom(foregroundColor: color, side: BorderSide(color: color.withValues(alpha: 0.7)), minimumSize: const Size(44, 44)),
          icon: Icon(icon, size: 18),
          label: Text(label),
        ),
      ));

  Widget _strategy(Map<String, dynamic> r) {
    final id = '${r['id']}';
    final state = '${r['state']}';
    final paused = state == 'paused';
    final disabled = r['disabled'] == true;
    final open = _open.contains(id);
    final skips = (r['recent_skips'] as List? ?? const []).whereType<Map>().toList();
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: _stroke)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Semantics(
              label: '${r['name']}${r['family'] == 'ICT' ? ', ICT group' : ''}. $state. ${r['entries_today']} of ${r['max_per_day']} entries today. ${'${r['state_reason'] ?? ''}'.isNotEmpty ? r['state_reason'] : r['data_label'] ?? ''}'.trim(),
              excludeSemantics: true,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${r['name']}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 15)),
                Text('${r['family']} · $state · ${r['entries_today']} of ${r['max_per_day']} entries today · ${r['signals_today'] ?? 0} valid signals today · ${r['skipped_total']} blocked',
                    style: TextStyle(color: _stateColor(state), fontSize: 12)),
                // Why a strategy that is switched on is not evaluating, or the delayed data it evaluates (never "live").
                if ('${r['state_reason'] ?? ''}'.isNotEmpty || '${r['data_label'] ?? ''}'.isNotEmpty)
                  Text('${r['state_reason'] ?? ''}'.isNotEmpty ? '${r['state_reason']}' : '${r['data_label']}',
                      key: Key('strategy_data_$id'), style: const TextStyle(color: Colors.white70, fontSize: 12)),
              ]),
            ),
          ),
          Semantics(
            label: paused ? 'Resume ${r['name']}' : 'Pause ${r['name']}',
            toggled: !paused,
            excludeSemantics: true,
            child: CheHelpTarget(name: 'Strategy switch', child: Switch(value: !paused && !disabled, onChanged: disabled || _busy ? null : (on) => _change({'kind': on ? 'resume' : 'pause', 'scope': id}))),
          ),
        ]),
        _stepper(kControlLabels['max_per_day']!, r['max_per_day'], 'max_per_day', id),
        _stepper(kControlLabels['qty']!, r['qty'], 'qty', id),
        Row(children: [
          Semantics(
            button: true,
            label: open ? 'Hide rules and skip reasons for ${r['name']}' : 'Show rules, results and skip reasons for ${r['name']}',
            excludeSemantics: true,
            child: CheHelpTarget(name: 'Skip reasons', child: TextButton(onPressed: () => setState(() => open ? _open.remove(id) : _open.add(id)), child: Text(open ? 'Hide details' : 'Rules, results, skips (${skips.length})'))),
          ),
          const Spacer(),
          Semantics(
            button: true,
            label: disabled ? 'Enable ${r['name']}' : 'Disable ${r['name']} (override)',
            excludeSemantics: true,
            child: TextButton(onPressed: _busy ? null : () => _change({'kind': disabled ? 'enable' : 'disable', 'scope': id}), child: Text(disabled ? 'Enable' : 'Disable', style: TextStyle(color: disabled ? _up : _down))),
          ),
        ]),
        if (open) ..._registry(r),
        if (open && skips.isEmpty) Text('No skipped signal on record. A strategy enters only on its own valid signal.', style: TextStyle(color: _dim, fontSize: 13)),
        if (open)
          for (final k in skips) Text('${_when(k['time'])} · ${k['variant'] ?? ''} · ${k['side']} · ${k['reason']}', style: TextStyle(color: _dim, fontSize: 13)),
      ]),
    );
  }

  List<Widget> _registry(Map<String, dynamic> r) {
    final paper = (r['paper'] as Map? ?? const {});
    final bt = r['backtest'] is Map ? (r['backtest'] as Map) : null;
    final ict = (r['ict_concepts'] as List? ?? const []);
    Widget line(String k, Object? v) => Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text.rich(TextSpan(children: [
            TextSpan(text: '$k: ', style: TextStyle(color: _dim, fontWeight: FontWeight.w700)),
            TextSpan(text: '$v', style: const TextStyle(color: Colors.white)),
          ]), style: const TextStyle(fontSize: 13)),
        );
    final trades = paper['trades'] ?? 0;
    return [
      if (r['rules'] != null) line('Rules', r['rules']),
      if (r['target'] != null) line('Target', r['target']),
      if (r['exit'] != null) line('Exit', r['exit']),
      if (r['timeframe'] != null) line('Timeframe', r['timeframe']),
      if (r['data'] != null) line('Data', r['data']),
      if ((r['variants'] as List? ?? const []).isNotEmpty) line('Variants', (r['variants'] as List).join('; ')),
      if (ict.isNotEmpty) line('ICT concepts in its rules', ict.join('; ')),
      line('Forward paper', trades == 0
          ? 'no closed trades yet'
          : '$trades trades, ${paper['wins']} wins, ${paper['losses']} losses, net ${paper['net_pnl']} dollars, expectancy ${paper['expectancy_r']} R${paper['enough'] == true ? '' : ' (fewer than ${paper['min_trades']} trades: too few to judge)'}'),
      line('Backtest', bt == null
          ? 'not run yet'
          : (bt['variants'] as List? ?? const []).whereType<Map>().map((v) => '${v['variant']}: ${v['trades']} trades, expectancy ${v['expectancy_r']} R${v['oos_trades'] == null ? '' : ', out of sample ${v['oos_trades']} trades at ${v['oos_expectancy_r']} R'}').join('; ')),
      const SizedBox(height: 4),
      Text('Skip reasons', style: TextStyle(color: _dim, fontWeight: FontWeight.w700, fontSize: 13)),
    ];
  }

  Widget _stepper(String label, Object? value, String field, String? scope) {
    final n = value is num ? value.toInt() : int.tryParse('$value') ?? 0;
    final (lo, hi) = kControlRanges[field]!;
    final step = _steps[field]!;
    void set(int to) => _change({'kind': 'set', 'scope': scope ?? 'all', 'field': field, 'value': to.clamp(lo, hi)});
    final who = scope == null ? 'account' : 'this strategy';
    return CheHelpTarget(name: label, child: Row(children: [
      Expanded(child: Text(label, style: TextStyle(color: _dim, fontSize: 13))),
      Semantics(button: true, label: 'Decrease $label for $who, now $n', excludeSemantics: true,
          child: IconButton(onPressed: _busy || n <= lo ? null : () => set(n - step), icon: const Icon(Icons.remove_circle_outline, color: Colors.white))),
      Semantics(label: '$label: $n', excludeSemantics: true, child: SizedBox(width: 56, child: Text('$n', textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)))),
      Semantics(button: true, label: 'Increase $label for $who, now $n', excludeSemantics: true,
          child: IconButton(onPressed: _busy || n >= hi ? null : () => set(n + step), icon: const Icon(Icons.add_circle_outline, color: Colors.white))),
    ]));
  }
}

/// The Control Center as its own page: "Emergency stop" or "pause the ICT strategy" by voice opens it.
class CheStrategyControlsPage extends StatelessWidget {
  const CheStrategyControlsPage({super.key, required this.baseUrl, required this.headers, required this.onAsk});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String prompt) onAsk;

  static Route<void> route({required String Function() baseUrl, required Map<String, String> Function() headers, required void Function(String) onAsk}) =>
      MaterialPageRoute(builder: (_) => CheStrategyControlsPage(baseUrl: baseUrl, headers: headers, onAsk: onAsk), settings: const RouteSettings(name: 'trading_controls'));

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(
          backgroundColor: Colors.black,
          foregroundColor: Colors.white,
          title: const Text('Strategy Control Center'),
          actions: const [CheHelpButton()],
          leading: IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
        ),
        body: SafeArea(child: SingleChildScrollView(padding: const EdgeInsets.all(12), child: CheStrategyControlsPanel(baseUrl: baseUrl, headers: headers, onAsk: onAsk))),
      );
}
