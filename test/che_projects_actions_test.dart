// Projects cards are tools: each shows its real stage and only the actions that stage allows. Nothing shows a
// percentage that the Worker never reported (2026-10-22: the owner called the made-up progress and empty scenes filler).
import 'package:chey/che_ui/che_theme.dart';
import 'package:chey/home/che_projects_board.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

CheBoardItem item(String id, String title, String status, {double progress = 0.35}) => CheBoardItem(
      id: id,
      title: title,
      kind: CheBoardKind.project,
      typeLabel: 'App',
      statusLabel: status,
      progress: progress,
      subtitle: 'Why it matters: $title',
    );

Future<void> pump(WidgetTester tester, List<CheBoardItem> items, {void Function(String)? onAsk}) async {
  await tester.pumpWidget(MaterialApp(
    theme: CheTheme.dark(),
    home: Scaffold(body: CheProjectsBoard(items: items, onAskChe: onAsk)),
  ));
  await tester.pump();
}

void main() {
  testWidgets('a blocked project offers Retry, asks CHE with its title, and shows no made-up percentage', (tester) async {
    String? asked;
    await pump(tester, [item('a', 'Dental site', 'Blocked · 1')], onAsk: (p) => asked = p);

    expect(find.text('Continue'), findsNothing);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.textContaining('percent'), findsNothing);

    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(asked, contains('Retry "Dental site"'));
  });

  testWidgets('a project waiting for review offers Review; a moving one offers Continue', (tester) async {
    await pump(tester, [item('r', 'Pilot script', 'review'), item('m', 'Shop page', 'In progress · 1/3')], onAsk: (_) {});
    expect(find.text('Review'), findsOneWidget);
    expect(find.text('Continue'), findsOneWidget);
  });

  testWidgets('the summary counts what needs attention, what is moving and what is finished, from real statuses', (tester) async {
    await pump(tester, [
      item('a', 'Dental site', 'Blocked · 1'),
      item('b', 'Shop page', 'In progress · 1/3'),
      item('c', 'Logo', 'complete', progress: 1),
    ]);
    expect(find.text('1 need attention · 1 in progress · 1 finished'), findsOneWidget);
  });

  testWidgets('with no projects the summary says so and offers no empty scene', (tester) async {
    await pump(tester, const []);
    expect(find.textContaining('Nothing yet'), findsOneWidget);
  });

  testWidgets('a lost deal is neither moving nor finished; an invoiced deal is still moving', (tester) async {
    await pump(tester, [
      item('l', 'Lost lead', 'lost', progress: 0),
      item('i', 'Invoice sent', 'invoiced', progress: 1),
    ]);
    expect(find.text('0 need attention · 1 in progress · 0 finished'), findsOneWidget);
  });
}
