// Rithmic wire format: every outgoing message matches the bytes the official R | Protocol client (protobufjs,
// from the R | Protocol API kit 0.90.0.0) produces for the same fields, and every incoming message decodes to
// the same values. Read-only: there is no order message to test because none is built.
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:chey/rithmic/rithmic_wire.dart';

Uint8List _hex(String text) {
  final out = Uint8List(text.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(text.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String _toHex(Uint8List bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

void main() {
  test('login request matches the official client byte for byte', () {
    final bytes = encodeLogin(
      user: 'user1',
      password: 'pass1',
      systemName: 'Rithmic Test',
      appName: 'CHE',
      appVersion: '1.0',
      infraType: RithmicInfra.ticker,
    );
    expect(_toHex(bytes), '92bd3f03434845a2bd3f057061737331dafb3f057573657231daad4003312e30a8814b01e2814b0c526974686d6963205465737498b64b0a');
  });

  test('heartbeat request matches the official client', () {
    expect(_toHex(encodeHeartbeat()), '98b64b12');
  });

  test('market-data subscription matches the official client (last trade and best bid/offer)', () {
    final bytes = encodeMarketDataSubscribe(symbol: 'MNQZ6', exchange: 'CME', updateBits: 3);
    expect(_toHex(bytes), '80ea3001a2e135054d4e515a36aae13503434d4598a64b0398b64b64');
  });

  test('the wire format is read-only: subscribe carries no order fields', () {
    final bytes = encodeMarketDataSubscribe(symbol: 'MNQZ6', exchange: 'CME');
    // Field 100000 (the request type) is the only action field; it is SUBSCRIBE, never an order.
    expect(bytes.first, 0x80);
    expect(RithmicFrame.parse(bytes).templateId(), RithmicTemplate.marketDataUpdate);
  });

  test('a last-trade update decodes to the same price, size, time and symbol as the official client', () {
    final frame = RithmicFrame.parse(_hex('b1ea300000000090f2d440a2e135054d4e515a36aae13503434d45a0a54980e2cfaa06a8a5490598b64b9601'));
    expect(frame.templateId(), RithmicTemplate.lastTrade);
    final trade = frame.toLastTrade();
    expect(trade.symbol, 'MNQZ6');
    expect(trade.exchange, 'CME');
    expect(trade.price, 21450.25);
    expect(trade.size, isNull, reason: 'the official client wrote no trade size into these bytes');
    expect(trade.ssboe, 1700000000);
  });

  test('a trade size on the wire is read as a number', () {
    // Field 159008 (trade_size_64), varint 3: the field the official client writes for a trade size.
    expect(RithmicFrame.parse(_hex('80d24d03')).toLastTrade().size, 3);
  });

  test('a successful login response is accepted and carries the heartbeat interval', () {
    final response = RithmicFrame.parse(_hex('89824b0000000000003e40ea994b0346434df2994b02494298b64b0b')).toLoginResponse();
    expect(response.accepted, isTrue);
    expect(response.heartbeatInterval, 30);
    expect(response.fcmId, 'FCM');
    expect(response.ibId, 'IB');
  });

  test('Rithmic answers a good login with response code "0": that is accepted, any other first code is not', () {
    expect(RithmicFrame.parse(encodeLoginResponse(rpCodes: const ['0'])).toLoginResponse().accepted, isTrue);
    expect(RithmicFrame.parse(encodeLoginResponse(rpCodes: const ['13', 'permission denied'])).toLoginResponse().accepted, isFalse);
  });

  test('discovery requests and answers round-trip: systems, then one system\'s gateways', () {
    expect(RithmicFrame.parse(encodeSystemInfoRequest()).templateId(), RithmicTemplate.systemInfo);
    final ask = RithmicFrame.parse(encodeGatewayInfoRequest(systemName: 'Rithmic Paper Trading'));
    expect(ask.templateId(), RithmicTemplate.gatewayInfo);
    final systems = RithmicFrame.parse(encodeSystemInfoResponse(systems: ['Rithmic Test', 'Rithmic Paper Trading'])).toSystemInfo();
    expect(systems.accepted, isTrue);
    expect(systems.systems, ['Rithmic Test', 'Rithmic Paper Trading']);
    final gateways = RithmicFrame.parse(encodeGatewayInfoResponse(systemName: 'Rithmic Paper Trading', names: ['Chicago Area'], uris: ['wss://g.example:443'])).toGatewayInfo();
    expect([gateways.systemName, gateways.names.single, gateways.uris.single], ['Rithmic Paper Trading', 'Chicago Area', 'wss://g.example:443']);
  });

  test('a refused login is never accepted, and its reason is kept', () {
    final response = RithmicFrame.parse(_hex('f2e9400133f2e9400c6261642070617373776f726498b64b0b')).toLoginResponse();
    expect(response.accepted, isFalse);
    expect(response.rpCodes, ['3', 'bad password']);
  });

  test('a cut-short frame is refused, never half-read', () {
    expect(() => RithmicFrame.parse(_hex('b1ea3000')), throwsFormatException);
  });
}
