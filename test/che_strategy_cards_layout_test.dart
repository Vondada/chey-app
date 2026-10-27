// Strategy cards on the iPhone (owner, 2026-10-23): a name never breaks mid-word and takes at least half the row, at
// iPhone 15 (390 pt) and SE (375 pt) widths, at text scale 1.0 and 1.3. Cards are compact; every timeframe is listed.
import 'package:chey/rooms/che_strategy_learning.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// True when [text] breaks inside a word on any line but the last shown one (an ellipsis on the last line is intended).
bool splitsMidWord(String text, TextStyle style, double width, TextScaler scaler, int maxLines) {
  final tp = TextPainter(text: TextSpan(text: text, style: style), textDirection: TextDirection.ltr, textScaler: scaler, maxLines: maxLines)..layout(maxWidth: width);
  final lines = tp.computeLineMetrics().length;
  var start = 0;
  for (var i = 0; i < lines - 1; i++) {
    final end = tp.getLineBoundary(TextPosition(offset: start)).end;
    if (end <= start || end >= text.length) break;
    // A line may end after a space, a hyphen or a middle dot; anywhere else inside a word is a split.
    const breaks = {' ', '-', '·'};
    if (!breaks.contains(text[end - 1]) && !breaks.contains(text[end])) return true;
    start = end;
  }
  return false;
}

const _names = ['Liquidity sweep and reclaim', 'VWAP 2-sigma reversion with session filter', 'ICT fair value gap retest'];

Map<String, dynamic> _row(String name, String id, {bool featured = false}) => {
      'id': id, 'name': name, 'featured': featured, 'secondary': false, 'stage': 'Collecting forward evidence', 'resolution': '5m',
      'forward': {'trades': 24, 'wins': 13, 'losses': 11, 'win_rate': 54.2, 'expectancy_r': 0.31, 'net_pnl': 136.5, 'profit_factor': 1.4, 'max_drawdown': -41.0},
      'progress': {'fraction': 0.8}, 'today': {'trades': 1, 'wins': 1, 'losses': 0}, 'next_milestone': 'Forward paper', 'milestones': [],
      'historical': {}, 'out_of_sample': {}, 'counts': {}, 'params': {'target_r': 2}, 'variants': [], 'duplicates': 0, 'correlated_entries': 0,
      'data_quality': ['REALTIME'], 'equity': [{'time': '2026-10-22T14:00:00Z', 'value': 20.0}], 'recent_trades': [], 'strategy_version': 'v1',
    };

List<Map<String, dynamic>> _timeframes() => [
      for (final tf in ['1m', '5m', '15m', '1h', '1D']) {'tf': tf, 'forward_trades': tf == '5m' ? 24 : 0, 'historical_trades': 40, 'evidence': 'NOT READY', 'min_required': 30},
    ];

Future<void> _pump(WidgetTester tester, Widget child, {required double width, required double scale}) async {
  tester.view.physicalSize = Size(width * 3, 2400 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData.dark(),
    home: MediaQuery(
      data: MediaQueryData(size: Size(width, 2400), textScaler: TextScaler.linear(scale)),
      child: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(12), child: SizedBox(width: width - 24, child: child))),
    ),
  ));
  await tester.pump();
}

void main() {
  for (final width in const [390.0, 375.0]) {
    for (final scale in const [1.0, 1.3]) {
      group('at ${width.toInt()} pt, text ×$scale', () {
        testWidgets('ranking rows: names keep the full row, never split a word, and the tag wraps', (tester) async {
          await _pump(tester, Column(children: [
            for (final (i, n) in _names.indexed) CheStrategyRankRow(row: {'name': n, 'filter': 'any', 'target_r': 2, 'trades': 24, 'win_rate': 45.83, 'net_pnl': 136.5, 'ranked': i != 0}, money: (v) => '\$$v'),
          ]), width: width, scale: scale);
          expect(tester.takeException(), isNull, reason: 'no overflow');
          for (final (i, n) in _names.indexed) {
            final row = tester.getSize(find.byKey(Key('rank_row_${n}_any')));
            final name = tester.getSize(find.byKey(Key('rank_name_${n}_any')));
            expect(name.width, greaterThanOrEqualTo(row.width / 2), reason: 'name column is at least half the row ($i)');
            final text = tester.widget<Text>(find.byKey(Key('rank_name_${n}_any')));
            final style = text.style ?? const TextStyle();
            expect(splitsMidWord('$n · any · 2R', style, name.width, MediaQuery.textScalerOf(tester.element(find.byKey(Key('rank_name_${n}_any')))), 2), isFalse, reason: 'no word split: $n');
          }
        });

        testWidgets('strategy cards: compact, name at least half the card, never split, every timeframe listed', (tester) async {
          await _pump(tester, Column(children: [
            for (final (i, n) in _names.indexed) _StrategyProbe(row: _row(n, 'strategy-$i', featured: i == 0), timeframes: _timeframes()),
          ]), width: width, scale: scale);
          expect(tester.takeException(), isNull, reason: 'no overflow');
          for (final (i, n) in _names.indexed) {
            final card = tester.getSize(find.byKey(Key('strategy_card_strategy-$i')));
            final name = tester.getSize(find.byKey(Key('strategy_name_strategy-$i')));
            expect(name.width, greaterThanOrEqualTo(card.width / 2), reason: 'name at least half the card ($i)');
            final text = tester.widget<Text>(find.byKey(Key('strategy_name_strategy-$i')));
            expect(splitsMidWord(n, text.style ?? const TextStyle(), name.width, MediaQuery.textScalerOf(tester.element(find.byKey(Key('strategy_name_strategy-$i')))), 2), isFalse, reason: 'no word split: $n');
            expect(find.text('5m '), findsWidgets, reason: 'the timeframe chips are built');
            expect(find.bySemanticsLabel(RegExp(r'^1m: 0 forward paper trades')), findsWidgets);
            expect(find.bySemanticsLabel(RegExp(r'^5m: 24 forward paper trades')), findsWidgets);
            expect(find.text('Recent unique forward trades'), findsNothing, reason: 'collapsed at rest');
          }
        });
      });
    }
  }

  testWidgets('a tap expands one card and the info control explains it', (tester) async {
    await _pump(tester, _StrategyProbe(row: _row(_names[0], 'strategy-0', featured: true), timeframes: _timeframes()), width: 390, scale: 1);
    expect(find.text('Forward paper'), findsNothing);
    await tester.tap(find.byKey(const Key('strategy_name_strategy-0')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Win rate'), findsWidgets, reason: 'the numbers open on tap');
    await tester.tap(find.byTooltip('About ${_names[0]}'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Each timeframe shows forward paper trades first'), findsOneWidget);
  });
}

/// The learning dashboard's card, pumped on its own (the dashboard needs the whole learning payload).
class _StrategyProbe extends StatelessWidget {
  const _StrategyProbe({required this.row, required this.timeframes});
  final Map<String, dynamic> row;
  final List<Map<String, dynamic>> timeframes;

  @override
  Widget build(BuildContext context) => CheStrategyLearningDashboard(
        data: {'strategies': [row]},
        onAsk: (_) {},
        onResearch: null,
        timeframes: {'${row['id']}': timeframes},
      );
}
