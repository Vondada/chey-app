// Rithmic R | Protocol API, the messages CHE needs for read-only market data: login, heartbeat, logout, the
// market-data subscription, and the last-trade and best-bid/offer updates it receives. Built from the
// protocol files in Rithmic's R | Protocol API kit (version 0.90.0.0). Each WebSocket frame is one protobuf
// message, with no length prefix. Fields are written in ascending field-number order, the same order the
// official client produces. There is deliberately no order-entry message here: CHE's Rithmic connection
// reads market data only.
import 'dart:convert';
import 'dart:typed_data';

class RithmicTemplate {
  static const login = 10;
  static const loginResponse = 11;
  static const logout = 12;
  static const heartbeat = 18;
  static const heartbeatResponse = 19;
  static const marketDataUpdate = 100;
  static const marketDataUpdateResponse = 101;
  static const lastTrade = 150;
  static const bestBidOffer = 151;
}

/// Infrastructure plant the login connects to. Market data runs on the ticker plant only.
class RithmicInfra {
  static const ticker = 1;
}

/// Bits in a market-data subscription: last trade and best bid/offer.
class RithmicUpdateBits {
  static const lastTrade = 1;
  static const bbo = 2;
}

const _templateField = 154467;

class _Writer {
  final _out = BytesBuilder();

