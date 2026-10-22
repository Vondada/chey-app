// CHE's read-only Rithmic market-data connection, from the phone. Credentials come from the on-device vault
// (lib/security/che_password_vault.dart) and are passed in here; they are never sent to the Worker, a model or a log.
// The client reads prices only. It has no order methods. A feed reaches the Worker's live-price gate only once a
// real-time, authenticated, subscribed Rithmic feed is confirmed (see server/cloudflare/trading_live.js).
//
// Routine use needs only a username and password: the system (for example "Rithmic Paper Trading") and its gateway
// are discovered from Rithmic's bootstrap endpoint, and the front-month contract is worked out from the date.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'rithmic_wire.dart';

typedef RithmicLog = void Function(String message);

/// Rithmic's bootstrap endpoint, from the owner's R | Protocol API kit. It answers system and gateway questions
/// before any login.
final kRithmicBootstrap = Uri.parse('wss://rituz00100.rithmic.com:443');

/// The app identity CHE logs in with. Internal defaults; the owner never has to type them.
const kRithmicAppName = 'CHE';
const kRithmicAppVersion = '1.0';

/// Why a Rithmic connection did not come up. Each kind has its own plain message for the owner.
enum RithmicFailure { badLogin, systemUnavailable, marketDataPermission, gatewayDiscovery, subscription, connection }

class RithmicException implements Exception {
  const RithmicException(this.kind, this.message);
  final RithmicFailure kind;
  final String message;
  @override
  String toString() => message;
}

String _codes(List<String> rpCodes) => rpCodes.where((c) => c.trim().isNotEmpty).join(', ');

/// A login refusal, named by what Rithmic said.
RithmicException rithmicLoginFailure(List<String> rpCodes, {String system = ''}) {
  final text = rpCodes.join(' ').toLowerCase();
  final codes = _codes(rpCodes);
  if (RegExp(r'unavailable|not available|maintenance|no such system|unknown system|invalid system').hasMatch(text)) {
    return RithmicException(RithmicFailure.systemUnavailable,
        'The Rithmic system${system.isEmpty ? '' : ' "$system"'} is not available right now ($codes). Nothing was saved.');
  }
  return RithmicException(RithmicFailure.badLogin, 'Rithmic rejected the username or password ($codes). Nothing was saved.');
}

/// A refused market-data subscription: a missing permission, or a symbol Rithmic would not subscribe to.
RithmicException rithmicSubscriptionFailure(List<String> rpCodes, {required String symbol, required String exchange}) {
  final text = rpCodes.join(' ').toLowerCase();
  final codes = _codes(rpCodes);
  if (RegExp(r'permission|entitle|not authori[sz]ed|not permitted|no market data|subscription required').hasMatch(text)) {
    return RithmicException(RithmicFailure.marketDataPermission,
        'Your Rithmic login has no market-data permission for $symbol on $exchange ($codes). Ask the firm to enable CME market data.');
  }
  return RithmicException(RithmicFailure.subscription, 'Rithmic would not subscribe to $symbol on $exchange ($codes).');
}

/// One WebSocket to Rithmic: binary frames out and in. Tests supply a fake.
abstract class RithmicChannel {
  Stream<Uint8List> get frames;
  void send(Uint8List frame);
  Future<void> close();
}

typedef RithmicChannelOpener = Future<RithmicChannel> Function(Uri uri, Duration timeout);

class _WebSocketChannel implements RithmicChannel {
  _WebSocketChannel(this._socket);
  final WebSocket _socket;
  @override
  Stream<Uint8List> get frames => _socket
      .where((d) => d is List<int>)
      .map((d) => d is Uint8List ? d : Uint8List.fromList(d as List<int>));
  @override
  void send(Uint8List frame) => _socket.add(frame);
  @override
  Future<void> close() => _socket.close();
}

Future<RithmicChannel> openRithmicWebSocket(Uri uri, Duration timeout) async =>
    _WebSocketChannel(await WebSocket.connect(uri.toString()).timeout(timeout));

/// Where to log in: the Rithmic system and one of its gateways.
class RithmicRoute {
  const RithmicRoute({required this.system, required this.gatewayName, required this.gatewayUri});
  final String system;
  final String gatewayName;
  final Uri gatewayUri;
}

abstract class RithmicRouteFinder {
  /// [preferPaper]: the account is a prop-firm evaluation (FundYourEdge), which runs on Rithmic Paper Trading.
  Future<RithmicRoute> find({required bool preferPaper});
}

/// Asks Rithmic's bootstrap endpoint for the systems, picks the right one, then asks for its gateways.
class RithmicBootstrapDiscovery implements RithmicRouteFinder {
  RithmicBootstrapDiscovery({Uri? bootstrap, RithmicChannelOpener? open, this.timeout = const Duration(seconds: 12)})
      : bootstrap = bootstrap ?? kRithmicBootstrap,
        _open = open ?? openRithmicWebSocket;

