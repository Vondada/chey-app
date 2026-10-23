// Setup Progress Board (owner, 2026-10-23, items 2, 11–13 and 15): every setup CHE follows on the
// real Rithmic candles, how far along it is, what is satisfied, pending or failed, and the signals.
//
// - Each stage has its own text, icon and colour, so colour is never the only signal.
// - The progress bar shows how far along the path to a trade a setup is, never a chance of profit.
// - Every figure says what it is measured from; evidence shows its sample size or says it is
//   insufficient. Everything here belongs to the CHE PAPER ACCOUNT.
// - Silent on open. "Read setups" reads the summary only when pressed; alerts speak only for the
//   types the owner turned audible in Alert settings.
import 'dart:async';

import 'package:flutter/material.dart';

import '../che_ui/che_theme.dart';
import 'che_setup_desk.dart';
import 'che_trade_alerts.dart';
import 'che_trade_signal.dart';

const _paperTag = CheTradeSignal.account;

IconData cheStageIcon(CheSetupStage s) => switch (s) {
  CheSetupStage.watching => Icons.radio_button_unchecked,
  CheSetupStage.forming => Icons.hourglass_top,
  CheSetupStage.nearEntry => Icons.radio_button_checked,
  CheSetupStage.ready => Icons.check_circle_outline,
  CheSetupStage.triggered => Icons.bolt_rounded,
  CheSetupStage.active => Icons.play_circle_outline,
  CheSetupStage.targetHit => Icons.flag_rounded,
  CheSetupStage.stopped => Icons.block_rounded,
  CheSetupStage.invalidated => Icons.cancel,
  CheSetupStage.expired => Icons.hourglass_empty_rounded,
};

Color cheStageColor(CheSetupStage s) => switch (s) {
  CheSetupStage.watching => const Color(0xFF9AA7B4),
  CheSetupStage.forming => const Color(0xFF7FD3FF),
  CheSetupStage.nearEntry => const Color(0xFFB794F6),
  CheSetupStage.ready => const Color(0xFFFFD166),
  CheSetupStage.triggered => const Color(0xFFFFA94D),
  CheSetupStage.active => const Color(0xFF3DDC97),
  CheSetupStage.targetHit => const Color(0xFF3DDC97),
  CheSetupStage.stopped => const Color(0xFFFF5C7A),
  CheSetupStage.invalidated => const Color(0xFFFF8FA3),
  CheSetupStage.expired => const Color(0xFF9AA7B4),
};

/// Stage badge: icon + words + colour.
class CheStageBadge extends StatelessWidget {
  const CheStageBadge(this.stage, {super.key});
  final CheSetupStage stage;

  @override
  Widget build(BuildContext context) {
    final c = cheStageColor(stage);
    return Semantics(
      label: 'Stage ${stage.label}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: c.withValues(alpha: 0.16),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: c),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(cheStageIcon(stage), size: 16, color: c),
            const SizedBox(width: 4),
            Text(
              stage.label,
              style: TextStyle(color: c, fontWeight: FontWeight.w800, fontSize: 12.5, letterSpacing: 0.6),
            ),
          ],
        ),
      ),
    );
  }
}

String _age(Duration d) => d.inMinutes < 1
    ? 'under a minute'
    : d.inMinutes < 60
    ? '${d.inMinutes} min'
    : '${d.inHours} h ${d.inMinutes % 60} min';
String _p(double? v) => v == null ? '—' : v.toStringAsFixed(2);
String _clock(DateTime? t) {
  if (t == null) return 'never';
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(l.hour)}:${two(l.minute)}:${two(l.second)}';
}

class CheSetupBoard extends StatefulWidget {
  const CheSetupBoard({super.key, required this.desk, this.onRead, DateTime Function()? clock}) : clock = clock ?? DateTime.now;
  final CheSetupDesk desk;

  /// Reads text aloud, only when the owner presses a Read button.
  final void Function(String text)? onRead;
  final DateTime Function() clock;

  @override
  State<CheSetupBoard> createState() => _CheSetupBoardState();
}

