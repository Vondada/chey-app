// The 3D crew shows real work only (owner, 2026-10-22): each character's clip comes from its agent's runtime status.
import 'package:chey/che_ui/che_agents.dart';
import 'package:chey/rooms/che_crew_states.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every status maps to a clip the crew models actually carry', () {
    for (final s in CheAgentStatus.values) {
      expect(cheCrewClips, contains(cheClipForStatus(s)), reason: s.name);
    }
  });

  test('working statuses look like work; idle, waiting and offline do not', () {
    expect(cheClipForStatus(CheAgentStatus.researching), 'think');
    expect(cheClipForStatus(CheAgentStatus.analyzing), 'think');
    expect(cheClipForStatus(CheAgentStatus.reviewing), 'think');
    expect(cheClipForStatus(CheAgentStatus.building), 'sit');
    expect(cheClipForStatus(CheAgentStatus.meeting), 'talk');
    expect(cheClipForStatus(CheAgentStatus.talking), 'talk');
    expect(cheClipForStatus(CheAgentStatus.done), 'celebrate');
    for (final s in [CheAgentStatus.idle, CheAgentStatus.waiting, CheAgentStatus.offline]) {
      expect(cheClipForStatus(s), 'idle', reason: s.name);
    }
    expect(cheCrewStateFor(CheAgentStatus.offline).still, isTrue, reason: 'an offline agent does not move');
    expect(cheCrewStateFor(CheAgentStatus.idle).still, isFalse);
  });

  test('all eight models get a state; a model with no live agent stands idle; temporary agents are left out', () {
    final states = cheCrewStates(
      CheAgent.che(status: CheAgentStatus.talking),
      const [
        CheAgent(id: 'a1', name: 'Nova', role: 'Product', status: CheAgentStatus.researching),
        CheAgent(id: 'a2', name: 'knox ', role: 'Engineering', status: CheAgentStatus.building),
        CheAgent(id: 'a3', name: 'Sage', role: 'Finance', status: CheAgentStatus.offline),
        CheAgent(id: 'tmp', name: 'Temp Helper', role: 'Temporary', status: CheAgentStatus.building),
      ],
    );
    expect(states.keys.toList(), cheCrewModelIds);
    expect(states['che'], const CheCrewState('talk'));
    expect(states['nova'], const CheCrewState('think'));
    expect(states['knox'], const CheCrewState('sit'));
    expect(states['sage'], const CheCrewState('idle', still: true));
    for (final id in ['atlas', 'mira', 'lyra', 'iris']) {
      expect(states[id], const CheCrewState('idle'), reason: '$id has no live agent');
    }
    expect(states.containsKey('temp helper'), isFalse);
    expect(states['nova']!.toJson(), {'clip': 'think', 'still': false});
  });

  // Stage 4 (2026-11-06): the new clips have a voice route in the crew room, not only buttons (Codex on #956).
  test('the crew room hears a clip by name in plain words, and leaves other chat alone', () {
    expect(cheCrewClips, containsAll(['dance', 'happy', 'sad', 'surprised', 'angry', 'point', 'clap']));
    expect(cheCrewModelIds, containsAll(['orion', 'vale']));
    const said = {
      'dance': 'dance',
      'CHE, dance!': 'dance',
      'make CHE clap': 'clap',
      'make everyone dance': 'dance',
      'play the wave animation': 'wave',
      'look surprised': 'surprised',
      'can you point': 'point',
      'shake your head': 'shake',
      'sit down': 'sit',
      'be happy': 'happy',
      'look angry': 'angry',
      'sad': 'sad',
    };
    for (final e in said.entries) {
      expect(cheCrewClipCommand(e.key), e.value, reason: e.key);
      expect(cheCrewClips, contains(cheCrewClipCommand(e.key)), reason: e.key);
    }
    for (final words in ['what is the weather today', 'run the tests on the worker', 'dance music playlist for tonight', 'che', '']) {
      expect(cheCrewClipCommand(words), isNull, reason: words);
    }
    expect(cheCrewClipSaid('dance'), 'CHE is dancing.');
    expect(cheCrewClipSaid('surprised'), 'CHE looks surprised.');
    for (final clip in cheCrewClips) {
      expect(cheCrewClipSaid(clip), isNot(contains('playing $clip')), reason: '$clip has its own words');
    }
    expect(cheCrewClipOptions(), allOf(contains('dance'), contains('clap'), contains('shake her head')));
  });
}
