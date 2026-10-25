// The dashboard's one definition of each figure (lib/trading/che_account_stats.dart), Trading Room v3, 2026-10-25.
import 'package:chey/trading/che_account_stats.dart';
import 'package:flutter_test/flutter_test.dart';

CheStatTrade t(String id, double? v, String exit, {String kind = 'forward_paper', String market = 'futures'}) =>
    CheStatTrade(id: id, instrument: market == 'crypto' ? 'BTC' : 'MNQ', market: market, value: v, exitAt: DateTime.parse(exit), kind: kind);

void main() {
  test('an empty journal reads "No recorded trades", never 0 or a dash', () {
    final s = cheComputeAccountStats(CheAccountSource.forwardPaperFutures, const [], openPositions: 0);
    expect(s.empty, isTrue);
    expect(cheStatValue(s, CheStat.pnl), 'No recorded trades');
    expect(cheStatValue(s, CheStat.winRate), 'No recorded trades');
    expect(cheStatValue(s, CheStat.drawdown), 'No recorded trades');
    expect(cheStatValue(s, CheStat.open), '0');
    for (final stat in CheStat.values) {
      expect(cheStatValue(s, stat), isNot(anyOf('—', '-', '\$0.00', '+\$0.00', '0%')));
    }
    expect(cheStatExplain(s, CheStat.pnl), contains('no recorded trades yet'));
  });

  test('a failed read says Data unavailable with its reason', () {
    final s = cheComputeAccountStats(CheAccountSource.simulation, const [], unavailable: 'the simulation record could not be read');
    expect(cheStatValue(s, CheStat.pnl), 'Data unavailable');
    expect(cheStatExplain(s, CheStat.winRate), contains('because the simulation record could not be read'));
  });

  test('realized P&L, win rate = wins/closed, W/L and max drawdown from the equity curve', () {
    // Exit order: +30, −20, −15, +10, flat 0, +40 → curve 30, 10, −5, 5, 5, 45; peak 30 then fall to −5 = 35.
    final trades = [
      t('a', 30, '2026-10-20T14:00:00Z'),
      t('c', -15, '2026-10-20T16:00:00Z'),
      t('b', -20, '2026-10-20T15:00:00Z'),
      t('d', 10, '2026-10-21T14:00:00Z'),
      t('e', 0, '2026-10-21T15:00:00Z'),
      t('f', 40, '2026-10-22T14:00:00Z'),
    ];
    final s = cheComputeAccountStats(CheAccountSource.forwardPaperFutures, trades, openPositions: 2);
    expect(s.closed, 6);
    expect(s.wins, 3);
    expect(s.losses, 2);
    expect(s.flat, 1);
    expect(s.realized, 45);
    expect(s.winRate, closeTo(0.5, 1e-9));
    expect(s.maxDrawdown, 35);
    expect(s.updatedAt, DateTime.parse('2026-10-22T14:00:00Z'));
    expect(cheStatValue(s, CheStat.pnl), '+\$45.00');
    expect(cheStatValue(s, CheStat.winRate), '50% · 3W 2L');
    expect(cheStatValue(s, CheStat.open), '2');
    expect(cheStatValue(s, CheStat.drawdown), '−\$35.00');
    expect(cheStatExplain(s, CheStat.winRate), contains('3 wins divided by 6 closed trades'));
    expect(cheStatExplain(s, CheStat.drawdown), contains('largest fall from a peak'));
  });

  test('a curve that only rises has zero drawdown; the simulation is in R', () {
    final s = cheComputeAccountStats(CheAccountSource.simulation, [t('a', 1.5, '2026-10-20T14:00:00Z', kind: 'simulation'), t('b', 0.5, '2026-10-20T15:00:00Z', kind: 'simulation')]);
    expect(s.maxDrawdown, 0);
    expect(cheStatValue(s, CheStat.pnl), '+2.00 R');
    expect(cheStatValue(s, CheStat.open), 'Not reported');
  });

  test('backtest P&L is never counted in a paper account', () {
    expect(() => cheComputeAccountStats(CheAccountSource.forwardPaperFutures, [t('bt', 900, '2026-10-20T14:00:00Z', kind: 'historical_backtest')]), throwsArgumentError);
  });

  test('a trade with no recorded result is counted as closed but never added as zero', () {
    final s = cheComputeAccountStats(CheAccountSource.forwardPaperCrypto, [t('a', null, '2026-10-20T14:00:00Z', market: 'crypto'), t('b', 5, '2026-10-20T15:00:00Z', market: 'crypto')]);
    expect(s.closed, 2);
    expect(s.realized, 5);
    expect(s.missingValues, 1);
    expect(cheStatExplain(s, CheStat.pnl), contains('1 closed trade has no recorded result'));
  });

  test('New York time and trade dates match the Worker across daylight saving and overnight futures', () {
    expect(cheNewYork(DateTime.utc(2026, 7, 1, 16)).hour, 12); // EDT
    expect(cheNewYork(DateTime.utc(2026, 12, 1, 17)).hour, 12); // EST
    // Overnight MNQ: 1:15 AM New York Oct 22 → CME date Oct 22; 6:30 PM Oct 22 → Oct 23.
    expect(cheTradeDate(DateTime.utc(2026, 10, 22, 5, 15), 'futures'), '2026-10-22');
    expect(cheTradeDate(DateTime.utc(2026, 10, 22, 22, 30), 'futures'), '2026-10-23');
    expect(cheTradeDate(DateTime.utc(2026, 10, 22, 22, 30), 'crypto'), '2026-10-22');
    // Spring forward, Sunday March 8 2026: 6:00 PM EDT = 22:00Z.
    expect(cheTradeDate(DateTime.utc(2026, 3, 8, 22), 'futures'), '2026-03-09');
    expect(cheTradeDate(DateTime.utc(2026, 3, 8, 21, 59), 'futures'), '2026-03-08');
    // Fall back, Sunday November 1 2026: 6:00 PM EST = 23:00Z.
    expect(cheTradeDate(DateTime.utc(2026, 11, 1, 23), 'futures'), '2026-11-02');
    expect(cheTradeDate(DateTime.utc(2026, 11, 1, 22, 30), 'futures'), '2026-11-01');
    expect(cheTradeDate(DateTime.utc(2026, 10, 31, 3, 30), 'crypto'), '2026-10-30');
    expect(cheTradeDate(DateTime.utc(2026, 11, 2, 4, 30), 'crypto'), '2026-11-01');
    // The 2 AM boundaries themselves.
    expect(cheNewYork(DateTime.utc(2026, 3, 8, 6, 59)).hour, 1);
    expect(cheNewYork(DateTime.utc(2026, 3, 8, 7)).hour, 3);
    expect(cheNewYork(DateTime.utc(2026, 11, 1, 5, 59)).hour, 1);
    expect(cheNewYork(DateTime.utc(2026, 11, 1, 6)).hour, 1);
  });
}
