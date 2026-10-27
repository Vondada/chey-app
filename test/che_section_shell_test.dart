// The section shell: swipe between sections, tab bar jumps, and a section keeps its state.
import 'package:chey/che_ui/che_office_hub.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  CheSection section(String id, String title, Widget Function(BuildContext) builder) =>
      CheSection(id: id, title: title, subtitle: '', icon: Icons.circle_rounded, hue: const Color(0xFF7FD3FF), builder: builder);

  testWidgets('swipe moves to the next section and the tab bar follows; the first section keeps its state', (tester) async {
    final sections = [
      section('one', 'ONE', (_) => const _Counter(key: Key('counter'))),
      section('two', 'TWO', (_) => const Center(child: Text('second section', key: Key('second')))),
    ];
    await tester.pumpWidget(MaterialApp(home: CheSectionShell(sections: sections, initialIndex: 0, onOpenChat: () {})));
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.byKey(const Key('counter')));
    await tester.pump();
    expect(find.text('taps 1'), findsOneWidget);

    await tester.fling(find.byType(PageView), const Offset(-400, 0), 1200);
    await tester.pump(const Duration(seconds: 1));
    expect(find.byKey(const Key('second')), findsOneWidget);

    await tester.fling(find.byType(PageView), const Offset(400, 0), 1200);
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('taps 1'), findsOneWidget, reason: 'the first section was kept alive, not rebuilt');
  });
}

class _Counter extends StatefulWidget {
  const _Counter({super.key});
  @override
  State<_Counter> createState() => _CounterState();
}

class _CounterState extends State<_Counter> {
  int _n = 0;
  @override
  Widget build(BuildContext context) => Center(
        child: TextButton(onPressed: () => setState(() => _n++), child: Text('taps $_n')),
      );
}
