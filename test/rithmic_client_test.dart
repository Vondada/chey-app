// Rithmic discovery, login, subscription and contract roll against a fake socket that plays Rithmic's part with the
// same wire messages (rithmic_wire.dart). No network. A real login still needs the owner's credentials.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:flutter_test/flutter_test.dart';

/// A socket whose server side answers each request with [answer].
class FakeChannel implements RithmicChannel {
  FakeChannel(this.answer);
  final List<Uint8List> Function(RithmicFrame request) answer;
  final _in = StreamController<Uint8List>.broadcast();
  final sent = <int?>[];
  final sentFrames = <Uint8List>[];
  bool closed = false;
  @override
  Stream<Uint8List> get frames => _in.stream;
  @override
  void send(Uint8List frame) {
    final request = RithmicFrame.parse(frame);
    sent.add(request.templateId());
    sentFrames.add(Uint8List.fromList(frame));
    for (final reply in answer(request)) {
      scheduleMicrotask(() {
        if (!closed) _in.add(reply);
      });
    }
  }

  @override
  Future<void> close() async {
    closed = true;
    await _in.close();
  }
}

RithmicChannelOpener opener(List<FakeChannel> opened, List<Uint8List> Function(RithmicFrame) answer, {List<Uri>? uris}) =>
    (uri, _) async {
      uris?.add(uri);
      final c = FakeChannel(answer);
      opened.add(c);
      return c;
    };

List<Uint8List> bootstrap(RithmicFrame r, {List<String> systems = const ['Rithmic Test', 'Rithmic Paper Trading', 'Rithmic 01']}) {
  if (r.templateId() == RithmicTemplate.systemInfo) return [encodeSystemInfoResponse(systems: systems)];
  if (r.templateId() == RithmicTemplate.gatewayInfo) {
    return [encodeGatewayInfoResponse(systemName: 'Rithmic Paper Trading', names: ['Europe', 'Chicago Area'], uris: ['wss://eu.example:443', 'wss://chicago.example:443'])];
  }
  return const [];
}