  void _varint(int value) {
    var v = value;
    while (v >= 0x80) {
      _out.addByte((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    _out.addByte(v);
  }

  void _tag(int field, int wire) => _varint((field << 3) | wire);

  void int32(int field, int value) {
    _tag(field, 0);
    _varint(value);
  }

  void boolean(int field, bool value) => int32(field, value ? 1 : 0);

  void string(int field, String value) {
    final bytes = utf8.encode(value);
    _tag(field, 2);
    _varint(bytes.length);
    _out.add(bytes);
  }

  Uint8List take() => _out.takeBytes();
}

/// One message's fields, written in ascending field-number order.
class _Message {
  final _fields = <int, void Function(_Writer)>{};

  _Message put(int field, void Function(_Writer) write) {
    _fields[field] = write;
    return this;
  }

  Uint8List encode() {
    final writer = _Writer();
    for (final field in _fields.keys.toList()..sort()) {
      _fields[field]!(writer);
    }
    return writer.take();
  }
}

/// Login request. [systemName] is the Rithmic system the firm gives you (for example the name shown on its login
/// page); [appName] and [appVersion] are the identity your Rithmic developer key was issued for.
Uint8List encodeLogin({
  required String user,
  required String password,
  required String systemName,
  required String appName,
  required String appVersion,
  String templateVersion = '',
  int infraType = RithmicInfra.ticker,
}) {
  final m = _Message()
    ..put(130002, (w) => w.string(130002, appName))
    ..put(130004, (w) => w.string(130004, password))
    ..put(131003, (w) => w.string(131003, user))
    ..put(131803, (w) => w.string(131803, appVersion))
    ..put(153621, (w) => w.int32(153621, infraType))
    ..put(153628, (w) => w.string(153628, systemName))
    ..put(_templateField, (w) => w.int32(_templateField, RithmicTemplate.login));
  if (templateVersion.isNotEmpty) m.put(153634, (w) => w.string(153634, templateVersion));
  return m.encode();
}

Uint8List encodeHeartbeat() => (_Message()..put(_templateField, (w) => w.int32(_templateField, RithmicTemplate.heartbeat))).encode();

Uint8List encodeLogout() => (_Message()..put(_templateField, (w) => w.int32(_templateField, RithmicTemplate.logout))).encode();

/// Subscribes to market data for one contract. [updateBits] picks the updates wanted (see [RithmicUpdateBits]).
Uint8List encodeMarketDataSubscribe({
  required String symbol,
  required String exchange,
  int updateBits = RithmicUpdateBits.lastTrade | RithmicUpdateBits.bbo,
}) {
  const subscribe = 1; // RequestMarketDataUpdate.Request.SUBSCRIBE
  return (_Message()
        ..put(100000, (w) => w.int32(100000, subscribe))
        ..put(110100, (w) => w.string(110100, symbol))
        ..put(110101, (w) => w.string(110101, exchange))
        ..put(154211, (w) => w.int32(154211, updateBits))
        ..put(_templateField, (w) => w.int32(_templateField, RithmicTemplate.marketDataUpdate)))
      .encode();
}

// ─── Reading ───

class _Field {
  _Field(this.wire, this.varint, this.bytes);
  final int wire;
  final int varint;
  final Uint8List bytes;
}

/// Reads one message into its fields. A malformed frame throws a FormatException; it is never half-read.
class RithmicFrame {
  RithmicFrame._(this._fields);

  final Map<int, List<_Field>> _fields;

  factory RithmicFrame.parse(Uint8List data) {
    final fields = <int, List<_Field>>{};
    var at = 0;
    int readVarint() {
      var shift = 0;
      var result = 0;
      while (true) {
        if (at >= data.length) throw const FormatException('Rithmic frame ended in the middle of a number.');
        final b = data[at++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) == 0) return result;
        shift += 7;
        if (shift > 63) throw const FormatException('Rithmic frame has a number that is too long.');
      }
    }

    while (at < data.length) {
      final tag = readVarint();
      final field = tag >>> 3;
      final wire = tag & 7;
      if (field == 0) throw const FormatException('Rithmic frame has an invalid field.');
      switch (wire) {
        case 0:
          fields.putIfAbsent(field, () => []).add(_Field(0, readVarint(), Uint8List(0)));
        case 1:
          if (at + 8 > data.length) throw const FormatException('Rithmic frame is cut short.');
          fields.putIfAbsent(field, () => []).add(_Field(1, 0, Uint8List.sublistView(data, at, at + 8)));
          at += 8;
        case 2:
          final length = readVarint();
          if (length < 0 || at + length > data.length) throw const FormatException('Rithmic frame is cut short.');
          fields.putIfAbsent(field, () => []).add(_Field(2, 0, Uint8List.sublistView(data, at, at + length)));
          at += length;
        default:
          throw FormatException('Rithmic frame uses an unsupported field type ($wire).');
      }
    }
    return RithmicFrame._(fields);
  }

  int? templateId() => _int(_templateField);

  int? _int(int field) {
    final list = _fields[field];
    return list == null || list.isEmpty ? null : list.first.varint;
  }

  String? _string(int field) {
    final list = _fields[field];
    return list == null || list.isEmpty ? null : utf8.decode(list.first.bytes);
  }

  double? _double(int field) {
    final list = _fields[field];
    if (list == null || list.isEmpty || list.first.wire != 1) return null;
    return ByteData.sublistView(list.first.bytes).getFloat64(0, Endian.little);
  }

  List<String> _strings(int field) => [for (final f in _fields[field] ?? const <_Field>[]) utf8.decode(f.bytes)];

  /// The login answer. Its rp_code list is empty on success; anything else is the reason it was refused.
  RithmicLoginResponse toLoginResponse() => RithmicLoginResponse(
        rpCodes: _strings(132766),
        heartbeatInterval: _double(153633),
        fcmId: _string(154013) ?? '',
        ibId: _string(154014) ?? '',
      );

  RithmicLastTrade toLastTrade() => RithmicLastTrade(
        symbol: _string(110100) ?? '',
        exchange: _string(110101) ?? '',
        price: _double(100006),
        size: _int(159008),
        ssboe: _int(150100),
      );

  RithmicBestBidOffer toBestBidOffer() => RithmicBestBidOffer(
        symbol: _string(110100) ?? '',
        exchange: _string(110101) ?? '',
        bidPrice: _double(100022),
        bidSize: _int(159000),
        askPrice: _double(100025),
        askSize: _int(159002),
        ssboe: _int(150100),
      );
}

class RithmicLoginResponse {
  const RithmicLoginResponse({required this.rpCodes, required this.heartbeatInterval, required this.fcmId, required this.ibId});
  final List<String> rpCodes;
  final double? heartbeatInterval;
  final String fcmId;
  final String ibId;

  /// True only when the server accepted the login: no response code was returned.
  bool get accepted => rpCodes.isEmpty;
}

class RithmicLastTrade {
  const RithmicLastTrade({required this.symbol, required this.exchange, required this.price, required this.size, required this.ssboe});
  final String symbol;
  final String exchange;
  final double? price;
  final int? size;
  final int? ssboe;
}

class RithmicBestBidOffer {
  const RithmicBestBidOffer({
    required this.symbol,
    required this.exchange,
    required this.bidPrice,
    required this.bidSize,
    required this.askPrice,
    required this.askSize,
    required this.ssboe,
  });
  final String symbol;
  final String exchange;
  final double? bidPrice;
  final int? bidSize;
  final double? askPrice;
  final int? askSize;
  final int? ssboe;
}
