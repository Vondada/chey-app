import 'dart:io';

import 'package:chey/trading/che_market_feed.dart';
import 'package:chey/trading/che_setup_board.dart';
import 'package:chey/trading/che_setup_desk.dart';
import 'package:chey/trading/che_setup_engine.dart';
import 'package:chey/trading/che_trade_alerts.dart';
import 'package:chey/trading/che_trade_audit.dart';
import 'package:chey/trading/che_trade_signal.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _t0 = DateTime.utc(2026, 10, 20, 13);

CheCandle _candle(int i, double o, double h, double l, double c, {bool closed = true, int minutes = 1}) => CheCandle(
      start: _t0.add(Duration(minutes: i * minutes)),
      minutes: minutes,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: 100,
      trades: 10,
      closed: closed,
      source: 'rithmic',
      symbol: 'MNQZ6',
    );

List<CheCandle> _uptrend() => [for (var i = 0; i < 60; i++) _candle(i, 20000 + 2.0 * i - 1, 20000 + 2.0 * i + 3, 20000 + 2.0 * i - 3, 20000 + 2.0 * i)];

CheCandle _pullback(List<CheCandle> bars, {bool closed = true}) {
  final e = CheIndicators.of([for (final b in bars) cheSetupBarOf(b)]).ema20.last!;
  return _candle(bars.length, e + 1, e + 7, e - 1, e + 6, closed: closed);
}

const _live = CheMarketSnapshot(
  symbol: 'MNQZ6',
  exchange: 'CME',
  source: 'rithmic',
  sourceLabel: 'Rithmic live — MNQZ6',
  connection: CheFeedConnection.connected,
  statusLabel: 'Connected',
  isLive: true,
  lastPrice: 20100,
  lastTradeAt: null,
  lastUpdate: null,
);

Future<(CheSetupDesk, CheTradeAudit, CheTradeAlerts, List<int>, List<String>)> _desk(Directory dir) async {
  SharedPreferences.setMockInitialValues({});
  final audit = CheTradeAudit(file: () async => File('${dir.path}/audit.jsonl'));
  final pulses = <int>[];
  final spoken = <String>[];
  final alerts = CheTradeAlerts(audit: audit, haptic: (n) async => pulses.add(n));
  alerts.speak = (t) async => spoken.add(t);
  var now = _t0;
  final desk = CheSetupDesk(alerts: alerts, audit: audit, clock: () => now = now.add(const Duration(seconds: 2)), strategies: [cheBuiltInSetupStrategy('ema-pullback-5m')!]);
  // Snapshot as the feed would deliver it.
  for (final e in desk.engines.values) {
    e
      ..dataSource = _live.sourceLabel
      ..dataLive = true;
  }
  desk.snapshot = _live;
  return (desk, audit, alerts, pulses, spoken);
}

