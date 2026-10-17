import 'package:flutter_test/flutter_test.dart';
import 'package:chey/home/screen_command.dart';

void main() {
  test('video phrase clears chips without a question', () {
    expect(
      parseScreenCommand(
        'Can you start off wit clearing some of the text off the screen those three bubbles',
      )?.op,
      ScreenOp.clearChips,
    );
  });

  test('add and remove a named chip', () {
    expect(parseScreenCommand('add a chip that says Check Atlas')?.op, ScreenOp.addChip);
    expect(parseScreenCommand('add a chip that says Check Atlas')?.text, 'Check Atlas');
    expect(parseScreenCommand('remove the bubble saying Read me what Atlas finished')?.op, ScreenOp.removeChip);
  });

  test('clear chat text and last message', () {
    expect(parseScreenCommand('clear the chat')?.op, ScreenOp.clearChat);
    expect(parseScreenCommand('remove the last message')?.op, ScreenOp.removeLast);
  });

  test('engineering instructions never act on the visible conversation', () {
    final prompts = [
      'CHE, you are my personal assistant. Never delete a chat message during a coding assignment. '
        'Before you update any code, explain what you checked and preserve the current conversation history.',
      '/che-build Implement an evidence gate and remove fake job status from chat responses.',
      'Fix the code that calls messages.clear() when the assistant receives a long BUILD request.',
      'Repair screen_command.dart so it does not clear chat when a prompt says to delete false claims.',
      'Please inspect the Flutter screen and tell me whether remove and chat are incorrectly matched.',
      'Explain why the message "clear the chat" accidentally reached an on-device action.',
      'CHE, review lib/home/screen_command.dart:\nRemove false positives from your chat parser.',
    ];
    for (final prompt in prompts) {
      expect(parseScreenCommand(prompt), isNull, reason: prompt);
    }
  });

  test('explicit screen edits continue to work', () {
    expect(parseScreenCommand('Clear the chat')?.op, ScreenOp.clearChat);
    expect(parseScreenCommand('Remove the last message')?.op, ScreenOp.removeLast);
    expect(parseScreenCommand('hide the greeting')?.op, ScreenOp.hideGreeting);
    expect(parseScreenCommand('Show the greeting')?.op, ScreenOp.showGreeting);
    expect(parseScreenCommand('add a chip that says Check Atlas')?.op, ScreenOp.addChip);
    expect(parseScreenCommand('remove the bubble saying Read me what Atlas finished')?.op, ScreenOp.removeChip);
  });

  test('normal chat is not a screen edit', () {
    expect(parseScreenCommand('What is the Office doing?'), isNull);
    expect(parseScreenCommand("What's next on ML classification"), isNull);
  });
}
