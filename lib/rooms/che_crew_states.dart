// Real runtime status -> the clip each 3D crew character plays (owner, 2026-10-22: characters respond to real
// activity, never to fake work). Every crew GLB carries the same clips (tools/character_pipeline/README.md): idle,
// walk, run, wave, sit, stand, talk, think, celebrate, nod, shake, and since Stage 4 (2026-11-06) dance, happy, sad,
// surprised, angry, point and clap.
import '../che_ui/che_agents.dart';

/// The ten bundled crew models (`assets/characters/crew/<id>.glb`); Orion and Vale since Stage 4.
const List<String> cheCrewModelIds = ['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris', 'orion', 'vale'];

/// The clips every crew model carries.
const Set<String> cheCrewClips = {
  'idle', 'walk', 'run', 'wave', 'sit', 'stand', 'talk', 'think', 'celebrate', 'nod', 'shake',
  'dance', 'happy', 'sad', 'surprised', 'angry', 'point', 'clap',
};

/// The words that ask the crew room for each clip, after "make CHE", "play the" and similar are taken off.
const Map<String, List<String>> _clipWords = {
  'idle': ['idle', 'stand still', 'rest'],
  'walk': ['walk', 'walking'],
  'run': ['run', 'running'],
  'wave': ['wave', 'waving', 'wave hello'],
  'sit': ['sit', 'sit down', 'sitting'],
  'stand': ['stand', 'stand up'],
  'talk': ['talk', 'talking'],
  'think': ['think', 'thinking'],
  'celebrate': ['celebrate', 'celebrating'],
  'nod': ['nod', 'nodding'],
  'shake': ['shake', 'shake head', 'shake her head', 'shake your head'],
  'dance': ['dance', 'dancing'],
  'happy': ['happy', 'look happy', 'be happy'],
  'sad': ['sad', 'look sad', 'be sad'],
  'surprised': ['surprised', 'look surprised', 'surprise'],
  'angry': ['angry', 'look angry', 'be angry', 'mad'],
  'point': ['point', 'pointing'],
  'clap': ['clap', 'clapping', 'applaud'],
};

/// What the crew room says after starting a clip.
const Map<String, String> _clipSaid = {
  'idle': 'CHE is standing at ease.', 'walk': 'CHE is walking.', 'run': 'CHE is running.', 'wave': 'CHE is waving.',
  'sit': 'CHE sits down.', 'stand': 'CHE stands up.', 'talk': 'CHE is talking.', 'think': 'CHE is thinking.',
  'celebrate': 'CHE is celebrating.', 'nod': 'CHE is nodding.', 'shake': 'CHE is shaking her head.',
  'dance': 'CHE is dancing.', 'happy': 'CHE looks happy.', 'sad': 'CHE looks sad.', 'surprised': 'CHE looks surprised.',
  'angry': 'CHE looks angry.', 'point': 'CHE points.', 'clap': 'CHE is clapping.',
};

/// The clip the owner's words ask the 3D crew room to play ("dance", "make CHE clap", "play the wave animation"), or
/// null when the words are not a room command, so ordinary chat goes on to CHE.
String? cheCrewClipCommand(String words) {
  var t = words.toLowerCase().replaceAll(RegExp(r"[^a-z' ]"), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  t = t.replaceFirst(RegExp(r'^(?:hey |ok |okay )?(?:che|chey|chay)\s+'), '');
  t = t.replaceFirst(RegExp(r'^(?:please |can you |could you )'), '');
  t = t.replaceFirst(RegExp(r'^(?:make (?:che|her|everyone|the crew|them) |play (?:the )?|show (?:me )?(?:the )?|do (?:the |a )?)'), '');
  t = t.replaceFirst(RegExp(r' (?:animation|clip|please)$'), '').trim();
  if (t.isEmpty || t.split(' ').length > 3) return null;
  for (final e in _clipWords.entries) {
    if (e.value.contains(t)) return e.key;
  }
  return null;
}

/// The spoken reply for a clip the room started.
String cheCrewClipSaid(String clip) => _clipSaid[clip] ?? 'CHE is playing $clip.';

/// The crew room's list of what it can play, for "options" or "what can CHE do".
String cheCrewClipOptions() =>
    'CHE can: ${[for (final c in cheCrewClips) c == 'shake' ? 'shake her head' : c].join(', ')}. Say one, like "dance" or "clap".';

/// The clip for a real agent status: thinking work thinks, building sits at the desk, meetings and talks talk, a
/// finished task celebrates once, waiting and idle stand at ease.
String cheClipForStatus(CheAgentStatus status) => switch (status) {
      CheAgentStatus.researching || CheAgentStatus.analyzing || CheAgentStatus.reviewing => 'think',
      CheAgentStatus.building => 'sit',
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
