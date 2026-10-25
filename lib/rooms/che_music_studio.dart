// Music Studio (owner, 2026-10-25): the Music room and the old Creator "Studio" view are one room tab, purely music
// creation. Each section opens the Recording Studio (lib/music/che_recording_studio.dart) on its own tab, so every
// working music feature stays where it already lives: recording, the Beat Maker, saved songs, vocal tools and pitch
// correction, presets, the mixer, mastering and export. "Make a song with CHE" uses the connected music engine.
//
// Moved out of this room on the same day: the render queue (cloud jobs now show under Working now in the Creation
// Room), voice and narration and podcast episodes (Film Studio tools), Apple Music and car audio (the Devices room's
// Speaker and Car), and the decorative 3D stages, foam wall and animated meters (nothing real drove them).
//
// Nothing is spoken when the room opens; Read aloud and the Help sheet speak only when the owner asks. While the room
// is the screen in front, typed or spoken words reach [CheMusicStudioRoom.voiceHandler] first (send.dart): a section
// by number ("number two") or by name ("beat maker"), "read aloud" and "help".
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_screen_awareness.dart';
import '../che_ui/che_theme.dart';
import '../create/che_creative_studio.dart' show cheSpokenChoice;

/// One Music Studio section. [tab] is the Recording Studio tab it opens (0 Record, 1 My Songs, 2 Beat Maker,
/// 3 Mixer, 4 Effects, 5 Master); null for the music-engine and help sections.
class CheMusicSection {
  const CheMusicSection(this.id, this.title, this.body, this.icon, {this.tab, this.words = const []});
  final String id;
  final String title;
  final String body;
  final IconData icon;
  final int? tab;

  /// Names the owner may say for this section ("beat maker", "beats").
  final List<String> words;
}

/// The room's sections in order. The numbers the owner hears and says are these positions plus one.
const cheMusicSections = <CheMusicSection>[
  CheMusicSection('record', 'Record', 'Record vocals and instruments on this iPhone. Count-in, punch in and out, loops, tracks, trim and split.',
      Icons.mic_rounded, tab: 0, words: ['record', 'recording', 'recorder', 'tracks']),
  CheMusicSection('beats', 'Beat Maker', 'Build beats on the step grid or have CHE produce one by genre, key and tempo, with swing.',
      Icons.grid_view_rounded, tab: 2, words: ['beat maker', 'beat', 'beats', 'drums']),
  CheMusicSection('songs', 'My Songs', 'Your saved songs and projects. Open one, save, and export WAV or M4A.',
      Icons.folder_open_outlined, tab: 1, words: ['my songs', 'songs', 'saved songs', 'saved projects', 'projects']),
  CheMusicSection('vocals', 'Vocal Tools and Presets', 'Vocal presets, pitch correction, vocal analysis, noise reduction, reverb, delay and compression.',
      Icons.record_voice_over_rounded, tab: 4, words: ['vocal tools', 'vocals', 'presets', 'effects', 'pitch', 'pitch correction', 'autotune', 'auto tune']),
  CheMusicSection('mixer', 'Mixer', 'Volume, pan, mute and solo for every track. Balance the mix or ask CHE for mixing advice.',
      Icons.tune_rounded, tab: 3, words: ['mixer', 'mixing', 'mix']),
  CheMusicSection('master', 'Mastering and Export', 'Tone, bus compression, loudness and a peak limiter on the whole song, then export.',
      Icons.graphic_eq_rounded, tab: 5, words: ['mastering', 'master', 'export']),
  CheMusicSection('engine', 'Make a Song with CHE', 'Songs, beats, stems and lyrics with the connected music engine.',
      Icons.music_note_rounded, words: ['make a song', 'make a song with che', 'make music', 'music engine']),
  CheMusicSection('help', 'Help and Tutorial', 'How the studio works and what you can say.', Icons.help_outline_rounded,
      words: ['help', 'tutorial', 'how does this work', 'how do i use this']),
];

/// The Help sheet's lines, read aloud on request.
const cheMusicHelp = <String>[
  'Start in Record: say "record my vocals", or press Record. Say "stop", then "play that back".',
  'Beat Maker: say "make a trap beat at 140", "play the beat", or "tempo 90".',
  'Vocal tools: say "tune my vocals", "add reverb", "compress it" or a preset name.',
  'Mixer: say "balance the mix". Mastering: say "master the song", then export from My Songs or Master.',
  'Your songs are saved on this iPhone under My Songs.',
  'In this room, say a section number, like "number two", or its name, like "mixer". Say "read aloud" to hear the list.',
];

