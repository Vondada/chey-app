// The phone's Brain replica: durable local writes, offline search, an outbox
// cleared only on acknowledgement, pull paging, conflicts kept, digests that
// match the Worker's, and a journal that survives a restart. The Worker is a
// fake here with the same reconcile outcomes brain_store.js returns; the
// Worker's own rules are tested in server/cloudflare/brain_store.test.mjs.
// Nothing in this file is proof of behavior on a physical iPhone.
import 'dart:convert';
import 'dart:io';

import 'package:chey/memory/che_brain_replica.dart';
import 'package:flutter_test/flutter_test.dart';

/// A tiny in-memory Worker: enough of /api/brain/push and /api/brain/changes to
/// exercise the client. Outcomes mirror brain_store.js.
class FakeWorker {
  final Map<String, Map<String, dynamic>> records = {};
  final Map<String, String> ops = {};
  int seq = 0;
  int pushes = 0;
  bool failPush = false;
  bool failChanges = false;
  Set<String> sensitive = {};

  Map<String, dynamic> _write(Map<String, dynamic> record, {required int rev, bool deleted = false, String origin = 'cloud'}) {
    seq += 1;
    final stored = {
      ...record, 'rev': rev, 'seq': seq, 'deleted': deleted, 'origin': origin,
      'updated_at': DateTime.now().toUtc().toIso8601String(),
      if (deleted) ...{'title': '', 'body': '', 'links': []},
    };
    records['${record['id']}'] = stored;
    return stored;
  }

  Future<({int status, String body})> post(Uri uri, Map<String, String> headers, String body) async {
    pushes += 1;
    if (failPush) return (status: 503, body: 'down');
    final payload = jsonDecode(body) as Map<String, dynamic>;
    final results = <Map<String, dynamic>>[];
    for (final raw in (payload['ops'] as List).whereType<Map>()) {
      final op = Map<String, dynamic>.from(raw);
      final opId = '${op['op_id']}';
      if (ops.containsKey(opId)) {
        final id = '${op['id'] ?? (op['record'] as Map?)?['id']}';
        results.add({'op_id': opId, 'outcome': 'duplicate', 'first_outcome': ops[opId], 'id': id, 'record': records[id]});
        continue;
      }
      if (op['type'] == 'delete') {
        final id = '${op['id']}';
        final current = records[id];
        final stored = _write(current ?? {'id': id, 'kind': 'note', 'region': 'Learned Knowledge', 'path': ''}, rev: ((current?['rev'] as int?) ?? 0) + 1, deleted: true, origin: '${payload['device']}');
        ops[opId] = 'deleted';
        results.add({'op_id': opId, 'id': id, 'outcome': 'deleted', 'rev': stored['rev'], 'record': stored});
        continue;
      }
      final record = Map<String, dynamic>.from(op['record'] as Map);
      final id = '${record['id']}';
      if (sensitive.contains(id)) {
        ops[opId] = 'rejected';
        results.add({'op_id': opId, 'id': id, 'outcome': 'rejected', 'reason': 'rejected_sensitive_or_empty'});
        continue;
      }
      final current = records[id];
      if (current == null) {
        final stored = _write(record, rev: 1, origin: '${payload['device']}');
        ops[opId] = 'created';
        results.add({'op_id': opId, 'id': id, 'outcome': 'created', 'rev': stored['rev']});
      } else if (op['base_rev'] == current['rev']) {
        final stored = _write(record, rev: (current['rev'] as int) + 1, origin: '${payload['device']}');
        ops[opId] = 'updated';
        results.add({'op_id': opId, 'id': id, 'outcome': 'updated', 'rev': stored['rev'], 'record': stored});
      } else {
        ops[opId] = 'conflict';
        results.add({'op_id': opId, 'id': id, 'outcome': 'conflict', 'rev': current['rev'], 'conflict_id': '$id@conflict', 'record': current});
      }
    }
    return (status: 200, body: jsonEncode({'results': results, 'seq': seq, 'digest': digest()}));
  }

  Map<String, int> digest() {
    var sum = 0;
    for (final r in records.values) {
      sum = (sum + cheFnv1a32('${r['id']}:${r['rev']}')) % 4294967296;
    }
    return {'count': records.length, 'sum': sum};
  }

