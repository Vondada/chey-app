import 'dart:convert';

import 'package:chey/brain/che_reflections_model.dart';
import 'package:chey/brain/che_reflections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _sampleDay() => {
      'reflections': [
        {
          'id': 'r1',
          'day': '2026-10-22',
          'items': [
            {'category': 'lesson', 'room': 'chat', 'text': 'Chat lesson one'},
            {'category': 'idea', 'room': 'office', 'text': 'Office idea'},
            {
              'category': 'mistake',
              'room': 'trading',
              'text': 'Trading mistake',
              'reply': 'replied',
              'reply_text': 'I will wait for confirmation',
            },
            {'category': 'lesson', 'room': 'chat', 'text': 'Chat lesson two', 'reply': 'skipped'},
          ],
        },
      ],
    };

void main() {
  group('model: grouping and room labels', () {
    final day = ReflectionDay.fromJson({
      'id': 'r1',
      'day': '2026-10-22',
      'items': [
        {'category': 'book', 'room': 'brain', 'text': 'Read the book'},
        {'category': 'lesson', 'room': 'chat', 'text': 'Lesson A'},
        {'category': 'lesson', 'room': 'office', 'text': 'Lesson B'},
        {'category': 'surprise', 'room': 'create', 'text': 'Odd category'},
      ],
    });

    test('groups in the fixed category order, unknown categories last as Other', () {
      final groups = day.groups;
      expect(groups.map((g) => g.category), ['lesson', 'book', 'other']);
      expect(groups.first.label, 'Lesson');
      expect(groups.first.entries.map((e) => e.index), [1, 2]);
      expect(groups.last.label, 'Other');
    });

    test('room filter keeps only that room and keeps original item indexes', () {
      final office = day.groupsFor(room: 'office');
      expect(office.length, 1);
      expect(office.single.entries.single.index, 2);
      expect(office.single.entries.single.item.text, 'Lesson B');
    });

    test('rooms are listed in first-seen order and labelled', () {
      expect(day.rooms, ['brain', 'chat', 'office', 'create']);
      expect(reflectionRoomLabel('chat'), 'Chat');
      expect(reflectionRoomLabel('office'), 'Office');
      expect(reflectionRoomLabel('trading'), 'Trading');
      expect(reflectionRoomLabel('create'), 'Create');
      expect(reflectionRoomLabel('brain'), 'Brain');
      expect(reflectionRoomLabel('garden'), 'Garden');
      expect(day.items.first.roomLabel, 'Brain');
    });

    test('reflectionDayKey formats YYYY-MM-DD', () {
      expect(reflectionDayKey(DateTime(2026, 3, 7)), '2026-03-07');
    });
  });

  group('model: reply and skip state', () {
    final base = ReflectionDay.fromJson(_sampleDay()['reflections'][0] as Map<String, dynamic>);

    test('parses owner state from reply and reply_text', () {
      expect(base.items[0].reply, ReflectionReply.open);
      expect(base.items[2].reply, ReflectionReply.replied);
      expect(base.items[2].replyText, 'I will wait for confirmation');
      expect(base.items[3].reply, ReflectionReply.skipped);
      expect(base.openCount, 2);
    });

    test('withReply saves trimmed words and marks the item replied', () {
      final next = base.withReply(0, '  Keep the stop tighter  ');
      expect(next.items[0].reply, ReflectionReply.replied);
      expect(next.items[0].replyText, 'Keep the stop tighter');
      expect(next.items[0].stateText, 'Your reply: Keep the stop tighter');
      expect(base.items[0].reply, ReflectionReply.open, reason: 'the original is unchanged');
    });

    test('blank reply text is refused and returns the same day', () {
      expect(identical(base.withReply(0, '   '), base), isTrue);
    });

    test('withSkip marks skipped and clears reply text', () {
      final next = base.withSkip(2);
      expect(next.items[2].reply, ReflectionReply.skipped);
      expect(next.items[2].replyText, '');
      expect(next.items[2].stateText, 'Skipped.');
    });

    test('out-of-range indexes change nothing', () {
      expect(identical(base.withSkip(99), base), isTrue);
    });

    test('reply without text but with reply state counts as replied only when text exists', () {
      final item = ReflectionItem.fromJson({'category': 'idea', 'text': 'x', 'reply': 'reply'});
      expect(item.reply, ReflectionReply.replied);
      final open = ReflectionItem.fromJson({'category': 'idea', 'text': 'x'});
      expect(open.reply, ReflectionReply.open);
      expect(open.stateText, 'Not answered yet.');
    });
  });

  group('model: responses', () {
    test('an empty reflections list means no reflection for the day', () {
      expect(reflectionDayFromResponse({'reflections': []}), isNull);
    });

    test('model_unavailable is recognised and has owner-facing words', () {
      expect(isReflectionModelUnavailable({'status': 'model_unavailable'}), isTrue);
      expect(isReflectionModelUnavailable({'reflections': []}), isFalse);
      expect(kReflectionModelUnavailableMessage, contains('model is unavailable'));
      expect(kReflectionEmptyMessage, 'No reflection for this day yet');
    });
  });

  group('page', () {
    late List<http.Request> requests;

    Future<void> pumpPage(WidgetTester tester, MockClientHandler handler) async {
      tester.view.physicalSize = const Size(1000, 4000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      requests = [];
      final client = MockClient((req) async {
        requests.add(req);
        return handler(req);
      });
      await tester.pumpWidget(MaterialApp(
        home: CheReflectionsPage(
          baseUrl: () => 'https://worker.example',
          headers: () => const {'Content-Type': 'application/json'},
          client: client,
          now: () => DateTime(2026, 10, 22),
        ),
      ));
      await tester.pumpAndSettle();
    }

    testWidgets('shows the empty state and makes no POST on load', (tester) async {
      await pumpPage(tester, (req) async => http.Response(jsonEncode({'reflections': []}), 200));
      expect(find.text(kReflectionEmptyMessage), findsOneWidget);
      expect(requests.single.method, 'GET');
      expect(requests.single.url.queryParameters['day'], '2026-10-22');
    });

    testWidgets('model_unavailable from generate is shown in words', (tester) async {
      await pumpPage(tester, (req) async {
        if (req.method == 'POST') {
          return http.Response(jsonEncode({'status': 'model_unavailable'}), 200);
        }
        return http.Response(jsonEncode({'reflections': []}), 200);
      });
      await tester.tap(find.widgetWithText(FilledButton, "Make today's reflection"));
      await tester.pumpAndSettle();
      expect(find.text(kReflectionModelUnavailableMessage), findsWidgets);
      expect(requests.last.method, 'POST');
      expect(requests.last.url.path, '/api/reflections/generate');
    });

    testWidgets('groups items with room labels and filters by room', (tester) async {
      await pumpPage(tester, (req) async => http.Response(jsonEncode(_sampleDay()), 200));
      expect(find.text('Room: Office'), findsOneWidget);
      expect(find.text('Chat lesson one'), findsOneWidget);
      await tester.tap(find.widgetWithText(ChoiceChip, 'Office'));
      await tester.pumpAndSettle();
      expect(find.text('Office idea'), findsOneWidget);
      expect(find.text('Chat lesson one'), findsNothing);
    });

    testWidgets('Reply saves the owner words and shows them', (tester) async {
      await pumpPage(tester, (req) async {
        if (req.method == 'POST') return http.Response(jsonEncode({'ok': true}), 200);
        return http.Response(jsonEncode(_sampleDay()), 200);
      });
      await tester.tap(find.widgetWithText(OutlinedButton, 'Reply').first);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Keep the stop tighter');
      await tester.tap(find.widgetWithText(FilledButton, 'Save reply'));
      await tester.pumpAndSettle();

      final post = requests.last;
      expect(post.url.path, '/api/reflections/reply');
      final body = jsonDecode(post.body) as Map<String, dynamic>;
      expect(body, {'id': 'r1', 'item_index': 0, 'reply': 'replied', 'reply_text': 'Keep the stop tighter'});
      expect(find.text('Your reply: Keep the stop tighter'), findsOneWidget);
    });

    testWidgets('Skip marks the item skipped and sends the skip', (tester) async {
      await pumpPage(tester, (req) async {
        if (req.method == 'POST') return http.Response(jsonEncode({'ok': true}), 200);
        return http.Response(jsonEncode(_sampleDay()), 200);
      });
      await tester.tap(find.widgetWithText(TextButton, 'Skip').first);
      await tester.pumpAndSettle();

      final body = jsonDecode(requests.last.body) as Map<String, dynamic>;
      expect(body, {'id': 'r1', 'item_index': 0, 'reply': 'skipped', 'reply_text': ''});
      expect(find.text('Skipped.'), findsWidgets);
    });
  });
}
