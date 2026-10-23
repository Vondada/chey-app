import 'package:chey/che_ui/che_clock.dart';
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_flagstaff_banner.dart';
import 'package:chey/home/che_home_tiles.dart';
import 'package:chey/home/che_mockup_home.dart';
import 'package:chey/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('market hours: each market’s next open or close', () {
    test('New York open in October (EDT): the next change is the 4:00 PM close, 20:00 UTC', () {
      expect(cheNextSessionChange('New York', DateTime.utc(2026, 10, 23, 14)), DateTime.utc(2026, 10, 23, 20));
    });

    test('across the November daylight-saving change, New York reopens at 9:30 AM EST (14:30 UTC)', () {
      // DST ends on Sunday 1 November 2026: on Monday 2 November New York is on EST, so the open is 14:30 UTC.
      expect(cheNextSessionChange('New York', DateTime.utc(2026, 11, 2, 14)), DateTime.utc(2026, 11, 2, 14, 30));
    });

    test('Tokyo has no daylight saving: it closes at 3:00 PM Tokyo time, 06:00 UTC', () {
      // Tokyo cash hours are 9:00 AM to 3:00 PM local (UTC+9), so at 01:00 UTC on a Friday the close is 06:00 UTC.
      expect(cheNextSessionChange('Tokyo', DateTime.utc(2026, 10, 23, 1)), DateTime.utc(2026, 10, 23, 6));
    });

    test('every market reports a next change within a week', () {
      for (final s in cheMarketSessions(DateTime.utc(2026, 10, 23, 14))) {
        expect(cheNextSessionChange(s.name, DateTime.utc(2026, 10, 23, 14)), isNotNull, reason: s.name);
      }
    });
  });

  group('Home tiles fit a phone without clipping', () {
    for (final width in [375.0, 390.0]) {
      testWidgets('markets and Flagstaff tiles at ${width.toInt()} pt', (tester) async {
        await tester.pumpWidget(MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: (width - 32) / 2,
                child: Column(children: [
                  CheHomeFlagstaffTile(
                    unread: 2,
                    latest: const [CheFlagstaffGist(from: 'chatgpt', text: 'A long message that keeps going for a while so it must wrap or be cut with dots.')],
                    onOpen: () {},
                  ),
                ]),
              ),
            ),
          ),
        ));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(MaterialApp(
          home: Scaffold(
            body: SizedBox(width: width - 32, child: CheHomeMarketsTile(now: DateTime.utc(2026, 10, 23, 14), onOpen: () {})),
          ),
        ));
        expect(tester.takeException(), isNull);
        expect(find.text('New York'), findsOneWidget);
        expect(find.text('Tokyo'), findsOneWidget);
      });
    }
  });

  testWidgets('Flagstaff shows the real gist, and says so when nothing is new', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheHomeFlagstaffTile(unread: 0, latest: const [], onOpen: () {}),
      ),
    ));
    expect(find.text('No new messages'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('no new messages')), findsOneWidget);
  });

  testWidgets('Office states what the numbers mean', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: CheHomeOfficeTile(working: 0, total: 23, onOpen: () {})),
    ));
    expect(find.text('0 working'), findsOneWidget);
    expect(find.text('23 ON STAFF'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('0 working now, 23 on staff')), findsOneWidget);
  });

  // The whole Home at the two most common iPhone widths: any clipped or overflowing row fails the test.
  for (final size in const [Size(390, 844), Size(375, 667)]) {
    testWidgets('Home fits at ${size.width.toInt()} x ${size.height.toInt()} pt', (tester) async {
      tester.view.physicalSize = Size(size.width * 3, size.height * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      SharedPreferences.setMockInitialValues({});

      await tester.pumpWidget(const CHEApp());
      for (var i = 0; i < 15; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      expect(tester.takeException(), isNull);
      expect(find.text('Talk to CHE'), findsOneWidget);
      // The room pills sit at the bottom of the Home list: scroll there and check each label is on screen.
      final homeList = find.descendant(of: find.byType(CheMockupHome), matching: find.byType(Scrollable)).first;
      tester.state<ScrollableState>(homeList).position.jumpTo(tester.state<ScrollableState>(homeList).position.maxScrollExtent);
      await tester.pump();
      for (final room in ['Brain', 'Create', 'CHE World', 'Security', 'MARKETS', 'OFFICE', 'FLAGSTAFF']) {
        expect(find.text(room), findsWidgets, reason: room);
      }
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  }

  test('theme tokens exist for the status colours the tiles use', () {
    expect(CheColors.success, isNotNull);
    expect(CheColors.textDim, isNotNull);
  });

  group('Codex review on #506', () {
    testWidgets('the Flagstaff banner has a VoiceOver tap action that opens Flagstaff', (tester) async {
      final handle = tester.ensureSemantics();
      var opened = 0;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showCheFlagstaffBanner(context, title: 'New message in Flagstaff', detail: 'chatgpt: hello', onOpen: () => opened++),
              child: const Text('show'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('show'));
      await tester.pump(const Duration(milliseconds: 400));
      // The node VoiceOver reads: a Semantics widget whose label names the banner and whose onTap opens Flagstaff.
      final semantics = tester.widget<Semantics>(find.byWidgetPredicate(
        (w) => w is Semantics && (w.properties.label ?? '').contains('New message in Flagstaff'),
      ));
      expect(semantics.properties.onTap, isNotNull, reason: 'VoiceOver double tap needs a tap action');
      semantics.properties.onTap!();
      await tester.pump(const Duration(milliseconds: 400));
      expect(opened, 1);
      // Let the banner's own timers finish so the test ends cleanly.
      await tester.pump(const Duration(seconds: 6));
      await tester.pump(const Duration(seconds: 1));
      handle.dispose();
    });

    test('the gist refreshes when the newest message changes but the count does not', () {
      const old = [CheFlagstaffGist(id: 'a', from: 'chatgpt', text: 'First.')];
      const same = [CheFlagstaffGist(id: 'a', from: 'chatgpt', text: 'First.')];
      const newest = [CheFlagstaffGist(id: 'b', from: 'gemini', text: 'Second.')];
      expect(cheGistChanged(old, same), isFalse);
      expect(cheGistChanged(old, newest), isTrue, reason: 'same count, new newest message');
      expect(cheGistChanged(old, const []), isTrue);
    });

    testWidgets('the Flagstaff tile label includes the sender and the preview', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 180,
            child: CheHomeFlagstaffTile(
              unread: 1,
              latest: const [CheFlagstaffGist(id: 'x', from: 'chatgpt', text: 'Try caching the voices.')],
              onOpen: () {},
            ),
          ),
        ),
      ));
      expect(find.bySemanticsLabel(RegExp('chatgpt: Try caching the voices')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Flagstaff, 1 new')), findsOneWidget);
      handle.dispose();
    });
  });
}
