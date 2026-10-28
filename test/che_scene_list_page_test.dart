// Widget test for the Create Studio project list (M2d navigation): the owner's saved projects, opening one in the editor,
// starting a New character, and returning to the list with the new project in it. The fake Worker checks each request.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chey/create/che_scene_studio_page.dart';
import 'support/fake_scene_worker.dart';

void main() {
  testWidgets('the list opens a saved project, and New character adds one that reopens', (tester) async {
    final worker = FakeWorker();
    final client = clientFor(worker);
    // One project already saved on the Worker.
    await client.create(name: 'Old robot', template: 'person');
    final oldId = worker.scenes.keys.single;

    await tester.pumpWidget(MaterialApp(home: CheSceneListPage(client: client)));
    await tester.pumpAndSettle();
    expect(find.text('Old robot'), findsOneWidget);
    expect(find.text('New character'), findsOneWidget);

    // Opening a project shows its editor with the saved height.
    await tester.tap(find.text('Old robot'));
    await tester.pumpAndSettle();
    expect(find.text('Height (m): 1.70'), findsOneWidget);
    expect(find.textContaining('Saved version 1'), findsOneWidget);

    // Back on the list, New character creates a second project and opens it.
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('New character'));
    await tester.pumpAndSettle();
    expect(worker.scenes, hasLength(2), reason: 'New character must store a new project on the Worker');
    expect(find.text('Height (m): 1.70'), findsOneWidget);

    // Back again: the list now holds both projects. The list reloads from the Worker after the editor closes; wait for
    // that reload to finish, then let the screen draw its result before checking it.
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pumpAndSettle();
    expect(find.text('Old robot'), findsOneWidget);
    expect(worker.scenes.keys, contains(oldId));
    expect(find.text('My character'), findsOneWidget, reason: 'the new project is listed by its name');
  });
}