  Future<({int status, String body})> get(Uri uri, Map<String, String> headers) async {
    if (failChanges) return (status: 500, body: 'down');
    final since = int.tryParse(uri.queryParameters['since'] ?? '0') ?? 0;
    final limit = int.tryParse(uri.queryParameters['limit'] ?? '500') ?? 500;
    final rows = records.values.where((r) => (r['seq'] as int) > since).toList()..sort((a, b) => (a['seq'] as int).compareTo(b['seq'] as int));
    final page = rows.take(limit).toList();
    return (status: 200, body: jsonEncode({
      'records': page, 'next': page.isEmpty ? since : page.last['seq'], 'more': rows.length > limit, 'seq': seq, 'digest': digest(),
    }));
  }

  void cloudWrite(String id, {required String title, required String body, String region = 'Learned Knowledge', String path = 'Notes', String kind = 'note'}) {
    final current = records[id];
    _write({'id': id, 'kind': kind, 'region': region, 'path': path, 'title': title, 'body': body, 'verification': 'owner_attested', 'source': {'kind': 'test'}, 'links': [], 'created_at': '2026-10-01T00:00:00.000Z'}, rev: ((current?['rev'] as int?) ?? 0) + 1);
  }
}

Future<Directory> freshDir() async => (await Directory.systemTemp.createTemp('che_brain_replica_')).absolute;

