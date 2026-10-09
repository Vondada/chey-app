import 'dart:io';

import 'package:chey/che_installed_skill_intent.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('explicit skill commands require the Worker, including unsupported skills', () {
    const commands = [
      'list installed skills',
      'show approved skills',
      'read agent skills',
      'what skills are installed?',
      'which skills can you use?',
      'find a skill for React testing',
      'find skills about React testing',
      'search for an agent skill to test React',
      'search skills React testing',
      'discover agent skills for React testing',
      'is there a skill for React testing?',
      'is there a skill to test React?',
      'is there a skill that can test React?',
      'use find-skills for React testing',
      'run find-skills to find React testing',
      'use find-skills to search for React testing',
      'install find-skills',
      'update find-skills',
      'use skill unknown',
      'run the skill unknown',
      'install agent skill unknown',
      'update the agent skill unknown',
      'execute skill unknown',
      'use find-skills to build an app',
      'use skill unknown to update your code',
    ];
    for (final command in commands) {
      for (final prefix in ['', 'CHE, please ', 'chay can you ', 'Chey: can you please ']) {
        expect(isInstalledSkillRequest('$prefix$command'), isTrue,
            reason: '$prefix$command');
      }
    }
  });

  test('human skills, examples and unrelated commands are not skill requests', () {
    for (final message in [
      '',
      'What skills should a React developer learn?',
      'Explain how people discover skills for their careers.',
      'I want to use find-skills for React testing.',
      'Explain the phrase "list installed skills".',
      '"find a skill for React testing"',
      'Do not run find-skills for React testing.',
      'find my React notes',
      'search for React testing',
      'show installed skills on a resume as an example',
      'open the browser',
      'read the page',
      'update yourself',
      'use skillful communication',
      'run find-skills-example',
    ]) {
      expect(isInstalledSkillRequest(message), isFalse, reason: message);
    }
  });

  test('all local shortcuts retain installed-skill guards', () {
    final connected = File('lib/home_state/connected.dart').readAsStringSync();
    expect(connected.indexOf('if (isInstalledSkillRequest(message)) return false;'),
        lessThan(connected.indexOf("'/api/find?q=")));
    final send = File('lib/home_state/send.dart').readAsStringSync();
    expect(send, matches(RegExp(
      r'if \(_realtimeVoice\?\.connected == true &&\s*'
      r'_pendingAttachment == null &&\s*!isInstalledSkillRequest\(message\)\)',
    )));
    final stream = File('lib/home_state/streaming.dart').readAsStringSync();
    expect(stream, contains('if (isInstalledSkillRequest(userMessage) ||'));
    expect(stream, contains('final codeRequest = !installedSkillRequest &&'));
    expect(stream, contains('if (!installedSkillRequest && !terminalChatOnly && !codeRequest'));
    expect(stream, matches(RegExp(
      r'if \(_pendingAttachment == null &&\s*!installedSkillRequest &&',
    )));
    expect(stream, contains('if (!installedSkillRequest && !hadAttachment && _streamMediaUrl == null)'));
  });
}
