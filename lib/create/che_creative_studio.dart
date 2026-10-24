// Create → Creative Studio, managed by Vale (owner, 2026-10-24). One vertically scrolling screen in place of the old
// gallery scene (a 3D room of purple stand-in figures over a wall of project frames) and its Projects | Art Studio |
// GPU Jobs segments. Everything the owner can make is here, each piece linking to the tool that already does it:
// Create New, the studios (Film, Music, Code, Art & Character) and Projects. Nothing is spoken when it opens; Read
// aloud reads it on request. Activity rows show only real backend states (the coding job the Worker reports, the GPU
// queue's own card); with none, it says so.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// The studio's own look: black, silver, white and one teal accent, whatever app palette is chosen.
class CheStudioColors {
  CheStudioColors._();
  static const Color bg = Color(0xFF050608);
  static const Color card = Color(0xFF0E1114);
  static const Color cardHi = Color(0xFF161B1F);
  static const Color stroke = Color(0x2EC9D1D6);
  static const Color silver = Color(0xFFC9D1D6);
  static const Color text = Color(0xFFF4F6F7);
  static const Color dim = Color(0xFF9AA4AA);
  static const Color teal = Color(0xFF2FD6C8);
  static const Color tealDeep = Color(0xFF0E5F59);
}

/// A real piece of work in progress, from a backend status (never simulated).
class CheStudioActivity {
  const CheStudioActivity({required this.title, required this.status, this.detail = '', this.onTap});
  final String title;
  final String status;
  final String detail;
  final VoidCallback? onTap;
}

/// What the studio's buttons do. Each one is an existing handler in the app.
class CheStudioActions {
  const CheStudioActions({
    required this.onOpenFilmStudio,
    required this.onNewVideo,
    required this.onOpenTheater,
    required this.onOpenMusic,
    required this.onNewSong,
    required this.onNewApp,
    required this.onOpenCommandCenter,
    required this.onOpenOffice,
    required this.onCharacterGenerator,
    required this.onOpenArtStudio,
    required this.onNewImage,
    required this.onNewProject,
    required this.onOpenProject,
    required this.onVault,
    required this.onResearch,
    this.onInventions,
    this.onShowroom,
  });

  final VoidCallback onOpenFilmStudio;
  final VoidCallback onNewVideo;
  final VoidCallback onOpenTheater;
  final VoidCallback onOpenMusic;
  final VoidCallback onNewSong;
  final VoidCallback onNewApp;
  final VoidCallback onOpenCommandCenter;
  final VoidCallback onOpenOffice;
  final VoidCallback onCharacterGenerator;
  final VoidCallback onOpenArtStudio;
  final VoidCallback onNewImage;
  final VoidCallback onNewProject;
  final Future<void> Function(Map<String, dynamic> project) onOpenProject;
  final VoidCallback onVault;
  final VoidCallback onResearch;
  final VoidCallback? onInventions;
  final VoidCallback? onShowroom;
}

/// Section keys, so voice routes and tests can scroll straight to a studio.
enum CheStudioSection { film, music, code, art, projects }

class CheCreativeStudio extends StatefulWidget {
  const CheCreativeStudio({
    super.key,
    required this.actions,
    required this.projects,
    required this.vaultCount,
    this.activity = const [],
    this.gpuJobs,
    this.creations,
    this.imageConnected = false,
    this.videoConnected = false,
    this.onRead,
    this.initialSection,
    this.active = true,
  });

  final CheStudioActions actions;
  final List<Map<String, dynamic>> projects;
  final int vaultCount;

  /// Real work in progress (the caller builds it from backend states only).
  final List<CheStudioActivity> activity;

  /// The GPU queue card (Pair Colab, jobs, previews), shown inside Art & Character Studio.
  final Widget? gpuJobs;

  /// The pictures and videos CHE made (CheCreationsStrip), shown in Projects.
  final Widget? creations;
  final bool imageConnected;
  final bool videoConnected;
  final void Function(String text)? onRead;
  final CheStudioSection? initialSection;

  /// False while Create is not the open tab: the studio then leaves spoken numbers to whatever is on screen.
  final bool active;

