// Create → Creative Studio, managed by Vale (owner, 2026-10-24). One vertically scrolling screen in place of the old
// gallery scene (a 3D room of purple stand-in figures over a wall of project frames) and its Projects | Art Studio |
// GPU Jobs segments. Everything the owner can make is here, each piece linking to the tool that already does it:
// Create New, the studios (Film, Music, Code, Art & Character) and Projects. Nothing is spoken when it opens; Read
// aloud reads it on request. Activity rows show only real backend states (the coding job the Worker reports); with
// none, it says so.
//
// Live 3D Studio (owner, 2026-10-24): the room now opens on six choices: Create Person, Create Object, Create Room,
// Create Animation, My Creations and Active Projects, with the Creation Engine's real state (online, offline with a
// Connect button, or not connected) above them. GPU jobs, Pair Colab and the worker token moved to Settings, Creation
// Engine. Object and room creation are not built yet and say so; animation previews the crew models' own clips.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_live_studio.dart' show CheCreationEngine;

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

/// Spoken Creation Engine settings: "start cloud workers automatically", "stop starting cloud workers",
/// "allow 4 cloud workers", "set cloud workers to 2". Null for anything else.
Map<String, Object>? cheEngineSettingFromWords(String words) {
  final t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
  if (RegExp(
    r'^(?:turn on|start|enable) (?:the )?(?:automatic |free )?cloud workers(?: automatically)?$|^start (?:free )?cloud workers automatically$',
  ).hasMatch(t)) {
    return {'auto_cloud': true};
  }
  if (RegExp(
    r'^(?:turn off|stop|disable) (?:the )?(?:automatic |free )?cloud workers$|^stop starting (?:free )?cloud workers(?: automatically)?$',
  ).hasMatch(t)) {
    return {'auto_cloud': false};
  }
  final n = RegExp(
    r'^(?:set|allow|use) (?:the )?(?:max(?:imum)? )?(?:number of )?(?:cloud workers (?:to )?(\d{1,2})|(\d{1,2}) cloud workers(?: at once)?)$',
  ).firstMatch(t);
  if (n != null) return {'max_cloud_workers': int.parse(n.group(1) ?? n.group(2)!)};
  return null;
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
    this.loadPeople,
    this.onCreatePerson,
    this.onCreateAnimation,
    this.onOpenCreation,
    this.onConnectEngine,
    this.onContinueCreating,
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

  /// Live 3D Studio. The characters a person can start from (id, name, role), from the Worker's identity presets.
  final Future<List<(String, String, String)>> Function()? loadPeople;

  /// Makes a creation project from one base character and opens it in the Live Studio.
  final void Function(String base)? onCreatePerson;
  final VoidCallback? onCreateAnimation;
  final void Function(String id)? onOpenCreation;

  /// Connect: never a website. The Cloud Computer starts its own workers; when none can run, this opens Settings,
  /// Connections, Cloud Computer (the only place with Colab setup).
  final void Function(CheCreationEngine engine)? onConnectEngine;

  /// "Continue creating": reopens the newest creation in its live 3D view and returns what CHE says.
  final Future<String> Function()? onContinueCreating;
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
    this.loadCreations,
    this.saveEngineSettings,
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

  /// GET /api/creations (creation_studio.js): the owner's creation projects, the Creation Engine's state and which kinds
  /// of creation are built. Null keeps the six choices with no engine bar (tests, or no Worker).
  final Future<Map<String, dynamic>?> Function()? loadCreations;

  /// Saves Creation Engine settings ({auto_cloud} or {max_cloud_workers}) and returns CHE's spoken result.
  final Future<String> Function(Map<String, Object> change)? saveEngineSettings;

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
  'ten': 10,
  'tenth': 10,
  'eleven': 11,
  'eleventh': 11,
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

  /// The sheet while one is open (Create New, Create Person, My Creations, Active Projects): its title and items in
  /// announced order, and its context, so a spoken number can choose from it.
  List<(String, String, IconData, VoidCallback?)>? _sheetItems;
  String _sheetTitle = '';
  BuildContext? _sheetContext;

  /// GET /api/creations: creation projects, the Creation Engine and which kinds of creation are built.
  Map<String, dynamic> _creations = const {};

  @override
  void dispose() {
    if (CheCreativeStudio.voiceHandler == voice) CheCreativeStudio.voiceHandler = null;
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant CheCreativeStudio oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) unawaited(loadCreations());
  }

  Future<void> loadCreations() async {
    final load = widget.loadCreations;
    if (load == null) return;
    final d = await load().catchError((_) => null);
    if (!mounted || d == null) return;
    setState(() => _creations = d);
  }

  CheCreationEngine get engine => CheCreationEngine.fromJson(_creations['engine']);

  List<Map<String, dynamic>> get creationProjects => [
    for (final p in (_creations['projects'] as List? ?? const []))
      if (p is Map) Map<String, dynamic>.from(p),
  ];

  /// One kind's real status from the Worker (available | partial | unavailable), with the built-in fallback when the
  /// Worker has not answered: only Create Person is built end to end.
  (String, String) capability(String id) {
    for (final c in (_creations['capabilities'] as List? ?? const [])) {
      if (c is Map && c['id'] == id) return ('${c['status'] ?? ''}', '${c['detail'] ?? ''}');
    }
    return switch (id) {
      'person' => (
        'available',
        'Start from CHE or an agent, edit by voice, and build a 3D model on your Creation Engine.',
      ),
      'animation' => ('partial', 'Preview the crew models’ built-in clips. Making new animations is not built yet.'),
      'object' => ('unavailable', 'Creating 3D objects is not built yet.'),
      _ => ('unavailable', 'Creating 3D rooms is not built yet.'),
    };
  }

  String _sheetSummary(List<(String, String, IconData, VoidCallback?)> items) =>
      '$_sheetTitle. Say or choose: '
      '${[for (var i = 0; i < items.length; i++)
        if (items[i].$4 != null) '${i + 1} ${items[i].$1}'].join(', ')}.';

  /// The room's numbered choices, in the order Read aloud announces them.
  List<(String, VoidCallback)> get _choices => [
    ('Create Person', () => unawaited(showCreatePerson())),
    ('Create Object', () => _notBuilt('object', 'Create Object')),
    ('Create Room', () => _notBuilt('room', 'Create Room')),
    ('Create Animation', () => widget.actions.onCreateAnimation?.call()),
    ('My Creations', () => unawaited(showMyCreations())),
    ('Active Projects', () => unawaited(showActiveProjects())),
    ('More to create', () => unawaited(showCreateNew())),
    ('Film Studio', () => scrollTo(CheStudioSection.film)),
    ('Music Studio', () => scrollTo(CheStudioSection.music)),
    ('Code Studio', () => scrollTo(CheStudioSection.code)),
    ('Art and Character Studio', () => scrollTo(CheStudioSection.art)),
  ];

  String _notBuilt(String id, String title) {
    final (_, detail) = capability(id);
    final text = '$title is not available yet. $detail';
    HapticFeedback.heavyImpact();
    if (mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(text, style: const TextStyle(fontSize: 16)),
          duration: const Duration(seconds: 6),
        ),
      );
    }
    return text;
  }

  /// Voice and typed control. Numbers resolve against what is on screen: an open sheet, otherwise the room's numbered
  /// choices. Actions can also be named ("create person", "new video", "character generator").
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
      return 'Closed $_sheetTitle.';
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
      final c = _choices;
      if (n < 1 || n > c.length) return 'There is no choice $n. $spokenSummary';
      return _runChoice(n - 1);
    }
    final setting = cheEngineSettingFromWords(t);
    if (setting != null) {
      final save = widget.saveEngineSettings;
      if (save == null) return 'I cannot change the Cloud Computer settings from here. Say open the cloud computer.';
      final said = await save(setting);
      unawaited(loadCreations());
      return said;
    }
    if (RegExp(
      r"^(?:what(?:'s| is) (?:the )?)?creation engine status$|^(?:is|how is) (?:the )?creation engine(?: doing| working| running| ready)?$",
    ).hasMatch(t)) {
      if (engine.status == 'unknown') {
        return 'I have not loaded the Cloud Computer yet. Say open the cloud computer for its settings.';
      }
      return '${engine.label}. ${engine.detail}';
    }
    // "Connect": the Cloud Computer starts its workers itself, so this never opens a website (owner, 2026-10-24).
    if (RegExp(
      r'^(?:open |go to )?(?:the )?(?:creation engine|cloud computer)(?: settings)?$|^connect(?: (?:the|my))?(?: (?:creation engine|cloud computer|gpu|engine))?$',
    ).hasMatch(t)) {
      a.onConnectEngine?.call(engine);
      return engine.online
          ? 'Connected. Your Creation Engine is online on ${engine.gpu ?? 'your GPU'}.'
          : engine.automatic
          ? 'Connected. Your Cloud Computer is ready: ${engine.detail}'
          : '${engine.label}. ${engine.detail} Opening Settings, Connections, Cloud Computer.';
    }
    // "Continue creating": back into the newest creation, in its live 3D view; the job kept running on the Worker.
    if (RegExp(r'^(?:continue|resume|keep) (?:creating|building|my creation|the creation|my person|making it)$|^continue where (?:i|we) left off$|^back to (?:my )?creation$')
        .hasMatch(t)) {
      final go = a.onContinueCreating;
      if (go == null) return 'Continue creating is not connected in this build.';
      if (sheet != null && _sheetContext != null) Navigator.of(_sheetContext!).pop();
      return go();
    }
    final main = <RegExp, int>{
      RegExp(r'^(?:create|make|new)(?: a)? (?:person|character|human|avatar)$'): 0,
      RegExp(r'^(?:create|make|new)(?: an?)? (?:object|prop|3d object)$'): 1,
      RegExp(r'^(?:create|make|new)(?: an?)? (?:room|environment|scene|space)$'): 2,
      RegExp(r'^(?:create|make|new)(?: an?)? animation$'): 3,
      RegExp(r'^(?:open |show )?(?:my )?creations$'): 4,
      RegExp(r'^(?:open |show )?(?:my )?active projects$'): 5,
    };
    for (final e in main.entries) {
      if (e.key.hasMatch(t)) {
        if (sheet != null && _sheetContext != null) Navigator.of(_sheetContext!).pop();
        return _runChoice(e.value);
      }
    }
    final named = <RegExp, (String, VoidCallback?)>{
      RegExp(r'^create new|^more to create$|^new (?:creation|thing)$'): (
        'Create New',
        () => unawaited(showCreateNew()),
      ),
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

  /// Runs choice [i] (0-based) and says what really happened.
  String _runChoice(int i) {
    final a = widget.actions;
    switch (i) {
      case 0:
        if (a.loadPeople == null || a.onCreatePerson == null) return 'Create Person is not connected in this build.';
        unawaited(showCreatePerson());
        return 'Create Person. Choose who to start from: say a number.';
      case 1:
        return _notBuilt('object', 'Create Object');
      case 2:
        return _notBuilt('room', 'Create Room');
      case 3:
        if (a.onCreateAnimation == null) return 'Create Animation is not connected in this build.';
        _tap(a.onCreateAnimation!);
        return 'Opening the animation preview. ${capability('animation').$2}';
      case 4:
        unawaited(showMyCreations());
        final n = creationProjects.length;
        return n == 0
            ? 'You have no 3D creations yet. Say create person.'
            : 'My Creations: $n. Say a number to open one.';
      case 5:
        unawaited(showActiveProjects());
        return 'Active Projects. Say a number to open one.';
      case 6:
        unawaited(showCreateNew());
        return _sheetSummaryFor('Create new', _createNewItems());
      case 7:
        scrollTo(CheStudioSection.film);
        return 'Film Studio. Say: open Film Studio, new video, or Theater.';
      case 8:
        scrollTo(CheStudioSection.music);
        return 'Music Studio. Say: open Music Studio, or new song.';
      case 9:
        scrollTo(CheStudioSection.code);
        return 'Code Studio. Say: new app, coding jobs, or commands.';
      default:
        scrollTo(CheStudioSection.art);
        return 'Art and Character Studio. Say: character generator, art studio, or new image. GPU jobs and Pair Colab are in Settings, Connections, Cloud Computer.';
    }
  }

  String _sheetSummaryFor(String title, List<(String, String, IconData, VoidCallback?)> items) {
    final old = _sheetTitle;
    _sheetTitle = title;
    final s = _sheetSummary(items);
    _sheetTitle = old.isEmpty ? title : old;
    return s;
  }

  @override
  void initState() {
    super.initState();
    CheCreativeStudio.voiceHandler = voice;
    if (widget.active) unawaited(loadCreations());
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

  /// What Read aloud says: the engine, the numbered choices and the real work in progress.
  String get spokenSummary {
    final n = widget.projects.length;
    final work = widget.activity.isEmpty
        ? 'No active jobs.'
        : 'Working now: ${widget.activity.map((a) => '${a.title}, ${a.status}').join('; ')}.';
    final eng = widget.loadCreations == null || engine.status == 'unknown' ? '' : '${engine.label}. ';
    final c = _choices;
    return 'Creation Room, managed by Vale. $eng'
        'Say or choose: ${[for (var i = 0; i < c.length; i++) '${i + 1} ${c[i].$1}'].join(', ')}. '
        'Create Object and Create Room are not built yet. $work '
        'You have ${creationProjects.length} 3D creation${creationProjects.length == 1 ? '' : 's'}, '
        '$n project${n == 1 ? '' : 's'} and ${widget.vaultCount} saved file${widget.vaultCount == 1 ? '' : 's'}.';
  }

  void _tap(VoidCallback f) {
    HapticFeedback.selectionClick();
    f();
  }

  Future<void> showCreateNew() => _showSheet('Create new', 'Choose what to make.', _createNewItems());

  /// Create Person: choose CHE or an agent to start from; the project opens in the Live Studio.
  Future<void> showCreatePerson() async {
    final a = widget.actions;
    if (a.loadPeople == null || a.onCreatePerson == null) return;
    HapticFeedback.selectionClick();
    final people = await a.loadPeople!().catchError((_) => <(String, String, String)>[]);
    if (!mounted) return;
    if (people.isEmpty) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(const SnackBar(content: Text('Could not load the characters from CHE. Try again.')));
      return;
    }
    await _showSheet('Create a person', 'Start from CHE or one of the crew. You can change everything after.', [
      for (final p in people) (p.$2, p.$3, Icons.person_outline_rounded, () => a.onCreatePerson!(p.$1)),
    ]);
  }

  Future<void> showMyCreations() async {
    await loadCreations();
    if (!mounted) return;
    final open = widget.actions.onOpenCreation;
    final list = creationProjects;
    await _showSheet(
      'My Creations',
      list.isEmpty ? 'No 3D creations yet. Use Create Person to start one.' : 'Your 3D creations, newest first.',
      [
        for (final p in list)
          (
            _creationTitle(p),
            _creationLine(p),
            Icons.view_in_ar_rounded,
            open == null ? null : () => open('${p['id']}'),
          ),
      ],
    );
  }

  /// Active Projects: 3D creations with a Creation Engine job waiting or running, then your saved projects.
  Future<void> showActiveProjects() async {
    await loadCreations();
    if (!mounted) return;
    final open = widget.actions.onOpenCreation;
    final busy = [
      for (final p in creationProjects)
        if (p['job'] is Map && const {'queued', 'rendering', 'paused'}.contains((p['job'] as Map)['state'])) p,
    ];
    final projects = cheProjectsNewestFirst(widget.projects).take(8);
    await _showSheet(
      'Active Projects',
      busy.isEmpty && projects.isEmpty ? 'Nothing active right now.' : 'Work in progress first.',
      [
        for (final p in busy)
          (
            _creationTitle(p),
            _creationLine(p),
            Icons.view_in_ar_rounded,
            open == null ? null : () => open('${p['id']}'),
          ),
        for (final p in projects)
          (
            '${p['title'] ?? 'Untitled project'}',
            'Project${'${p['status'] ?? ''}'.isEmpty ? '' : ' · ${p['status']}'}',
            Icons.folder_outlined,
            () => widget.actions.onOpenProject(p),
          ),
      ],
    );
  }

  static String _creationTitle(Map<String, dynamic> p) => '${p['title'] ?? 'Creation'}';

  static String _creationLine(Map<String, dynamic> p) {
    final j = p['job'] is Map ? p['job'] as Map : null;
    final state = j == null ? 'not generated yet' : '${j['state']}';
    return 'Version ${p['version'] ?? 1} · ${p['model_url'] != null ? '3D model ready' : state}';
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
        'Edit CHE or an agent in the Character Generator',
        Icons.face_retouching_natural,
        a.onCharacterGenerator,
      ),
      ('Project', 'A saved project to work on over time', Icons.folder_special_rounded, a.onNewProject),
      ('Invention', 'Concept, parts, costs and stages', Icons.rocket_launch_outlined, a.onInventions),
    ];
  }

  Future<void> _showSheet(String title, String subtitle, List<(String, String, IconData, VoidCallback?)> items) async {
    HapticFeedback.selectionClick();
    _sheetItems = items;
    _sheetTitle = title;
    try {
      await _showChoiceSheet(title, subtitle, items);
    } finally {
      _sheetItems = null;
      _sheetContext = null;
    }
  }

  Future<void> _showChoiceSheet(
    String title,
    String subtitle,
    List<(String, String, IconData, VoidCallback?)> items,
  ) async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: CheStudioColors.card,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) {
        _sheetContext = sheet;
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(sheet).height * 0.85),
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    title,
                    style: const TextStyle(color: CheStudioColors.text, fontSize: 22, fontWeight: FontWeight.w800),
                  ),
                ),
                const SizedBox(height: 4),
                Text(subtitle, style: const TextStyle(color: CheStudioColors.dim, fontSize: 14)),
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
                          'CREATION ROOM',
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
                  label: 'Read the Creation Room aloud',
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
            const SizedBox(height: 16),
            // ── Creation Engine state (real, from the Worker) ──────────────────────
            if (widget.loadCreations != null && engine.status != 'unknown') ...[
              _EngineRow(
                engine: engine,
                onConnect: a.onConnectEngine == null ? null : () => a.onConnectEngine!(engine),
              ),
              const SizedBox(height: 14),
            ],
            // ── The six main choices ───────────────────────────────────────────────
            LayoutBuilder(
              builder: (context, box) {
                final w = (box.maxWidth - 12) / 2;
                final (pStatus, _) = capability('person');
                final (oStatus, _) = capability('object');
                final (rStatus, _) = capability('room');
                final (aStatus, _) = capability('animation');
                final nCreations = creationProjects.length;
                final nActive = creationProjects
                    .where(
                      (p) =>
                          p['job'] is Map &&
                          const {'queued', 'rendering', 'paused'}.contains((p['job'] as Map)['state']),
                    )
                    .length;
                String word(String s) => switch (s) {
                  'available' => 'Ready',
                  'partial' => 'Preview only',
                  _ => 'Not available yet',
                };
                final tiles = [
                  ('person', 'Create Person', Icons.person_add_alt_1_rounded, word(pStatus), pStatus != 'unavailable'),
                  ('object', 'Create Object', Icons.widgets_rounded, word(oStatus), oStatus != 'unavailable'),
                  ('room', 'Create Room', Icons.meeting_room_rounded, word(rStatus), rStatus != 'unavailable'),
                  (
                    'animation',
                    'Create Animation',
                    Icons.directions_walk_rounded,
                    word(aStatus),
                    aStatus != 'unavailable',
                  ),
                  (
                    'mine',
                    'My Creations',
                    Icons.view_in_ar_rounded,
                    '$nCreations 3D creation${nCreations == 1 ? '' : 's'}',
                    true,
                  ),
                  (
                    'active',
                    'Active Projects',
                    Icons.hourglass_top,
                    nActive == 0
                        ? '${widget.projects.length} project${widget.projects.length == 1 ? '' : 's'}'
                        : '$nActive building now',
                    true,
                  ),
                ];
                return Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    for (var i = 0; i < tiles.length; i++)
                      SizedBox(
                        width: w,
                        child: _MainTile(
                          id: tiles[i].$1,
                          number: i + 1,
                          title: tiles[i].$2,
                          icon: tiles[i].$3,
                          status: tiles[i].$4,
                          live: tiles[i].$5,
                          onTap: () => _runChoice(i),
                        ),
                      ),
                  ],
                );
              },
            ),
            const SizedBox(height: 16),
            // ── Create New ─────────────────────────────────────────────────────────
            Semantics(
              button: true,
              label: 'More to create. Choose a video, film, song, app, image, character, project or invention.',
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
                label: const Text('More to create'),
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
              tagline:
                  'Images, avatars, 3D characters, outfits and animation. Blender renders on your Creation Engine.',
              tags: const ['Images', 'Avatars', '3D characters', 'Outfits', 'Animation', 'Blender'],
              status: widget.imageConnected ? 'Image generation ready' : 'Image generator not connected',
              ready: widget.imageConnected,
              primary: ('Character Generator', a.onCharacterGenerator),
              secondary: [
                ('Art Studio', Icons.photo_library_outlined, a.onOpenArtStudio),
                ('New image', Icons.image_rounded, a.onNewImage),
              ],
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

/// One of the room's six main choices: a large square with its real status.
class _MainTile extends StatelessWidget {
  const _MainTile({
    required this.id,
    required this.number,
    required this.title,
    required this.icon,
    required this.status,
    required this.live,
    required this.onTap,
  });
  final String id;
  final int number;
  final String title;
  final IconData icon;
  final String status;
  final bool live;
  final VoidCallback onTap;

  /// Picture-first tiles: CHE's own Blender renders (tools/avatar_body/thumbs.py), not stock art. A choice that is not
  /// built yet shows its picture dimmed, and its status says so.
  static const _pictures = {
    'person': 'assets/characters/app/thumb_person.jpg',
    'object': 'assets/characters/app/thumb_object.jpg',
    'room': 'assets/characters/app/thumb_room.jpg',
    'animation': 'assets/characters/app/thumb_animation.jpg',
  };

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: '$number. $title. $status.',
    excludeSemantics: true,
    child: Material(
      color: live ? CheStudioColors.cardHi : CheStudioColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: live ? CheStudioColors.teal.withValues(alpha: .35) : CheStudioColors.stroke),
      ),
      child: InkWell(
        key: ValueKey('studio-tile-$id'),
        borderRadius: BorderRadius.circular(20),
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 128),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_pictures[id] != null)
                ClipRRect(
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
                  child: AspectRatio(
                    aspectRatio: 4 / 3,
                    child: Opacity(
                      opacity: live ? 1 : 0.45,
                      child: Image.asset(
                        _pictures[id]!,
                        key: ValueKey('studio-tile-picture-$id'),
                        fit: BoxFit.cover,
                        alignment: const Alignment(0, -0.55),
                        errorBuilder: (_, _, _) => const SizedBox.shrink(),
                      ),
                    ),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_pictures[id] == null) ...[
                      Icon(icon, size: 30, color: live ? CheStudioColors.teal : CheStudioColors.dim),
                      const SizedBox(height: 12),
                    ],
                    Text(
                      title,
                      style: TextStyle(
                        color: live ? CheStudioColors.text : CheStudioColors.silver,
                        fontSize: 16.5,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(status, style: const TextStyle(color: CheStudioColors.dim, fontSize: 13, height: 1.3)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// The Creation Engine's real state, with Connect when it is not running.
class _EngineRow extends StatelessWidget {
  const _EngineRow({required this.engine, this.onConnect});
  final CheCreationEngine engine;
  final VoidCallback? onConnect;

  @override
  Widget build(BuildContext context) {
    final on = engine.ready;
    return Semantics(
      container: true,
      label: '${engine.label}. ${engine.detail}',
      child: Container(
        key: const ValueKey('studio-engine'),
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        decoration: BoxDecoration(
          color: CheStudioColors.card,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: on ? CheStudioColors.teal.withValues(alpha: .6) : CheStudioColors.stroke),
        ),
        child: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(shape: BoxShape.circle, color: on ? CheStudioColors.teal : CheStudioColors.dim),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: ExcludeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      engine.label,
                      style: const TextStyle(color: CheStudioColors.text, fontSize: 15.5, fontWeight: FontWeight.w700),
                    ),
                    if (engine.detail.isNotEmpty)
                      Text(
                        engine.detail,
                        style: const TextStyle(color: CheStudioColors.dim, fontSize: 13, height: 1.3),
                      ),
                  ],
                ),
              ),
            ),
            if (!on && onConnect != null)
              Semantics(
                container: true,
                button: true,
                label: 'Cloud Computer: open Settings, Connections, Cloud Computer',
                excludeSemantics: true,
                child: TextButton(
                  key: const ValueKey('studio-connect'),
                  style: TextButton.styleFrom(foregroundColor: CheStudioColors.teal, minimumSize: const Size(64, 44)),
                  onPressed: onConnect,
                  child: const Text('Cloud Computer', style: TextStyle(fontWeight: FontWeight.w800)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
