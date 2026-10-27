// Phone-side voice routing (reliability lane rel-infra-app, 2026-10-25). sendMessage (lib/home_state/send.dart) tries
// its on-device parsers in a fixed order before anything reaches the Worker. This replays that order for the
// stateless parsers and checks which one claims each owner phrase, typed and as speech recognition delivers it
// (lowercase, no punctuation, wake word in front). A phrase claimed by the wrong parser is a misroute the owner hears
// as a wrong action; a phrase meant for the Worker must pass through every parser untouched.
// Keep _routes in the same order as sendMessage. Worker-side routes: server/cloudflare/voice_command_routing.test.mjs.
import 'package:chey/brain/che_brain_space_model.dart';
import 'package:chey/browser/che_video_voice.dart';
import 'package:chey/che_ui/che_help.dart';
import 'package:chey/che_ui/che_screen_awareness.dart';
import 'package:chey/che_ui/che_ui_voice_command.dart';
import 'package:chey/home/screen_command.dart';
import 'package:chey/rithmic/rithmic_session.dart';
import 'package:chey/rooms/che_live_chart.dart';
import 'package:chey/security/che_password_vault.dart';
import 'package:chey/security/che_secret_scan.dart';
import 'package:chey/self_update/che_self_update_intent.dart';
import 'package:chey/world/che_meetings.dart';
import 'package:flutter_test/flutter_test.dart';

final _routes = <(String, bool Function(String))>[
  ('vault', (m) => CheVaultCommand.parse(m) != null),
  ('secret', cheChatLooksSecret),
  ('screen', (m) => parseScreenCommand(m) != null),
  ('ui', (m) => CheUiVoiceCommand.parse(m) != null),
  ('meetings', (m) => cheMeetingNavIntent(m) != null),
  ('screen_question', cheAsksAboutScreen),
  ('help', (m) => cheHelpIntent(m) != null),
  ('video', (m) => CheVideoVoiceCommand.parse(m) != null),
  ('brain', (m) => CheBrainCommand.parse(m) != null),
  ('chart', (m) => CheChartCommand.parse(m) != null),
  ('rithmic_diagnose', cheRithmicDiagnoseCommand),
];

String _firstRoute(String message) {
  for (final (name, claims) in _routes) {
    if (claims(message)) return name;
  }
  return 'worker';
}

void main() {
  const expected = <String, List<String>>{
    'vault': ['save my password for netflix', 'Chay, read my password for Gmail.'],
    'screen': ['Clear the chat', 'clear the chat', 'remove the last message', 'open the command center'],
    'ui': ['Dark mode', 'chay switch to light mode', 'make the text bigger', 'volume down'],
    'screen_question': ["What's on my screen?", 'whats on my screen', 'chay what is on my screen'],
    'video': ['search youtube for jazz', 'Search YouTube for lofi beats.'],
    'chart': ['show me the e-mini', 'Show me the E-mini.'],
    'rithmic_diagnose': ['diagnose rithmic', 'Diagnose Rithmic.'],
    // Everything CHE's records answer on the Worker: no phone parser may take these.
    'worker': [
      'what version of che am i running',
      'is the new build installed on my phone',
      'chay whats on my iphone right now',
      'did the update go through',
      'cancel the coding job',
      'what is the coding job doing',
      'coding status',
      'mission status',
      'pause the strategy simulation',
      'what are my trading connections',
      'remember that my favorite color is green',
      'write an essay about why dark mode saves battery',
      'tell me a joke',
    ],
  };

  for (final entry in expected.entries) {
    test('owner phrases for ${entry.key} reach ${entry.key} first', () {
      for (final phrase in entry.value) {
        expect(_firstRoute(phrase), entry.key, reason: phrase);
      }
    });
  }

  // CHE's own secret-scan reply tells the owner "say save my password for, then the site"; that sentence used to
  // match no parser and went to the Worker as chat.
  test('the vault takes the password phrasings CHE herself suggests, and never invents a password', () {
    final ask = CheVaultCommand.parse('save my password for netflix')!;
    expect(ask.kind, 'ask_password');
    expect(ask.site, 'netflix');
    expect(ask.password, isEmpty);
    final saved = CheVaultCommand.parse('Chay, save my password for Netflix as Hunter2!')!;
    expect(saved.kind, 'save');
    expect(saved.site, 'netflix');
    expect(saved.password, 'Hunter2!', reason: 'capitalisation and punctuation are kept');
    final read = CheVaultCommand.parse('Chay, read my password for Gmail.')!;
    expect(read.kind, 'read');
    expect(read.site, 'gmail');
    expect(CheVaultCommand.parse('save my netflix password as hunter2')!.password, 'hunter2', reason: 'the form CHE asks for');
  });

  test('version and install questions carry the device report and skip page voice handlers', () {
    // send.dart lets the open Commands, Security, Brain and browser pages answer first unless the phrase is an app
    // status request; these must stay status requests so the Worker gets the native build report.
    for (final phrase in ['what version of che am i running', 'is the new build installed on my phone', 'chay whats on my iphone right now']) {
      expect(cheIsAppStatusRequest(phrase), isTrue, reason: phrase);
    }
  });
}
