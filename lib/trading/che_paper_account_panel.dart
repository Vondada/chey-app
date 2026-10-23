// CHE PAPER ACCOUNT in the Trading Room (owner, 2026-10-23): the balance, every CHE paper position,
// a detail view per trade, the balance history and the journal. Everything shown is read from the
// paper engine's records (che_paper_engine.dart); nothing here computes a result of its own.
// Every figure is labelled CHE PAPER ACCOUNT and "simulated"; status is shown as words and icons,
// never colour alone. Silent: it speaks only when the owner presses Read aloud.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import 'che_market_feed.dart';
import 'che_paper_account.dart';
import 'che_paper_engine.dart';

const _gold = CheColors.markets;
const _up = CheColors.success;
const _down = CheColors.danger;
const _warn = CheColors.warning;
final _dim = CheColors.textDim;
final _panel = CheColors.surface;
final _stroke = CheColors.stroke;

String cheMoney(double? x) => x == null ? '—' : '${x < 0 ? '−' : ''}\$${x.abs().toStringAsFixed(2)}';
String _signed(double? x) => x == null ? '—' : '${x > 0 ? '+' : ''}${cheMoney(x)}';
String _px(double? x) => x == null ? '—' : x.toStringAsFixed(2);
String _when(DateTime? t) {
  if (t == null) return '—';
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}:${two(l.second)}';
}

String cheDuration(Duration? d) {
  if (d == null) return '—';
  if (d.inHours >= 1) return '${d.inHours} h ${d.inMinutes % 60} min';
  if (d.inMinutes >= 1) return '${d.inMinutes} min ${d.inSeconds % 60} s';
  return '${d.inSeconds} s';
}

/// The label every CHE paper figure carries.
class ChePaperBadge extends StatelessWidget {
  const ChePaperBadge({super.key});
  @override
  Widget build(BuildContext context) => Semantics(
        label: 'CHE PAPER ACCOUNT, simulated, not a broker account',
        excludeSemantics: true,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(border: Border.all(color: _gold), borderRadius: BorderRadius.circular(6)),
          child: const Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.science_outlined, size: 14, color: _gold),
            SizedBox(width: 4),
            Text('$kChePaperLabel · SIMULATED', style: TextStyle(color: _gold, fontSize: 11.5, fontWeight: FontWeight.w800, letterSpacing: 0.8)),
          ]),
        ),
      );
}

/// Status as icon + words (colour only reinforces it).
({IconData icon, Color color}) _statusLook(ChePositionStatus s) => switch (s) {
      ChePositionStatus.pendingEntry => (icon: Icons.hourglass_top, color: _warn),
      ChePositionStatus.open => (icon: Icons.play_circle_outline, color: _gold),
      ChePositionStatus.targetHit => (icon: Icons.flag, color: _up),
      ChePositionStatus.stopped => (icon: Icons.block, color: _down),
      ChePositionStatus.closed => (icon: Icons.check_circle_outline, color: Colors.white70),
      ChePositionStatus.cancelled => (icon: Icons.cancel_outlined, color: Colors.white70),
      ChePositionStatus.unresolved => (icon: Icons.help_outline, color: _warn),
    };

/// Loads the phone's CHE paper account (or a given one) and keeps it attached to the live feed.
class ChePaperAccountPanel extends StatefulWidget {
  const ChePaperAccountPanel({super.key, this.engine, this.feed, this.onRead, this.compact = false});

  /// Tests pass an engine; the app uses ChePaperEngine.shared().
  final ChePaperEngine? engine;
  final CheMarketFeed? feed;
  final void Function(String text)? onRead;

  /// The ACCOUNT section shows only the balance and its controls.
  final bool compact;

  /// "Set CHE paper balance to 500" by voice: the panel opens the confirmation with this amount.
  static final requestedBalance = ValueNotifier<double?>(null);

  @override
  State<ChePaperAccountPanel> createState() => _ChePaperAccountPanelState();
}

class _ChePaperAccountPanelState extends State<ChePaperAccountPanel> {
  ChePaperEngine? _engine;
  String _error = '';
  String _filter = 'open';
  StreamSubscription<CheMarketSnapshot>? _feedSub;
  static bool _attached = false;

  @override
  void initState() {
    super.initState();
    _load();
    ChePaperAccountPanel.requestedBalance.addListener(_onVoiceBalance);
  }