  final Uri bootstrap;
  final RithmicChannelOpener _open;
  final Duration timeout;

  /// One question per connection, as the kit's samples do: connect, ask, read the answer, close.
  Future<RithmicFrame> _ask(Uint8List request, int answerTemplate) async {
    final RithmicChannel channel;
    try {
      channel = await _open(bootstrap, timeout);
    } catch (e) {
      throw RithmicException(RithmicFailure.gatewayDiscovery, 'Could not reach Rithmic to find your gateway ($e). Nothing was saved.');
    }
    try {
      final answer = channel.frames.map(_parseOrNull).firstWhere((f) => f?.templateId() == answerTemplate);
      channel.send(request);
      return (await answer.timeout(timeout))!;
    } on TimeoutException {
      throw const RithmicException(RithmicFailure.gatewayDiscovery, 'Rithmic did not answer the gateway lookup in time. Nothing was saved.');
    } on StateError {
      throw const RithmicException(RithmicFailure.gatewayDiscovery, 'Rithmic closed the gateway lookup before answering. Nothing was saved.');
    } finally {
      await channel.close();
    }
  }

  static RithmicFrame? _parseOrNull(Uint8List bytes) {
    try {
      return RithmicFrame.parse(bytes);
    } on FormatException {
      return null;
    }
  }

  @override
  Future<RithmicRoute> find({required bool preferPaper}) async {
    final info = (await _ask(encodeSystemInfoRequest(), RithmicTemplate.systemInfoResponse)).toSystemInfo();
    if (!info.accepted || info.systems.isEmpty) {
      throw RithmicException(RithmicFailure.gatewayDiscovery, 'Rithmic listed no systems (${_codes(info.rpCodes)}). Nothing was saved.');
    }
    final system = pickRithmicSystem(info.systems, preferPaper: preferPaper);
    final gateways = (await _ask(encodeGatewayInfoRequest(systemName: system), RithmicTemplate.gatewayInfoResponse)).toGatewayInfo();
    if (!gateways.accepted) throw rithmicLoginFailure(gateways.rpCodes, system: system);
    final usable = <int>[
      for (var i = 0; i < gateways.uris.length; i++)
        if (Uri.tryParse(gateways.uris[i])?.scheme == 'wss') i,
    ];
    if (usable.isEmpty) {
      throw RithmicException(RithmicFailure.systemUnavailable, 'Rithmic has no gateway open for "$system" right now. Nothing was saved.');
    }
    // CME futures are matched in Chicago, so a Chicago gateway is the nearest to the prices.
    final pick = usable.firstWhere((i) => i < gateways.names.length && gateways.names[i].toLowerCase().contains('chicago'), orElse: () => usable.first);
    return RithmicRoute(
      system: system,
      gatewayName: pick < gateways.names.length ? gateways.names[pick] : 'gateway',
      gatewayUri: Uri.parse(gateways.uris[pick]),
    );
  }
}

/// The system to log in to. A prop-firm evaluation account uses the paper-trading system; otherwise a single listed
/// system is used. CHE never guesses between several.
String pickRithmicSystem(List<String> systems, {required bool preferPaper}) {
  final paper = systems.where((s) => s.toLowerCase().contains('paper')).toList();
  if (preferPaper && paper.isNotEmpty) return paper.first;
  if (systems.length == 1) return systems.first;
  throw RithmicException(RithmicFailure.systemUnavailable,
      'Rithmic offers several systems (${systems.join(', ')}). Choose one under Advanced. Nothing was saved.');
}

/// The front-month contract for an equity-index future (MNQ, NQ, MES, ES): quarterly March, June, September and
/// December contracts, rolled on the Thursday eight days before the third-Friday expiry, as CME volume rolls.
String rithmicFrontMonth(String root, DateTime now) {
  const codes = {3: 'H', 6: 'M', 9: 'U', 12: 'Z'};
  final today = DateTime.utc(now.year, now.month, now.day);
  for (var year = now.year; year <= now.year + 1; year++) {
    for (final month in codes.keys) {
      final first = DateTime.utc(year, month, 1);
      final thirdFriday = first.add(Duration(days: (DateTime.friday - first.weekday + 7) % 7 + 14));
      final roll = thirdFriday.subtract(const Duration(days: 8));
      if (today.isBefore(roll)) return '$root${codes[month]}${year % 10}';
    }
  }
  return '${root}H${(now.year + 2) % 10}';
}

/// A read-only market-data feed from Rithmic. The app's screen talks to this, so tests can supply a fake feed.
abstract class RithmicMarketFeed {
  Stream<RithmicLastTrade> get trades;
  Stream<RithmicBestBidOffer> get quotes;

  /// True once Rithmic confirmed the market-data subscription (or sent a trade); false while it is only sent.
  bool get subscriptionConfirmed;
  Future<void> connect({
    required String user,
    required String password,
    required String systemName,
    required String appName,
    required String appVersion,
    required String symbol,
    required String exchange,
  });
  Future<void> close();
}

