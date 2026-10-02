import 'package:chey/platform/che_platform_client.dart';
import 'package:chey/platform/che_platform_models.dart';
import 'package:chey/platform/che_platform_screens.dart';
import 'package:chey/platform/che_core_sphere.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('notifications and core requests sort newest first', () {
    final older = DateTime.utc(2026, 10, 1);
    final newer = DateTime.utc(2026, 10, 2);
    final sorted = cheSortNotificationsNewestFirst([
      ChePlatformNotification(
        id: 'old',
        tenantId: 'owner-369',
        source: 'CHE',
        title: 'Older',
        body: 'first',
        priority: 'low',
        target: '',
        createdAt: older,
      ),
      ChePlatformNotification(
        id: 'new',
        tenantId: 'owner-369',
        source: 'CHE',
        title: 'Newer',
        body: 'second',
        priority: 'urgent',
        target: '',
        createdAt: newer,
      ),
    ]);
    expect(sorted.first.id, 'new');
    expect(cheTopPriorityBanners(sorted).single.id, 'new');
  });

  test('read or normal notifications are not top-priority banners', () {
    final item = ChePlatformNotification.fromJson({
      'id': 'notice_1',
      'tenant_id': 'owner-369',
      'source': 'CHE',
      'title': 'Done',
      'body': 'Finished',
      'priority': 'high',
      'target': '',
      'created_at': '2026-10-02T12:00:00Z',
      'read_at': '2026-10-02T12:01:00Z',
    });
    expect(item?.isRead, isTrue);
    expect(cheTopPriorityBanners([item!]), isEmpty);
  });

  test('brain presentation is exactly two named brains', () {
    expect(cheBrainPresentations.map((item) => item.title).toList(), [
      'CHE Brain — Live',
      'CHE Brain — Offline',
    ]);
  });

  test('missing platform endpoint stays unavailable and does not invent items', () async {
    final gateway = CheHttpPlatformGateway(
      baseUrl: () => 'https://che.example',
      headers: () => {'Authorization': 'Bearer ${'a' * 40}'},
      client: MockClient((request) async => http.Response('{"detail":"not found"}', 404)),
    );
    final page = await gateway.notifications();
    expect(page.availability, ChePlatformAvailability.unavailable);
    expect(page.items, isEmpty);
    expect(page.message, contains('not on the connected Worker'));
  });

  test('live notification payload parses without adding sample rows', () async {
    final gateway = CheHttpPlatformGateway(
      baseUrl: () => 'https://che.example',
      headers: () => {'Authorization': 'Bearer ${'a' * 40}'},
      client: MockClient((request) async {
        expect(request.url.path, '/api/notifications');
        return http.Response(
          '{"notifications":[{"id":"notice_9","tenant_id":"owner-369","source":"Core","title":"Rule check","body":"Review","priority":"urgent","target":"","created_at":"2026-10-02T15:00:00Z","read_at":null}]}',
          200,
        );
      }),
    );
    final page = await gateway.notifications();
    expect(page.isLive, isTrue);
    expect(page.items.single.title, 'Rule check');
    expect(cheTopPriorityBanners(page.items).single.id, 'notice_9');
  });

  test('unpaired gateway does not pretend a platform view exists', () async {
    final gateway = CheHttpPlatformGateway(
      baseUrl: () => '',
      headers: () => const {},
      client: MockClient((request) async => http.Response('{}', 200)),
    );
    final devices = await gateway.devices();
    expect(devices.availability, ChePlatformAvailability.notPaired);
    expect(devices.items, isEmpty);
  });

  testWidgets('priority banner exposes VoiceOver label and core sphere label', (tester) async {
    final gateway = _FakeGateway();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            ChePriorityNotificationBanner(gateway: gateway),
            const CheCoreSphere(active: false),
          ],
        ),
      ),
    ));
    await tester.pump();
    expect(find.text('Worker down'), findsOneWidget);
    expect(
      find.byWidgetPredicate((widget) => widget is Semantics && (widget.properties.label ?? '').contains('Priority CHE notification')),
      findsOneWidget,
    );
    expect(
      find.byWidgetPredicate((widget) => widget is Semantics && (widget.properties.label ?? '').contains('compressed-energy sphere')),
      findsOneWidget,
    );
  });
}

class _FakeGateway implements ChePlatformGateway {
  @override
  Future<ChePlatformPage<ChePlatformNotification>> notifications({bool unreadOnly = false}) async {
    return ChePlatformPage(
      availability: ChePlatformAvailability.live,
      items: [
        ChePlatformNotification(
          id: 'notice_urgent',
          tenantId: 'owner-369',
          source: 'CHE',
          title: 'Worker down',
          body: 'Platform lane has not answered.',
          priority: 'urgent',
          target: '',
          createdAt: DateTime.utc(2026, 10, 2),
        ),
      ],
    );
  }

  @override
  Future<CheEnrollmentResult> createEnrollment({String access = 'private', int ttlMinutes = 10}) async {
    return const CheEnrollmentResult(availability: ChePlatformAvailability.unavailable);
  }

  @override
  Future<ChePlatformPage<CheCoreRequest>> coreRequests() async {
    return const ChePlatformPage(availability: ChePlatformAvailability.unavailable, items: []);
  }

  @override
  Future<ChePlatformPage<CheCoreRule>> coreRules() async {
    return const ChePlatformPage(availability: ChePlatformAvailability.unavailable, items: []);
  }

  @override
  Future<ChePlatformPage<ChePlatformDevice>> devices() async {
    return const ChePlatformPage(availability: ChePlatformAvailability.unavailable, items: []);
  }

  @override
  Future<ChePlatformAvailability> markNotificationRead(String id) async => ChePlatformAvailability.live;

  @override
  Future<ChePlatformPage<CheCoreRequest>> submitCoreRequest(CheCoreRequestDraft draft) async {
    return const ChePlatformPage(availability: ChePlatformAvailability.unavailable, items: []);
  }

  @override
  Future<ChePlatformTenant?> tenant() async => null;
}
