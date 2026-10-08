import 'package:chey/che_wake_match.dart';
import 'package:chey/che_ui/che_wake.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('CHE wake spellings are accepted', () {
    for (final word in ['CHE', 'Chay', 'Chey', 'Shay', 'Chai', 'Che']) {
      expect(cheIsWake('$word what time is it'), isTrue, reason: word);
    }
  });

  test('wake opens remainder without requiring another wake name', () {
    expect(cheWakeRemainder('Hey Chay, read this to me'), 'read this to me');
  });

  test('wake name matches Chay, CHE and Hey Chay; unrelated speech does not', () {
    expect(matchWake('Chay'), isTrue);
    expect(matchWake('CHE'), isTrue);
    expect(matchWake('Hey Chay'), isTrue);
    expect(matchWake('hey chay, you there?'), isTrue);
    expect(matchWake('Check the weather'), isFalse);
    expect(matchWake('Order a pizza'), isFalse);
    expect(matchWake(''), isFalse);
  });

  test('the command after the wake name is kept', () {
    expect(commandAfterWake('Hey Chay, what is Knox doing?'), 'what is Knox doing?');
    expect(commandAfterWake('Chay'), '');
    expect(commandAfterWake('what is Knox doing?'), isNull);
  });

  test('Office phrases still match after the wake name', () {
    expect(matchOfficePhrase("Hey Chay, what's happening in the Office?")?.type, CheOfficePhrase.happening);
    expect(matchOfficePhrase('Chay what did they build today')?.type, CheOfficePhrase.builtToday);
    expect(matchOfficePhrase('CHE, how much did we make today?')?.type, CheOfficePhrase.earnedToday);
    expect(matchOfficePhrase("Chay, what's stalled?")?.type, CheOfficePhrase.stalled);
    expect(matchOfficePhrase('Chay, read this Office to me')?.type, CheOfficePhrase.readOffice);
    final knox = matchOfficePhrase('Hey Chay, what is Knox doing?');
    expect(knox?.type, CheOfficePhrase.agentStatus);
    expect(knox?.agentId, 'knox');
    expect(matchOfficePhrase('Chay, stand down')?.type, CheOfficePhrase.standDown);
    final iris = matchOfficePhrase('Hey Chay, what is Iris doing?');
    expect(iris?.type, CheOfficePhrase.agentStatus);
    expect(iris?.agentId, 'iris');
  });

  test('Iris hire, Fiverr scout, and tonight pack phrases match', () {
    expect(matchOfficePhrase('hire Iris')?.type, CheOfficePhrase.hireIris);
    expect(matchOfficePhrase('Chay, hire Iris for Ad Studio')?.type, CheOfficePhrase.hireIris);
    final scout = matchOfficePhrase('scout Fiverr for AI ad buyers');
    expect(scout?.type, CheOfficePhrase.fiverrScout);
    expect(scout?.detail, 'AI ad buyers');
    final pack = matchOfficePhrase('draft tonight pack for Cafe Luna');
    expect(pack?.type, CheOfficePhrase.goal);
    expect(pack?.detail, contains('tonight pack'));
    expect(pack?.detail, contains('Cafe Luna'));
  });

  test('Office phrases also match without the wake name; others do not', () {
    expect(matchOfficePhrase('Read the Office to me')?.type, CheOfficePhrase.readOffice);
    expect(matchOfficePhrase('What is Bob doing?'), isNull);
    expect(matchOfficePhrase('Tell me a joke'), isNull);
  });

  test('cheOfficeRoster includes Iris', () {
    expect(cheOfficeRoster, contains('iris'));
  });

  test('Roblox studio phrases match', () {
    final weapon = matchOfficePhrase('Chay, build a Roblox weapon tool base');
    expect(weapon?.type, CheOfficePhrase.robloxJob);
    expect(weapon?.detail?.toLowerCase(), contains('roblox weapon'));
    final hire = matchOfficePhrase('hire Knox for Roblox Luau clothing shirt');
    expect(hire?.type, CheOfficePhrase.robloxJob);
    final create = matchOfficePhrase('create a Roblox game lobby script');
    expect(create?.type, CheOfficePhrase.robloxJob);
  });

  test('ML and translate phrases match', () {
    final ml = matchOfficePhrase('Chay, run classification');
    expect(ml?.type, CheOfficePhrase.mlJob);
    expect(ml?.detail, 'classification');
    final cl = matchOfficePhrase('Start clustering');
    expect(cl?.type, CheOfficePhrase.mlJob);
    expect(cl?.detail, 'clustering');
    final tr = matchOfficePhrase('Translate to Spanish: good morning');
    expect(tr?.type, CheOfficePhrase.translate);
    final loc = matchOfficePhrase('Set my language to French');
    expect(loc?.type, CheOfficePhrase.setLocale);
  });

  test('a finished-sounding sentence ends the turn quickly; trailing fillers do not', () {
    expect(cheSoundsComplete('what time is it'), isTrue);
    expect(cheSoundsComplete('Play some jazz.'), isTrue);
    expect(cheSoundsComplete('build me a website and'), isFalse);
    expect(cheSoundsComplete('so um'), isFalse);
    expect(cheSoundsComplete('what'), isFalse);
    expect(cheQuickEndOfTurn < const Duration(milliseconds: 3600), isTrue);
  });
}