class _CheSetupBoardState extends State<CheSetupBoard> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    widget.desk.addListener(_changed);
    widget.desk.alerts.addListener(_changed);
    unawaited(widget.desk.alerts.load());
    // Ages ("first seen 3 min ago") refresh quietly.
    _tick = Timer.periodic(const Duration(seconds: 30), (_) => _changed());
  }

  @override
  void dispose() {
    _tick?.cancel();
    widget.desk.removeListener(_changed);
    widget.desk.alerts.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Widget _feedHeader() {
    final s = widget.desk.snapshot;
    final live = s?.isLive == true;
    final text = s == null ? 'No market feed yet. Setups start when Rithmic candles arrive.' : '${s.sourceLabel} · ${s.statusLabel} · last update ${_clock(s.lastUpdate)}';
    return Semantics(
      label: 'Data: $text',
      excludeSemantics: true,
      child: Row(
        children: [
          Icon(live ? Icons.cloud_rounded : Icons.cloud_off_outlined, color: live ? CheColors.success : CheColors.warning, size: 18),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              key: const Key('setup_feed_header'),
              style: const TextStyle(color: Colors.white, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  Widget _alertBanner() {
    final recent = widget.desk.alerts.recent;
    if (recent.isEmpty) return const SizedBox.shrink();
    final a = recent.first;
    return Container(
      key: const Key('setup_alert_banner'),
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: CheColors.surfaceHi,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: CheColors.warning),
      ),
      child: Row(
        children: [
          const Icon(Icons.notifications_active_outlined, color: CheColors.warning),
          const SizedBox(width: 8),
          Expanded(
            child: Semantics(
              label: 'Alert. ${a.spoken}',
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${a.account} · ${a.title}',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
                  ),
                  Text(
                    a.message,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Colors.white70, fontSize: 13),
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            tooltip: 'Dismiss alert',
            onPressed: () => widget.desk.alerts.dismiss(a),
            icon: const Icon(Icons.close, color: Colors.white70),
          ),
        ],
      ),
    );
  }

  Widget _condition(CheSetupCondition c) {
    final (icon, color, word) = switch (c.state) {
      CheConditionState.satisfied => (Icons.check_rounded, CheColors.success, 'met'),
      CheConditionState.pending => (Icons.more_horiz_rounded, const Color(0xFF7FD3FF), 'pending'),
      CheConditionState.failed => (Icons.close_rounded, CheColors.danger, 'failed'),
      CheConditionState.unavailable => (Icons.remove_rounded, CheColors.textDim, 'not available'),
    };
    return Semantics(
      label: '${c.label}: $word${c.detail.isEmpty ? '' : ', ${c.detail}'}${c.requiredForEntry ? '' : ', for context only'}',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 16, color: color),
            const SizedBox(width: 6),
            Expanded(
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: '${c.label} — $word',
                      style: const TextStyle(color: Colors.white, fontSize: 13),
                    ),
                    if (c.detail.isNotEmpty)
                      TextSpan(
                        text: '  (${c.detail})',
                        style: const TextStyle(color: Colors.white60, fontSize: 12),
                      ),
                    if (!c.requiredForEntry)
                      const TextSpan(
                        text: '  context only',
                        style: TextStyle(color: Colors.white54, fontSize: 12, fontStyle: FontStyle.italic),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _setupCard(CheSetupState s) {
    final now = widget.clock();
    final (have, need) = s.checklist;
    final c = cheStageColor(s.stage);
    final pathStep = s.stage.isFinal ? 'finished' : 'step ${s.stage.index + 1} of ${CheSetupStage.active.index + 1}';
    // A Material (not a decorated box) so the timeline's tile can paint its ink on the card.
    return Padding(
      key: Key('setup_${s.id}'),
      padding: const EdgeInsets.only(top: 10),
      child: Material(
        color: CheColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: c.withValues(alpha: 0.6)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        '${s.strategyName} · ${s.symbol} ${s.timeframeMinutes}m${s.side.isEmpty ? '' : ' · ${s.side.toUpperCase()}'}',
                        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 15),
                      ),
                    ),
                  ),
                  CheStageBadge(s.stage),
                ],
              ),
              const SizedBox(height: 4),
              Text('$_paperTag · ${s.stage.meaning}', style: const TextStyle(color: Colors.white70, fontSize: 12.5)),
              const SizedBox(height: 8),
              Semantics(
                label: 'Setup progress: $pathStep, $have of $need entry conditions met. This is progress toward an entry, not a chance of profit.',
                excludeSemantics: true,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(4),
                      child: LinearProgressIndicator(value: s.stage.progress, minHeight: 8, color: c, backgroundColor: Colors.white12),
                    ),
                    const SizedBox(height: 4),
                    Text('Path to entry: $pathStep · $have of $need entry conditions met', style: const TextStyle(color: Colors.white, fontSize: 12.5)),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              for (final cond in s.conditions) _condition(cond),
              const SizedBox(height: 8),
              Wrap(
                spacing: 12,
                runSpacing: 4,
                children: [
                  _fact('Planned entry', _p(s.plannedEntry)),
                  _fact('Stop', _p(s.plannedStop)),
                  _fact('Target', _p(s.plannedTarget)),
                  _fact('Last price', _p(s.lastPrice)),
                  _fact('From entry', s.distanceToEntry == null ? '—' : '${_p(s.distanceToEntry)} pts'),
                  _fact('From stop', s.distanceToStop == null ? '—' : '${_p(s.distanceToStop)} pts'),
                  _fact('From target', s.distanceToTarget == null ? '—' : '${_p(s.distanceToTarget)} pts'),
                  _fact('First seen', '${_age(s.age(now))} ago'),
                ],
              ),
              const SizedBox(height: 6),
              _line('Market structure', s.marketStructure),
              _line('Trend', s.trend),
              _line('Timeframes', s.timeframeAlignment),
              _line('Evidence', s.evidence.status),
              _line('Data', s.dataSource.isEmpty ? 'waiting for Rithmic candles' : '${s.dataSource}${s.dataLive ? '' : ' (not live right now)'}'),
              if (s.signal != null) _line('Signal', s.signal!.spoken),
              Theme(
                data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  iconColor: Colors.white,
                  collapsedIconColor: Colors.white70,
                  title: Text(
                    'Timeline (${s.timeline.length})',
                    style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700),
                  ),
                  children: [
                    for (final (t, stage, why) in s.timeline.reversed)
                      Semantics(
                        label: '${_clock(t)}, ${stage.label}: $why',
                        excludeSemantics: true,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Icon(cheStageIcon(stage), size: 14, color: cheStageColor(stage)),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text('${_clock(t)} ${stage.label} — $why', style: const TextStyle(color: Colors.white70, fontSize: 12.5)),
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (widget.onRead != null)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(onPressed: () => widget.onRead!(s.spoken(widget.clock())), icon: const Icon(Icons.volume_up_rounded), label: const Text('Read this setup')),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _fact(String k, String v) => Semantics(
    label: '$k: $v',
    excludeSemantics: true,
    child: Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '$k ',
            style: const TextStyle(color: Colors.white60, fontSize: 12),
          ),
          TextSpan(
            text: v,
            style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()]),
          ),
        ],
      ),
    ),
  );

  Widget _line(String k, String v) => Padding(
    padding: const EdgeInsets.only(top: 2),
    child: Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '$k: ',
            style: const TextStyle(color: Colors.white60, fontSize: 12.5),
          ),
          TextSpan(
            text: v,
            style: const TextStyle(color: Colors.white, fontSize: 12.5),
          ),
        ],
      ),
    ),
  );

  Widget _signals() {
    final list = widget.desk.signals;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 14),
        Semantics(
          header: true,
          child: Text(
            'SIGNALS · $_paperTag',
            style: const TextStyle(color: CheColors.markets, fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1),
          ),
        ),
        if (list.isEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('No signals yet. A signal appears only when a closed candle meets every entry rule.', style: TextStyle(color: Colors.white70, fontSize: 13)),
          ),
        for (final sig in list.take(10))
          Semantics(
            label: sig.spoken,
            excludeSemantics: true,
            child: Container(
              margin: const EdgeInsets.only(top: 6),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: CheColors.surface,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFFFFA94D)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${sig.strategyName} · ${sig.side.toUpperCase()} ${sig.symbol} ${sig.timeframeMinutes}m · ${_clock(sig.signalTime)}',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
                  ),
                  Text(
                    'Entry ${_p(sig.entry)} · Stop ${_p(sig.stop)} · Target ${_p(sig.target)} · R:R ${sig.rewardRisk?.toStringAsFixed(1) ?? '—'}',
                    style: const TextStyle(color: Colors.white, fontSize: 13, fontFeatures: [FontFeature.tabularFigures()]),
                  ),
                  Text('Data: ${sig.dataSource}${sig.dataLive ? '' : ' (not live)'} · Evidence: ${sig.evidence.status}', style: const TextStyle(color: Colors.white70, fontSize: 12.5)),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Future<void> _settings() => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: CheColors.surface,
    builder: (_) => CheAlertSettingsSheet(alerts: widget.desk.alerts),
  );

  @override
  Widget build(BuildContext context) {
    final d = widget.desk;
    final live = d.setups.where((s) => !s.stage.isFinal).toList();
    final done = d.setups.where((s) => s.stage.isFinal).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: const Text(
                  'SETUP PROGRESS BOARD',
                  style: TextStyle(color: CheColors.markets, fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1.1),
                ),
              ),
            ),
            IconButton(
              tooltip: d.alerts.muted ? 'Alerts muted. Unmute alerts' : 'Mute all alerts',
              onPressed: () => unawaited(d.alerts.setMuted(!d.alerts.muted)),
              icon: Icon(d.alerts.muted ? Icons.volume_off_rounded : Icons.notifications_active_outlined, color: Colors.white),
            ),
            IconButton(
              tooltip: 'Alert settings',
              onPressed: () => unawaited(_settings()),
              icon: const Icon(Icons.tune_rounded, color: Colors.white),
            ),
            if (widget.onRead != null)
              IconButton(
                tooltip: 'Read setups aloud',
                onPressed: () => widget.onRead!(d.spokenSummary()),
                icon: const Icon(Icons.volume_up_rounded, color: Colors.white),
              ),
          ],
        ),
        _feedHeader(),
        const Padding(
          padding: EdgeInsets.only(top: 4),
          child: Text(
            '$_paperTag. Setups and signals are paper records from verified market data. Progress is not a prediction or a guarantee.',
            style: TextStyle(color: Colors.white70, fontSize: 12.5),
          ),
        ),
        _alertBanner(),
        if (live.isEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 10),
            child: Text('No setups yet. CHE follows setups once Rithmic candles arrive.', style: TextStyle(color: Colors.white70, fontSize: 13)),
          ),
        for (final s in live) _setupCard(s),
        _signals(),
        if (done.isNotEmpty) ...[
          const SizedBox(height: 14),
          Semantics(
            header: true,
            child: const Text(
              'RECENTLY FINISHED',
              style: TextStyle(color: CheColors.markets, fontWeight: FontWeight.w800, fontSize: 13, letterSpacing: 1),
            ),
          ),
          for (final s in done) _setupCard(s),
        ],
      ],
    );
  }
}

