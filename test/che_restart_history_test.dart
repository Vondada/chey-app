// The owner asked "What's my favorite drink?", CHE said "Sprite", and he
// answered "No, strawberry Sprite." The Worker reads that correction from the
// `history` the app sends with each /api/chat request. The home chat list is
// in memory only, so after a relaunch the first request carried no history;
// the conversation log CHE saves on the phone now fills it while it is fresh.
import 'package:chey/che_ui/che_agent_chat.dart';
import 'package:chey/che_ui/che_backend.dart';
import 'package:chey/che_ui/che_log.dart';
import 'package:chey/che_ui/che_models.dart';
import 'package:flutter_test/flutter_test.dart';

/// A log store that answers from memory: no files, no Worker.
class _SavedLog extends CheConversationStore {
  _SavedLog(this.saved);
  final List<CheConversation> saved;

  @override
  Future<List<CheConversation>> loadAll() async => saved;

  @override
  Future<void> save(CheConversation c) async {}

  @override
  Future<void> remoteLog(CheConversation c, CheMessage user, CheMessage reply, {String source = 'chat'}) async {}
}

CheConversation _drinkTalk({required Duration ago, bool spoken = true}) {
  final c = CheConversation('drink');
  c.messages
    ..add(CheMessage.user(spoken ? "🎙 What's my favorite drink?" : "What's my favorite drink?"))
    ..add(CheMessage.assistant()..text = 'Sprite');
  c.updatedAt = DateTime.now().subtract(ago);
  return c;
}

CheAgentController _relaunched(List<CheConversation> saved) => CheAgentController(
      backend: CheBackend.fromFuture((_) async => ''),
      store: _SavedLog(saved),
    );

void main() {
  test('after a relaunch the Worker still sees "What\'s my favorite drink?" and "Sprite"', () async {
    final log = _relaunched([_drinkTalk(ago: const Duration(minutes: 2))]);
    await log.restore();

    expect(log.restoredTurnsForHistory(), [
      {'role': 'user', 'content': "What's my favorite drink?"},
      {'role': 'assistant', 'content': 'Sprite'},
    ]);
  });

  test('a typed turn is sent as the owner wrote it', () async {
    final log = _relaunched([_drinkTalk(ago: const Duration(minutes: 2), spoken: false)]);
    await log.restore();

    expect(log.restoredTurnsForHistory().first['content'], "What's my favorite drink?");
  });

  test('a conversation saved long before the relaunch is not this chat\'s history', () async {
    final log = _relaunched([_drinkTalk(ago: const Duration(hours: 3))]);
    await log.restore();

    expect(log.restoredTurnsForHistory(), isEmpty);
    expect(log.restoredTurnsForHistory(within: const Duration(hours: 4)), isNotEmpty);
  });

  test('only the last turns go, newest conversation first', () async {
    final long = CheConversation('long');
    for (var i = 0; i < 10; i++) {
      long.messages
        ..add(CheMessage.user('question $i'))
        ..add(CheMessage.assistant()..text = 'answer $i');
    }
    long.updatedAt = DateTime.now().subtract(const Duration(minutes: 1));
    final older = _drinkTalk(ago: const Duration(minutes: 5));
    final log = _relaunched([older, long]);
    await log.restore();

    final turns = log.restoredTurnsForHistory();
    expect(turns.length, 8);
    expect(turns.first, {'role': 'user', 'content': 'question 6'});
    expect(turns.last, {'role': 'assistant', 'content': 'answer 9'});
  });

  test('once a turn finished in this launch the live chat is the history', () async {
    final log = _relaunched([_drinkTalk(ago: const Duration(minutes: 2))]);
    await log.restore();
    log.logTurn('No, strawberry Sprite.', 'Strawberry Sprite. Noted, sir.', source: 'voice');

    expect(log.restoredTurnsForHistory(), isEmpty);
  });

  test('New chat and clear chat drop the restored conversation', () async {
    final fresh = _relaunched([_drinkTalk(ago: const Duration(minutes: 2))]);
    await fresh.restore();
    fresh.newConversation();
    expect(fresh.restoredTurnsForHistory(), isEmpty);

    final cleared = _relaunched([_drinkTalk(ago: const Duration(minutes: 2))]);
    await cleared.restore();
    cleared.dropRestoredContext();
    expect(cleared.restoredTurnsForHistory(), isEmpty);
  });

  test('nothing saved means no history, as before', () async {
    final log = _relaunched(const []);
    await log.restore();

    expect(log.restoredTurnsForHistory(), isEmpty);
  });
}
