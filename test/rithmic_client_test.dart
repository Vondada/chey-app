// Rithmic discovery, login, subscription and contract roll against a fake socket that plays Rithmic's part with the
// same wire messages (rithmic_wire.dart). No network. A real login still needs the owner's credentials.
import 'dart:async';
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
  bool closed = false;
  @override
  Stream<Uint8List> get frames => _in.stream;
  @override
  void send(Uint8List frame) {
    final request = RithmicFrame.parse(frame);
    sent.add(request.templateId());
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