  Future<void> _load() async {
    try {
      final e = widget.engine ?? await ChePaperEngine.shared();
      if (widget.engine == null && !_attached) {
        // One app-wide subscription: live Rithmic prices reach CHE's paper trades.
        _attached = true;
        e.attach(widget.feed ?? CheMarketFeed.instance);
      } else if (widget.engine != null && widget.feed != null) {
        _feedSub = e.attach(widget.feed!);
      }
      if (!mounted) return;
      setState(() => _engine = e);
      e.addListener(_changed);
      _onVoiceBalance();
    } catch (err) {
      ChePaperEngine.forgetShared();
      if (mounted) setState(() => _error = 'The CHE paper account could not load on this phone ($err). No figures are shown rather than guessed ones.');
    }
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _onVoiceBalance() {
    final amount = ChePaperAccountPanel.requestedBalance.value;
    if (amount == null || _engine == null || !mounted) return;
    ChePaperAccountPanel.requestedBalance.value = null;
    scheduleMicrotask(() {
      if (mounted) _changeBalance(presetAmount: amount, presetType: CheBalanceChangeType.simulationSetting);
    });
  }

  @override
  void dispose() {
    _engine?.removeListener(_changed);
    _feedSub?.cancel();
    ChePaperAccountPanel.requestedBalance.removeListener(_onVoiceBalance);
    super.dispose();
  }

  String _summary(ChePaperEngine e) {
    final s = e.snapshot();
    final open = e.openPositions;
    return [
      '$kChePaperLabel, simulated.',
      'Balance ${cheMoney(s.balance)}, starting balance ${cheMoney(s.startingBalance)}, equity ${cheMoney(s.equity)}, available ${cheMoney(s.available)}.',
      'Realized P and L ${_signed(s.realizedPnl)}, unrealized ${_signed(s.unrealizedPnl)}, open risk ${cheMoney(s.openRisk)}, drawdown ${cheMoney(s.drawdown)}.',
      if (open.isEmpty) 'No open CHE paper positions.' else '${open.length} open: ${open.map(_positionWords).join(' ')}',
    ].join(' ');
  }

  String _positionWords(ChePaperPosition p) =>
      '${p.side.label} ${p.qty} ${p.contract.root}, ${p.status.label}, entry ${_px(p.entry)}, stop ${_px(p.stop)}, target ${_px(p.target)}, unrealized ${_signed(p.unrealizedPnl)}.';

  Future<void> _changeBalance({double? presetAmount, CheBalanceChangeType? presetType}) async {
    final e = _engine;
    if (e == null) return;
    final result = await showDialog<String>(
      context: context,
      builder: (_) => _BalanceDialog(engine: e, presetAmount: presetAmount, presetType: presetType),
    );
    if (result == null || !mounted) return;
    HapticFeedback.mediumImpact();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result)));
  }

  Future<void> _changeLimits() async {
    final e = _engine;
    if (e == null) return;
    final result = await showDialog<String>(context: context, builder: (_) => _LimitsDialog(engine: e));
    if (result == null || !mounted) return;
    HapticFeedback.mediumImpact();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result)));
  }

  @override
  Widget build(BuildContext context) {
    if (_error.isNotEmpty) {
      return _card(Text(_error, key: const Key('paper_error'), style: const TextStyle(color: Colors.white, fontSize: 15)));
    }
    final e = _engine;
    if (e == null) return _card(Text('Loading the CHE paper account…', style: TextStyle(color: _dim)));
    final s = e.snapshot();
    final feed = (widget.feed ?? CheMarketFeed.instance).current;
    return _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 10, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
        Semantics(header: true, child: const Text('CHE PAPER ACCOUNT', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16))),
        const ChePaperBadge(),
      ]),
      const SizedBox(height: 6),
      Semantics(
        label: 'Price source for paper fills: ${feed.sourceLabel}, ${feed.statusLabel}',
        excludeSemantics: true,
        child: Row(children: [
          Icon(feed.isLive ? Icons.sensors : Icons.sensors_off, size: 16, color: feed.isLive ? _up : _warn),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              feed.isLive
                  ? 'Fills use ${feed.sourceLabel} (${feed.statusLabel}).'
                  : 'No live Rithmic prices (${feed.statusLabel}): CHE paper orders wait; delayed prices never fill them.',
              key: const Key('paper_feed_status'),
              style: TextStyle(color: feed.isLive ? Colors.white : _warn, fontSize: 13.5),
            ),
          ),
        ]),
      ),
      const SizedBox(height: 10),
      _figures(s),
      const SizedBox(height: 10),
      Wrap(spacing: 8, runSpacing: 8, children: [
        _button(key: 'paper_change_balance', icon: Icons.account_balance_wallet_outlined, label: 'Change CHE paper balance', onTap: _changeBalance),
        _button(key: 'paper_limits', icon: Icons.tune, label: 'Risk limits', onTap: _changeLimits),
        if (widget.onRead != null) _button(key: 'paper_read', icon: Icons.volume_up_outlined, label: 'Read aloud', onTap: () => widget.onRead!(_summary(e))),
      ]),
      const SizedBox(height: 8),
      _riskNote(e, s),
      if (!widget.compact) ...[
        const SizedBox(height: 12),
        _equityChart(e),
        const SizedBox(height: 12),
        _positionsView(e),
        _journal(e),
      ],
      _balanceHistory(e),
    ]));
  }

  // A Material (not a coloured box) so the expansion tiles inside keep their ink.
  Widget _card(Widget child) => Material(
        color: _panel,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: _stroke)),
        child: Padding(padding: const EdgeInsets.all(14), child: SizedBox(width: double.infinity, child: child)),
      );

  Widget _button({required String key, required IconData icon, required String label, required VoidCallback onTap}) => Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: OutlinedButton.icon(
          key: Key(key),
          onPressed: onTap,
          icon: Icon(icon, color: _gold, size: 18),
          label: Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
          style: OutlinedButton.styleFrom(side: const BorderSide(color: _gold), minimumSize: const Size(44, 44)),
        ),
      );

  Widget _figures(ChePaperSnapshot s) {
    final tiles = <(String, String, String)>[
      ('Current balance', cheMoney(s.balance), 'paper_balance'),
      ('Starting balance', cheMoney(s.startingBalance), 'paper_starting'),
      ('Available', cheMoney(s.available), 'paper_available'),
      ('Equity', cheMoney(s.equity), 'paper_equity'),
      ('Unrealized P&L', _signed(s.unrealizedPnl), 'paper_unrealized'),
      ('Realized P&L (this period)', _signed(s.realizedPnl), 'paper_realized'),
      ('Total open risk', '${cheMoney(s.openRisk)} · ${s.totalRiskPct.toStringAsFixed(1)}%', 'paper_risk'),
      ('Drawdown', '${cheMoney(s.drawdown)} · ${s.drawdownPct.toStringAsFixed(1)}% (max ${cheMoney(s.maxDrawdown)})', 'paper_drawdown'),
      if (s.netDeposits != 0) ('Net deposits this period', _signed(s.netDeposits), 'paper_deposits'),
    ];
    return LayoutBuilder(builder: (context, c) {
      final cols = c.maxWidth > 640 ? 4 : 2;
      final w = (c.maxWidth - (cols - 1) * 8) / cols;
      return Wrap(spacing: 8, runSpacing: 8, children: [
        for (final (label, value, key) in tiles)
          Semantics(
            label: '$kChePaperLabel $label: $value',
            excludeSemantics: true,
            child: Container(
              key: Key(key),
              width: w,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(12)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: TextStyle(color: _dim, fontSize: 12.5)),
                const SizedBox(height: 2),
                Text(value, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16, fontFeatures: [FontFeature.tabularFigures()])),
              ]),
            ),
          ),
      ]);
    });
  }

  /// Plain words on what the balance allows (owner, 2026-10-23): one MNQ point is $2, so a typical
  /// 15–25 point stop risks $30–50 plus costs. Figures come from the engine's own risk formula.
  Widget _riskNote(ChePaperEngine e, ChePaperSnapshot s) {
    final cap = s.equity * e.limits.maxRiskPerTradePct / 100;
    final r15 = e.riskPerContract(CheContractSpec.mnq, 0, 15), r25 = e.riskPerContract(CheContractSpec.mnq, 0, 25);
    final fixed = e.riskPerContract(CheContractSpec.mnq, 0, 0);
    final maxStop = (cap - fixed) / CheContractSpec.mnq.pointValue;
    int pct(double r) => s.equity <= 0 ? 0 : (r / s.equity * 100).round();
    final fits = maxStop >= 15;
    final text = [
      'On MNQ one point is \$2. A typical 15–25 point stop risks ${cheMoney(r15)}–${cheMoney(r25)} with costs: ${pct(r15)}–${pct(r25)}% of this ${cheMoney(s.equity)} account on one trade.',
      'The per-trade limit is ${e.limits.maxRiskPerTradePct.toStringAsFixed(e.limits.maxRiskPerTradePct % 1 == 0 ? 0 : 1)}% (${cheMoney(cap)}), so ${maxStop <= 0 ? 'no MNQ stop fits' : 'stops up to ${maxStop.toStringAsFixed(1)} points fit'}.',
      if (!fits) 'Setups that need more are logged "skipped: risk exceeds limit" — never traded anyway and never made to fit by moving the stop. A larger simulated balance or a higher limit is your choice.',
    ].join(' ');
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Icon(fits ? Icons.info_outline : Icons.warning_amber_rounded, size: 18, color: fits ? _dim : _warn),
      const SizedBox(width: 6),
      Expanded(child: Text(text, key: const Key('paper_risk_note'), style: TextStyle(color: fits ? _dim : _warn, fontSize: 13.5))),
    ]);
  }

  Widget _equityChart(ChePaperEngine e) {
    final pts = [...e.equityPoints, CheEquityPoint(DateTime.now(), e.snapshot().equity, 'Now')];
    final first = pts.first.equity, last = pts.last.equity;
    return Semantics(
      label: '$kChePaperLabel equity progression: ${pts.length - 1} recorded points, from ${cheMoney(first)} to ${cheMoney(last)} now.',
      excludeSemantics: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Equity progression', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        SizedBox(key: const Key('paper_equity_chart'), height: 120, width: double.infinity, child: CustomPaint(painter: _LinePainter([for (final p in pts) p.equity]))),
      ]),
    );
  }

  Widget _positionsView(ChePaperEngine e) {
    final list = switch (_filter) {
      'open' => e.openPositions,
      'closed' => e.closedPositions,
      _ => e.positions,
    }.reversed.toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Semantics(header: true, child: const Text('CHE positions', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 15))),
      const SizedBox(height: 6),
      Wrap(spacing: 6, children: [
        for (final f in const ['open', 'closed', 'all'])
          ChoiceChip(
            key: Key('paper_filter_$f'),
            label: Text(switch (f) { 'open' => 'Open', 'closed' => 'Closed', _ => 'All' }),
            selected: _filter == f,
            onSelected: (_) => setState(() => _filter = f),
          ),
      ]),
      const SizedBox(height: 6),
      if (list.isEmpty)
        Text(
          _filter == 'open' ? 'No open CHE paper positions. CHE opens one only from a READY or TRIGGERED setup on live Rithmic prices.' : 'No CHE paper positions here yet.',
          key: const Key('paper_no_positions'),
          style: TextStyle(color: _dim, fontSize: 14),
        ),
      for (final p in list.take(50)) _positionRow(e, p),
    ]);
  }

  Widget _positionRow(ChePaperEngine e, ChePaperPosition p) {
    final look = _statusLook(p.status);
    final now = DateTime.now();
    final pnl = p.status.isOpen ? p.unrealizedPnl : p.netPnl;
    final rows = <(String, String)>[
      ('Direction', '${p.side.label} ${p.qty} ${p.contract.root}'),
      ('Entry', _px(p.entry)),
      ('Current', _px(p.status.isOpen ? p.lastPrice : p.exitRaw)),
      ('Stop', _px(p.stop)),
      ('Target', _px(p.target)),
      ('Unrealized', p.status.isOpen ? _signed(p.unrealizedPnl) : '—'),
      ('Realized', p.status.isOpen ? '—' : _signed(p.netPnl)),
      ('Risk', cheMoney(p.riskDollars)),
      ('Reward', cheMoney(p.rewardDollars)),
      ('Time in trade', cheDuration(p.entryAt == null ? null : (p.exitAt ?? now).difference(p.entryAt!))),
      ('Setup', '${p.signal.strategy} · ${p.signal.timeframe}'),
    ];
    return Semantics(
      button: true,
      label: '$kChePaperLabel position ${p.symbol}: ${_positionWords(p)} Open details.',
      excludeSemantics: true,
      child: InkWell(
        key: Key('paper_position_${p.id}'),
        borderRadius: BorderRadius.circular(12),
        onTap: () => Navigator.of(context).push(ChePaperTradeDetailPage.route(engine: e, positionId: p.id, onRead: widget.onRead)),
        child: Container(
          margin: const EdgeInsets.only(top: 8),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(border: Border.all(color: look.color.withValues(alpha: 0.6)), borderRadius: BorderRadius.circular(12)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(p.side == CheSide.long ? Icons.north_east : Icons.south_east, color: Colors.white, size: 18),
              const SizedBox(width: 6),
              Expanded(child: Text('${p.symbol} · ${p.side.label}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 15))),
              Icon(look.icon, color: look.color, size: 18),
              const SizedBox(width: 4),
              Text(p.status.label, style: TextStyle(color: look.color, fontWeight: FontWeight.w700)),
            ]),
            const SizedBox(height: 4),
            Wrap(spacing: 14, runSpacing: 2, children: [
              for (final (k, v) in rows) Text('$k $v', style: const TextStyle(color: Colors.white, fontSize: 13.5, fontFeatures: [FontFeature.tabularFigures()])),
            ]),
            if (p.gaps.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('Feed gap${p.gaps.length == 1 ? '' : 's'} during this trade: stop/target status unknown for ${p.gaps.length == 1 ? 'that window' : 'those windows'}.',
                    style: const TextStyle(color: _warn, fontSize: 13)),
              ),
            if (pnl != null) ...[
              const SizedBox(height: 4),
              Text('${p.status.isOpen ? 'Unrealized' : 'Net'} ${_signed(pnl)} ${pnl >= 0 ? '(gain)' : '(loss)'}',
                  style: TextStyle(color: pnl >= 0 ? _up : _down, fontWeight: FontWeight.w800)),
            ],
          ]),
        ),
      ),
    );
  }

  Widget _journal(ChePaperEngine e) => ExpansionTile(
        key: const Key('paper_journal'),
        tilePadding: EdgeInsets.zero,
        iconColor: Colors.white,
        collapsedIconColor: Colors.white70,
        title: Text('CHE paper journal (${e.journal.length})', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        children: [
          if (e.journal.isEmpty) Text('Nothing journaled yet.', style: TextStyle(color: _dim)),
          for (final j in e.journal.reversed.take(30))
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text('${_when(j.at)} · ${j.kind.replaceAll('_', ' ')} — ${j.text}', style: const TextStyle(color: Colors.white, fontSize: 13.5)),
            ),
        ],
      );

  Widget _balanceHistory(ChePaperEngine e) => ExpansionTile(
        key: const Key('paper_balance_history'),
        tilePadding: EdgeInsets.zero,
        iconColor: Colors.white,
        collapsedIconColor: Colors.white70,
        title: Text('Balance history (${e.balanceHistory.length})', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        subtitle: Text('Kept permanently; changes never rewrite closed trades.', style: TextStyle(color: _dim, fontSize: 12.5)),
        children: [
          for (final b in e.balanceHistory.reversed)
            Semantics(
              label: '${b.type.label}: ${cheMoney(b.previous)} to ${cheMoney(b.next)} on ${_when(b.at)}${b.reason.isEmpty ? '' : ', reason ${b.reason}'}',
              excludeSemantics: true,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(children: [
                  Expanded(
                    child: Text('#${b.seq} ${b.type.label}: ${cheMoney(b.previous)} → ${cheMoney(b.next)}${b.reason.isEmpty ? '' : ' — ${b.reason}'}',
                        style: const TextStyle(color: Colors.white, fontSize: 13.5)),
                  ),
                  Text(_when(b.at), style: TextStyle(color: _dim, fontSize: 12)),
                ]),
              ),
            ),
        ],
      );
}

