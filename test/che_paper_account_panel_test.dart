import 'package:chey/trading/che_paper_account.dart';
import 'package:chey/trading/che_paper_account_panel.dart';
import 'package:chey/trading/che_paper_engine.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final t0 = DateTime.utc(2026, 10, 23, 14, 30);

ChePaperSignal sig() => ChePaperSignal(
      id: 's1', symbol: 'MNQZ6', side: CheSide.long, entry: 21000, stop: 20995, target: 21010, strategy: 'EMA 20 pullback',
      timeframe: '5m', stage: 'triggered', detectedAt: t0, dataSource: 'rithmic', evidence: 'provisional: 12 paper trades',
      conditions: const [ChePaperCondition('Price above EMA 20', 'satisfied'), ChePaperCondition('Volume confirmation', 'pending')],
    );

Future<ChePaperEngine> engine({bool wide = true}) async {
  final e = await ChePaperEngine.load(ChePaperMemoryStore(), clock: () => t0);
  if (wide) e.setLimits(const ChePaperRiskLimits(maxRiskPerTradePct: 25, maxOpenRiskPct: 50, maxDailyLossPct: 50), confirmed: true);
  return e;
}

Widget host(ChePaperEngine e, {void Function(String)? onRead, bool compact = false}) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: ChePaperAccountPanel(engine: e, onRead: onRead, compact: compact))),
    );

