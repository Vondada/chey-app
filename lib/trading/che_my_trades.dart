// MY ACCOUNT trades the owner enters himself (owner, 2026-10-23). CHE cannot read the owner's funded
// account (its Rithmic link is market data only), so to compare his trade with CHE's the owner types or
// says the trade he took. These records are his words, labelled "entered by you", kept on this phone, and
// never sent to a broker. Closing a trade records the exit; nothing is deleted.
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'che_account_kind.dart';
import 'che_trade_compare.dart';

class CheMyTradesStore {
  CheMyTradesStore({this.storageKey = 'che_my_trades_v1'});

  final String storageKey;

  Future<List<CheTradeView>> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return [
        for (final line in prefs.getStringList(storageKey) ?? const <String>[])
          if (jsonDecode(line) case final Map m) CheTradeView.fromJson(Map<String, dynamic>.from(m)),
      ];
    } catch (_) {
      return const [];
    }
  }

  Future<void> _save(List<CheTradeView> trades) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(storageKey, [for (final t in trades) jsonEncode(t.toJson())]);
  }

  /// Records a new open trade the owner took.
  Future<CheTradeView> add({
    required String symbol,
    required String side,
    required double qty,
    required double entry,
    double? stop,
    double? target,
    String setup = '',
    String timeframe = '',
    DateTime? openedAt,
  }) async {
    final opened = (openedAt ?? DateTime.now()).toUtc();
    final trade = CheTradeView(
      id: 'mine-${opened.microsecondsSinceEpoch}',
      account: CheAccountKind.mine,
      symbol: symbol.toUpperCase(),
      side: side,
      qty: qty,
      entry: entry,
      stop: stop,
      target: target,
      openedAt: opened,
      setup: setup,
      timeframe: timeframe,
      source: 'entered by you',
    );
    await _save([...await load(), trade]);
    return trade;
  }

  /// Records the exit price the owner gives. Realized P&L is computed from his own entry and exit prices
  /// and the contract multiplier, before fees; it is labelled that way wherever it is shown.
  Future<CheTradeView?> close(String id, double exitPrice, {DateTime? at}) async {
    final all = await load();
    final i = all.indexWhere((t) => t.id == id && t.isOpen);
    if (i < 0) return null;
    final t = all[i];
    final pv = t.pointValue;
    final points = t.isLong ? exitPrice - t.entry : t.entry - exitPrice;
    final closed = CheTradeView(
      id: t.id,
      account: t.account,
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      entry: t.entry,
      stop: t.stop,
      target: t.target,
      exit: exitPrice,
      openedAt: t.openedAt,
      closedAt: (at ?? DateTime.now()).toUtc(),
      setup: t.setup,
      timeframe: t.timeframe,
      status: 'closed',
      realized: pv == null ? null : points * t.qty * pv,
      adjusted: t.adjusted,
      source: 'entered by you (P&L before fees)',
    );
    all[i] = closed;
    await _save(all);
    return closed;
  }

  /// Updates the stop or target of an open trade and marks it adjusted.
  Future<CheTradeView?> adjust(String id, {double? stop, double? target}) async {
    final all = await load();
    final i = all.indexWhere((t) => t.id == id && t.isOpen);
    if (i < 0) return null;
    final t = all[i];
    final next = CheTradeView(
      id: t.id,
      account: t.account,
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      entry: t.entry,
      stop: stop ?? t.stop,
      target: target ?? t.target,
      openedAt: t.openedAt,
      setup: t.setup,
      timeframe: t.timeframe,
      adjusted: true,
      source: t.source,
    );
    all[i] = next;
    await _save(all);
    return next;
  }
}

/// Unrealized P&L of an owner-entered open trade at a live price, before fees. Null without a live price
/// or a known multiplier: a delayed or recorded price is never used as if it were live.
double? cheUnrealizedAt(CheTradeView t, double? livePrice) {
  final pv = t.pointValue;
  if (livePrice == null || pv == null || !t.isOpen) return null;
  final points = t.isLong ? livePrice - t.entry : t.entry - livePrice;
  return points * t.qty * pv;
}