/// Change the CHE paper balance: choose the kind, the amount and a reason, see exactly what changes, then confirm.
class _BalanceDialog extends StatefulWidget {
  const _BalanceDialog({required this.engine, this.presetAmount, this.presetType});
  final ChePaperEngine engine;
  final double? presetAmount;
  final CheBalanceChangeType? presetType;
  @override
  State<_BalanceDialog> createState() => _BalanceDialogState();
}

class _BalanceDialogState extends State<_BalanceDialog> {
  late CheBalanceChangeType _type = widget.presetType ?? CheBalanceChangeType.simulationSetting;
  late final _amount = TextEditingController(text: widget.presetAmount == null ? '' : widget.presetAmount!.toStringAsFixed(2));
  final _reason = TextEditingController();
  bool _reviewing = false;
  String _error = '';

  double? get _value => double.tryParse(_amount.text.replaceAll(RegExp(r'[,\$\s]'), ''));

  String _effect(ChePaperSnapshot s) {
    final v = _value ?? 0;
    return switch (_type) {
      CheBalanceChangeType.deposit => 'Deposit ${cheMoney(v)}: balance ${cheMoney(s.balance)} → ${cheMoney(s.balance + v)}. Starting balance stays ${cheMoney(s.startingBalance)}; deposits are not counted as profit.',
      CheBalanceChangeType.withdrawal => 'Withdraw ${cheMoney(v)}: balance ${cheMoney(s.balance)} → ${cheMoney(s.balance - v)}. Withdrawals are not counted as losses.',
      CheBalanceChangeType.reset => 'Reset: balance and starting balance become ${cheMoney(v)}, and P&L and drawdown start a new period. Earlier trades and their results are kept unchanged.',
      CheBalanceChangeType.simulationSetting => 'Simulation setting: balance ${cheMoney(s.balance)} → ${cheMoney(v)} (the difference is recorded as a deposit-like adjustment, not profit). Starting balance stays ${cheMoney(s.startingBalance)}.',
      CheBalanceChangeType.initial => '',
    };
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.engine.snapshot();
    final amountLabel = _type == CheBalanceChangeType.deposit || _type == CheBalanceChangeType.withdrawal ? 'Amount in dollars' : 'New balance in dollars';
    return AlertDialog(
      backgroundColor: _panel,
      title: const Text('Change CHE paper balance', style: TextStyle(color: Colors.white)),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const ChePaperBadge(),
          const SizedBox(height: 8),
          Text('Current balance ${cheMoney(s.balance)}, available ${cheMoney(s.available)}.', style: const TextStyle(color: Colors.white)),
          const SizedBox(height: 8),
          if (!_reviewing) ...[
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final t in const [CheBalanceChangeType.simulationSetting, CheBalanceChangeType.deposit, CheBalanceChangeType.withdrawal, CheBalanceChangeType.reset])
                ChoiceChip(key: Key('balance_type_${t.name}'), label: Text(t.label), selected: _type == t, onSelected: (_) => setState(() => _type = t)),
            ]),
            const SizedBox(height: 6),
            Text('Optional presets (simulation settings, recorded in the history):', style: TextStyle(color: _dim, fontSize: 12.5)),
            Wrap(spacing: 6, children: [
              for (final v in const [2500.0, 50000.0])
                ActionChip(
                  key: Key('balance_preset_${v.toInt()}'),
                  label: Text(v == 2500 ? '\$2,500' : '\$50,000 (prop-style)'),
                  onPressed: () => setState(() {
                    _type = CheBalanceChangeType.simulationSetting;
                    _amount.text = v.toStringAsFixed(2);
                  }),
                ),
            ]),
            TextField(
              key: const Key('balance_amount'),
              controller: _amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              style: const TextStyle(color: Colors.white),
              decoration: InputDecoration(labelText: amountLabel, labelStyle: TextStyle(color: _dim)),
            ),
            TextField(
              key: const Key('balance_reason'),
              controller: _reason,
              style: const TextStyle(color: Colors.white),
              decoration: InputDecoration(labelText: 'Reason (optional)', labelStyle: TextStyle(color: _dim)),
            ),
          ] else
            Text(_effect(s), key: const Key('balance_effect'), style: const TextStyle(color: Colors.white, fontSize: 15)),
          if (_error.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error, key: const Key('balance_error'), style: const TextStyle(color: _warn))),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        if (!_reviewing)
          FilledButton(
            key: const Key('balance_review'),
            onPressed: () {
              final v = _value;
              if (v == null || v <= 0) return setState(() => _error = 'Enter an amount above zero.');
              setState(() {
                _error = '';
                _reviewing = true;
              });
            },
            child: const Text('Review'),
          )
        else
          FilledButton(
            key: const Key('balance_confirm'),
            onPressed: () {
              final refused = widget.engine.changeBalance(type: _type, amount: _value!, reason: _reason.text, confirmed: true);
              if (refused != null) return setState(() => _error = refused);
              final b = widget.engine.balanceHistory.last;
              Navigator.of(context).pop('CHE paper balance: ${b.type.label}, ${cheMoney(b.previous)} → ${cheMoney(b.next)}. Recorded in the balance history.');
            },
            child: const Text('Confirm change'),
          ),
      ],
    );
  }
}