void main() {
  late Directory dir;
  setUp(() => dir = Directory.systemTemp.createTempSync('che_signals'));
  // Desk and alert writes to the audit are fire-and-forget (and never finish inside a widget test's fake clock), so an
  // append can land while the directory is being deleted ("Directory not empty"). Retry the delete briefly; a write
  // after the directory is gone is caught inside CheTradeAudit.append.
  tearDown(() {
    for (var attempt = 0;; attempt++) {
      try {
        if (dir.existsSync()) dir.deleteSync(recursive: true);
        return;
      } on FileSystemException {
        if (attempt >= 20) rethrow;
        sleep(const Duration(milliseconds: 25));
      }
    }
  });

  test('the desk turns real candles into a signal, audits every stage, alerts once, never speaks by default', () async {
    final (desk, audit, alerts, pulses, spoken) = await _desk(dir);
    final bars = _uptrend();
    for (final b in bars) {
      desk.ingest(b);
    }
    desk.ingest(_pullback(bars, closed: false));
    desk.ingest(_pullback(bars, closed: false)); // a repeat inside the throttle window
    final events = desk.ingest(_pullback(bars));
    expect(events.map((e) => e.to), contains(CheSetupStage.triggered));
    expect(desk.signals, hasLength(1));
    expect(desk.markerFeed.value.single['source'], 'che_signal');
    expect(desk.markerFeed.value.single['account'], 'CHE PAPER ACCOUNT');
    await Future<void>.delayed(const Duration(milliseconds: 50));

    final log = await audit.entries();
    expect(log.where((e) => e.kind == 'signal'), hasLength(1));
    expect(log.where((e) => e.kind == 'setup_stage').map((e) => e.data['to']), containsAll(['READY', 'TRIGGERED']));
    expect(log.every((e) => e.account == 'CHE PAPER ACCOUNT'), isTrue);
    expect(await audit.verify(), isEmpty);

    final ready = alerts.recent.where((a) => a.type == CheAlertType.setupReady).toList();
    expect(ready, hasLength(2), reason: 'one READY and one TRIGGERED alert, no repeats');
    expect(pulses, isNotEmpty, reason: 'haptic is on by default');
    expect(spoken, isEmpty, reason: 'sound and speech are off until the owner turns them on');
  });

  test('audible alerts speak only for the types turned on; master mute silences everything', () async {
    final (desk, _, alerts, pulses, spoken) = await _desk(dir);
    await alerts.setPref(CheAlertType.setupReady, const CheAlertPref(audible: true));
    final bars = _uptrend();
    for (final b in bars) {
      desk.ingest(b);
    }
    desk.ingest(_pullback(bars));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(spoken, hasLength(1));
    expect(spoken.single, contains('CHE PAPER ACCOUNT'));
    expect(spoken.single, contains('not a prediction'));

    await alerts.setMuted(true);
    pulses.clear();
    await alerts.raise(CheAlertType.setupReady, title: 't', message: 'm', account: 'CHE PAPER ACCOUNT');
    expect(spoken, hasLength(1));
    expect(pulses, isEmpty);
    expect(alerts.recent.first.title, 't', reason: 'a muted alert is still shown');

    await alerts.setPref(CheAlertType.paperOpened, const CheAlertPref(enabled: false));
    expect(await alerts.raise(CheAlertType.paperOpened, title: 'x', message: 'y', account: 'CHE PAPER ACCOUNT'), isNull);
  });

  test('alert settings persist', () async {
    SharedPreferences.setMockInitialValues({});
    final audit = CheTradeAudit(file: () async => File('${dir.path}/a.jsonl'));
    final a = CheTradeAlerts(audit: audit, haptic: (_) async {});
    await a.setPref(CheAlertType.setupInvalidated, const CheAlertPref(enabled: true, audible: true, haptic: false));
    await a.setNearEntryPoints(8);
    await a.setMuted(true);
    final b = CheTradeAlerts(audit: audit, haptic: (_) async {});
    await b.load();
    expect(b.pref(CheAlertType.setupInvalidated).audible, isTrue);
    expect(b.pref(CheAlertType.setupInvalidated).haptic, isFalse);
    expect(b.nearEntryPoints, 8);
    expect(b.muted, isTrue);
    expect(b.pref(CheAlertType.setupReady).audible, isFalse, reason: 'untouched types keep the silent default');
  });

  test('replayed history makes no alerts; non-Rithmic candles are refused', () async {
    final (desk, _, alerts, _, _) = await _desk(dir);
    final yahoo = CheCandle(start: _t0, minutes: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, trades: 1, closed: true, source: 'yahoo', symbol: 'MNQ=F');
    expect(desk.ingest(yahoo), isEmpty);
    expect(desk.engines[1]!.closedBars, isEmpty);
    expect(alerts.recent, isEmpty);
  });

  test('audit trail is append-only and detects a changed or removed line', () async {
    final f = File('${dir.path}/chain.jsonl');
    final audit = CheTradeAudit(file: () async => f);
    await audit.append('signal', account: 'CHE PAPER ACCOUNT', data: {'entry': 20100.5});
    await audit.append('balance_change', account: 'CHE PAPER ACCOUNT', data: {'from': 100, 'to': 250});
    await audit.append('setup_stage', account: 'CHE PAPER ACCOUNT', data: {'to': 'READY'});
    expect(await CheTradeAudit(file: () async => f).verify(), isEmpty);
    final lines = f.readAsLinesSync();
    // Change the amount itself: a bare '250' can match the timestamp's milliseconds, which Dart reads back as the same instant.
    f.writeAsStringSync('${[lines[0], lines[1].replaceFirst('"to":250', '"to":2500'), lines[2]].join('\n')}\n');
    expect(await CheTradeAudit(file: () async => f).verify(), isNotEmpty);
    f.writeAsStringSync('${[lines[0], lines[2]].join('\n')}\n');
    final problems = await CheTradeAudit(file: () async => f).verify();
    expect(problems.join(' '), contains('missing'));
  });

  testWidgets('the board shows source, stage badge with words, checklist, progress wording and the paper label', (tester) async {
    final (desk, _, _, _, _) = await _desk(dir);
    final bars = _uptrend();
    for (final b in bars) {
      desk.ingest(b);
    }
    desk.ingest(_pullback(bars, closed: false));
    final read = <String>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: CheSetupBoard(desk: desk, onRead: read.add, clock: () => _t0.add(const Duration(hours: 1)))))));
    await tester.pump();
    expect(find.text('SETUP PROGRESS BOARD'), findsOneWidget);
    expect(find.textContaining('Rithmic live — MNQZ6'), findsWidgets);
    expect(find.text('READY'), findsOneWidget, reason: 'the stage is written, not only coloured');
    expect(find.byIcon(Icons.check_circle_outline), findsOneWidget);
    expect(find.textContaining('entry conditions met'), findsWidgets);
    expect(find.textContaining('not a prediction'), findsWidgets);
    expect(find.textContaining('CHE PAPER ACCOUNT'), findsWidgets);
    expect(find.bySemanticsLabel(RegExp(r'^Stage READY$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('not a chance of profit')), findsWidgets);
    expect(read, isEmpty, reason: 'silent on open');
    await tester.tap(find.byTooltip('Read setups aloud'));
    expect(read.single, contains('ready'));
    expect(read.single, contains('not predictions'));
  });

  testWidgets('alert settings sheet toggles a type and the master mute', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final alerts = CheTradeAlerts(audit: CheTradeAudit(file: () async => File('${dir.path}/s.jsonl')), haptic: (_) async {});
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheAlertSettingsSheet(alerts: alerts))));
    await tester.pump();
    await tester.tap(find.text('Mute all alerts'));
    await tester.pump();
    expect(alerts.muted, isTrue);
    await tester.tap(find.text('Sound and speech').first);
    await tester.pump();
    expect(alerts.pref(CheAlertType.values.first).audible, isTrue);
  });

  test('evidence from the research ledger reaches the setups with its sample size', () async {
    final (desk, _, _, _, _) = await _desk(dir);
    desk.applyEvidence({
      'strategies': [
        {'strategy_id': 'ema-pullback-5m', 'sample_trades': 140, 'paper_trades': 4, 'expectancy_r': 0.12, 'win_rate': 0.38, 'readiness': '30+ SAMPLE'},
      ],
    });
    final bars = _uptrend();
    for (final b in bars) {
      desk.ingest(b);
    }
    final s = desk.setups.firstWhere((s) => s.strategyId == 'ema-pullback-5m');
    expect(s.evidence.status, '140 trades, +0.12R expectancy, 38% wins (30+ SAMPLE)');
  });
}