  /// While the studio is on screen, typed or spoken words reach it first (lib/home_state/send.dart): the numbered
  /// choices Read aloud announces ("four", "option four"), the Create New sheet's numbers, and each action by name.
  /// Returns null for anything else, so it goes to Chat.
  static Future<String?> Function(String words)? voiceHandler;

  @override
  State<CheCreativeStudio> createState() => CheCreativeStudioState();
}

const _cheNumberWords = {
  'one': 1,
  'first': 1,
  'two': 2,
  'second': 2,
  'three': 3,
  'third': 3,
  'four': 4,
  'fourth': 4,
  'for': 4,
  'five': 5,
  'fifth': 5,
  'six': 6,
  'sixth': 6,
  'seven': 7,
  'seventh': 7,
  'eight': 8,
  'eighth': 8,
  'nine': 9,
  'ninth': 9,
};

/// "4", "four", "option four", "number 4", "choose the fourth" -> 4; anything else null.
int? cheSpokenChoice(String words) {
  final t = words
      .trim()
      .toLowerCase()
      .replaceAll(RegExp(r'[.!?,]+'), '')
      .replaceFirst(RegExp(r'^(?:che|chey|chay)\s+'), '');
  final m = RegExp(r'^(?:(?:choose|pick|select|open)\s+)?(?:(?:the|option|number|choice|item)\s+)*(\d{1,2}|[a-z]+)$')
      .firstMatch(t);
  if (m == null) return null;
  return int.tryParse(m.group(1)!) ?? _cheNumberWords[m.group(1)!];
}

/// Newest first by updated_at, then created_at.
List<Map<String, dynamic>> cheProjectsNewestFirst(List<Map<String, dynamic>> projects) {
  DateTime when(Map<String, dynamic> p) =>
      DateTime.tryParse('${p['updated_at'] ?? p['created_at'] ?? ''}') ?? DateTime.fromMillisecondsSinceEpoch(0);
  return [...projects]..sort((a, b) => when(b).compareTo(when(a)));
}

class CheCreativeStudioState extends State<CheCreativeStudio> {
  final _keys = {for (final s in CheStudioSection.values) s: GlobalKey()};

  /// The Create New sheet while it is open: its items (in announced order) and its context, so a spoken number can
  /// choose from it.
  List<(String, String, IconData, VoidCallback?)>? _sheetItems;
  BuildContext? _sheetContext;

  @override
  void dispose() {
    if (CheCreativeStudio.voiceHandler == voice) CheCreativeStudio.voiceHandler = null;
    super.dispose();
  }