void main() {
  testWidgets('shows the CHE PAPER ACCOUNT figures with the default 100 dollar balance and an honest risk note', (tester) async {
    final e = await engine(wide: false);
    final read = <String>[];
    await tester.pumpWidget(host(e, onRead: read.add));
    await tester.pumpAndSettle();
    expect(find.text('CHE PAPER ACCOUNT'), findsOneWidget);
    expect(find.textContaining('SIMULATED'), findsWidgets);
    expect(find.bySemanticsLabel(RegExp(r'^CHE PAPER ACCOUNT Current balance: \$100\.00$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^CHE PAPER ACCOUNT Starting balance: \$100\.00$')), findsOneWidget);
    for (final k in ['paper_available', 'paper_equity', 'paper_unrealized', 'paper_realized', 'paper_risk', 'paper_drawdown', 'paper_equity_chart']) {
      expect(find.byKey(Key(k)), findsOneWidget, reason: k);
    }
    // One MNQ point is $2: a 15–25 point stop is 36–56% of $100, against a 2% limit. Said plainly.
    expect(find.textContaining('On MNQ one point is \$2. A typical 15–25 point stop risks \$35.50–\$55.50'), findsOneWidget);
    expect(find.textContaining('"skipped: risk exceeds limit"'), findsOneWidget);
    expect(find.textContaining('no MNQ stop fits'), findsOneWidget);
    expect(find.textContaining('delayed prices never fill them'), findsOneWidget);
    expect(read, isEmpty, reason: 'the panel never speaks on its own');
    await tester.tap(find.byKey(const Key('paper_read')));
    expect(read.single, startsWith('CHE PAPER ACCOUNT, simulated. Balance \$100.00'));
  });

  testWidgets('changing the balance needs a review and a confirmation, and is kept in the history', (tester) async {
    final e = await engine();
    await tester.pumpWidget(host(e));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('paper_change_balance')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('balance_type_deposit')));
    await tester.enterText(find.byKey(const Key('balance_amount')), '400');
    await tester.enterText(find.byKey(const Key('balance_reason')), 'larger test');
    await tester.tap(find.byKey(const Key('balance_review')));
    await tester.pumpAndSettle();
    expect(e.balanceHistory, hasLength(1), reason: 'nothing changes before the confirmation');
    expect(find.textContaining('Deposit \$400.00: balance \$100.00 → \$500.00'), findsOneWidget);
    await tester.tap(find.byKey(const Key('balance_confirm')));
    await tester.pumpAndSettle();
    expect(e.balanceHistory.last.type, CheBalanceChangeType.deposit);
    expect(e.balanceHistory.last.reason, 'larger test');
    expect(find.bySemanticsLabel(RegExp(r'Current balance: \$500\.00$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Starting balance: \$100\.00$')), findsOneWidget);
    expect(find.textContaining('Recorded in the balance history'), findsOneWidget);
  });

  testWidgets('a voice request opens the confirmation with the amount, it does not change the balance by itself', (tester) async {
    final e = await engine();
    await tester.pumpWidget(host(e, compact: true));
    await tester.pumpAndSettle();
    ChePaperAccountPanel.requestedBalance.value = 500;
    await tester.pumpAndSettle();
    expect(find.text('Change CHE paper balance'), findsWidgets);
    expect(find.byKey(const Key('balance_amount')), findsOneWidget);
    expect(find.text('500.00'), findsOneWidget);
    expect(e.balanceHistory, hasLength(1));
    await tester.tap(find.byKey(const Key('balance_review')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('balance_confirm')));
    await tester.pumpAndSettle();
    expect(e.snapshot().balance, 500);
    expect(e.balanceHistory.last.type, CheBalanceChangeType.simulationSetting);
  });

  testWidgets('positions list every field and open a detail view with levels, progress, setup and journal', (tester) async {
    final e = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(ChePriceTick(symbol: 'MNQZ6', price: 21000.5, time: t0.add(const Duration(seconds: 1)), source: 'rithmic'));
    e.onTick(ChePriceTick(symbol: 'MNQZ6', price: 21004, time: t0.add(const Duration(seconds: 30)), source: 'rithmic'));
    await tester.pumpWidget(host(e));
    await tester.pumpAndSettle();
    final row = find.byKey(Key('paper_position_${p.id}'));
    expect(row, findsOneWidget);
    for (final text in ['MNQZ6 · LONG', 'Open', 'Entry 21000.88', 'Current 21004.00', 'Stop 20995.00', 'Target 21010.00', 'Risk \$15.50', 'Setup EMA 20 pullback · 5m']) {
      expect(find.descendant(of: row, matching: find.textContaining(text)), findsWidgets, reason: text);
    }
    await tester.ensureVisible(find.byKey(const Key('paper_filter_closed')));
    await tester.tap(find.byKey(const Key('paper_filter_closed')));
    await tester.pumpAndSettle();
    expect(row, findsNothing);
    await tester.tap(find.byKey(const Key('paper_filter_open')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(row);
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('paper_detail_chart')), findsOneWidget);
    expect(find.byKey(const Key('paper_detail_status')), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(const Key('paper_progress_stop')), 200);
    expect(find.byKey(const Key('paper_progress_target')), findsOneWidget);
    expect(find.textContaining('not a probability'), findsOneWidget);
    expect(find.byKey(const Key('paper_progress_stop')), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(const Key('paper_no_current_conditions')), 200);
    expect(find.text('Price above EMA 20 — met'), findsOneWidget);
    expect(find.text('Volume confirmation — pending'), findsOneWidget);
    expect(find.byKey(const Key('paper_no_current_conditions')), findsOneWidget);
    await tester.scrollUntilVisible(find.textContaining('Opened LONG 1 MNQ (paper)'), 200);
    expect(find.textContaining('Opened LONG 1 MNQ (paper)'), findsOneWidget);

    e.adjust(p.id, target: 21012, reason: 'next swing high');
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.textContaining('target 21010.00 → 21012.00: next swing high'), 200);
    expect(find.textContaining('target 21010.00 → 21012.00: next swing high'), findsOneWidget);
  });

  testWidgets('a phone that cannot load the account shows that, not guessed figures', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: ChePaperAccountPanel())));
    // The phone's file store needs a platform plugin the test host does not have.
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('paper_error')), findsOneWidget);
    expect(find.textContaining('\$100.00'), findsNothing);
  });

  testWidgets('presets are offered, not applied, and risk limits change only on confirmation', (tester) async {
    final e = await engine(wide: false);
    await tester.pumpWidget(host(e));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('paper_change_balance')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('balance_preset_2500')));
    await tester.pumpAndSettle();
    expect(e.snapshot().balance, 100, reason: 'a preset only fills the form');
    await tester.tap(find.byKey(const Key('balance_review')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('balance_confirm')));
    await tester.pumpAndSettle();
    expect(e.snapshot().balance, 2500);
    expect(e.balanceHistory.last.type, CheBalanceChangeType.simulationSetting);

    await tester.ensureVisible(find.byKey(const Key('paper_limits')));
    await tester.tap(find.byKey(const Key('paper_limits')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('limit_trade')), '150');
    await tester.tap(find.byKey(const Key('limits_confirm')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('limits_error')), findsOneWidget);
    expect(e.limits.maxRiskPerTradePct, 2);
    await tester.enterText(find.byKey(const Key('limit_trade')), '1');
    await tester.tap(find.byKey(const Key('limits_confirm')));
    await tester.pumpAndSettle();
    expect(e.limits.maxRiskPerTradePct, 1);
  });

  testWidgets('an unresolved trade after a feed gap says so and shows no result', (tester) async {
    final e = await engine();
    final p = e.onSignal(sig()).position!;
    e.onTick(ChePriceTick(symbol: 'MNQZ6', price: 21000.5, time: t0.add(const Duration(seconds: 1)), source: 'rithmic'));
    e.onTick(ChePriceTick(symbol: 'MNQZ6', price: 20990, time: t0.add(const Duration(minutes: 35)), source: 'rithmic'));
    await tester.pumpWidget(host(e));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('paper_filter_closed')));
    await tester.tap(find.byKey(const Key('paper_filter_closed')));
    await tester.pumpAndSettle();
    final row = find.byKey(Key('paper_position_${p.id}'));
    await tester.ensureVisible(row);
    expect(find.descendant(of: row, matching: find.text('Unresolved (feed gap)')), findsOneWidget);
    expect(find.descendant(of: row, matching: find.textContaining('stop/target status unknown')), findsOneWidget);
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.textContaining('No result (unresolved (feed gap))'), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(const Key('paper_unresolved_reason')), 200);
    expect(find.textContaining('Stop/target status unknown for that window'), findsOneWidget);
  });
}
