// CHE trading audit trail (owner, 2026-10-23, item 25): one append-only log on this phone for
// signals, setup-stage changes, alerts, and (from the paper-account and live-preview lanes) paper
// orders, balance changes, position changes and live-order approvals.
//
// Append-only by construction: the only write is [CheTradeAudit.append]. There is no edit or delete.
// Each line carries a sequence number and a chain value over the previous line, so a removed or
// changed line shows up in [CheTradeAudit.verify]. The chain is an integrity check, not encryption.
// Nothing secret is ever written here: no passwords, keys or account credentials.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

class CheAuditEntry {
  const CheAuditEntry({required this.seq, required this.at, required this.kind, required this.account, required this.data, required this.chain});

  final int seq;
  final DateTime at;

  /// e.g. 'signal', 'setup_stage', 'alert', 'paper_order', 'balance_change', 'position_change', 'live_order_approval'.
  final String kind;

  /// 'CHE PAPER ACCOUNT', 'MY ACCOUNT' or 'LIVE ACCOUNT'.
  final String account;
  final Map<String, dynamic> data;
  final String chain;

  Map<String, dynamic> toJson() => {'seq': seq, 'at': at.toUtc().toIso8601String(), 'kind': kind, 'account': account, 'data': data, 'chain': chain};

  static CheAuditEntry? fromJson(Object? j) {
    if (j is! Map) return null;
    final at = DateTime.tryParse('${j['at']}');
    if (at == null || j['seq'] is! int) return null;
    return CheAuditEntry(
      seq: j['seq'] as int,
      at: at,
      kind: '${j['kind']}',
      account: '${j['account']}',
      data: j['data'] is Map ? Map<String, dynamic>.from(j['data'] as Map) : const {},
      chain: '${j['chain']}',
    );
  }
}

/// FNV-1a over the previous chain value and this line's content.
String cheAuditChain(String previous, int seq, String at, String kind, String account, Map<String, dynamic> data) {
  var h = 0xcbf29ce484222325;
  const prime = 0x100000001b3;
  for (final unit in utf8.encode('$previous|$seq|$at|$kind|$account|${jsonEncode(data)}')) {
    h ^= unit;
    h = (h * prime) & 0xFFFFFFFFFFFFFFFF;
  }
  return h.toUnsigned(64).toRadixString(16).padLeft(16, '0');
}

class CheTradeAudit {
  CheTradeAudit({Future<File> Function()? file, DateTime Function()? clock})
      : _file = file ?? _defaultFile,
        _clock = clock ?? DateTime.now;

  static final instance = CheTradeAudit();

  final Future<File> Function() _file;
  final DateTime Function() _clock;
  final List<CheAuditEntry> _entries = [];
  final _added = StreamController<CheAuditEntry>.broadcast();
  bool _loaded = false;
  Future<void> _queue = Future.value();

  static Future<File> _defaultFile() async {
    final dir = await getApplicationDocumentsDirectory();
    return File('${dir.path}/che_trade_audit.jsonl');
  }

  Stream<CheAuditEntry> get added => _added.stream;

  /// Every entry so far, oldest first. The list is a copy; it cannot change the log.
  Future<List<CheAuditEntry>> entries() async {
    await _load();
    return List.unmodifiable(_entries);
  }

  Future<void> _load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final f = await _file();
      if (!await f.exists()) return;
      for (final line in await f.readAsLines()) {
        if (line.trim().isEmpty) continue;
        try {
          final e = CheAuditEntry.fromJson(jsonDecode(line));
          if (e != null) _entries.add(e);
        } catch (_) {}
      }
    } catch (_) {}
  }

  /// Adds one line. Writes are serialized so sequence numbers never collide.
  Future<CheAuditEntry> append(String kind, {required String account, Map<String, dynamic> data = const {}}) {
    final done = Completer<CheAuditEntry>();
    _queue = _queue.then((_) async {
      await _load();
      final seq = _entries.isEmpty ? 1 : _entries.last.seq + 1;
      final at = _clock().toUtc();
      final previous = _entries.isEmpty ? '' : _entries.last.chain;
      final clean = Map<String, dynamic>.from(data);
      final entry = CheAuditEntry(seq: seq, at: at, kind: kind, account: account, data: clean, chain: cheAuditChain(previous, seq, at.toIso8601String(), kind, account, clean));
      _entries.add(entry);
      try {
        final f = await _file();
        await f.writeAsString('${jsonEncode(entry.toJson())}\n', mode: FileMode.append, flush: true);
      } catch (_) {
        // The in-memory log still holds it; a disk failure is reported by verify() as a gap after restart.
      }
      _added.add(entry);
      done.complete(entry);
    });
    return done.future;
  }

  /// Checks sequence and chain. Returns problems in plain words; empty means intact.
  Future<List<String>> verify() async {
    await _load();
    final problems = <String>[];
    var previous = '';
    for (var i = 0; i < _entries.length; i++) {
      final e = _entries[i];
      if (e.seq != i + 1) problems.add('entry ${i + 1} has sequence ${e.seq}: an entry is missing or out of order');
      final expect = cheAuditChain(previous, e.seq, e.at.toUtc().toIso8601String(), e.kind, e.account, e.data);
      if (expect != e.chain) problems.add('entry ${e.seq} does not match the chain: it or an earlier entry was changed');
      previous = e.chain;
    }
    return problems;
  }
}