/// "music studio", "the music studio", "studio" or "music" after open, show or go to: the Music Studio room tab, not
/// the Apple Music app ("open Apple Music" still opens the app).
bool cheIsMusicStudioName(String name) => RegExp(r'^(?:the |my )?(?:music studio|music|studio)\W*$').hasMatch(name.trim().toLowerCase());

class CheMusicStudioRoom extends StatefulWidget {
  const CheMusicStudioRoom({
    super.key,
    required this.onOpenSection,
    this.onMakeSong,
    this.musicEngineConnected = false,
    this.onRead,
    this.active = true,
  });

  /// Opens the Recording Studio on a tab (see [CheMusicSection.tab]).
  final void Function(int tab) onOpenSection;

  /// "Make a Song with CHE": asks CHE to make a track with the connected music engine.
  final VoidCallback? onMakeSong;
  final bool musicEngineConnected;

  /// Speaks text the owner asked to hear (Read aloud, Help).
  final void Function(String text)? onRead;

  /// The room is the selected room tab.
  final bool active;

  /// While the room is in front: a section by number or name, "read aloud" and "help". Null for anything else.
  static Future<String?> Function(String words)? voiceHandler;

  @override
  State<CheMusicStudioRoom> createState() => CheMusicStudioRoomState();
}

class CheMusicStudioRoomState extends State<CheMusicStudioRoom> {
  Object? _screen;
  late final Future<String?> Function(String words) _voice = _handle;

  String get _engineState => widget.musicEngineConnected ? 'Music engine connected' : 'Music engine not connected';

  /// The numbered list Read aloud says.
  String get spokenSummary => 'Music Studio. $_engineState. '
      '${[for (final (i, s) in cheMusicSections.indexed) '${i + 1}. ${s.title}'].join('. ')}. '
      'Say a number or a name to open it.';

  @override
  void initState() {
    super.initState();
    CheMusicStudioRoom.voiceHandler = _voice;
    _screen = CheScreenAwareness.register(context, () => CheScreenReport(
          page: 'Music Studio',
          detail: '$_engineState. Sections: ${[for (final (i, s) in cheMusicSections.indexed) '${i + 1}. ${s.title}'].join(', ')}',
          controls: ['Read the Music Studio aloud', for (final s in cheMusicSections) s.title, 'Close rooms'],
        ));
  }

  @override
  void dispose() {
    if (CheMusicStudioRoom.voiceHandler == _voice) CheMusicStudioRoom.voiceHandler = null;
    CheScreenAwareness.unregister(_screen);
    super.dispose();
  }

  bool get _inFront => widget.active && mounted && (ModalRoute.of(context)?.isCurrent ?? true);

  Future<String?> _handle(String words) async {
    if (!_inFront) return null;
    final t = words
        .trim()
        .toLowerCase()
        .replaceAll(RegExp(r'[.!?,]+'), '')
        .replaceFirst(RegExp(r'^(?:che|chey|chay)\s+'), '')
        .replaceFirst(RegExp(r'^(?:open|show|go to|start)\s+(?:the\s+|my\s+)?'), '');
    if (RegExp(r'^(?:read(?: (?:it|this|the music studio|the options))?(?: aloud)?|read aloud|what can i do here|list (?:the )?options)$').hasMatch(t)) {
      return spokenSummary;
    }
    final n = cheSpokenChoice(words);
    if (n != null) {
      if (n < 1 || n > cheMusicSections.length) return 'There are ${cheMusicSections.length} sections. Say a number from 1 to ${cheMusicSections.length}.';
      return _run(cheMusicSections[n - 1], viaVoice: true);
    }
    for (final s in cheMusicSections) {
      if (s.words.contains(t) || s.title.toLowerCase() == t) return _run(s, viaVoice: true);
    }
    return null;
  }