/// Per-trade, open and daily-loss limits as % of equity, and the contract cap. Confirmed, audited.
class _LimitsDialog extends StatefulWidget {
  const _LimitsDialog({required this.engine});
  final ChePaperEngine engine;
  @override
  State<_LimitsDialog> createState() => _LimitsDialogState();
}

class _LimitsDialogState extends State<_LimitsDialog> {
  late final l = widget.engine.limits;
  late final _trade = TextEditingController(text: '${l.maxRiskPerTradePct}');
  late final _open = TextEditingController(text: '${l.maxOpenRiskPct}');
  late final _daily = TextEditingController(text: '${l.maxDailyLossPct}');
  late final _contracts = TextEditingController(text: '${l.maxContracts}');
  String _error = '';

  Widget _field(String key, String label, TextEditingController c) => TextField(
        key: Key(key),
        controller: c,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        style: const TextStyle(color: Colors.white),
        decoration: InputDecoration(labelText: label, labelStyle: TextStyle(color: _dim)),
      );

  @override
  Widget build(BuildContext context) => AlertDialog(
        backgroundColor: _panel,
        title: const Text('CHE paper risk limits', style: TextStyle(color: Colors.white)),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const ChePaperBadge(),
            _field('limit_trade', 'Risk per trade, % of equity (default 2)', _trade),
            _field('limit_open', 'Total open risk, % of equity (default 6)', _open),
            _field('limit_daily', 'Daily loss limit, % (default 6)', _daily),
            _field('limit_contracts', 'Most contracts per trade (default 1)', _contracts),
            const SizedBox(height: 6),
            Text('Open trades keep the risk they were opened with. Stops are never moved to fit a limit.', style: TextStyle(color: _dim, fontSize: 12.5)),
            if (_error.isNotEmpty) Text(_error, key: const Key('limits_error'), style: const TextStyle(color: _warn)),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            key: const Key('limits_confirm'),
            onPressed: () {
              final next = ChePaperRiskLimits(
                maxRiskPerTradePct: double.tryParse(_trade.text) ?? -1,
                maxOpenRiskPct: double.tryParse(_open.text) ?? -1,
                maxDailyLossPct: double.tryParse(_daily.text) ?? -1,
                maxContracts: int.tryParse(_contracts.text) ?? 0,
                maxOpenPositions: l.maxOpenPositions,
              );
              final refused = widget.engine.setLimits(next, confirmed: true);
              if (refused != null) return setState(() => _error = refused);
              Navigator.of(context).pop('CHE paper risk limits saved: ${next.maxRiskPerTradePct}% per trade, ${next.maxOpenRiskPct}% open, ${next.maxDailyLossPct}% daily loss.');
            },
            child: const Text('Confirm limits'),
          ),
        ],
      );
}

