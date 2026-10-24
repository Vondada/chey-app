// Real runtime status -> the clip each 3D crew character plays (owner, 2026-10-22: characters respond to real
// activity, never to fake work). Every crew GLB carries the same twelve clips (tools/character_pipeline/README.md):
// idle, walk, run, wave, sit, stand, talk, think, celebrate, nod, shake, type.
import '../che_ui/che_agents.dart';

/// The eight bundled crew models (`assets/characters/crew/<id>.glb`).
const List<String> cheCrewModelIds = ['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris'];

/// The clips every crew model carries.
const Set<String> cheCrewClips = {
  'idle', 'walk', 'run', 'wave', 'sit', 'stand', 'talk', 'think', 'celebrate', 'nod', 'shake', 'type',
};

/// The clip for a real agent status: thinking work thinks, building types at the desk, meetings and talks talk, a
/// finished task celebrates once, waiting and idle stand at ease.
String cheClipForStatus(CheAgentStatus status) => switch (status) {
      CheAgentStatus.researching || CheAgentStatus.analyzing || CheAgentStatus.reviewing => 'think',
      CheAgentStatus.building => 'type',
      CheAgentStatus.meeting || CheAgentStatus.talking => 'talk',
      CheAgentStatus.done => 'celebrate',
      CheAgentStatus.waiting || CheAgentStatus.idle => 'idle',
      CheAgentStatus.offline => 'idle',
    };

/// One character's state for the page: its clip, and whether it stands still (offline agents do not move).
class CheCrewState {
  const CheCrewState(this.clip, {this.still = false});

  final String clip;
  final bool still;

  Map<String, Object> toJson() => {'clip': clip, 'still': still};

  @override
  bool operator ==(Object other) => other is CheCrewState && other.clip == clip && other.still == still;

  @override
  int get hashCode => Object.hash(clip, still);
}

CheCrewState cheCrewStateFor(CheAgentStatus status) =>
    CheCrewState(cheClipForStatus(status), still: status == CheAgentStatus.offline);

/// The state of every bundled character from the real runtime: CHE from her own status, each crew model from the
/// agent of the same name. A model with no live agent stands idle; agents without a model (temporary ones) are left out.
Map<String, CheCrewState> cheCrewStates(CheAgent che, Iterable<CheAgent> agents) {
  final byName = {for (final a in agents) a.name.trim().toLowerCase(): a};
  return {
    for (final id in cheCrewModelIds)
      id: id == 'che'
          ? cheCrewStateFor(che.status)
          : byName[id] == null
              ? const CheCrewState('idle')
              : cheCrewStateFor(byName[id]!.status),
  };
}
