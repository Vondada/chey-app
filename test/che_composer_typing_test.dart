import 'dart:io';

import 'package:chey/home/che_home_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _Host extends StatefulWidget {
  const _Host({required this.controller, required this.onBuild});
  final TextEditingController controller;
  final VoidCallback onBuild;
  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  final focus = FocusNode();
  @override
  void dispose() {
    focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    widget.onBuild();
    return MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: CheHomeComposer(
            controller: widget.controller,
            focusNode: focus,
            busy: false,
            modes: const ['Chat'],
            modeIndex: 0,
            onModeChanged: (_) {},
            onSend: () {},
            onStop: () {},
            onAttach: () {},
            onMic: () {},
            micActive: false,
            hint: 'Message CHE',
          ),
        ),
      ),
    );
  }
}

void main() {
  testWidgets('typing rebuilds only the composer, never the home screen', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    var hostBuilds = 0;
    await tester.pumpWidget(_Host(controller: controller, onBuild: () => hostBuilds++));
    expect(hostBuilds, 1);
    for (final text in ['H', 'He', 'Hel', 'Hell', 'Hello CHE']) {
      await tester.enterText(find.byType(TextField), text);
      await tester.pump();
    }
    expect(find.text('Hello CHE'), findsOneWidget);
    expect(hostBuilds, 1);
  });

  test('live transcripts update the composer without a home-level setState', () {
    final mic = File('lib/home_state/microphone.dart').readAsStringSync();
    expect(mic, isNot(contains('_set(() => controller.text')));
    expect(mic, isNot(matches(RegExp(r'_set\(\(\) \{\s*controller\.text'))));
    expect(mic, contains('_mic.scheduleRestart('));
    final voice = File('lib/home_state/voice.dart').readAsStringSync();
    expect(voice, isNot(contains('isListening = listeningNow')));
    expect(voice, contains("_restartListeningSoon(reason: 'TTS_END')"));
  });
}