void main() {
  test('the actual WebSocket adds and removes the Rithmic length header', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final peer = server.first.then(WebSocketTransformer.upgrade);
    final channel = await openRithmicWebSocket(Uri.parse('ws://127.0.0.1:${server.port}'), const Duration(seconds: 2));
    addTearDown(channel.close);
    final socket = await peer;
    addTearDown(socket.close);
    final request = socket.first;
    final response = channel.frames.first;
    channel.send(encodeHeartbeat());
    expect(await request, [0, 0, 0, 4, 0x98, 0xb6, 0x4b, 0x12]);
    socket.add([0, 0, 0, 4, 0x98, 0xb6, 0x4b, 0x13]);
    expect(RithmicFrame.parse(await response).templateId(), RithmicTemplate.heartbeatResponse);
  });

  test('ordinary account discovery uses production, never the UAT gateway', () {
    expect(kRithmicBootstrap.host, 'rprotocol.rithmic.com');
  });

  test('a chosen system controls discovery and gateway lookup together', () async {
    final uris = <Uri>[];
    final gatewayRequests = <String>[];
    final finder = RithmicBootstrapDiscovery(open: opener([], (request) {
      if (request.templateId() == RithmicTemplate.systemInfo) {
        return [encodeSystemInfoResponse(systems: ['Rithmic Paper Trading', 'Firm System'])];
      }
      gatewayRequests.add(request.toGatewayInfo().systemName);
      return [encodeGatewayInfoResponse(systemName: 'Firm System', names: ['Chicago'], uris: ['wss://firm.example:443'])];
    }, uris: uris));
    final route = await finder.find(preferPaper: true, systemName: 'Firm System');
    expect(route.system, 'Firm System');
    expect(route.gatewayUri.host, 'firm.example');
    expect(gatewayRequests, ['Firm System']);
    expect(uris.every((uri) => uri == kRithmicBootstrap), isTrue);
  });

  test('Rithmic Test is used only when explicitly chosen', () async {
    final uris = <Uri>[];
    final finder = RithmicBootstrapDiscovery(open: opener([], (request) {
      if (request.templateId() == RithmicTemplate.systemInfo) {
        return [encodeSystemInfoResponse(systems: ['Rithmic Test'])];
      }
      return [encodeGatewayInfoResponse(systemName: 'Rithmic Test', names: ['UAT'], uris: ['wss://test.example:443'])];
    }, uris: uris));
    final route = await finder.find(preferPaper: false, systemName: 'Rithmic Test');
    expect(route.system, 'Rithmic Test');
    expect(uris.every((uri) => uri == kRithmicTestBootstrap), isTrue);
  });

  test('an unavailable explicit system never sends a gateway lookup or login', () async {
    final opened = <FakeChannel>[];
    final finder = RithmicBootstrapDiscovery(open: opener(opened, bootstrap));
    await expectLater(finder.find(preferPaper: true, systemName: 'Absent firm'),
        throwsA(isA<RithmicException>().having((e) => e.message, 'message', contains('Login was not attempted'))));
    expect(opened.expand((c) => c.sent), [RithmicTemplate.systemInfo]);
    expect(opened.single.closed, isTrue);
  });

  test('discovery asks the bootstrap endpoint for systems, picks Paper Trading for a prop account, and its Chicago gateway', () async {
    final opened = <FakeChannel>[];
    final uris = <Uri>[];
    final route = await RithmicBootstrapDiscovery(open: opener(opened, bootstrap, uris: uris)).find(preferPaper: true);
    expect(route.system, 'Rithmic Paper Trading');
    expect(route.gatewayName, 'Chicago Area');
    expect(route.gatewayUri.toString(), 'wss://chicago.example:443');
    expect(uris.every((u) => u == kRithmicBootstrap), isTrue);
    expect(opened.expand((c) => c.sent), [RithmicTemplate.systemInfo, RithmicTemplate.gatewayInfo]);
    expect(opened.every((c) => c.closed), isTrue, reason: 'each lookup closes its connection');
  });

  test('several systems and no prop account: CHE asks for one under Advanced instead of guessing', () async {
    final finder = RithmicBootstrapDiscovery(open: opener([], bootstrap));
    await expectLater(finder.find(preferPaper: false), throwsA(isA<RithmicException>().having((e) => e.message, 'message', contains('Choose one under Advanced'))));
  });

  test('a gateway lookup that fails is a discovery failure, never a connection', () async {
    final unreachable = RithmicBootstrapDiscovery(open: (_, _) async => throw Exception('offline'));
    await expectLater(unreachable.find(preferPaper: true),
        throwsA(isA<RithmicException>().having((e) => e.kind, 'kind', RithmicFailure.gatewayDiscovery)));
    final silent = RithmicBootstrapDiscovery(open: opener([], (_) => const []), timeout: const Duration(milliseconds: 50));
    await expectLater(silent.find(preferPaper: true),
        throwsA(isA<RithmicException>().having((e) => e.kind, 'kind', RithmicFailure.gatewayDiscovery)));
    final none = RithmicBootstrapDiscovery(open: opener([], (r) => bootstrap(r, systems: const [])));
    await expectLater(none.find(preferPaper: true),
        throwsA(isA<RithmicException>().having((e) => e.kind, 'kind', RithmicFailure.gatewayDiscovery)));
  });

  test('a login Rithmic answers with code "0" is accepted, and the subscription is confirmed', () async {
    final opened = <FakeChannel>[];
    final client = RithmicClient(uri: Uri.parse('wss://chicago.example:443'), open: opener(opened, (r) {
      if (r.templateId() == RithmicTemplate.login) return [encodeLoginResponse(rpCodes: const ['0'])];
      if (r.templateId() == RithmicTemplate.marketDataUpdate) return [encodeMarketDataResponse()];
      return const [];
    }));
    await client.connect(user: 'u', password: 'p', systemName: 'Rithmic Paper Trading', appName: 'CHE', appVersion: '1.0', symbol: 'MNQZ6', exchange: 'CME');
    expect(client.subscriptionConfirmed, isTrue);
    expect(opened.single.sent, [RithmicTemplate.login, RithmicTemplate.marketDataUpdate]);
    expect(opened.single.closed, isFalse);
    await client.close();
    expect(opened.single.closed, isTrue);
  });

  test('the actual login socket frame contains the template version and preserves app/system identity', () async {
    final opened = <FakeChannel>[];
    final client = RithmicClient(uri: Uri.parse('wss://gateway.example:443'), open: opener(opened, (r) {
      if (r.templateId() == RithmicTemplate.login) return [encodeLoginResponse(rpCodes: const ['0'])];
      if (r.templateId() == RithmicTemplate.marketDataUpdate) return [encodeMarketDataResponse()];
      return const [];
    }));
    await client.connect(user: 'fixture-user', password: 'fixture-password', systemName: 'Rithmic Paper Trading', appName: 'CHE', appVersion: '1.0', symbol: 'MNQZ6', exchange: 'CME');
    final frame = opened.single.sentFrames.first;
    final hex = frame.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    // Field 153634, wire type 2, length 3, UTF-8 "3.9"; not app_version field 131803.
    expect(hex, contains('92824b03332e39'));
    expect(hex, contains('daad4003312e30'));
    expect(String.fromCharCodes(frame), contains('Rithmic Paper Trading'));
    expect(opened.single.sent, [RithmicTemplate.login, RithmicTemplate.marketDataUpdate]);
    await client.close();
  });

  test('1084 closes the connection and reports protocol incompatibility without blaming credentials', () async {
    final opened = <FakeChannel>[];
    final client = RithmicClient(uri: Uri.parse('wss://gateway.example:443'), open: opener(opened, (_) => [encodeLoginResponse(rpCodes: const ['1084', 'template version field is not received'])]));
    await expectLater(client.connect(user: 'fixture-user', password: 'fixture-password', systemName: 'Rithmic Paper Trading', appName: 'CHE', appVersion: '1.0', symbol: 'MNQZ6', exchange: 'CME'),
      throwsA(isA<RithmicException>().having((e) => e.kind, 'kind', RithmicFailure.protocolVersion).having((e) => e.message, 'reason', contains('1084'))));
    expect(opened.single.closed, isTrue);
    expect(client.subscriptionConfirmed, isFalse);
    expect(opened.single.sent, isNot(contains(RithmicTemplate.marketDataUpdate)));
  });

  test('application rejection and unknown refusals are not mislabeled as bad passwords', () {
    expect(rithmicLoginFailure(['application name not permitted']).kind, RithmicFailure.applicationIdentity);
    expect(rithmicLoginFailure(['9999', 'unspecified refusal']).kind, RithmicFailure.loginRejected);
  });

  test('a refused login is a bad-login error and closes the connection', () async {
    final opened = <FakeChannel>[];
    final client = RithmicClient(uri: Uri.parse('wss://g.example'), open: opener(opened, (r) => [encodeLoginResponse(rpCodes: const ['3', 'bad password'])]));
    await expectLater(
      client.connect(user: 'u', password: 'wrong', systemName: 'S', appName: 'CHE', appVersion: '1.0', symbol: 'MNQZ6', exchange: 'CME'),
      throwsA(isA<RithmicException>().having((e) => e.kind, 'kind', RithmicFailure.badLogin)),
    );
    expect(opened.single.closed, isTrue);
  });

  test('a subscription refused for market-data permission says so and closes', () async {
    final opened = <FakeChannel>[];
    final client = RithmicClient(uri: Uri.parse('wss://g.example'), open: opener(opened, (r) {
      if (r.templateId() == RithmicTemplate.login) return [encodeLoginResponse()];
      if (r.templateId() == RithmicTemplate.marketDataUpdate) return [encodeMarketDataResponse(rpCodes: const ['7', 'no market data permission'])];
      return const [];
    }));
    await expectLater(
      client.connect(user: 'u', password: 'p', systemName: 'S', appName: 'CHE', appVersion: '1.0', symbol: 'MNQZ6', exchange: 'CME'),
      throwsA(isA<RithmicException>().having((e) => e.kind, 'kind', RithmicFailure.marketDataPermission)),
    );
    expect(opened.single.closed, isTrue);
  });

  test('the front-month contract rolls on its own: Thursday eight days before the third-Friday expiry', () {
    expect(rithmicFrontMonth('MNQ', DateTime.utc(2026, 10, 22)), 'MNQZ6');
    // December 2026 expires Friday the 18th; volume rolls Thursday the 10th.
    expect(rithmicFrontMonth('MNQ', DateTime.utc(2026, 12, 9)), 'MNQZ6');
    expect(rithmicFrontMonth('MNQ', DateTime.utc(2026, 12, 10)), 'MNQH7');
    expect(rithmicFrontMonth('NQ', DateTime.utc(2027, 1, 5)), 'NQH7');
    // March 2027 expires Friday the 19th; it rolls to June on Thursday the 11th.
    expect(rithmicFrontMonth('NQ', DateTime.utc(2027, 3, 11)), 'NQM7');
    expect(rithmicFrontMonth('MNQ', DateTime.utc(2027, 8, 30)), 'MNQU7');
  });

  test('the system pick never guesses between several systems', () {
    expect(pickRithmicSystem(['Rithmic Paper Trading', 'Rithmic 01'], preferPaper: true), 'Rithmic Paper Trading');
    expect(pickRithmicSystem(['Rithmic 01'], preferPaper: false), 'Rithmic 01');
    expect(() => pickRithmicSystem(['Rithmic 01', 'Rithmic 04'], preferPaper: true), throwsA(isA<RithmicException>()));
  });
}
