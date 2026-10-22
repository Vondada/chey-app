// CHE 2.0 Home (owner, 2026-10-22): CHE's state comes from real signals only, every destination opens its room, only
// running work is listed, and the screen works by VoiceOver, with large text, Reduce Motion and no scrolling to reach
// the Talk control and the five destinations on the owner's iPhone. Since 2026-10-22 the Home is the approved HUD
// concept: Trading is the MNQ tile, the Office is the OFFICE tile, Brain, Create and CHE World are glass pills.
import 'package:chey/che_ui/che_agents.dart';
import 'package:chey/che_ui/che_futuristic.dart';
import 'package:chey/home/che_mockup_home.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _nova = CheAgent(id: 'nova', name: 'Nova', role: 'Research', status: CheAgentStatus.researching, task: 'Market notes');
const _atlas = CheAgent(id: 'atlas', name: 'Atlas', role: 'Build', status: CheAgentStatus.idle);
const _mira = CheAgent(id: 'mira', name: 'Mira', role: 'Design', status: CheAgentStatus.offline);

Widget _home({
  bool connected = true,
  bool listening = false,
  bool thinking = false,
  bool speaking = false,
  int working = 0,
  List<CheAgent> agents = const [],
  Map<String, int>? opened,
  bool reduceMotion = false,
  double textScale = 1.0,
}) {
  void hit(String id) => opened?[id] = (opened[id] ?? 0) + 1;
  return MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(
        size: const Size(440, 956),
        disableAnimations: reduceMotion,
        textScaler: TextScaler.linear(textScale),
      ),
      child: Scaffold(
        body: CheMockupHome(
          che: CheAgent.che(),
          agents: agents,
          working: working,
          liveMeetings: 0,
          connected: connected,
          greeting: '',
          listening: listening,
          thinking: thinking,
          speaking: speaking,
          onTalk: () => hit('talk'),
          onOpenChat: () => hit('chat'),
          onOpenOffice: () => hit('office'),
          onOpenBrain: () => hit('brain'),
          onOpenTrading: () => hit('trading'),
          onOpenCreate: () => hit('create'),
          onOpenWorld: () => hit('world'),
          onOfficeStatus: () => hit('status'),
          onToggleVoiceReplies: () => hit('voice'),
        ),
      ),
    ),
  );
}