  String _sheetSummary(List<(String, String, IconData, VoidCallback?)> items) =>
      'Create new. Say or choose: '
      '${[for (var i = 0; i < items.length; i++)
        if (items[i].$4 != null) '${i + 1} ${items[i].$1}'].join(', ')}.';

  /// Voice and typed control. Numbers resolve against what is on screen: the Create New sheet when it is open,
  /// otherwise the six choices Read aloud announces. Actions can also be named ("new video", "character generator").
  Future<String?> voice(String words) async {
    final t = words
        .trim()
        .toLowerCase()
        .replaceAll(RegExp(r'[.!?]+$'), '')
        .replaceFirst(RegExp(r'^(?:che|chey|chay)[,:]?\s+'), '');
    final a = widget.actions;
    final sheet = _sheetItems;
    // Only while the studio is what the owner sees: its tab is open and no other screen is pushed over it.
    if (sheet == null && (!widget.active || !(ModalRoute.of(context)?.isCurrent ?? true))) return null;
    if (RegExp(r"^(?:read(?: aloud| it| this| the screen)?|what(?:'s| is) on (?:the |this )?screen)$").hasMatch(t)) {
      return sheet != null ? _sheetSummary(sheet) : spokenSummary;
    }
    if (sheet != null && RegExp(r'^(?:cancel|close|never mind|back)$').hasMatch(t)) {
      if (_sheetContext != null) Navigator.of(_sheetContext!).pop();
      return 'Closed Create New.';
    }
    final n = cheSpokenChoice(t);
    if (n != null) {
      if (sheet != null) {
        if (n < 1 || n > sheet.length || sheet[n - 1].$4 == null) {
          return 'There is no choice $n. ${_sheetSummary(sheet)}';
        }
        final item = sheet[n - 1];
        if (_sheetContext != null) Navigator.of(_sheetContext!).pop();
        _tap(item.$4!);
        return 'Opening ${item.$1}.';
      }
      switch (n) {
        case 1:
          unawaited(showCreateNew());
          return _sheetSummary(_createNewItems());
        case 2:
          scrollTo(CheStudioSection.film);
          return 'Film Studio. Say: open Film Studio, new video, or Theater.';
        case 3:
          scrollTo(CheStudioSection.music);
          return 'Music Studio. Say: open Music Studio, or new song.';
        case 4:
          scrollTo(CheStudioSection.code);
          return 'Code Studio. Say: new app, coding jobs, or commands.';
        case 5:
          scrollTo(CheStudioSection.art);
          return 'Art and Character Studio. Say: character generator, art studio, or new image. GPU jobs and Pair Colab are in this studio.';
        case 6:
          scrollTo(CheStudioSection.projects);
          final n2 = widget.projects.length;
          return 'Projects: $n2 project${n2 == 1 ? '' : 's'} and ${widget.vaultCount} saved file${widget.vaultCount == 1 ? '' : 's'}. Say: new project, or saved files.';
      }
      return 'There is no choice $n. $spokenSummary';
    }
    final named = <RegExp, (String, VoidCallback?)>{
      RegExp(r'^create new|^new (?:creation|thing)$'): ('Create New', () => unawaited(showCreateNew())),
      RegExp(r'^open (?:the )?film studio$'): ('Film Studio', a.onOpenFilmStudio),
      RegExp(r'^(?:new|make a|create a) video$'): ('a new video', a.onNewVideo),
      RegExp(r'^(?:open (?:the )?)?theat(?:er|re)$'): ('Theater', a.onOpenTheater),
      RegExp(r'^open (?:the )?music studio$'): ('Music Studio', a.onOpenMusic),
      RegExp(r'^(?:new|make a|create a) (?:song|beat|song or beat)$'): ('a new song', a.onNewSong),
      RegExp(r'^(?:new|make an?|create an?) (?:app|website|site|game)(?:,? site or game)?$'): (
        'a new app, site or game',
        a.onNewApp,
      ),
      RegExp(r'^(?:open )?coding jobs$'): ('coding jobs in the Office', a.onOpenOffice),
      RegExp(r'^(?:open )?(?:the )?command(?:s| center)$'): ('the Command Center', a.onOpenCommandCenter),
      RegExp(r'^(?:open )?(?:the )?character generator$'): ('the Character Generator', a.onCharacterGenerator),
      RegExp(r'^(?:open )?(?:the )?art studio$'): ('Art Studio', a.onOpenArtStudio),
      RegExp(r'^(?:new|make an?|create an?) (?:image|picture)$'): ('a new image', a.onNewImage),
      RegExp(r'^(?:new|create a) project$'): ('a new project', a.onNewProject),
      RegExp(r'^(?:open )?saved files$'): ('saved files', a.onVault),
    };
    for (final e in named.entries) {
      if (e.key.hasMatch(t) && e.value.$2 != null) {
        if (sheet != null && _sheetContext != null) Navigator.of(_sheetContext!).pop();
        _tap(e.value.$2!);
        return 'Opening ${e.value.$1}.';
      }
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    CheCreativeStudio.voiceHandler = voice;
    final s = widget.initialSection;
    if (s != null) WidgetsBinding.instance.addPostFrameCallback((_) => scrollTo(s, animate: false));
  }

  /// Brings one studio into view (voice: "open the music studio" while Create is open).
  void scrollTo(CheStudioSection section, {bool animate = true}) {
    final ctx = _keys[section]?.currentContext;
    if (ctx == null) return;
    Scrollable.ensureVisible(
      ctx,
      duration: animate ? const Duration(milliseconds: 320) : Duration.zero,
      curve: Curves.easeOutCubic,
    );
  }

  /// What Read aloud says: the studios as a numbered list and the real work in progress.
  String get spokenSummary {
    final n = widget.projects.length;
    final work = widget.activity.isEmpty
        ? 'No active jobs.'
        : 'Working now: ${widget.activity.map((a) => '${a.title}, ${a.status}').join('; ')}.';
    return 'Creative Studio, managed by Vale. Say or choose: 1 Create New, 2 Film Studio, 3 Music Studio, '
        '4 Code Studio, 5 Art and Character Studio, 6 Projects. $work '
        'You have $n project${n == 1 ? '' : 's'} and ${widget.vaultCount} saved file${widget.vaultCount == 1 ? '' : 's'}.';
  }

  void _tap(VoidCallback f) {
    HapticFeedback.selectionClick();
    f();
  }

  Future<void> showCreateNew() async {
    HapticFeedback.selectionClick();
    final items = _createNewItems();
    _sheetItems = items;
    try {
      await _showCreateNewSheet(items);
    } finally {
      _sheetItems = null;
      _sheetContext = null;
    }
  }

  List<(String, String, IconData, VoidCallback?)> _createNewItems() {
    final a = widget.actions;
    return <(String, String, IconData, VoidCallback?)>[
      ('Video', 'A clip from a prompt or storyboard', Icons.videocam_rounded, a.onNewVideo),
      ('Film', 'Script, scenes and storyboard in Film Studio', Icons.movie_filter_outlined, a.onOpenFilmStudio),
      ('Song or beat', 'Music, vocals or sound effects', Icons.music_note_rounded, a.onNewSong),
      ('App, website or game', 'A coding job for the crew', Icons.code_rounded, a.onNewApp),
      ('Image', 'A picture from a prompt', Icons.image_rounded, a.onNewImage),
      (
        'Character',
        'Edit CHE or an agent and preview on the GPU',
        Icons.face_retouching_natural,
        a.onCharacterGenerator,
      ),
      ('Project', 'A saved project to work on over time', Icons.folder_special_rounded, a.onNewProject),
      ('Invention', 'Concept, parts, costs and stages', Icons.rocket_launch_outlined, a.onInventions),
    ];
  }

  Future<void> _showCreateNewSheet(List<(String, String, IconData, VoidCallback?)> items) async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: CheStudioColors.card,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) {
        _sheetContext = sheet;
        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            children: [
              Semantics(
                header: true,
                child: const Text(
                  'Create new',
                  style: TextStyle(color: CheStudioColors.text, fontSize: 22, fontWeight: FontWeight.w800),
                ),
              ),
              const SizedBox(height: 4),
              const Text('Choose what to make.', style: TextStyle(color: CheStudioColors.dim, fontSize: 14)),
              const SizedBox(height: 12),
              for (var i = 0; i < items.length; i++)
                if (items[i].$4 != null)
                  Semantics(
                    button: true,
                    label: '${i + 1}. ${items[i].$1}. ${items[i].$2}',
                    excludeSemantics: true,
                    child: ListTile(
                      key: ValueKey('studio-new-${items[i].$1}'),
                      minVerticalPadding: 12,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      leading: _IconDisk(icon: items[i].$3, size: 44),
                      title: Text(
                        items[i].$1,
                        style: const TextStyle(
                          color: CheStudioColors.text,
                          fontSize: 16.5,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      subtitle: Text(items[i].$2, style: const TextStyle(color: CheStudioColors.dim, fontSize: 13)),
                      trailing: const Icon(Icons.chevron_right_rounded, color: CheStudioColors.silver),
                      onTap: () {
                        Navigator.of(sheet).pop();
                        _tap(items[i].$4!);
                      },
                    ),
                  ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _showAllProjects(List<Map<String, dynamic>> sorted) async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: CheStudioColors.card,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) => SizedBox(
        height: MediaQuery.sizeOf(sheet).height * 0.8,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
          children: [
            Semantics(
              header: true,
              child: Text(
                'All projects (${sorted.length})',
                style: const TextStyle(color: CheStudioColors.text, fontSize: 20, fontWeight: FontWeight.w800),
              ),
            ),
            const SizedBox(height: 8),
            for (final p in sorted)
              _ProjectRow(
                project: p,
                onTap: () {
                  Navigator.of(sheet).pop();
                  widget.actions.onOpenProject(p);
                },
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.actions;
    final sorted = cheProjectsNewestFirst(widget.projects);
    return ColoredBox(
      color: CheStudioColors.bg,
      // One built column (not a lazy list), so a voice route can scroll straight to any studio.
      child: SingleChildScrollView(
        key: const ValueKey('creative-studio-scroll'),
        physics: const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics()),
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // ── Header ─────────────────────────────────────────────────────────────
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Semantics(
                        header: true,
                        child: const Text(
                          'CREATIVE STUDIO',
                          style: TextStyle(
                            color: CheStudioColors.text,
                            fontSize: 26,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 2.4,
                          ),
                        ),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: const BoxDecoration(color: CheStudioColors.teal, shape: BoxShape.circle),
                          ),
                          const SizedBox(width: 8),
                          const Flexible(
                            child: Text(
                              'Managed by Vale',
                              style: TextStyle(
                                color: CheStudioColors.silver,
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                Semantics(
                  button: true,
                  label: 'Read the Creative Studio aloud',
                  excludeSemantics: true,
                  child: IconButton(
                    key: const ValueKey('studio-read'),
                    constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                    onPressed: widget.onRead == null ? null : () => widget.onRead!(spokenSummary),
                    icon: const Icon(Icons.volume_up_rounded, color: CheStudioColors.silver),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),
            // ── Create New ─────────────────────────────────────────────────────────
            Semantics(
              button: true,
              label: 'Create new. Choose a video, film, song, app, image, character, project or invention.',
              excludeSemantics: true,
              child: FilledButton.icon(
                key: const ValueKey('studio-create-new'),
                style: FilledButton.styleFrom(
                  backgroundColor: CheStudioColors.teal,
                  foregroundColor: Colors.black,
                  minimumSize: const Size.fromHeight(60),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                  textStyle: Theme.of(context).textTheme.labelLarge
                      ?.copyWith(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: .4),
                ),
                onPressed: showCreateNew,
                icon: const Icon(Icons.add_rounded, size: 26),
                label: const Text('Create New'),
              ),
            ),
            const SizedBox(height: 22),
            // ── Working now (real states only) ─────────────────────────────────────
            const _SectionLabel('WORKING NOW'),
            const SizedBox(height: 8),
            _ActivityPanel(activity: widget.activity),
            const SizedBox(height: 26),
            // ── Studios ────────────────────────────────────────────────────────────
            _StudioCard(
              key: _keys[CheStudioSection.film],
              id: 'film',
              icon: Icons.movie_creation_outlined,
              title: 'Film Studio',
              tagline: 'Videos, movies, scripts, storyboards and scenes. Render, edit, preview and play back.',
              tags: const ['Videos', 'Movies', 'Scripts', 'Storyboards', 'Scenes', 'Editing'],
              status: widget.videoConnected ? 'Video generation ready' : 'Video generator not connected',
              ready: widget.videoConnected,
              primary: ('Open Film Studio', a.onOpenFilmStudio),
              secondary: [
                ('New video', Icons.videocam_rounded, a.onNewVideo),
                ('Theater', Icons.theaters_outlined, a.onOpenTheater),
              ],
            ),
            _StudioCard(
              key: _keys[CheStudioSection.music],
              id: 'music',
              icon: Icons.graphic_eq_rounded,
              title: 'Music Studio',
              tagline: 'Songs, beats, vocals, sound effects and audio production.',
              tags: const ['Songs', 'Beats', 'Vocals', 'Sound effects'],
              primary: ('Open Music Studio', a.onOpenMusic),
              secondary: [('New song or beat', Icons.music_note_rounded, a.onNewSong)],
            ),
            _StudioCard(
              key: _keys[CheStudioSection.code],
              id: 'code',
              icon: Icons.code_rounded,
              title: 'Code Studio',
              tagline: 'Apps, websites, games and software, built as coding jobs you can follow.',
              tags: const ['Apps', 'Websites', 'Games', 'Software', 'Coding jobs'],
              primary: ('New app, site or game', a.onNewApp),
              secondary: [
                ('Coding jobs', Icons.workspaces_outline, a.onOpenOffice),
                ('Commands', Icons.apps_rounded, a.onOpenCommandCenter),
              ],
            ),
            _StudioCard(
              key: _keys[CheStudioSection.art],
              id: 'art',
              icon: Icons.palette_outlined,
              title: 'Art & Character Studio',
              tagline: 'Images, avatars, 3D characters, outfits and animation. Blender renders on your Colab GPU.',
              tags: const ['Images', 'Avatars', '3D characters', 'Outfits', 'Animation', 'Blender'],
              status: widget.imageConnected ? 'Image generation ready' : 'Image generator not connected',
              ready: widget.imageConnected,
              primary: ('Character Generator', a.onCharacterGenerator),
              secondary: [
                ('Art Studio', Icons.photo_library_outlined, a.onOpenArtStudio),
                ('New image', Icons.image_rounded, a.onNewImage),
              ],
              child: widget.gpuJobs == null
                  ? null
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const SizedBox(height: 14),
                        const _SectionLabel('GPU JOBS · PAIR COLAB'),
                        const SizedBox(height: 8),
                        KeyedSubtree(key: const ValueKey('studio-gpu-jobs'), child: widget.gpuJobs!),
                      ],
                    ),
            ),
            // ── Projects ───────────────────────────────────────────────────────────
            const SizedBox(height: 8),
            Row(
              key: _keys[CheStudioSection.projects],
              children: [
                const Expanded(child: _SectionLabel('PROJECTS')),
                if (sorted.length > 4)
                  Semantics(
                    button: true,
                    label: 'See all ${sorted.length} projects',
                    excludeSemantics: true,
                    child: TextButton(
                      key: const ValueKey('studio-see-all'),
                      onPressed: () => _showAllProjects(sorted),
                      child: Text(
                        'See all (${sorted.length})',
                        style: const TextStyle(color: CheStudioColors.teal, fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Material(
              color: CheStudioColors.card,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(20),
                side: const BorderSide(color: CheStudioColors.stroke),
              ),
              clipBehavior: Clip.antiAlias,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                child: Column(
                  children: [
                    if (sorted.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(16),
                        child: Text(
                          'No projects yet. Use Create New to start one.',
                          style: TextStyle(color: CheStudioColors.dim, fontSize: 14),
                        ),
                      )
                    else
                      for (final p in sorted.take(4)) _ProjectRow(project: p, onTap: () => a.onOpenProject(p)),
                    const Divider(color: CheStudioColors.stroke, height: 12),
                    _LinkRow(
                      icon: Icons.inventory_2_outlined,
                      title: 'Saved files',
                      subtitle: '${widget.vaultCount} in CHE’s Data Vault',
                      onTap: a.onVault,
                    ),
                    if (a.onInventions != null)
                      _LinkRow(
                        icon: Icons.rocket_launch_outlined,
                        title: 'Invention Studio',
                        subtitle: 'Concepts, parts, costs, feasibility and stages',
                        onTap: a.onInventions!,
                      ),
                    if (a.onShowroom != null)
                      _LinkRow(
                        icon: Icons.auto_awesome_rounded,
                        title: 'Capability Showroom',
                        subtitle: 'What CHE can make, with each feature’s real status',
                        onTap: a.onShowroom!,
                      ),
                    _LinkRow(
                      icon: Icons.public,
                      title: 'Novelty and feasibility research',
                      subtitle: 'Research the project you are working on',
                      onTap: a.onResearch,
                    ),
                  ],
                ),
              ),
            ),
            if (widget.creations != null) ...[
              const SizedBox(height: 22),
              const _SectionLabel('COMPLETED CREATIONS'),
              const SizedBox(height: 8),
              widget.creations!,
            ],
          ],
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(
      text,
      style: const TextStyle(color: CheStudioColors.dim, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 2.2),
    ),
  );
}

class _IconDisk extends StatelessWidget {
  const _IconDisk({required this.icon, this.size = 64});
  final IconData icon;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      gradient: const RadialGradient(colors: [CheStudioColors.tealDeep, CheStudioColors.cardHi], radius: .9),
      border: Border.all(color: CheStudioColors.teal.withValues(alpha: .55), width: 1.2),
      boxShadow: [BoxShadow(color: CheStudioColors.teal.withValues(alpha: .22), blurRadius: 18)],
    ),
    child: Icon(icon, color: CheStudioColors.text, size: size * .48),
  );
}

class _ActivityPanel extends StatelessWidget {
  const _ActivityPanel({required this.activity});
  final List<CheStudioActivity> activity;
  @override
  Widget build(BuildContext context) {
    return Material(
      key: const ValueKey('studio-activity'),
      color: CheStudioColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: const BorderSide(color: CheStudioColors.stroke),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: activity.isEmpty
            ? Semantics(
                label: 'No active jobs right now.',
                excludeSemantics: true,
                child: const Padding(
                  padding: EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    children: [
                      Icon(Icons.check_circle_outline, color: CheStudioColors.dim, size: 20),
                      SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'No active jobs right now.',
                          style: TextStyle(color: CheStudioColors.dim, fontSize: 14.5),
                        ),
                      ),
                    ],
                  ),
                ),
              )
            : Column(
                children: [
                  for (final w in activity)
                    Semantics(
                      button: w.onTap != null,
                      label: '${w.title}. ${w.status}.${w.detail.isEmpty ? '' : ' ${w.detail}'}',
                      excludeSemantics: true,
                      child: InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: w.onTap,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          child: Row(
                            children: [
                              Container(
                                width: 10,
                                height: 10,
                                decoration: const BoxDecoration(color: CheStudioColors.teal, shape: BoxShape.circle),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      w.title,
                                      style: const TextStyle(
                                        color: CheStudioColors.text,
                                        fontSize: 15,
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                    if (w.detail.isNotEmpty)
                                      Text(
                                        w.detail,
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(color: CheStudioColors.dim, fontSize: 12.5),
                                      ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 8),
                              Text(
                                w.status,
                                style: const TextStyle(
                                  color: CheStudioColors.teal,
                                  fontSize: 13,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
      ),
    );
  }
}

class _StudioCard extends StatelessWidget {
  const _StudioCard({
    super.key,
    required this.id,
    required this.icon,
    required this.title,
    required this.tagline,
    required this.tags,
    required this.primary,
    this.secondary = const [],
    this.status,
    this.ready = false,
    this.child,
  });

  final String id;
  final IconData icon;
  final String title;
  final String tagline;
  final List<String> tags;
  final (String, VoidCallback) primary;
  final List<(String, IconData, VoidCallback)> secondary;
  final String? status;
  final bool ready;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Container(
        key: ValueKey('studio-$id'),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: CheStudioColors.stroke),
          gradient: const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [CheStudioColors.cardHi, CheStudioColors.card, Color(0xFF07090B)],
          ),
        ),
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _IconDisk(icon: icon),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Semantics(
                        header: true,
                        child: Text(
                          title,
                          style: const TextStyle(
                            color: CheStudioColors.text,
                            fontSize: 21,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      if (status != null) ...[
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: ready ? CheStudioColors.teal : CheStudioColors.dim,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(status!, style: const TextStyle(color: CheStudioColors.dim, fontSize: 12.5)),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(tagline, style: const TextStyle(color: CheStudioColors.silver, fontSize: 14.5, height: 1.4)),
            const SizedBox(height: 12),
            ExcludeSemantics(
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final t in tags)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(color: CheStudioColors.stroke),
                        color: const Color(0x0DFFFFFF),
                      ),
                      child: Text(
                        t,
                        style: const TextStyle(
                          color: CheStudioColors.silver,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              button: true,
              label: '$title: ${primary.$1}',
              excludeSemantics: true,
              child: FilledButton(
                key: ValueKey('studio-$id-primary'),
                style: FilledButton.styleFrom(
                  backgroundColor: CheStudioColors.text,
                  foregroundColor: Colors.black,
                  minimumSize: const Size.fromHeight(52),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  textStyle: Theme.of(context).textTheme.labelLarge
                      ?.copyWith(fontSize: 16, fontWeight: FontWeight.w800),
                ),
                onPressed: () {
                  HapticFeedback.selectionClick();
                  primary.$2();
                },
                child: Text(primary.$1),
              ),
            ),
            if (secondary.isNotEmpty) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  for (var i = 0; i < secondary.length; i++) ...[
                    if (i > 0) const SizedBox(width: 10),
                    Expanded(
                      child: Semantics(
                        button: true,
                        label: '$title: ${secondary[i].$1}',
                        excludeSemantics: true,
                        child: OutlinedButton.icon(
                          key: ValueKey('studio-$id-${secondary[i].$1}'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: CheStudioColors.text,
                            side: const BorderSide(color: CheStudioColors.stroke),
                            minimumSize: const Size.fromHeight(48),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                            textStyle: Theme.of(context).textTheme.labelLarge
                                ?.copyWith(fontSize: 13.5, fontWeight: FontWeight.w700),
                          ),
                          onPressed: () {
                            HapticFeedback.selectionClick();
                            secondary[i].$3();
                          },
                          icon: Icon(secondary[i].$2, size: 18, color: CheStudioColors.teal),
                          label: Text(secondary[i].$1, maxLines: 1, overflow: TextOverflow.ellipsis),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ],
            ?child,
          ],
        ),
      ),
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.project, required this.onTap});
  final Map<String, dynamic> project;
  final VoidCallback onTap;

  static String _date(Map<String, dynamic> p) {
    final d = DateTime.tryParse('${p['updated_at'] ?? p['created_at'] ?? ''}');
    if (d == null) return '';
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${m[d.month - 1]} ${d.day}';
  }

  @override
  Widget build(BuildContext context) {
    final title = '${project['title'] ?? 'Untitled project'}';
    final status = '${project['status'] ?? ''}'.trim();
    final type = '${project['type'] ?? ''}'.trim();
    final date = _date(project);
    final meta = [if (type.isNotEmpty) type, if (date.isNotEmpty) date].join(' · ');
    return Semantics(
      button: true,
      label: 'Open project $title.${status.isEmpty ? '' : ' Status $status.'}${date.isEmpty ? '' : ' Updated $date.'}',
      excludeSemantics: true,
      child: ListTile(
        key: ValueKey('studio-project-${project['id']}'),
        contentPadding: const EdgeInsets.symmetric(horizontal: 8),
        leading: const Icon(Icons.folder_outlined, color: CheStudioColors.silver),
        title: Text(
          title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: CheStudioColors.text, fontSize: 15, fontWeight: FontWeight.w700),
        ),
        subtitle: meta.isEmpty ? null : Text(meta, style: const TextStyle(color: CheStudioColors.dim, fontSize: 12.5)),
        trailing: status.isEmpty
            ? const Icon(Icons.chevron_right_rounded, color: CheStudioColors.dim)
            : Text(
                status,
                style: const TextStyle(color: CheStudioColors.teal, fontSize: 12.5, fontWeight: FontWeight.w700),
              ),
        onTap: onTap,
      ),
    );
  }
}

class _LinkRow extends StatelessWidget {
  const _LinkRow({required this.icon, required this.title, required this.subtitle, required this.onTap});
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: '$title. $subtitle',
    excludeSemantics: true,
    child: ListTile(
      key: ValueKey('studio-link-$title'),
      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
      leading: Icon(icon, color: CheStudioColors.teal),
      title: Text(
        title,
        style: const TextStyle(color: CheStudioColors.text, fontSize: 15, fontWeight: FontWeight.w600),
      ),
      subtitle: Text(subtitle, style: const TextStyle(color: CheStudioColors.dim, fontSize: 12.5)),
      trailing: const Icon(Icons.chevron_right_rounded, color: CheStudioColors.dim),
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
    ),
  );
}
