// Stand-alone preview of the new CHE UI with a fake backend.
// Build it with:  flutter run -t lib/che_ui/che_preview.dart
// (Use it to check the look before wiring the real screens and Worker.)

import 'package:flutter/material.dart';

import 'che_ui.dart';

void main() => runApp(const ChePreviewApp());

class ChePreviewApp extends StatefulWidget {
  const ChePreviewApp({super.key});
  @override
  State<ChePreviewApp> createState() => _ChePreviewAppState();
}

class _ChePreviewAppState extends State<ChePreviewApp> {
  final plugins = ChePluginRegistry();
  final brain = CheBrain();
  late final CheAgentController chat = CheAgentController(
    brain: brain,
    backend: CheBackend.fromStream(_fakeStream),
    store: CheConversationStore(),
    systemAddons: plugins.systemAddons,
  );
  final navKey = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    plugins.load();
    brain.load();
    chat.restore();
  }

  Stream<String> _fakeStream(CheRequest req) async* {
    req.step('Understanding “${req.message.length > 30 ? '${req.message.substring(0, 30)}…' : req.message}”');
    await Future<void>.delayed(const Duration(milliseconds: 250));
    req.step('Planning the answer');
    await Future<void>.delayed(const Duration(milliseconds: 250));
    final text = req.message.toLowerCase().contains('plugin')
        ? 'Here is a plugin that adds a quick crypto check.\n\n```che-plugin\n'
            '{"id":"crypto-pulse","name":"Crypto Pulse","version":"1.0.0","author":"CHE",'
            '"description":"Quick crypto market pulse.","icon":"crypto","color":"#E8B04A",'
            '"instructions":"When asked about crypto, summarize top movers first.",'
            '"quickActions":["Crypto pulse now"],'
            '"screen":{"type":"cards","cards":[{"icon":"bolt","title":"Top movers","body":"Biggest 24h moves","prompt":"Show top crypto movers"}]}}'
            '\n```'
        : '## Done\nHere’s what I found for **${req.mode}** mode:\n- Fast streaming replies\n- Live steps while I work\n\n```dart main.dart\nvoid main() {\n  print("CHE online"); // hello\n}\n```';
    for (final w in text.split(RegExp(r'(?<= )'))) {
      if (req.isCancelled()) return;
      yield w;
      await Future<void>.delayed(const Duration(milliseconds: 12));
    }
  }

  void _openChat([String? prompt]) {
    navKey.currentState!.push(CheRoute(
      builder: (_) => CheAgentChatScreen(controller: chat, pluginRegistry: plugins, onMic: () {}),
    ));
    if (prompt != null) chat.send(prompt);
  }

  Widget _placeholder(String title, List<Widget> extra) => CheSectionPage(
        title: title,
        description: 'Existing $title content goes here.',
        children: [
          ...extra,
          const CheFeatureCard(icon: Icons.bolt_rounded, title: 'Example card', body: 'Consistent spacing, no clipping.'),
        ],
      );

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: navKey,
      debugShowCheckedModeBanner: false,
      theme: CheTheme.dark(),
      home: Builder(
        builder: (context) => CheOfficeHub(
          onOpenChat: _openChat,
          sections: cheDefaultSections(
            memory: (_) => _placeholder('Memory', const []),
            insights: (_) => _placeholder('Brain', [CheBrainCard(brain: brain, controller: chat)]),
            markets: (_) => _placeholder('Markets', const []),
            business: (_) => _placeholder('Business', const []),
            devices: (_) => _placeholder('Devices', const []),
            music: (_) => _placeholder('Music', const []),
            create: (_) => _placeholder('Create', const []),
            office: (_) => _placeholder('Office', [
                  // PREVIEW ONLY — real agents + states come from the backend Agent Runtime.
                  CheOfficeFloor(
                    che: CheAgent.che(status: chat.busy ? CheAgentStatus.talking : CheAgentStatus.idle),
                    agents: const [
                      CheAgent(id: 'nova', name: 'Nova', role: 'Research', color: Color(0xFF5CC8FF), status: CheAgentStatus.researching, task: 'Market catalysts'),
                      CheAgent(id: 'mira', name: 'Mira', role: 'Design', color: Color(0xFFFF8A4C), hair: Color(0xFF7A3B1D), skin: Color(0xFFE0B08A), status: CheAgentStatus.building, task: 'Studio visuals'),
                      CheAgent(id: 'atlas', name: 'Atlas', role: 'Quant', color: Color(0xFF3DDC97), skin: Color(0xFF8D5A3B), status: CheAgentStatus.analyzing),
                      CheAgent(id: 'sage', name: 'Sage', role: 'Reviewer', color: Color(0xFF8B7BFF), status: CheAgentStatus.waiting),
                    ],
                    onTapAgent: (a) => _openChat('What is ${a.name} working on?'),
                    onConvene: () => _openChat('Convene the team in the War Room'),
                  ),
                ]),
            apps: (_) => _placeholder('Apps', const []),
            plugins: (_) => ChePluginsScreen(
              registry: plugins,
              onAskCheToBuild: () => _openChat('Build me a plugin that '),
              onRunPrompt: _openChat,
            ),
          ),
        ),
      ),
    );
  }
}
