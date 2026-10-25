import 'dart:convert';
import 'dart:typed_data';

import 'package:chey/create/che_gpu_browser.dart';
import 'package:chey/create/che_gpu_connect.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _email = 'owner@che.office';
// A real 1 by 1 PNG.
final _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');

/// CHE's browser session, faked: [page] decides what each probe sees from the calls so far.
class FakeBrowser implements CheGpuConnectBrowser {
  FakeBrowser(this.page);
  Map<String, dynamic>? Function(FakeBrowser b) page;
  final opened = <String>[];
  final acts = <String>[];
  final safari = <String>[];
  int fronts = 0;
  int probes = 0;
  @override
  Future<bool> open(String url) async {
    opened.add(url);
    return true;
  }

  @override
  String? currentUrl() => opened.isEmpty ? null : opened.last;
  @override
  Future<Map<String, dynamic>?> probe() async {
    probes++;
    return page(this);
  }

  @override
  Future<String> act(String action) async {
    acts.add(action);
    return 'clicked';
  }

  @override
  Future<void> bringToFront() async => fronts++;
  @override
  Future<bool> openInSafari(String url) async {
    safari.add(url);
    return true;
  }
}

/// CHE's Worker, faked: [gpuAfter] status reads before a Colab GPU heartbeat appears (null: never).
class FakeWorker implements CheGpuConnectWorker {
  FakeWorker({this.gpuAfter, this.jobAfter = 2});
  int? gpuAfter;
  int jobAfter;
  int reads = 0;
  bool stale = false;
  String? jobId;
  int jobReads = 0;
  @override
  Future<Map<String, dynamic>?> status() async {
    reads++;
    final online = !stale && gpuAfter != null && reads > gpuAfter!;
    final jobs = <Map<String, dynamic>>[];
    if (jobId != null) {
      jobReads++;
      jobs.add({'id': jobId, 'state': jobReads > jobAfter ? 'completed' : 'rendering', 'previews': {'0': 'media_1'}, 'worker_name': 'Colab GPU worker'});
    }
    return {
      'worker_paired': true,
      'workers': [
        {'id': 'gh-1', 'class': 'github_cpu', 'gpu': 'CPU', 'device': 'cpu', 'online': true},
        {'id': 'colab-1', 'class': 'colab', 'gpu': 'Tesla T4, 550.54, 15360 MiB', 'online': online, 'last_seen': '2026-10-25T12:00:00Z'},
      ],
      'jobs': jobs,
    };
  }

  @override
  Future<({String? id, String reason})> queueTestJob() async {
    jobId = 'gpu_0123456789ab';
    return (id: jobId, reason: '');
  }

  @override
  Future<Uint8List?> image(String mediaId) async => mediaId == 'media_1' ? _png : null;
}

Map<String, dynamic> signedIn([String account = _email]) => {'host': 'colab.research.google.com', 'account': account, 'signInRequired': false};

typedef Rig = ({CheGpuConnect c, List<String> spoken, Set<String> granted});

