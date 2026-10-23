// The CHE PAPER ACCOUNT (che_paper_engine.dart) in the side-by-side view's terms: its positions as
// CheTradeView and its figures as a CheAccountSummary. Values are copied from the engine's records;
// a figure the engine does not have stays null and reads "unknown".
import 'che_account_kind.dart';
import 'che_paper_account.dart';
import 'che_paper_engine.dart';
import 'che_trade_compare.dart';

const kChePaperAccountSource = 'CHE PAPER ACCOUNT (live Rithmic prices, on this phone)';

String _status(ChePositionStatus s) => switch (s) {
      ChePositionStatus.open || ChePositionStatus.pendingEntry => 'open',
      ChePositionStatus.cancelled => 'cancelled',
      ChePositionStatus.unresolved => 'unresolved',
      _ => 'closed',
    };

/// A CHE paper position as the side-by-side view lists it. A waiting order shows its planned entry.
CheTradeView cheTradeViewFromPaper(ChePaperPosition p) => CheTradeView(
      id: 'paper|${p.id}',
      account: CheAccountKind.chePaper,
      symbol: p.symbol,
      side: p.side == CheSide.short ? 'short' : 'long',
      qty: p.qty.toDouble(),
      entry: p.entry,
      stop: p.stop,
      target: p.target,
      current: p.status.isOpen ? p.lastPrice : p.exitRaw,
      openedAt: p.entryAt,
      closedAt: p.status.isOpen ? null : p.exitAt,
      exit: p.exitFill,
      setup: p.signal.strategy,
      timeframe: p.signal.timeframe,
      status: _status(p.status),
      unrealized: p.unrealizedPnl,
      realized: p.netPnl,
      adjusted: p.adjustments.isNotEmpty,
      source: kChePaperAccountSource,
      why: p.status == ChePositionStatus.pendingEntry ? 'Waiting for the next Rithmic trade to fill' : (p.exitReason ?? ''),
    );

/// The CHE PAPER ACCOUNT's figures for the summary card.
CheAccountSummary cheAccountSummaryFromPaper(ChePaperEngine e) {
  final s = e.snapshot();
  return CheAccountSummary(
    account: CheAccountKind.chePaper,
    balance: s.balance,
    available: s.available,
    equity: s.equity,
    realized: s.realizedPnl,
    unrealized: s.unrealizedPnl,
    openPositions: s.openPositions,
    winRate: s.winRate == null ? null : s.winRate! * 100,
    avgWin: s.wins == 0 ? null : s.avgWin,
    avgLoss: s.losses == 0 ? null : s.avgLoss,
    maxDrawdown: s.maxDrawdown,
    dailyRisk: s.openRisk,
    activeTrades: e.openPositions.where((p) => p.status == ChePositionStatus.open).length,
    source: kChePaperAccountSource,
    note: 'Simulated. Starting balance ${cheMoneyPlain(s.startingBalance)}; win rate and averages count this balance period only.',
  );
}

String cheMoneyPlain(double v) => '${v < 0 ? '−' : ''}\$${v.abs().toStringAsFixed(2)}';