/// One CHE paper trade: its price path with entry, stop and target, the setup then and now,
/// progress, adjustments and journal.
class ChePaperTradeDetailPage extends StatefulWidget {
  const ChePaperTradeDetailPage({super.key, required this.engine, required this.positionId, this.onRead});
  final ChePaperEngine engine;
  final String positionId;
  final void Function(String text)? onRead;

  static Route<void> route({required ChePaperEngine engine, required String positionId, void Function(String)? onRead}) =>
      MaterialPageRoute<void>(builder: (_) => ChePaperTradeDetailPage(engine: engine, positionId: positionId, onRead: onRead));

  @override
  State<ChePaperTradeDetailPage> createState() => _ChePaperTradeDetailPageState();
}

class _ChePaperTradeDetailPageState extends State<ChePaperTradeDetailPage> {
  @override
  void initState() {
    super.initState();
    widget.engine.addListener(_changed);
  }

  @override
  void dispose() {
    widget.engine.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  String _words(ChePaperPosition p, DateTime now) {
    final s = p.signal;
    return [
      '$kChePaperLabel, simulated. ${s.side.label} ${p.qty} ${p.contract.root}, ${p.status.label}.',
      'Setup ${s.strategy} on ${s.timeframe}. Entry ${_px(p.entry)}, stop ${_px(p.stop)}, target ${_px(p.target)}.',
      if (p.lastPrice != null) 'Last price ${_px(p.lastPrice)}: ${_px(p.distanceToTargetPoints)} points to target, ${_px(p.distanceToStopPoints)} points to stop.',
      if (p.status.isOpen) 'Unrealized ${_signed(p.unrealizedPnl)}.' else 'Net result ${_signed(p.netPnl)}.',
      'Trade age ${cheDuration(p.age(now))}.',
      if (p.adjustments.isNotEmpty) '${p.adjustments.length} adjustment${p.adjustments.length == 1 ? '' : 's'}.',
    ].join(' ');
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.engine.position(widget.positionId);
    final now = DateTime.now();
    if (p == null) {
      return Scaffold(appBar: AppBar(title: const Text('CHE paper trade')), body: const Center(child: Text('This CHE paper trade is not in the records.')));
    }
    final look = _statusLook(p.status);
    final s = p.signal;
    final journal = widget.engine.journal.where((j) => j.positionId == p.id).toList();
    Widget section(String title, List<Widget> children) => Padding(
          padding: const EdgeInsets.only(top: 14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Semantics(header: true, child: Text(title, style: const TextStyle(color: _gold, fontWeight: FontWeight.w800, fontSize: 14, letterSpacing: 0.6))),
            const SizedBox(height: 6),
            ...children,
          ]),
        );
    Widget line(String k, String v) => Semantics(
          label: '$k: $v',
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 3),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 150, child: Text(k, style: TextStyle(color: _dim, fontSize: 14))),
              Expanded(child: Text(v, style: const TextStyle(color: Colors.white, fontSize: 14.5, fontFeatures: [FontFeature.tabularFigures()]))),
            ]),
          ),
        );
    Widget condition(ChePaperCondition c) {
      final (icon, color, word) = switch (c.status) {
        'satisfied' => (Icons.check_circle, _up, 'met'),
        'failed' => (Icons.cancel, _down, 'failed'),
        _ => (Icons.radio_button_unchecked, _warn, 'pending'),
      };
      return Semantics(
        label: '${c.name}: $word',
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Row(children: [
            Icon(icon, size: 16, color: color),
            const SizedBox(width: 6),
            Expanded(child: Text('${c.name} — $word', style: const TextStyle(color: Colors.white, fontSize: 14))),
          ]),
        ),
      );
    }

    Widget progress(String label, double? v, Color color, String key) => Semantics(
          label: '$label: ${v == null ? 'unknown' : '${(v * 100).round()} percent'}',
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('$label: ${v == null ? '—' : '${(v * 100).round()}%'}', style: const TextStyle(color: Colors.white, fontSize: 14)),
              const SizedBox(height: 3),
              LinearProgressIndicator(key: Key(key), value: v ?? 0, color: color, backgroundColor: _stroke, minHeight: 8),
            ]),
          ),
        );

    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        backgroundColor: CheColors.bg,
        title: Text('${p.symbol} ${p.side.label} · CHE paper', style: const TextStyle(color: Colors.white)),
        actions: [
          if (widget.onRead != null)
            IconButton(key: const Key('paper_detail_read'), tooltip: 'Read aloud', icon: const Icon(Icons.volume_up_outlined), onPressed: () => widget.onRead!(_words(p, now))),
        ],
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Row(children: [
          const ChePaperBadge(),
          const Spacer(),
          Icon(look.icon, color: look.color, size: 18),
          const SizedBox(width: 4),
          Text(p.status.label, key: const Key('paper_detail_status'), style: TextStyle(color: look.color, fontWeight: FontWeight.w800)),
        ]),
        const SizedBox(height: 10),
        Semantics(
          label: 'Price path of this CHE paper trade from Rithmic trades, with entry ${_px(p.entry)}, stop ${_px(p.stop)} and target ${_px(p.target)} lines.',
          excludeSemantics: true,
          child: SizedBox(
            key: const Key('paper_detail_chart'),
            height: 220,
            width: double.infinity,
            child: CustomPaint(painter: _TradePainter(p)),
          ),
        ),
        if (p.path.isEmpty) Text('No fill yet, so no price path. The chart fills in from live Rithmic trades.', style: TextStyle(color: _dim)),
        section('POSITION', [
          line('Direction', '${s.side.label} ${p.qty} ${p.contract.root} (${p.symbol})'),
          line('Entry', p.entryFill == null ? 'Planned ${_px(s.entry)} — waiting for a Rithmic trade' : '${_px(p.entryFill)} (traded ${_px(p.entryRaw)}) at ${_when(p.entryAt)}'),
          line('Stop / target', '${_px(p.stop)} / ${_px(p.target)}'),
          line('Current price', p.status.isOpen ? '${_px(p.lastPrice)} at ${_when(p.lastPriceAt)}' : 'Closed at ${_px(p.exitFill)} (traded ${_px(p.exitRaw)}) at ${_when(p.exitAt)}'),
          line('Risk / reward', '${cheMoney(p.riskDollars)} / ${cheMoney(p.rewardDollars)} · planned ${p.plannedRewardRisk} : 1 · ${p.riskPctOfEquity}% of equity at entry'),
          line(p.status.isOpen ? 'Unrealized P&L' : 'Net P&L',
              p.status.isOpen ? _signed(p.unrealizedPnl) : p.netPnl == null ? 'No result (${p.status.label.toLowerCase()})' : '${_signed(p.netPnl)} (gross ${_signed(p.grossPnl)}, costs ${cheMoney(p.costDollars)})'),
          line('Trade age', cheDuration(p.entryAt == null ? null : (p.exitAt ?? now).difference(p.entryAt!))),
        ]),
        if (p.status.isOpen && p.lastPrice != null)
          section('PROGRESS', [
            line('To target', '${_px(p.distanceToTargetPoints)} points'),
            line('To stop', '${_px(p.distanceToStopPoints)} points'),
            line('Current R', '${_px(p.currentR)} R (planned ${p.plannedRewardRisk} R)'),
            progress('Progress toward target', p.progressToTarget, _up, 'paper_progress_target'),
            progress('Progress toward invalidation (stop)', p.progressToStop, _down, 'paper_progress_stop'),
            Text('Progress is distance travelled, not a probability; it does not predict the outcome.', style: TextStyle(color: _dim, fontSize: 12.5)),
          ]),
        if (p.gaps.isNotEmpty || p.status == ChePositionStatus.unresolved)
          section('FEED GAPS', [
            for (final g in p.gaps)
              line('${_when(g.from)} – ${_when(g.to)}', 'No live prices for ${cheDuration(g.length)}; price came back at ${_px(g.resumePrice)}. Stop/target status unknown for that window.'),
            if (p.status == ChePositionStatus.unresolved) Text(p.exitReason ?? '', key: const Key('paper_unresolved_reason'), style: const TextStyle(color: _warn, fontSize: 14)),
          ]),
        section('SETUP WHEN THE TRADE WAS TAKEN', [
          line('Setup', '${s.strategy} · ${s.timeframe} · stage ${s.stage}'),
          line('Detected', '${_when(s.detectedAt)} from ${s.dataSource}'),
          if (s.evidence.isNotEmpty) line('Evidence', s.evidence),
          if (s.conditions.isEmpty) Text('The signal recorded no conditions.', style: TextStyle(color: _dim)),
          for (final c in s.conditions) condition(c),
        ]),
        section('SETUP NOW', [
          if (p.currentConditions.isEmpty)
            Text('The signal engine has not re-checked this setup since entry.', key: const Key('paper_no_current_conditions'), style: TextStyle(color: _dim))
          else ...[
            line('Re-checked', _when(p.conditionsAt)),
            for (final c in p.currentConditions) condition(c),
          ],
        ]),
        section('CHANGES CHE MADE', [
          if (p.adjustments.isEmpty) Text('None: the stop and target are as planned.', style: TextStyle(color: _dim)),
          for (final a in p.adjustments) line(_when(a.at), '${a.field} ${_px(a.from)} → ${_px(a.to)}: ${a.reason}'),
        ]),
        section('JOURNAL', [
          if (journal.isEmpty) Text('No journal entries yet.', style: TextStyle(color: _dim)),
          for (final j in journal) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('${_when(j.at)} · ${j.kind.replaceAll('_', ' ')} — ${j.text}', style: const TextStyle(color: Colors.white, fontSize: 14))),
        ]),
        const SizedBox(height: 24),
      ]),
    );
  }
}