Rig rig(FakeBrowser b, FakeWorker w, {String account = _email, void Function(CheGpuConnect c)? onWait}) {
  final spoken = <String>[];
  final granted = <String>{};
  late CheGpuConnect c;
  c = CheGpuConnect(
    pageTries: 6, runTries: 8, heartbeatTries: 10, ownerTries: 6, jobTries: 10,
    monitorEvery: const Duration(hours: 1),
    wait: (_) async => onWait?.call(c),
    decode: (bytes) async => bytes.isEmpty ? null : '160 by 160 pixels',
    grant: (app) async => granted..add(app),
    readAccount: () async => account,
  );
  c.configure(browser: b, worker: w, speak: (text) {
    // "GPU connected" may be said only once CHE's Worker verified the heartbeat.
    if (text.startsWith('GPU connected')) expect(c.heartbeat.state, CheGpuCheckState.passed);
    spoken.add(text);
  });
  return (c: c, spoken: spoken, granted: granted);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('voice commands: Connect GPU, continue and the CHE Office account', () {
    for (final said in ['Connect GPU', 'connect the GPU.', 'start my GPU', 'CHE, connect my GPU please', '/cloud-gpu connect']) {
      expect(cheGpuConnectCommand(said), isTrue, reason: said);
    }
    for (final said in ['what is a GPU', 'connect my gmail', 'open gpu browser']) {
      expect(cheGpuConnectCommand(said), isFalse, reason: said);
    }
    expect(cheGpuContinueCommand('Continue.'), isTrue);
    expect(cheGpuContinueCommand("I'm signed in"), isTrue);
    expect(cheGpuAccountFromWords('My CHE Office Google account is owner at che dot office'), _email);
    expect(cheGpuAccountFromWords('use owner@che.office for the GPU'), _email);
    expect(cheGpuAccountFromWords('my office account is nobody'), isNull);
    expect(cheGpuNotebookUrl(_email), endsWith('CHE_GPU_Face_Preview.ipynb?authuser=owner%40che.office'));
  });

  test('permission is enforced in code: only the Connect GPU command opens Colab, and it is recorded', () async {
    final b = FakeBrowser((_) => signedIn());
    final r = rig(b, FakeWorker());
    expect(r.c.start('open youtube'), contains('only when you ask me to connect the GPU'));
    expect(r.c.busy, isFalse);
    expect(b.opened, isEmpty);
    expect(r.granted, isEmpty);
  });

  test('signed in with the right account: Run all, fresh heartbeat, then GPU connected, then the test job opens', () async {
    final b = FakeBrowser((b) => {...signedIn(), if (b.acts.isNotEmpty) 'connected': true, if (b.acts.isNotEmpty) 'gpuLine': 'Tesla T4'});
    final w = FakeWorker(gpuAfter: 3);
    final r = rig(b, w);
    expect(r.c.start('Connect GPU'), startsWith('Connecting your GPU'));
    await r.c.running;
    expect(r.granted, {'colab'});
    expect(r.c.permissionLog.single, contains('colab: owner said "Connect GPU"'));
    expect(b.opened.first, contains('authuser=owner%40che.office'));
    expect(b.acts, ['runall']);
    expect(r.c.account.state, CheGpuCheckState.passed);
    expect(r.c.account.detail, contains(_email));
    expect(r.c.runtime.state, CheGpuCheckState.passed);
    expect(r.c.heartbeat.state, CheGpuCheckState.passed);
    expect(r.c.heartbeat.detail, contains('Tesla T4'));
    expect(r.c.testJob.state, CheGpuCheckState.passed);
    expect(r.c.testJob.detail, contains('opened in CHE'));
    expect(r.c.testImage, isNotNull);
    expect(r.c.phase, CheGpuPhase.done);
    expect(r.c.connected, isTrue);
    expect(r.spoken.where((s) => s.startsWith('GPU connected')), hasLength(1));
    expect(r.spoken.last, 'Test job completed and opened: its picture is on screen.');
    r.c.dispose();
  });

  test('wrong account: CHE opens Google\'s account chooser for the CHE Office account and resumes when it is chosen', () async {
    final b = FakeBrowser((b) => b.opened.any((u) => u.contains('AccountChooser')) ? signedIn() : signedIn('other@gmail.com'));
    final r = rig(b, FakeWorker(gpuAfter: 0));
    r.c.start('Connect GPU');
    await r.c.running;
    expect(b.opened.where((u) => u.startsWith('https://accounts.google.com/AccountChooser?Email=owner%40che.office')), hasLength(1));
    expect(r.spoken.first, contains('not your CHE Office account $_email'));
    expect(r.c.account.state, CheGpuCheckState.passed);
    expect(r.c.connected, isTrue);
    r.c.dispose();
  });

  test('an account that stays wrong stops before Connect: no Run all, never connected', () async {
    final b = FakeBrowser((_) => signedIn('other@gmail.com'));
    final r = rig(b, FakeWorker());
    r.c.start('Connect GPU');
    await r.c.running;
    expect(b.acts, isEmpty);
    expect(r.c.account.state, CheGpuCheckState.failed);
    expect(r.c.phase, CheGpuPhase.failed);
    expect(r.c.connected, isFalse);
    expect(r.spoken.any((s) => s.startsWith('GPU connected')), isFalse);
  });

  test('sign-in required: CHE pauses at Google\'s page, says so, and resumes when the owner says continue', () async {
    var signedInYet = false;
    final b = FakeBrowser((_) => signedInYet ? signedIn() : {'host': 'accounts.google.com', 'account': '', 'signInRequired': true});
    final r = rig(b, FakeWorker(gpuAfter: 2), onWait: (c) {
      if (c.waitingForOwner) {
        signedInYet = true;   // the owner signed in himself
        c.ownerContinue();
      }
    });
    r.c.start('Connect GPU');
    await r.c.running;
    expect(r.spoken.first, startsWith('Google needs you to sign in here with $_email. CHE never types your password.'));
    expect(b.fronts, greaterThanOrEqualTo(2), reason: 'the browser is brought to the exact step');
    expect(r.c.account.state, CheGpuCheckState.passed);
    expect(r.c.heartbeat.state, CheGpuCheckState.passed);
    r.c.dispose();
  });

  test('Google refuses sign-in inside CHE\'s browser: Safari fallback, account not verified, the worker proves the GPU', () async {
    final b = FakeBrowser((_) => {'host': 'accounts.google.com', 'blocked': true, 'signInRequired': true});
    final w = FakeWorker(gpuAfter: 4);
    final r = rig(b, w);
    r.c.start('Connect GPU');
    await r.c.running;
    expect(r.c.mode, 'safari');
    expect(b.safari.single, contains('authuser=owner%40che.office'));
    expect(r.spoken.first, contains('opened your notebook in Safari'));
    expect(r.c.account.state, CheGpuCheckState.unverified);
    expect(r.c.runtime.state, CheGpuCheckState.passed);
    expect(r.c.runtime.detail, contains('worker in your Colab runtime reports Tesla T4'));
    expect(r.c.heartbeat.state, CheGpuCheckState.passed);
    expect(r.c.connected, isTrue);
    r.c.dispose();
  });

  test('Colab\'s "not authored by Google" warning is handed to the owner; CHE never presses Run anyway', () async {
    var answered = false;
    final b = FakeBrowser((b) => {...signedIn(), if (b.acts.isNotEmpty && !answered) 'dialogKind': 'not_authored'});
    final r = rig(b, FakeWorker(gpuAfter: 6), onWait: (c) {
      if (c.waitingForOwner) {
        answered = true;
        c.ownerContinue();
      }
    });
    r.c.start('Connect GPU');
    await r.c.running;
    expect(r.spoken.first, contains('choose Run anyway'));
    expect(b.acts, ['runall'], reason: 'only Run all; the warning is the owner\'s');
    expect(r.c.connected, isTrue);
    r.c.dispose();
  });

  test('a connected runtime without a worker heartbeat is never reported as connected', () async {
    final b = FakeBrowser((b) => {...signedIn(), 'connected': true, 'gpuLine': 'Tesla T4'});
    final r = rig(b, FakeWorker());   // only the CPU worker ever checks in
    r.c.start('Connect GPU');
    await r.c.running;
    expect(r.c.runtime.state, CheGpuCheckState.passed, reason: 'the page shows a GPU');
    expect(r.c.heartbeat.state, CheGpuCheckState.failed);
    expect(r.c.testJob.state, CheGpuCheckState.pending);
    expect(r.c.phase, CheGpuPhase.failed);
    expect(r.c.connected, isFalse);
    expect(r.spoken.single, startsWith('GPU not connected'));
  });

  test('a stale heartbeat after connecting shows Disconnected, keeps jobs, and does not speak', () async {
    final w = FakeWorker(gpuAfter: 0);
    final r = rig(FakeBrowser((_) => signedIn()), w);
    r.c.start('Connect GPU');
    await r.c.running;
    expect(r.c.phase, CheGpuPhase.done);
    final said = r.spoken.length;
    w.stale = true;
    await r.c.checkStillConnected();
    expect(r.c.phase, CheGpuPhase.disconnected);
    expect(r.c.status, cheGpuDisconnectedText);
    expect(r.c.status, contains('jobs are kept and will resume from their last checkpoint on the next worker'));
    expect(r.c.heartbeat.state, CheGpuCheckState.failed);
    expect(r.c.connected, isFalse);
    expect(r.spoken.length, said, reason: 'passive status is quiet');
    r.c.dispose();
  });

  testWidgets('the panel shows each check as its own VoiceOver line and the test picture', (tester) async {
    final r = rig(FakeBrowser((_) => signedIn()), FakeWorker(gpuAfter: 0));
    final read = <String>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: CheGpuConnectPanel(controller: r.c, onRead: read.add)))));
    for (final id in ['account', 'runtime', 'heartbeat', 'test']) {
      expect(find.byKey(ValueKey('gpu-check-$id')), findsOneWidget);
    }
    expect(find.bySemanticsLabel(RegExp(r'^CHE worker heartbeat: pending')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('gpu-connect-start')));
    await tester.runAsync(() async => r.c.running);
    await tester.pump();
    expect(read.first, startsWith('Connecting your GPU'));
    expect(find.bySemanticsLabel(RegExp(r'^CHE worker heartbeat: passed')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Test job completed and opened: passed')), findsOneWidget);
    expect(find.bySemanticsLabel('Test job picture from your GPU, front view'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Read the GPU connection checks aloud'));
    expect(read.last, contains('Google account: passed'));
    r.c.dispose();
  });

  testWidgets('the GPU Browser takes Connect GPU, continue and the account by voice', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final r = rig(FakeBrowser((_) => signedIn()), FakeWorker(gpuAfter: 0));
    await tester.pumpWidget(MaterialApp(home: CheGpuBrowser(baseUrl: 'https://che.test', headers: const {}, browser: const SizedBox(), connect: r.c)));
    await tester.pump();
    final voice = CheGpuBrowser.voiceHandler!;
    expect(await voice('continue'), isNull, reason: 'nothing is waiting, so the words go elsewhere');
    expect(await voice('my CHE Office Google account is owner at che dot office'), 'Saved. CHE uses $_email for Colab.');
    expect(await CheGpuAccount.read(), _email);
    expect(await voice('Connect GPU'), startsWith('Connecting your GPU'));
    await tester.runAsync(() async => r.c.running);
    expect(r.c.connected, isTrue);
    expect(await voice('read the GPU connection'), contains('CHE worker heartbeat: passed'));
    r.c.cancel();
    await tester.pumpWidget(const SizedBox());
    expect(CheGpuBrowser.openCount, 0);
  });
}
