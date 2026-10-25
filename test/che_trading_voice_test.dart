// Trading Room v3 voice routes on the phone (lib/trading/che_trading_voice.dart): typed or spoken, answered from the
// figures on screen, never by a model; folds open by name.
import 'package:chey/brain/che_brain_space_model.dart';
import 'package:chey/rooms/che_live_chart.dart';
import 'package:chey/rooms/che_trading_dashboard.dart';
import 'package:chey/rooms/che_trading_hud.dart';
import 'package:chey/trading/che_account_stats.dart';
import 'package:chey/trading/che_trading_voice.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() {
    CheTradingDashboard.latest.value = null;
    CheTradingFold.requested.value = null;
  });

  test('the owner\'s phrasings reach the right figure or fold, typed and spoken', () {
    expect(CheTradingVoice.parse('explain win rate')?.stat, CheStat.winRate);
    expect(CheTradingVoice.parse('Explain my win rate.')?.stat, CheStat.winRate);
    expect(CheTradingVoice.parse('chay what does drawdown mean')?.stat, CheStat.drawdown);
    expect(CheTradingVoice.parse("what's my drawdown")?.stat, CheStat.drawdown);
    expect(CheTradingVoice.parse('whats my drawdown')?.stat, CheStat.drawdown);
    expect(CheTradingVoice.parse('What is my win rate?')?.stat, CheStat.winRate);
    expect(CheTradingVoice.parse('explain p&l')?.stat, CheStat.pnl);
    expect(CheTradingVoice.parse('how many open positions do i have')?.stat, CheStat.open);
    expect(CheTradingVoice.parse('open advanced controls')?.fold, 'advanced');
    expect(CheTradingVoice.parse('Open the research section')?.fold, 'research');
    expect(CheTradingVoice.parse('open replay')?.fold, 'replay');
  });

  test('other trading questions keep their own routes', () {
    for (final p in ["what's my p&l today", 'show me the mnq chart', 'open the trading room', 'explain how a stop loss works', 'is the mnq data live']) {
      expect(CheTradingVoice.parse(p), isNull, reason: p);
    }
  });

  test('earlier phone routes do not catch these phrases', () {
    for (final p in ['explain win rate', "what's my drawdown", 'open advanced controls', 'how many open positions']) {
      expect(CheBrainCommand.parse(p), isNull, reason: p);
      expect(CheChartCommand.parse(p), isNull, reason: p);
    }
  });

  test('the answer is the dashboard\'s own explanation; folds open; nothing loaded says so', () {
    expect(CheTradingVoice.parse('explain win rate')!.run(), startsWith('The Trading Room has not loaded an account yet'));
    final s = cheComputeAccountStats(CheAccountSource.forwardPaperFutures, [
      CheStatTrade(id: 'a', instrument: 'MNQ', market: 'futures', value: 30, exitAt: DateTime.utc(2026, 10, 21, 14)),
      CheStatTrade(id: 'b', instrument: 'MNQ', market: 'futures', value: -10, exitAt: DateTime.utc(2026, 10, 21, 15)),
    ]);
    CheTradingDashboard.latest.value = s;
    expect(CheTradingVoice.parse('explain win rate')!.run(), allOf(contains('1 win divided by 2 closed trades'), endsWith('Account: FORWARD PAPER · FUTURES.')));
    expect(CheTradingVoice.parse("what's my drawdown")!.run(), contains('Max drawdown: −\$10.00'));
    expect(CheTradingVoice.parse('open advanced controls')!.run(), 'Opened advanced controls in the Trading Room, sir.');
    expect(CheTradingFold.requested.value, 'advanced');
  });
}