  /// Runs one section and returns what CHE says about it (voice), or null when nothing needs saying (a tap).
  Future<String?> _run(CheMusicSection s, {bool viaVoice = false}) async {
    HapticFeedback.selectionClick();
    if (s.id == 'help') {
      if (!viaVoice) {
        await _showHelp();
        return null;
      }
      // Spoken "help": the sheet opens and its lines are the reply, so a blind owner hears them.
      unawaited(_showHelp());
      return cheMusicHelp.join(' ');
    }
    if (s.id == 'engine') {
      final make = widget.onMakeSong;
      if (make == null) return viaVoice ? 'Making a song is not available here.' : null;
      make();
      return viaVoice ? (widget.musicEngineConnected ? 'Asked CHE to make a song with the music engine.' : 'The music engine is not connected, so CHE will write the brief and lyrics.') : null;
    }
    widget.onOpenSection(s.tab!);
    return viaVoice ? 'Opened ${s.title} in the Recording Studio.' : null;
  }

  Future<void> _showHelp() => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        backgroundColor: CheColors.surface,
        builder: (sheet) => SafeArea(
          child: ListView(
            key: const ValueKey('music-help'),
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.lg),
            children: [
              Semantics(header: true, child: Text('Music Studio help', style: CheType.title)),
              const SizedBox(height: CheSpace.sm),
              for (final line in cheMusicHelp)
                Padding(padding: const EdgeInsets.only(bottom: CheSpace.sm), child: Text(line, style: CheType.body.copyWith(fontSize: 18, height: 1.4))),
              const SizedBox(height: CheSpace.sm),
              Semantics(
                container: true,
                button: true,
                label: 'Read the help aloud',
                excludeSemantics: true,
                child: OutlinedButton.icon(
                  key: const ValueKey('music-help-read'),
                  onPressed: widget.onRead == null ? null : () => widget.onRead!(cheMusicHelp.join(' ')),
                  icon: const Icon(Icons.volume_up_rounded),
                  label: const Text('Read aloud'),
                ),
              ),
            ],
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return Material(
      key: const ValueKey('music-studio-room'),
      color: CheColors.screen,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.md, CheSpace.gutter, CheSpace.xxl),
        children: [
          Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Semantics(header: true, child: Text('Music Studio', style: CheType.title.copyWith(fontSize: 28, fontWeight: FontWeight.w800))),
                const SizedBox(height: 4),
                // Quiet status: not a live region, so nothing is announced when the room opens.
                Text(_engineState, key: const ValueKey('music-engine-state'), style: CheType.bodyDim.copyWith(fontSize: 16)),
              ]),
            ),
            Semantics(
              container: true,
              button: true,
              label: 'Read the Music Studio aloud',
              excludeSemantics: true,
              child: IconButton(
                key: const ValueKey('music-read'),
                tooltip: 'Read the Music Studio aloud',
                constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                onPressed: widget.onRead == null ? null : () => widget.onRead!(spokenSummary),
                icon: const Icon(Icons.volume_up_rounded),
              ),
            ),
          ]),
          const SizedBox(height: CheSpace.md),
          for (final (i, s) in cheMusicSections.indexed) _SectionTile(
            number: i + 1,
            section: s,
            status: s.id == 'engine' ? (widget.musicEngineConnected ? 'Ready' : 'Not connected: CHE writes the brief and lyrics') : null,
            onTap: () => _run(s),
          ),
        ],
      ),
    );
  }
}

class _SectionTile extends StatelessWidget {
  const _SectionTile({required this.number, required this.section, required this.onTap, this.status});
  final int number;
  final CheMusicSection section;
  final String? status;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: CheSpace.sm),
      child: Semantics(
        container: true,
        button: true,
        label: '$number. ${section.title}. ${section.body}${status == null ? '' : ' $status.'}',
        excludeSemantics: true,
        child: Material(
          key: ValueKey('music-section-${section.id}'),
          color: CheColors.surface,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CheRadius.md), side: BorderSide(color: CheColors.stroke)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 72),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: CheSpace.md, vertical: CheSpace.sm),
                child: Row(children: [
                  Icon(section.icon, color: CheColors.accent, size: 28),
                  const SizedBox(width: CheSpace.md),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('$number. ${section.title}', style: CheType.label.copyWith(fontSize: 18, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 2),
                      Text(section.body, style: CheType.caption.copyWith(fontSize: 14, height: 1.35)),
                      if (status != null) ...[
                        const SizedBox(height: 4),
                        Text(status!, style: CheType.caption.copyWith(fontSize: 13, color: status == 'Ready' ? CheColors.success : CheColors.warning)),
                      ],
                    ]),
                  ),
                  const Icon(Icons.chevron_right_rounded),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
