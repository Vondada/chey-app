// CHE's read-only Rithmic market-data connection, from the phone. Credentials come from the on-device vault
// (lib/security/che_password_vault.dart) and are passed in here; they are never sent to the Worker, a model or a log.
// The client reads prices only. It has no order methods. A feed reaches the Worker's live-price gate only once a
// real-time, authenticated, subscribed Rithmic feed is confirmed (see server/cloudflare/trading_live.js).
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'rithmic_wire.dart';

typedef RithmicLog = void Function(String message);

/// A read-only market-data feed from Rithmic. The app's screen talks to this, so tests can supply a fake feed.
abstract class RithmicMarketFeed {
  Stream<RithmicLastTrade> get trades;
  Stream<RithmicBestBidOffer> get quotes;
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
  RithmicClient({required this.uri, this.log, this.connectTimeout = const Duration(seconds: 15)});

  final Uri uri;
  final RithmicLog? log;
  final Duration connectTimeout;

  WebSocket? _socket;
  Timer? _heartbeat;
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  final _quotes = StreamController<RithmicBestBidOffer>.broadcast();
  final _loginWait = Completer<RithmicLoginResponse>();
  StreamSubscription<dynamic>? _incoming;

  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => _quotes.stream;

  @override
  /// Connects, logs in, starts heartbeats and subscribes to [symbol] on [exchange]. Throws when the server
  /// refuses the login or the connection cannot be made; a refused login never leaves the connection open.
  Future<void> connect({
    required String user,
    required String password,
    required String systemName,
    required String appName,
    required String appVersion,
    required String symbol,
    required String exchange,
  }) async {
    final socket = await WebSocket.connect(uri.toString()).timeout(connectTimeout);
    _socket = socket;
    _incoming = socket.listen(_onFrame, onError: (Object e) => log?.call('Rithmic connection error: $e'), onDone: _onDone);
    socket.add(encodeLogin(user: user, password: password, systemName: systemName, appName: appName, appVersion: appVersion));
    final answer = await _loginWait.future.timeout(connectTimeout);
    if (!answer.accepted) {
      await close();
      throw StateError('Rithmic refused the login: ${answer.rpCodes.join(' ')}');
    }
    final seconds = (answer.heartbeatInterval ?? 30).clamp(5, 60).toDouble();
    _heartbeat = Timer.periodic(Duration(milliseconds: (seconds * 1000).round()), (_) => _socket?.add(encodeHeartbeat()));
    socket.add(encodeMarketDataSubscribe(symbol: symbol, exchange: exchange));
    log?.call('Rithmic market data subscribed to $symbol on $exchange.');
  }

  void _onFrame(dynamic data) {
    final bytes = data is Uint8List ? data : (data is List<int> ? Uint8List.fromList(data) : null);
    if (bytes == null) return;
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
      case RithmicTemplate.lastTrade:
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
    final socket = _socket;
    _socket = null;
    if (socket != null) {
      try {
        socket.add(encodeLogout());
      } catch (_) {
        // The connection may already be gone; closing is still correct.
      }
      await socket.close();
    }
    await _incoming?.cancel();
    _incoming = null;
  }
}