Future<void> _phone(WidgetTester tester) async {
  // iPhone 17 Pro Max: 440 x 956 points at 3x.
  tester.view.physicalSize = const Size(1320, 2868);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void main() {
  test('the mode comes only from real signals, with speech and listening first', () {
    CheHomeMode m({bool c = true, bool l = false, bool t = false, bool s = false, int w = 0}) =>
        cheHomeModeFor(connected: c, listening: l, thinking: t, speaking: s, working: w);
    expect(m(), CheHomeMode.idle);
    expect(m(w: 2), CheHomeMode.working);
    expect(m(t: true, w: 2), CheHomeMode.thinking);
    expect(m(l: true, t: true), CheHomeMode.listening);
    expect(m(s: true, l: true), CheHomeMode.speaking);
    expect(m(c: false, w: 3), CheHomeMode.offline, reason: 'no connection: the working count is not current');
    expect(m(c: false, l: true), CheHomeMode.listening, reason: 'the microphone works without the server');
  });

  test('each mode has its own colour, and only listening, thinking, speaking and working move', () {
    expect(CheHomeMode.values.map((m) => m.color).toSet().length, CheHomeMode.values.length);
    expect(CheHomeMode.values.where((m) => m.active).toSet(),
        {CheHomeMode.listening, CheHomeMode.thinking, CheHomeMode.speaking, CheHomeMode.working});
    for (final m in CheHomeMode.values) {
      expect(cheHomeModeSentence(m, working: 2), isNot(contains('tap')), reason: m.name);
    }
    expect(cheHomeModeSentence(CheHomeMode.working, working: 1), '1 agent is working right now.');
  });

  test('only agents with running work are listed; CHE, idle, offline and done agents are not', () {
    final listed = cheHomeActiveAgents([CheAgent.che(status: CheAgentStatus.building), _nova, _atlas, _mira,
      const CheAgent(id: 'k', name: 'Knox', role: 'QA', status: CheAgentStatus.done)]);
    expect(listed.map((a) => a.name), ['Nova']);
  });

  testWidgets('Talk and all five destinations are visible without scrolling on the owner\'s iPhone', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_home());
    await tester.pump();
    final screen = tester.getRect(find.byType(CheMockupHome));
    for (final label in ['Talk to CHE', 'OFFICE', 'Brain', 'MNQ', 'Create', 'CHE World']) {
      final rect = tester.getRect(find.text(label));
      expect(rect.bottom, lessThanOrEqualTo(screen.bottom), reason: '$label is on the first screen');
    }
  });

  testWidgets('each destination and the Talk control open what they say', (tester) async {
    await _phone(tester);
    final opened = <String, int>{};
    await tester.pumpWidget(_home(opened: opened));
    await tester.pump();
    for (final (label, id) in [
      ('OFFICE', 'office'), ('Brain', 'brain'), ('MNQ', 'trading'), ('Create', 'create'), ('CHE World', 'world'),
      ('Talk to CHE', 'talk'),
    ]) {
      await tester.tap(find.text(label));
      await tester.pump(const Duration(milliseconds: 300));
      expect(opened[id], 1, reason: label);
    }
    await tester.tap(find.byIcon(Icons.keyboard_rounded));
    await tester.pump(const Duration(milliseconds: 300));
    expect(opened['chat'], 1);
  });

  testWidgets('the state is shown in words: listening shows Stop listening and the listening sentence', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_home(listening: true));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('CHE ONLINE · LISTENING'), findsOneWidget);
    expect(find.bySemanticsLabel('CHE. CHE is listening.'), findsOneWidget);
    expect(find.text('Stop listening'), findsOneWidget);
    expect(find.text('Talk to CHE'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('no work is invented: an idle team says so, a working agent is named with its real task', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_home());
    await tester.pump();
    await tester.scrollUntilVisible(find.text('No work is running right now.'), 200);
    expect(find.text('No work is running right now.'), findsOneWidget);

    await tester.pumpWidget(_home(working: 1, agents: const [_nova, _atlas, _mira]));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.scrollUntilVisible(find.textContaining('Market notes'), 200);
    expect(find.textContaining('Nova'), findsOneWidget);
    expect(find.textContaining('Atlas'), findsNothing);
    expect(find.textContaining('Mira'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('VoiceOver hears CHE\'s state, the Talk control and every destination', (tester) async {
    await _phone(tester);
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_home(thinking: true));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.bySemanticsLabel('CHE is thinking'), findsOneWidget);
    expect(find.bySemanticsLabel('CHE. CHE is thinking about your request.'), findsOneWidget);
    expect(find.bySemanticsLabel('Talk to CHE. Starts a voice conversation.'), findsOneWidget);
    expect(find.bySemanticsLabel('Type to CHE. Opens Chat.'), findsOneWidget);
    for (final name in ['The Office', 'Brain', 'Trading', 'Create', 'CHE World']) {
      expect(find.bySemanticsLabel(RegExp('^$name\\. .*Double tap to open\\.\$')), findsOneWidget, reason: name);
    }
    await tester.pumpWidget(const SizedBox());
    handle.dispose();
  });

  testWidgets('large text does not overflow', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_home(textScale: 1.6, working: 1, agents: const [_nova]));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('the ring moves only while CHE is active, and never with Reduce Motion', (tester) async {
    await _phone(tester);
    await tester.pumpWidget(_home());
    await tester.pump();
    expect(tester.hasRunningAnimations, isFalse, reason: 'idle: still');

    await tester.pumpWidget(_home(speaking: true));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.hasRunningAnimations, isTrue, reason: 'speaking: the ring pulses');

    await tester.pumpWidget(_home(speaking: true, reduceMotion: true));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.hasRunningAnimations, isFalse, reason: 'Reduce Motion: still');
    await tester.pumpWidget(const SizedBox());
  });
}
