import 'dart:convert';

import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_connections_screen.dart';
import 'package:chey/security/che_app_permissions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A fake CHE Worker for the Connections screen: it keeps the grant list in
/// memory and records every grant request, so tests can check what was sent.
class _FakeGrantServer {
  _FakeGrantServer({Set<String>? granted, this.refuseGrants = false})
      : granted = granted ?? <String>{};

  static const known = ['gmail', 'instagram', 'youtube'];

  final Set<String> granted;
  final bool refuseGrants;
  final List<Map<String, dynamic>> posts = [];
  final List<String> paths = [];

  late final http.Client client = MockClient((r) async {
    final headers = {'content-type': 'application/json'};
    paths.add(r.url.path);
    if (r.url.path == '/api/commands') {
      return http.Response(jsonEncode({'connectors': {}}), 200, headers: headers);
    }
    if (r.url.path == '/api/app-grants' && r.method == 'GET') {
      return http.Response(jsonEncode({
        'apps': [for (final a in granted) {'app': a, 'granted_at': 1}],
        'known': known,
      }), 200, headers: headers);
    }
    if (r.url.path == '/api/app-grants' && r.method == 'POST') {
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      posts.add(body);
      final app = body['app'] as String;
      if (body['action'] == 'grant') {
        if (refuseGrants) {
          return http.Response(jsonEncode({'detail': 'Lockdown is on; app grants are frozen. Revoking still works.'}),
              423, headers: headers);
        }
        granted.add(app);
      } else {
        granted.remove(app);
      }
      return http.Response(jsonEncode({'ok': true, 'app': app, 'granted': granted.contains(app)}),
          200, headers: headers);
    }
    return http.Response('not found', 404);
  });
}

Future<void> _pumpConnections(WidgetTester tester, _FakeGrantServer server, List<String> spoken) async {
  tester.view.physicalSize = const Size(1170, 4200);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: CheTheme.dark(),
    home: CheConnectionsScreen(
      baseUrl: 'https://che.test',
      headers: () => {'Authorization': 'Bearer x'},
      client: server.client,
      onVoiceSettings: () {},
      onKeys: () {},
      onSpeak: spoken.add,
    ),
  ));
  await tester.pumpAndSettle();
}

Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(finder, 200, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('known apps are listed with a Grant or Revoke button and a spoken label', (tester) async {
    final handle = tester.ensureSemantics();
    final server = _FakeGrantServer(granted: {'gmail'});
    await _pumpConnections(tester, server, []);

    await _scrollTo(tester, find.text('Instagram'));
    expect(find.text('APPS CHE MAY USE'), findsOneWidget);
    expect(find.bySemanticsLabel('Grant CHE access to Instagram'), findsOneWidget);
    expect(find.bySemanticsLabel('Revoke CHE access to Gmail'), findsOneWidget);
    expect(find.text('CHE may use this app without asking'), findsOneWidget);
    expect(server.paths, containsAll(['/api/commands', '/api/app-grants']));
    handle.dispose();
  });

  testWidgets('Grant saves the permission, sends only app and action, and speaks the result', (tester) async {
    final handle = tester.ensureSemantics();
    final server = _FakeGrantServer();
    final spoken = <String>[];
    await _pumpConnections(tester, server, spoken);

    await _scrollTo(tester, find.text('Instagram'));
    tester.semantics.tap(find.semantics.byLabel('Grant CHE access to Instagram'));
    await tester.pumpAndSettle();

    expect(server.posts, [{'app': 'instagram', 'action': 'grant'}]);
    expect(server.granted, {'instagram'});
    expect(await CheAppPermissions.granted(), {'instagram'});
    expect(find.bySemanticsLabel('Revoke CHE access to Instagram'), findsOneWidget);
    expect(spoken, ['CHE can now use Instagram without asking each time. Permission saved.']);
    handle.dispose();
  });

  testWidgets('Revoke removes the grant on the server and on this phone, and says so', (tester) async {
    final handle = tester.ensureSemantics();
    SharedPreferences.setMockInitialValues({'che_granted_apps': ['instagram']});
    final server = _FakeGrantServer(granted: {'instagram'});
    final spoken = <String>[];
    await _pumpConnections(tester, server, spoken);

    await _scrollTo(tester, find.text('Instagram'));
    tester.semantics.tap(find.semantics.byLabel('Revoke CHE access to Instagram'));
    await tester.pumpAndSettle();

    expect(server.posts, [{'app': 'instagram', 'action': 'revoke'}]);
    expect(server.granted, isEmpty);
    expect(await CheAppPermissions.granted(), isEmpty);
    expect(find.bySemanticsLabel('Grant CHE access to Instagram'), findsOneWidget);
    expect(spoken, ['CHE can no longer use Instagram. Permission removed.']);
    handle.dispose();
  });

  testWidgets('a refused grant changes nothing on screen or on the phone, and is spoken honestly', (tester) async {
    final handle = tester.ensureSemantics();
    final server = _FakeGrantServer(refuseGrants: true);
    final spoken = <String>[];
    await _pumpConnections(tester, server, spoken);

    await _scrollTo(tester, find.text('Instagram'));
    tester.semantics.tap(find.semantics.byLabel('Grant CHE access to Instagram'));
    await tester.pumpAndSettle();

    expect(server.granted, isEmpty);
    expect(await CheAppPermissions.granted(), isEmpty);
    expect(find.bySemanticsLabel('Grant CHE access to Instagram'), findsOneWidget);
    expect(spoken.single, startsWith('Could not grant Instagram: Lockdown is on'));
    handle.dispose();
  });

  testWidgets('Grant and Revoke buttons are at least 48 by 48', (tester) async {
    final server = _FakeGrantServer(granted: {'gmail'});
    await _pumpConnections(tester, server, []);
    await _scrollTo(tester, find.text('Instagram'));

    // Gmail is granted (Revoke), Instagram is not (Grant); both must meet the 48 dp minimum.
    for (final button in [find.widgetWithText(FilledButton, 'Grant').first, find.widgetWithText(OutlinedButton, 'Revoke').first]) {
      final size = tester.getSize(button);
      expect(size.height, greaterThanOrEqualTo(48));
      expect(size.width, greaterThanOrEqualTo(48));
    }
  });
}
