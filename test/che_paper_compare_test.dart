import 'package:chey/trading/che_account_kind.dart';
import 'package:chey/trading/che_paper_account.dart';
import 'package:chey/trading/che_paper_compare.dart';
import 'package:chey/trading/che_paper_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final t0 = DateTime.utc(2026, 10, 23, 14, 30);
  ChePriceTick tick(double p, int s) => ChePriceTick(symbol: 'MNQZ6', price: p, time: t0.add(Duration(seconds: s)), source: 'rithmic');

  test('the side-by-side view reads the CHE PAPER ACCOUNT records as they are', () async {
    final e = await ChePaperEngine.load(ChePaperMemoryStore(), clock: () => t0);
    e.changeBalance(type: CheBalanceChangeType.simulationSetting, amount: 2500, confirmed: true);
    final p = e.onSignal(ChePaperSignal(
      id: 's', symbol: 'MNQZ6', side: CheSide.long, entry: 21000, stop: 20995, target: 21010, strategy: 'EMA 20 pullback', timeframe: '5m',
      stage: 'ready', detectedAt: t0, dataSource: 'rithmic',
    )).position!;
    e.onTick(tick(21000.5, 1));
    e.onTick(tick(21003, 2));
    final open = cheTradeViewFromPaper(p);
    expect(open.account, CheAccountKind.chePaper);
    expect(open.isOpen, isTrue);
    expect(open.entry, p.entryFill);
    expect(open.unrealized, p.unrealizedPnl);
    expect(open.source, contains('CHE PAPER ACCOUNT'));
    final sum = cheAccountSummaryFromPaper(e);
    expect(sum.balance, 2500);
    expect(sum.openPositions, 1);
    expect(sum.winRate, isNull, reason: 'no closed trade yet: unknown, not 0%');
    e.onTick(tick(21010.25, 3));
    final closed = cheTradeViewFromPaper(p);
    expect(closed.isOpen, isFalse);
    expect(closed.realized, p.netPnl);
    expect(cheAccountSummaryFromPaper(e).winRate, 100);
  });
}
