// Trading Room v3 voice routes on the phone (owner, 2026-10-25): "explain win rate", "what's my drawdown",
// "how many open positions", "open advanced controls". The dashboard's figures live on this phone (the selected
// account, computed by cheComputeAccountStats), so the answer is read from what the Trading Room shows right now
// (CheTradingDashboard.latest), never from a model. Folds open through CheTradingFold.requested. Narrow on purpose:
// "what's my P&L today" and other trading questions keep their Worker routes.
import '../rooms/che_trading_dashboard.dart';
import '../rooms/che_trading_hud.dart';
import 'che_account_stats.dart';

class CheTradingVoice {
  const CheTradingVoice._({this.stat, this.fold});

  /// The figure to explain, or null for a fold.
  final CheStat? stat;

  /// The fold to open: 'advanced', 'research' or 'replay'.
  final String? fold;

  static CheStat? _statWord(String w) => switch (w) {
        'win rate' || 'winrate' || 'win loss' || 'wins and losses' || 'w/l' => CheStat.winRate,
        'drawdown' || 'draw down' || 'max drawdown' || 'maximum drawdown' => CheStat.drawdown,
        'open positions' || 'open trades' || 'positions' => CheStat.open,
        'p&l' || 'pnl' || 'p and l' || 'profit and loss' || 'realized p&l' || 'realized pnl' => CheStat.pnl,
        _ => null,
      };

  static const _stats = r'(win rate|winrate|win loss|wins and losses|w/l|max drawdown|maximum drawdown|drawdown|draw down|open positions|open trades|realized p&l|realized pnl|p&l|pnl|p and l|profit and loss)';

  /// The owner's words, as typed or as speech recognition delivers them (lowercase, no punctuation, wake word first).
  static CheTradingVoice? parse(String message) {
    final t = message.toLowerCase().replaceAll('’', "'").replaceFirst(RegExp(r'^\s*(?:hey\s+)?(?:che|chey|chay)[,:\s]+'), '').replaceAll(RegExp(r'[?.!]+$'), '').trim();
    final explain = RegExp('^(?:please\\s+)?(?:explain|define|what does)\\s+(?:my\\s+|the\\s+)?$_stats(?:\\s+mean)?(?:\\s+please)?\$').firstMatch(t);
    if (explain != null) return CheTradingVoice._(stat: _statWord(explain.group(1)!));
    final mine = RegExp("^(?:what's|whats|what is|tell me|read)\\s+my\\s+(win rate|winrate|max drawdown|maximum drawdown|drawdown|draw down)\$").firstMatch(t);
    if (mine != null) return CheTradingVoice._(stat: _statWord(mine.group(1)!));
    if (RegExp(r'^how many (?:open positions|positions are open|trades are open)(?: do i have)?$').hasMatch(t)) return const CheTradingVoice._(stat: CheStat.open);
    final fold = RegExp(r'^(?:please\s+)?(?:open|show|expand)\s+(?:the\s+)?(advanced controls|advanced|research and backtesting|research|backtesting|replay)(?:\s+(?:section|panel|controls))?(?:\s+please)?$').firstMatch(t);
    if (fold != null) {
      final w = fold.group(1)!;
      return CheTradingVoice._(fold: w.startsWith('advanced') ? 'advanced' : (w == 'replay' ? 'replay' : 'research'));
    }
    return null;
  }

  /// Opens the fold (when asked) and returns the words to show and speak.
  String run() {
    if (fold != null) {
      CheTradingFold.requested.value = fold;
      final name = fold == 'advanced' ? 'advanced controls' : (fold == 'replay' ? 'replay' : 'research and backtesting');
      return 'Opened $name in the Trading Room, sir.';
    }
    final s = CheTradingDashboard.latest.value;
    if (s == null) return 'The Trading Room has not loaded an account yet, sir. I am opening it; ask again once the figures show.';
    return '${cheStatExplain(s, stat!)} Account: ${s.source.label}.';
  }
}