class _LinePainter extends CustomPainter {
  _LinePainter(this.values);
  final List<double> values;
  @override
  void paint(Canvas canvas, Size size) {
    if (values.length < 2) return;
    final lo = values.reduce(math.min), hi = values.reduce(math.max);
    final span = (hi - lo).abs() < 1e-9 ? 1.0 : hi - lo;
    final path = Path();
    for (var i = 0; i < values.length; i++) {
      final x = size.width * i / (values.length - 1);
      final y = size.height - (values[i] - lo) / span * (size.height - 8) - 4;
      i == 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    }
    canvas.drawPath(path, Paint()
      ..color = _gold
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2);
  }

  @override
  bool shouldRepaint(_LinePainter old) => old.values != values;
}

class _TradePainter extends CustomPainter {
  _TradePainter(this.p);
  final ChePaperPosition p;
  @override
  void paint(Canvas canvas, Size size) {
    final prices = [for (final q in p.path) q.price, p.entry, p.stop, p.target];
    final lo = prices.reduce(math.min), hi = prices.reduce(math.max);
    final span = (hi - lo).abs() < 1e-9 ? 1.0 : hi - lo;
    const labelW = 96.0;
    final w = size.width - labelW;
    double y(double v) => size.height - (v - lo) / span * (size.height - 16) - 8;
    void level(double v, Color c, String label, {bool dashed = false}) {
      final paint = Paint()
        ..color = c
        ..strokeWidth = 1.5;
      if (dashed) {
        for (var x = 0.0; x < w; x += 10) {
          canvas.drawLine(Offset(x, y(v)), Offset(math.min(x + 6, w), y(v)), paint);
        }
      } else {
        canvas.drawLine(Offset(0, y(v)), Offset(w, y(v)), paint);
      }
      final tp = TextPainter(text: TextSpan(text: '$label ${v.toStringAsFixed(2)}', style: TextStyle(color: c, fontSize: 11, fontWeight: FontWeight.w700)), textDirection: TextDirection.ltr)
        ..layout(maxWidth: labelW - 4);
      tp.paint(canvas, Offset(w + 4, y(v) - tp.height / 2));
    }

    // Different line styles as well as colours: target solid, stop dashed, entry solid white.
    level(p.target, _up, 'TARGET');
    level(p.stop, _down, 'STOP', dashed: true);
    level(p.entry, Colors.white, 'ENTRY');
    if (p.path.length >= 2) {
      final t0 = p.path.first.time.millisecondsSinceEpoch, t1 = p.path.last.time.millisecondsSinceEpoch;
      final dt = math.max(1, t1 - t0);
      final path = Path();
      for (var i = 0; i < p.path.length; i++) {
        final x = w * (p.path[i].time.millisecondsSinceEpoch - t0) / dt;
        i == 0 ? path.moveTo(x, y(p.path[i].price)) : path.lineTo(x, y(p.path[i].price));
      }
      canvas.drawPath(path, Paint()
        ..color = _gold
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2);
    }
  }

  @override
  bool shouldRepaint(_TradePainter old) => true;
}