/// Per-type alert switches (shown, sound and speech, haptic), the near-entry distance and a master mute.
class CheAlertSettingsSheet extends StatefulWidget {
  const CheAlertSettingsSheet({super.key, required this.alerts});
  final CheTradeAlerts alerts;
  @override
  State<CheAlertSettingsSheet> createState() => _CheAlertSettingsSheetState();
}

class _CheAlertSettingsSheetState extends State<CheAlertSettingsSheet> {
  @override
  void initState() {
    super.initState();
    widget.alerts.addListener(_c);
  }

  @override
  void dispose() {
    widget.alerts.removeListener(_c);
    super.dispose();
  }

  void _c() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.alerts;
    return SafeArea(
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.8,
        builder: (_, scroll) => ListView(
          controller: scroll,
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              'Alert settings',
              style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800),
            ),
            const Text('Alerts are always shown as a banner when on. Sound and speech are off unless you turn them on per type.', style: TextStyle(color: Colors.white70, fontSize: 13)),
            SwitchListTile(
              title: const Text('Mute all alerts', style: TextStyle(color: Colors.white)),
              value: a.muted,
              onChanged: (v) => unawaited(a.setMuted(v)),
            ),
            ListTile(
              title: const Text('Near entry means within', style: TextStyle(color: Colors.white)),
              subtitle: Text('${a.nearEntryPoints.toStringAsFixed(1)} index points', style: const TextStyle(color: Colors.white70)),
            ),
            Slider(
              value: a.nearEntryPoints.clamp(1, 30),
              min: 1,
              max: 30,
              divisions: 58,
              label: '${a.nearEntryPoints.toStringAsFixed(1)} points',
              semanticFormatterCallback: (v) => '${v.toStringAsFixed(1)} points',
              onChanged: (v) => unawaited(a.setNearEntryPoints(v)),
            ),
            for (final t in CheAlertType.values) ...[
              const Divider(color: Colors.white24),
              Text(
                t.label,
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
              ),
              SwitchListTile(
                dense: true,
                title: const Text('Show this alert', style: TextStyle(color: Colors.white)),
                value: a.pref(t).enabled,
                onChanged: (v) => unawaited(a.setPref(t, a.pref(t).copyWith(enabled: v))),
              ),
              SwitchListTile(
                dense: true,
                title: const Text('Sound and speech', style: TextStyle(color: Colors.white)),
                value: a.pref(t).audible,
                onChanged: a.pref(t).enabled ? (v) => unawaited(a.setPref(t, a.pref(t).copyWith(audible: v))) : null,
              ),
              SwitchListTile(
                dense: true,
                title: const Text('Haptic', style: TextStyle(color: Colors.white)),
                value: a.pref(t).haptic,
                onChanged: a.pref(t).enabled ? (v) => unawaited(a.setPref(t, a.pref(t).copyWith(haptic: v))) : null,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