void main() {
  test('fnv1a32 matches the Worker reference values', () {
    expect(cheFnv1a32(''), 0x811c9dc5);
    expect(cheFnv1a32('a'), 0xe40c292c);
    expect(cheFnv1a32('mem:abc:3'), isNot(cheFnv1a32('mem:abc:4')));
  });

  test('A: a memory saved offline is durable, searchable, and queued; a restart replays the journal', () async {
    final dir = await freshDir();
    final brain = CheBrainReplica(directory: dir);
    final saved = (await brain.remember(kind: 'memory', region: 'Personal Memory', path: 'Family', body: 'My sister Ana lives in Lisbon.'))!;
    expect(saved.pending, isTrue);
    expect(saved.rev, 0);
    expect(brain.pendingOps, 1);
    expect(brain.search('where does my sister live').first.id, saved.id);
    expect(brain.folders().firstWhere((f) => f['region'] == 'Personal Memory')['count'], 1);

    final again = CheBrainReplica(directory: dir);
    await again.load();
    expect(again.count, 1);
    expect(again.pendingOps, 1, reason: 'the outbox survives a restart');
    expect(again.search('Lisbon').first.title, 'My sister Ana lives in Lisbon.');
  });

  test('B: push then pull; the outbox is cleared only on acknowledgement; digests match the Worker', () async {
    final dir = await freshDir();
    final worker = FakeWorker();
    final brain = CheBrainReplica(directory: dir, deviceName: 'iphone');
    await brain.remember(id: 'mem:1', kind: 'memory', region: 'Personal Memory', body: 'The boiler is serviced every October.');
    worker.cloudWrite('note:cloud', title: 'From the cloud', body: 'The Worker learned this while the phone was away.');

    worker.failPush = true;
    final failed = await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect(failed.ok, isFalse);
    expect(failed.pendingAfter, 1, reason: 'a failed push drops nothing');
    expect(brain.get('mem:1')!.pending, isTrue);
    expect(failed.speech(), contains('Nothing was lost'));

    worker.failPush = false;
    final receipt = await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect(receipt.ok, isTrue);
    expect(receipt.pushed, 1);
    expect(receipt.acknowledged, 1);
    expect(receipt.pulled, 2, reason: 'its own record comes back with its seq, plus the cloud note');
    expect(brain.pendingOps, 0);
    expect(brain.get('mem:1')!.rev, 1);
    expect(brain.get('mem:1')!.pending, isFalse);
    expect(brain.get('note:cloud')!.title, 'From the cloud');
    expect(receipt.digestChecked, isTrue);
    expect(receipt.digestMatch, isTrue);
    expect(brain.digest().sum, worker.digest()['sum']);
    expect(receipt.speech(), contains('Both copies match'));

    final idle = await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect(idle.pushed, 0);
    expect(idle.pulled, 0);
    expect(idle.digestMatch, isTrue);
  });

  test('C: a delete here becomes a tombstone there, and a cloud delete removes the record here', () async {
    final dir = await freshDir();
    final worker = FakeWorker();
    final brain = CheBrainReplica(directory: dir);
    await brain.remember(id: 'mem:gone', kind: 'memory', region: 'Personal Memory', body: 'Temporary note to forget.');
    await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    await brain.forget('mem:gone');
    expect(brain.search('temporary').isEmpty, isTrue);
    await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect(worker.records['mem:gone']!['deleted'], isTrue);
    expect(brain.get('mem:gone')!.deleted, isTrue);
    expect(brain.count, 0);
    expect(brain.tombstones, 1);
    expect(brain.digest().sum, worker.digest()['sum']);

    worker.cloudWrite('note:x', title: 'Will vanish', body: 'Deleted on the Memory screen later.');
    await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect(brain.get('note:x'), isNotNull);
    worker._write(worker.records['note:x']!, rev: 2, deleted: true);
    await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect(brain.get('note:x')!.deleted, isTrue);
    expect(brain.search('vanish').isEmpty, isTrue);
  });

  test('D: a concurrent edit is kept as a conflict with both copies, and a rejected record stays marked, never dropped', () async {
    final dir = await freshDir();
    final worker = FakeWorker();
    final brain = CheBrainReplica(directory: dir);
    await brain.remember(id: 'note:b', kind: 'note', region: 'Learned Knowledge', body: 'Version one.');
    await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    worker.cloudWrite('note:b', title: 'Cloud edit', body: 'Version two, from the cloud.');
    await brain.remember(id: 'note:b', kind: 'note', region: 'Learned Knowledge', body: 'Version two, from the phone.');
    worker.sensitive.add('mem:secret');
    await brain.remember(id: 'mem:secret', kind: 'memory', region: 'Personal Memory', body: 'Something the Worker refuses.');
    final receipt = await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect(receipt.conflicts, 1);
    expect(receipt.rejected, 1);
    expect(brain.pendingOps, 0);
    expect(brain.conflicts.length, 1);
    expect(brain.conflicts.first.local['body'], 'Version two, from the phone.');
    expect(brain.conflicts.first.server['body'], 'Version two, from the cloud.');
    expect(brain.get('note:b')!.excerpt, 'Version two, from the cloud.', reason: 'the stored copy is current until the owner decides');
    expect(brain.get('mem:secret')!.syncNote, startsWith('rejected'));
    expect(brain.get('mem:secret')!.excerpt, 'Something the Worker refuses.');
    expect(receipt.speech(), contains('conflict'));

    await brain.resolveConflict(brain.conflicts.first.id, keepLocal: true);
    expect(brain.conflicts, isEmpty);
    expect(brain.pendingOps, 1, reason: 'keeping the local copy re-queues it on top of the cloud revision');
    final after = await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect(after.conflicts, 0);
    expect(worker.records['note:b']!['body'], 'Version two, from the phone.');
  });

  test('E: pull pages through many changes, an interrupted pull resumes from its cursor, and long bodies live in files', () async {
    final dir = await freshDir();
    final worker = FakeWorker();
    for (var i = 0; i < 1203; i += 1) {
      worker.cloudWrite('note:$i', title: 'Note $i', body: i == 7 ? 'Long body. ' * 400 : 'Body of note $i about topic ${i % 13}.');
    }
    final brain = CheBrainReplica(directory: dir);
    var calls = 0;
    Future<({int status, String body})> flaky(Uri uri, Map<String, String> h) async {
      calls += 1;
      if (calls == 2) return (status: 500, body: 'cut off');
      return worker.get(uri, h);
    }
    final first = await brain.sync('https://che.example', const {}, get: flaky, post: worker.post);
    expect(first.ok, isFalse);
    expect(first.pulled, 500);
    expect(brain.since, 500);
    final second = await brain.sync('https://che.example', const {}, get: flaky, post: worker.post);
    expect(second.ok, isTrue);
    expect(second.pulled, 703);
    expect(brain.count, 1203);
    expect(second.digestMatch, isTrue);
    final long = brain.get('note:7')!;
    expect(long.inlineBody, isFalse);
    expect(long.excerpt.length, 600);
    expect((await brain.bodyOf('note:7')).length, 'Long body. '.length * 400);
    expect(brain.list(region: 'Learned Knowledge', limit: 5).length, 5);
    final reopened = CheBrainReplica(directory: dir);
    await reopened.load();
    expect(reopened.count, 1203);
    expect(reopened.since, brain.since);
  });

  test('H: a secret is never written, and a body between 601 and 2000 characters is kept whole', () async {
    final dir = await freshDir();
    final worker = FakeWorker();
    final brain = CheBrainReplica(directory: dir);
    expect(cheBrainTextIsSensitive('my wifi password is hunter2'), isTrue);
    expect(cheBrainTextIsSensitive('My sister lives in Lisbon.'), isFalse);
    final refused = await brain.remember(kind: 'memory', region: 'Personal Memory', body: 'remember my bank password is hunter2');
    expect(refused, isNull);
    expect(brain.count, 0);
    expect(brain.pendingOps, 0);
    final journal = File('${dir.path}/journal.ndjson');
    expect(await journal.exists() ? await journal.readAsString() : '', isNot(contains('hunter2')));
    final medium = 'A sentence of the record body. ' * 50; // ~1 550 chars
    final saved = await brain.remember(id: 'note:m', kind: 'note', region: 'Learned Knowledge', body: medium);
    expect(saved!.inlineBody, isFalse);
    expect(await brain.bodyOf('note:m'), medium.trim());
    worker.cloudWrite('note:c', title: 'Cloud medium', body: 'Cloud words. ' * 100 + 'lighthouse');
    await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    expect((await brain.bodyOf('note:c')).endsWith('lighthouse'), isTrue);
    final reopened = CheBrainReplica(directory: dir);
    await reopened.load();
    expect(await reopened.bodyOf('note:m'), medium.trim());
  });

  test('I: a replayed op is read by its first outcome, so a conflict answered late is still a conflict here', () async {
    final dir = await freshDir();
    final worker = FakeWorker();
    final brain = CheBrainReplica(directory: dir);
    await brain.remember(id: 'note:d', kind: 'note', region: 'Learned Knowledge', body: 'First.');
    await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    worker.cloudWrite('note:d', title: 'Cloud', body: 'Cloud second.');
    await brain.remember(id: 'note:d', kind: 'note', region: 'Learned Knowledge', body: 'Phone second.');
    // The Worker stores the conflict but the answer is lost on the way back.
    final realPost = worker.post;
    var calls = 0;
    Future<({int status, String body})> lossy(Uri u, Map<String, String> h, String b) async {
      calls += 1;
      final res = await realPost(u, h, b);
      return calls == 1 ? (status: 503, body: 'lost') : res;
    }
    final first = await brain.sync('https://che.example', const {}, get: worker.get, post: lossy);
    expect(first.ok, isFalse);
    expect(brain.pendingOps, 1);
    final second = await brain.sync('https://che.example', const {}, get: worker.get, post: lossy);
    expect(second.ok, isTrue);
    expect(second.conflicts, 1, reason: 'duplicate + first_outcome conflict is a conflict');
    expect(brain.conflicts.length, 1);
    expect(brain.conflicts.first.local['body'], 'Phone second.');
  });

  test('J: a journal replayed with duplicate op lines queues each op once', () async {
    final dir = await freshDir();
    final brain = CheBrainReplica(directory: dir);
    await brain.remember(id: 'note:dup', kind: 'note', region: 'Learned Knowledge', body: 'Once.');
    final journal = File('${dir.path}/journal.ndjson');
    final lines = await journal.readAsString();
    final opLines = lines.split('\n').where((l) => l.contains('"t":"op"')).join('\n');
    await journal.writeAsString('$lines$opLines\n', mode: FileMode.append, flush: true);
    final reopened = CheBrainReplica(directory: dir);
    await reopened.load();
    expect(reopened.pendingOps, 1);
  });

  test('K: replaying two offline edits of the same record queues only the last, and forgetting by words removes every twin', () async {
    final dir = await freshDir();
    final brain = CheBrainReplica(directory: dir);
    await brain.remember(id: 'note:e', kind: 'note', region: 'Learned Knowledge', body: 'Draft one.');
    await brain.remember(id: 'note:e', kind: 'note', region: 'Learned Knowledge', body: 'Draft two.');
    expect(brain.pendingOps, 1);
    final reopened = CheBrainReplica(directory: dir);
    await reopened.load();
    expect(reopened.pendingOps, 1, reason: 'a replay keeps only the last put for the record');
    await reopened.remember(id: 'mem:a', kind: 'memory', region: 'Personal Memory', body: 'My sister  lives in\nLisbon.');
    await reopened.remember(id: 'mem:b', kind: 'memory', region: 'Personal Memory', body: 'My sister lives in Lisbon.');
    expect(await reopened.forgetMemoriesShowing('My sister lives in Lisbon.'), 2);
    expect(reopened.search('Lisbon'), isEmpty);
    // The 500th character of the collapsed text is a space: the Memory screen shows the cut copy,
    // and forgetting by those words must still reach the whole record.
    final words = List.filled(150, 'word').join(' ');
    await reopened.remember(id: 'mem:w', kind: 'memory', region: 'Personal Memory', body: words);
    final shown = words.substring(0, 500).trimRight();
    expect(await reopened.forgetMemoriesShowing(shown), 1);
    expect(reopened.search('word'), isEmpty);
  });

  test('M: a memory remembered again after an offline forget sends one put against the live revision, not a delete', () async {
    final dir = await freshDir();
    final brain = CheBrainReplica(directory: dir);
    await brain.remember(id: 'mem:re', kind: 'memory', region: 'Personal Memory', body: 'First words.');
    await brain.forget('mem:re');
    await brain.remember(id: 'mem:re', kind: 'memory', region: 'Personal Memory', body: 'Second words.');
    expect(brain.pendingOps, 1);
    expect(brain.get('mem:re')!.deleted, isFalse);
    final reopened = CheBrainReplica(directory: dir);
    await reopened.load();
    expect(reopened.pendingOps, 1, reason: 'the replay keeps the recreate only');
    expect(reopened.search('Second'), hasLength(1));
  });

  test('L: a delete replayed after a put for the same record leaves only the delete, and forgetting by words ignores case', () async {
    final dir = await freshDir();
    final brain = CheBrainReplica(directory: dir);
    await brain.remember(id: 'note:pd', kind: 'note', region: 'Learned Knowledge', body: 'To be deleted.');
    await brain.forget('note:pd');
    expect(brain.pendingOps, 1);
    // The journal still holds the put line before the delete line; a replay must end with the delete only.
    final journal = File('${dir.path}/journal.ndjson');
    expect((await journal.readAsString()).contains('"type":"put"'), isTrue);
    final reopened = CheBrainReplica(directory: dir);
    await reopened.load();
    expect(reopened.pendingOps, 1, reason: 'a replayed delete supersedes the earlier put');
    expect(reopened.search('deleted'), isEmpty);
    await reopened.remember(id: 'mem:lc', kind: 'memory', region: 'Personal Memory', body: 'my dog is called rex.');
    expect(await reopened.forgetMemoriesShowing('My dog is called Rex.'), 1);
  });

  test('F: a queued offline request is a task record that says it did not run', () async {
    final brain = CheBrainReplica(directory: await freshDir());
    final queued = (await brain.queueRemoteRequest('send the report to Claude'))!;
    expect(queued.region, 'Active and Historical Tasks');
    expect(queued.path, 'Queued offline');
    expect(queued.excerpt, startsWith('Queued, not run'));
    expect(queued.verification, 'unknown');
    expect(brain.status()['pending_ops'], 1);
  });

  test('G: scale on the VM: 10k records load, search and digest in bounded time (not iPhone proof)', () async {
    final dir = await freshDir();
    final worker = FakeWorker();
    final n = int.tryParse(Platform.environment['CHE_BRAIN_SCALE'] ?? '') ?? 10000;
    for (var i = 0; i < n; i += 1) {
      worker.cloudWrite('note:$i', title: 'Record $i', body: 'Topic ${i % 97} detail ${i % 11} word${i % 7}.');
    }
    final brain = CheBrainReplica(directory: dir);
    final watch = Stopwatch()..start();
    final receipt = await brain.sync('https://che.example', const {}, get: worker.get, post: worker.post);
    final syncMs = watch.elapsedMilliseconds;
    expect(receipt.pulled, n);
    expect(receipt.digestMatch, isTrue);
    watch.reset();
    final hits = brain.search('topic 42 detail 3');
    final searchMs = watch.elapsedMilliseconds;
    expect(hits, isNotEmpty);
    watch.reset();
    await brain.compact();
    final reopened = CheBrainReplica(directory: dir);
    await reopened.load();
    final loadMs = watch.elapsedMilliseconds;
    expect(reopened.count, n);
    // Printed so the numbers are in the test log; the limits only catch a pathological slowdown.
    // ignore: avoid_print
    print('brain replica scale n=$n sync=${syncMs}ms search=${searchMs}ms load=${loadMs}ms');
    expect(searchMs, lessThan(2000));
    expect(loadMs, lessThan(30000));
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('O: forgetting by words finds a memory whose body is full of whitespace (the raw excerpt collapses short of the display copy)', () async {
    final brain = CheBrainReplica(directory: await freshDir());
    final body = List.filled(200, 'ab').join('\n\n');
    final saved = (await brain.remember(id: 'mem:ws', kind: 'memory', region: 'Personal Memory', body: body))!;
    expect(saved.inlineBody, isFalse, reason: 'the body lives in its own file');
    final shown = body.replaceAll(RegExp(r'\s+'), ' ').trim();
    expect(shown.length, 599);
    expect(await brain.forgetMemoriesShowing(shown.length > 500 ? shown.substring(0, 500).trimRight() : shown), 1);
    expect(brain.search('ab'), isEmpty);
  });

  test('P: the Memory list hydrated from the replica shows the display copy of the whole body, as the cloud does', () async {
    final body = 'Line one about the boiler.\nLine two:   the valve sticks.  ';
    expect(CheBrainReplica.displayCopy(body), 'Line one about the boiler. Line two: the valve sticks.');
    final long = '${'ab ' * 165}x pinnacle of the whole trip, worth every step.';
    expect(CheBrainReplica.displayCopy(long), long.substring(0, 500).trimRight());
    expect(CheBrainReplica.displayCopy(CheBrainReplica.displayCopy(long)), CheBrainReplica.displayCopy(long));
  });

  test('N: a pulled record keeps every place it sits in across a restart, so worker brains work offline', () async {
    final dir = await freshDir();
    final brain = CheBrainReplica(directory: dir);
    final record = CheBrainRecord.fromJson({
      'id': 'task:shared', 'kind': 'task', 'region': 'Active and Historical Tasks', 'path': 'Historical', 'title': 'Research silver',
      'body': 'Task: research silver. Status: failed.', 'source': {'kind': 'team_task', 'agent': 'Atlas', 'outcome': 'failed'},
      'verification': 'unverified_reference', 'rev': 1, 'seq': 1, 'created_at': '2026-10-09T08:00:00.000Z', 'updated_at': '2026-10-09T09:30:00.000Z', 'origin': 'cloud',
      'places': [{'region': 'Active and Historical Tasks', 'path': 'Historical'}, {'region': 'Office Agents', 'path': 'Atlas'}, {'region': 'Office Agents', 'path': 'Knox'}, {'region': '', 'path': 'ignored'}],
    })!;
    expect(record.places.map((p) => p['path']), ['Historical', 'Atlas', 'Knox']);
    final json = record.toJson();
    expect((json['places'] as List).length, 3);
    final again = CheBrainRecord.fromJson(json)!;
    expect(again.places, record.places);
    // Through the journal: written as the sync would write it, read back after a restart.
    await brain.load();
    final file = File('${dir.path}/journal.ndjson');
    await file.writeAsString('${jsonEncode({'t': 'rec', 'r': json})}\n', mode: FileMode.append, flush: true);
    final reopened = CheBrainReplica(directory: dir);
    await reopened.load();
    expect(reopened.get('task:shared')!.places.map((p) => p['path']), ['Historical', 'Atlas', 'Knox']);
    expect(reopened.recordsJson().single['places'], hasLength(3));
  });

  test('Q: a receipt tells a lost connection from an answer the sync could not use', () {
    expect(CheBrainSyncReceipt(at: '2026-10-18T00:00:00Z', error: 'SocketException: Failed host lookup: che.example').unreachable, isTrue);
    expect(CheBrainSyncReceipt(at: '2026-10-18T00:00:00Z', error: 'TimeoutException after 0:00:30.000000: Future not completed').unreachable, isTrue);
    expect(CheBrainSyncReceipt(at: '2026-10-18T00:00:00Z', error: 'ClientException: Connection reset by peer').unreachable, isTrue);
    final refused = CheBrainSyncReceipt(at: '2026-10-18T00:00:00Z', error: 'HTTP 401');
    expect(refused.ok, isFalse);
    expect(refused.unreachable, isFalse, reason: 'the cloud answered; this is not offline');
    expect(CheBrainSyncReceipt(at: '2026-10-18T00:00:00Z').unreachable, isFalse);
  });
}