class RithmicClient implements RithmicMarketFeed {
  RithmicClient({required this.uri, this.log, this.connectTimeout = const Duration(seconds: 15), RithmicChannelOpener? open})
      : _open = open ?? openRithmicWebSocket;

  final Uri uri;
  final RithmicLog? log;
  final Duration connectTimeout;
  final RithmicChannelOpener _open;

  RithmicChannel? _channel;
  Timer? _heartbeat;
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  final _quotes = StreamController<RithmicBestBidOffer>.broadcast();
  final _loginWait = Completer<RithmicLoginResponse>();
  final _subscribeWait = Completer<RithmicReply>();
  StreamSubscription<Uint8List>? _incoming;
  bool _confirmed = false;

  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => _quotes.stream;
  @override
  bool get subscriptionConfirmed => _confirmed;

  @override
  /// Connects, logs in, starts heartbeats and subscribes to [symbol] on [exchange]. Throws a [RithmicException] when
  /// the server refuses the login or the subscription, or the connection cannot be made; a refusal never leaves the
  /// connection open.
  Future<void> connect({
    required String user,
    required String password,
    required String systemName,
    required String appName,
    required String appVersion,
    required String symbol,
    required String exchange,
  }) async {
    final RithmicChannel channel;
    try {
      channel = await _open(uri, connectTimeout);
    } catch (e) {
      throw RithmicException(RithmicFailure.connection, 'Could not reach the Rithmic gateway ($e). Nothing was saved.');
    }
    _channel = channel;
    _incoming = channel.frames.listen(_onFrame, onError: (Object e) => log?.call('Rithmic connection error: $e'), onDone: _onDone);
    channel.send(encodeLogin(user: user, password: password, systemName: systemName, appName: appName, appVersion: appVersion));
    final RithmicLoginResponse answer;
    try {
      answer = await _loginWait.future.timeout(connectTimeout);
    } on TimeoutException {
      await close();
      throw const RithmicException(RithmicFailure.connection, 'Rithmic did not answer the login in time. Nothing was saved.');
    } on StateError {
      await close();
      throw RithmicException(RithmicFailure.systemUnavailable,
          'Rithmic closed the connection before answering the login. The system "$systemName" may be unavailable. Nothing was saved.');
    }
    if (!answer.accepted) {
      await close();
      throw rithmicLoginFailure(answer.rpCodes, system: systemName);
    }
    final seconds = (answer.heartbeatInterval ?? 30).clamp(5, 60).toDouble();
    _heartbeat = Timer.periodic(Duration(milliseconds: (seconds * 1000).round()), (_) => _channel?.send(encodeHeartbeat()));
    channel.send(encodeMarketDataSubscribe(symbol: symbol, exchange: exchange));
    final RithmicReply reply;
    try {
      reply = await _subscribeWait.future.timeout(connectTimeout);
    } on TimeoutException {
      // Sent, not confirmed: the screen says so instead of claiming live data.
      log?.call('Rithmic has not confirmed the $symbol subscription yet.');
      return;
    }
    if (!reply.accepted) {
      await close();
      throw rithmicSubscriptionFailure(reply.rpCodes, symbol: symbol, exchange: exchange);
    }
    _confirmed = true;
    log?.call('Rithmic market data subscribed to $symbol on $exchange.');
  }

  void _onFrame(Uint8List bytes) {
    final RithmicFrame frame;
    try {
      frame = RithmicFrame.parse(bytes);
    } on FormatException catch (e) {
      log?.call('Rithmic frame refused: ${e.message}');
      return;
    }
    switch (frame.templateId()) {
      case RithmicTemplate.loginResponse:
        if (!_loginWait.isCompleted) _loginWait.complete(frame.toLoginResponse());
      case RithmicTemplate.marketDataUpdateResponse:
        if (!_subscribeWait.isCompleted) _subscribeWait.complete(frame.toReply());
      case RithmicTemplate.lastTrade:
        _confirmed = true;
        _trades.add(frame.toLastTrade());
      case RithmicTemplate.bestBidOffer:
        _quotes.add(frame.toBestBidOffer());
    }
  }

  void _onDone() {
    _heartbeat?.cancel();
    if (!_loginWait.isCompleted) _loginWait.completeError(StateError('Rithmic closed before the login answer.'));
    log?.call('Rithmic connection closed.');
  }

  /// Logs out and closes. Safe to call more than once.
  @override
  Future<void> close() async {
    _heartbeat?.cancel();
    _heartbeat = null;
    final channel = _channel;
    _channel = null;
    if (channel != null) {
      try {
        channel.send(encodeLogout());
      } catch (_) {
        // The connection may already be gone; closing is still correct.
      }
      await channel.close();
    }
    await _incoming?.cancel();
    _incoming = null;
  }
}
