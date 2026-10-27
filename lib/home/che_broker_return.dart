// The return from Tradovate's sign-in page into CHE (che://broker/tradovate?result=...).
//
// The Worker's callback page links here after the owner signs in on Tradovate in Safari. The
// link's result is only what that page said: CHE re-checks her Worker and reports the verified
// state, so "NinjaTrader connected" is said only when the Worker reports the sign-in as signed_in.
// Nothing here places or enables an order.
import 'dart:async';
import 'dart:io' show Platform;

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';

import '../rooms/che_trading_connections.dart' show cheConnectionStateWords;

/// A parsed che://broker/tradovate link. [result] is 'connected', 'failed' or 'unknown'.
@immutable
class CheBrokerReturn {
  const CheBrokerReturn(this.result);
  final String result;

  /// Null for every link that is not the Tradovate return.
  static CheBrokerReturn? parse(Uri uri) {
    if (uri.scheme.toLowerCase() != 'che' || uri.host.toLowerCase() != 'broker') return null;
    final segments = [for (final s in uri.pathSegments) if (s.isNotEmpty) s.toLowerCase()];
    if (segments.length != 1 || segments.single != 'tradovate') return null;
    final said = (uri.queryParameters['result'] ?? '').trim().toLowerCase();
    return CheBrokerReturn(said == 'connected' || said == 'failed' ? said : 'unknown');
  }

  @override
  bool operator ==(Object other) => other is CheBrokerReturn && other.result == result;

  @override
  int get hashCode => result.hashCode;
}

/// Links opened into CHE (the `che` URL scheme registered by tool/bootstrap.sh).
class CheDeepLinks {
  CheDeepLinks._();

  /// Tests hand in their own links; null uses the app_links plugin.
  @visibleForTesting
  static Stream<Uri>? debugStream;

  /// Listens for links, including the one that launched the app. Only the iPhone app has the
  /// scheme, so other platforms (and widget tests, which have no plugin) get null.
  static StreamSubscription<Uri>? listen(void Function(Uri uri) onLink) {
    final Stream<Uri> stream;
    if (debugStream != null) {
      stream = debugStream!;
    } else {
      if (kIsWeb || !Platform.isIOS) return null;
      stream = AppLinks().uriLinkStream;
    }
    return stream.listen(onLink, onError: (Object _) {});
  }
}

String _yesNo(Object? value) => value == true ? 'yes' : value == false ? 'no' : 'unknown';

String _sentence(String text) {
  final t = text.trim();
  if (t.isEmpty) return t;
  final first = t[0].toUpperCase() + t.substring(1);
  return RegExp(r'[.!?]$').hasMatch(first) ? first : '$first.';
}

/// The NinjaTrader card's separate facts, one line each, exactly as the Worker reported them.
/// Empty when the Worker did not report them.
List<String> cheNinjaTraderLines(Object? separate) {
  if (separate is! Map) return const [];
  final website = (separate['website_login'] ?? '').toString().trim();
  final accounts = separate['accounts'];
  String accountLine = 'Accounts: none reported to CHE.';
  if (accounts is Map) {
    final sim = (accounts['sim'] ?? '').toString().trim();
    final live = (accounts['live'] ?? '').toString().trim();
    final parts = [if (sim.isNotEmpty) 'simulated $sim', if (live.isNotEmpty) 'live $live'];
    if (parts.isNotEmpty) accountLine = 'Accounts: ${parts.join(', ')}.';
  }
  final market = (separate['market_data'] ?? 'unknown').toString().trim();
  final orders = (separate['live_orders'] ?? '').toString().trim();
  return [
    'Website login: ${website.isEmpty ? 'not visible to CHE.' : _sentence(website)}',
    'Brokerage authorized: ${_yesNo(separate['brokerage_authorized'])}.',
    accountLine,
    'Market data: ${market.isEmpty ? 'unknown' : market}.',
    // Live orders are reported as the Worker says; CHE's app never turns them on.
    'Live orders: ${orders.isEmpty ? 'disabled.' : _sentence(orders)}',
  ];
}

/// What CHE shows and says after the return link, from the Worker's refreshed Tradovate card
/// ([card] is null when that check failed, with [error] saying why).
String cheNinjaTraderReturnLine({required String linkResult, Map<String, dynamic>? card, String error = ''}) {
  if (card == null) {
    final why = error.trim().isEmpty ? '' : ' ${_sentence(error)}';
    return 'I could not verify NinjaTrader after the Tradovate page, sir.$why Nothing is claimed as connected.';
  }
  final state = (card['state'] ?? '').toString();
  final lines = cheNinjaTraderLines(card['separate']);
  final facts = lines.length > 2 ? ' ${lines.sublist(2).join(' ')}' : '';
  if (state == 'signed_in') return 'NinjaTrader connected. CHE verified the Tradovate sign-in.$facts';
  final words = cheConnectionStateWords[state] ?? (state.isEmpty ? 'not reported' : state.replaceAll('_', ' '));
  final page = linkResult == 'connected'
      ? 'The Tradovate page said connected, but CHE\'s check says NinjaTrader is $words.'
      : linkResult == 'failed'
          ? 'The Tradovate sign-in did not finish. CHE\'s check says NinjaTrader is $words.'
          : 'CHE\'s check says NinjaTrader is $words.';
  return 'NinjaTrader is not connected. $page Brokerage authorized: no.';
}
