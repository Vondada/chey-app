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

  test('normal chat is not a screen edit', () {
    expect(parseScreenCommand('What is the Office doing?'), isNull);
    expect(parseScreenCommand("What's next on ML classification"), isNull);
  });
}
