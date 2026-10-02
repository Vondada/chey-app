import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Flagstaff root network is viewport-driven and Chat suggestions wrap', () {
    final mailbox = File('lib/mailbox/che_mailbox_screen.dart').readAsStringSync();
    final main = File('lib/main.dart').readAsStringSync();

    final graphStart = mailbox.indexOf('class _AiNeuralWeb');
    final painterStart = mailbox.indexOf('class _AiNeuralPainter', graphStart);
    final graph = mailbox.substring(graphStart, painterStart);

    expect(graph, contains('LayoutBuilder('));
    expect(graph, contains('constraints.maxWidth'));
    expect(graph, contains('final center = Offset(width / 2, height / 2)'));
    expect(graph, contains('clipBehavior: Clip.hardEdge'));
    expect(graph, isNot(contains('InteractiveViewer(')));
    expect(graph, isNot(contains('final side = math.max(420.0')));

    final chatStart = main.indexOf('Widget _buildChatTab');
    final chatEnd = main.indexOf('Future<void> _persistLanguages', chatStart);
    final chat = main.substring(chatStart, chatEnd);

    expect(chat, contains("messages.last['role'] == 'assistant'"));
    expect(chat, contains('postReplyActions.take(3)'));
    expect(chat, contains('Wrap('));
    expect(chat, isNot(contains('scrollDirection: Axis.horizontal')));
    expect(chat, isNot(contains('FractionallySizedBox(')));
  });
}
