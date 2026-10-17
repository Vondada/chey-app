import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The owner's spoken or typed "check for updates" command is matched by the
/// `updateCommand` expression inside `_handleLocalNavigation`
/// (lib/home_state/send.dart). That method is private to the home state, so this
/// test reads the shipped pattern out of the source and runs the exact same
/// match send.dart runs (`hasMatch(message.trim())`). If the pattern is edited,
/// these phrases are checked against the edited pattern.
RegExp _shippedUpdateCommand() {
  final source = File('lib/home_state/send.dart').readAsStringSync();
  final found = RegExp(
    r"final updateCommand = RegExp\(\s*r'([^']+)',\s*caseSensitive: false,\s*\);",
  ).firstMatch(source);
  if (found == null) {
    throw StateError('updateCommand pattern not found in lib/home_state/send.dart');
  }
  return RegExp(found.group(1)!, caseSensitive: false);
}

void main() {
  final updateCommand = _shippedUpdateCommand();
  bool opensUpdates(String message) => updateCommand.hasMatch(message.trim());

  test('short update-check phrases open the update screen', () {
    for (final phrase in [
      'check update',
      'check updates',
      'CHE, check for updates',
      'check my updates',
    ]) {
      expect(opensUpdates(phrase), isTrue, reason: phrase);
    }
  });

  test('every earlier update phrase still opens the update screen', () {
    for (final phrase in [
      'update yourself',
      'check for updates',
      'check for an update',
      'check for any updates',
      'check my che update',
      'install the che update',
      'download the che update',
      'Che, update yourself.',
      'chey check updates!',
      'shay, check for an update?',
    ]) {
      expect(opensUpdates(phrase), isTrue, reason: phrase);
    }
  });

  test('ordinary sentences that mention updates do not open the update screen', () {
    for (final phrase in [
      'check the update log in my notes',
      'check updates in my notes',
      'check my updates folder',
      'check update status of the contract',
      'what does check update mean',
      'update the log',
      'check my notes',
      'check',
      'updates',
    ]) {
      expect(opensUpdates(phrase), isFalse, reason: phrase);
    }
  });
}
