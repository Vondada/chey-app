// CHE Command Center: Chat → Commands. The whole command library from CHE's
// own catalog (GET /api/commands), searchable by name or goal, in eight
// categories, with favorites, recents, saved workflows, a workflow builder
// and the real status of every run. Opening this page never makes CHE
// speak; Read This buttons and the owner's own actions do.
import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoAlertDialog, CupertinoDialogAction, showCupertinoDialog;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';
import 'che_command_client.dart';
import 'che_command_detail.dart';
import 'che_command_models.dart';
import 'che_command_store.dart';
import 'che_command_voice.dart';
import 'che_command_widgets.dart';
import 'che_workflow_builder.dart';

/// Runs a command in CHE's chat. `confirmed` is true only after the owner
/// approved it on this page.
typedef CheRunInChat = Future<void> Function(String message, {bool confirmed});

class CheCommandCenterScreen extends StatefulWidget {
  const CheCommandCenterScreen({
    super.key,
    required this.client,
    required this.store,
    required this.onRunInChat,
    this.onSpeak,
    this.onListen,
    this.initialCommand,
    this.initialSearch = '',
    this.initialList,
    this.initialSteps,
    this.initialTab = 0,
    this.statesMaxAge = const Duration(seconds: 60),
  });

  final CheCommandClient client;
  final CheCommandStore store;
  final CheRunInChat onRunInChat;
  final void Function(String text)? onSpeak;

  /// Starts or stops CHE's microphone (the same as Chat's mic button). What
  /// the owner says reaches this page's voice routes first.
  final VoidCallback? onListen;

  /// Opens this command's details first (from a chat suggestion).
  final String? initialCommand;

  /// Explicit Chat request: open the local command library filtered to this goal.
  final String initialSearch;

  /// A list request said in Chat ("show me five YouTube commands and tell me
  /// which are ready"): the page opens filtered and reads the answer.
  final CheCommandListRequest? initialList;

  /// Opens the builder with these commands (from a chat suggestion card).
  final List<String>? initialSteps;
  final int initialTab;

  /// How old the command states may be when CHE reads a list aloud before
  /// they are read from CHE again.
  final Duration statesMaxAge;

  @override
  State<CheCommandCenterScreen> createState() => _CheCommandCenterScreenState();
}

class _CheCommandCenterScreenState extends State<CheCommandCenterScreen> {
  CheCommandCatalog _catalog = CheCommandCatalog.empty;
  bool _loading = true;
  bool _fromCache = false;
  String _loadError = '';
  late int _tab = widget.initialTab;
  late final CheCommandListRequest? _initialList = widget.initialList ??
      (widget.initialSearch.trim().isEmpty ? null : CheCommandListRequest(topic: widget.initialSearch.trim()));
  late String _query = _initialList?.topic ?? '';
  String _category = 'all';

  /// 'ready' or 'setup' while the list shows only those (as CHE read them).
  String _statusFilter = '';
  String _status = '';
  bool _statusOk = true;
  bool _busy = false;
  late final _search = TextEditingController(text: _query);
  // New search results or a new category start at the top of the list.
  final _libraryScroll = ScrollController();
  // The banner's own scroll position (never the page's primary one); each
  // new answer starts at its first line.
  final _bannerScroll = ScrollController(keepScrollOffset: false);

  /// When the catalog (and its states) last came from CHE.
  DateTime? _loadedAt;

  /// The latest list request; an older one that finishes later stays quiet.
  int _listTicket = 0;

  void _toTop() {
    if (_libraryScroll.hasClients) _libraryScroll.jumpTo(0);
  }

  @override
  void initState() {
    super.initState();
    widget.store.addListener(_onStore);
    CheCommandCenterVoice.handler = _voice;
    unawaited(_start());
  }

  @override
  void dispose() {
    if (CheCommandCenterVoice.handler == _voice) CheCommandCenterVoice.handler = null;
    widget.store.removeListener(_onStore);
    _search.dispose();
    _libraryScroll.dispose();
    _bannerScroll.dispose();
    super.dispose();
  }

  void _onStore() {
    if (mounted) setState(() {});
  }

  Future<void> _start() async {
    if (!widget.store.loaded) await widget.store.load();
    final cached = widget.store.cachedCatalog;
    if (cached != null && mounted) {
      setState(() {
        _catalog = cached;
        _fromCache = true;
      });
    }
    await _refresh();
    if (!mounted) return;
    // A Chat voice search explicitly requested these local results, unlike
    // passive navigation which must remain silent.
    final request = _initialList;
    if (request != null) {
      if (_catalog.commands.isEmpty) {
        _report('I could not search the command library${_query.isEmpty ? '' : ' for "$_query"'}, sir. '
            'CHE has no command catalog on this phone right now. '
            'Check pairing or your connection and retry.', ok: false);
      } else {
        // The catalog was just read from CHE, so its states are current.
        final answer = await _listByVoice(request, fresh: true);
        if (answer.isNotEmpty) widget.onSpeak?.call(answer);
      }
    }
    final open = widget.initialCommand == null ? null : _catalog.byId(widget.initialCommand!);
    if (open != null) unawaited(_openDetail(open));
    final steps = widget.initialSteps;
    if (steps != null && steps.isNotEmpty) {
      unawaited(_openBuilder(CheSavedWorkflow(name: '', steps: [for (final id in steps) CheWorkflowStepDraft(command: id)])));
    }
  }

  /// Quiet: loading shows muted text and never speaks.
  Future<void> _refresh({Duration? timeout}) async {
    setState(() => _loading = true);
    try {
      final read = widget.client.catalogJson();
      final json = timeout == null ? await read : await read.timeout(timeout);
      await widget.store.cacheCatalog(json);
      if (!mounted) return;
      setState(() {
        _catalog = CheCommandCatalog.fromJson(json);
        _fromCache = false;
        _loadError = '';
        _loadedAt = DateTime.now();
      });
    } on Object catch (e) {
      if (!mounted) return;
      final text = e is TimeoutException ? 'CHE did not answer in time' : e.toString();
      setState(() => _loadError = text.length > 240 ? '${text.substring(0, 240)}…' : text);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// The result of something the owner did: a visible banner, a haptic and
  /// CHE's voice saying the real outcome.
  void _report(String text, {bool ok = true}) {
    setState(() {
      _status = text;
      _statusOk = ok;
    });
    HapticFeedback.heavyImpact();
    if (!ok) HapticFeedback.vibrate();
    widget.onSpeak?.call(text);
  }

  // ── Actions ──────────────────────────────────────────────────────────

  Future<void> _run(CheCommandInfo command) async {
    final ask = await cheAskToRun(context, command);
    if (ask == null || !mounted) return;
    await widget.store.noteUsed(command.id);
    if (!mounted) return;
    // Back to Chat, where CHE runs it and says the real result.
    Navigator.of(context).popUntil((route) => route.isFirst);
    await widget.onRunInChat(ask.message, confirmed: ask.confirmed);
  }

  Future<void> _openDetail(CheCommandInfo command) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheCommandDetailScreen(
        command: command,
        catalog: _catalog,
        favorite: widget.store.isFavorite(command.id),
        onRun: _run,
        onToggleFavorite: () => widget.store.toggleFavorite(command.id),
        onAddToWorkflow: (c) {
          Navigator.of(context).pop();
          unawaited(_openBuilder(CheSavedWorkflow(name: '', steps: [CheWorkflowStepDraft(command: c.id)])));
        },
        onSpeak: widget.onSpeak,
      ),
    ));
  }

  Future<void> _openBuilder([CheSavedWorkflow? initial]) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheWorkflowBuilderScreen(
        catalog: _catalog,
        client: widget.client,
        initial: initial,
        onSpeak: widget.onSpeak,
        onSaved: (_, all) => setState(() => _catalog = _withWorkflows(all)),
        onStarted: () => setState(() => _tab = 2),
      ),
    ));
    if (mounted) unawaited(_refresh());
  }

  CheCommandCatalog _withWorkflows(List<CheSavedWorkflow> all) => CheCommandCatalog(
        categories: _catalog.categories,
        commands: _catalog.commands,
        connectors: _catalog.connectors,
        templates: _catalog.templates,
        workflows: all,
        runs: _catalog.runs,
        missions: _catalog.missions,
      );

  Future<void> _runSaved(CheSavedWorkflow workflow) async {
    final approvals = [
      for (final s in workflow.steps)
        if (_catalog.byId(s.command)?.approvalRequired == true) '/${s.command}',
    ];
    final go = await showCupertinoDialog<bool>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('Run "${workflow.name}"?'),
        content: Text([
          '${workflow.steps.length} steps run on CHE\'s mission queue, each through her normal chat and its permissions.',
          if (approvals.isNotEmpty) 'These wait for your approval when they are reached: ${approvals.join(', ')}.',
        ].join('\n\n')),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Run')),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    final result = await widget.client.run(workflow);
    if (!mounted) return;
    setState(() => _busy = false);
    _report(result.ok ? result.message : 'CHE did not start it: ${result.message}', ok: result.ok);
    if (result.ok) {
      setState(() => _tab = 2);
      await _refresh();
    }
  }

  Future<void> _deleteSaved(CheSavedWorkflow workflow) async {
    // Owner rule: ask before deleting anything.
    final yes = await showCupertinoDialog<bool>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('Delete "${workflow.name}"?'),
        content: const Text('The saved workflow is removed from CHE. Past runs and their results stay.'),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
          CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    try {
      await widget.client.delete(workflow.id);
      if (!mounted) return;
      setState(() => _catalog = _withWorkflows([for (final w in _catalog.workflows) if (w.id != workflow.id) w]));
      _report('Deleted the saved workflow "${workflow.name}".');
    } on Object catch (e) {
      _report('CHE did not delete it: $e', ok: false);
    }
  }

  Future<void> _control(CheMission mission, String action, {String? stepId}) async {
    if (action == 'cancel') {
      final yes = await showCupertinoDialog<bool>(
        context: context,
        builder: (ctx) => CupertinoAlertDialog(
          title: Text('Cancel "${mission.name}"?'),
          content: const Text('Steps that have not finished are cancelled. Finished results are kept.'),
          actions: [
            CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep running')),
            CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Cancel run')),
          ],
        ),
      );
      if (yes != true || !mounted) return;
    }
    final result = await _controlCore(mission, action, stepId: stepId);
    if (!mounted) return;
    _report(result.ok ? result.message : 'CHE did not $action it: ${result.message}', ok: result.ok);
  }

  Future<CheCommandResult> _controlCore(CheMission mission, String action, {String? stepId}) async {
    setState(() => _busy = true);
    try {
      return await widget.client.control(mission.id, action, stepId: stepId);
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        unawaited(_refresh());
      }
    }
  }

  String _pageSummary() {
    final ready = _catalog.commands.where((c) => c.canRun).length;
    final setup = _catalog.commands.where((c) => c.status == CheCommandStatus.setupRequired).length;
    final favorites = [for (final id in widget.store.favorites) '/$id'];
    return [
      'Commands. ${_catalog.commands.length} commands in ${_catalog.categories.length} categories.',
      '$ready ready now${setup > 0 ? ', $setup need setup' : ''}.',
      if (favorites.isNotEmpty) 'Favorites: ${favorites.join(', ')}.',
      if (_catalog.workflows.isNotEmpty) '${_catalog.workflows.length} saved workflows.',
      'Search by name or say what you want to do.',
    ].join(' ');
  }

  // ── Voice ────────────────────────────────────────────────────────────
  // Every action on this page by voice (AGENTS.md: a voice route to each
  // action). Chat offers the owner's words here first while the page is
  // open; the reply is shown on the banner and spoken by Chat. Deleting and
  // cancelling ask first, and only a plain yes on the next turn goes ahead.

  /// What CHE last read as a numbered list (commands or workflows).
  List<Object> _voiceList = const [];

  /// Every match of the last list request, how many were read, and how
  /// many to read per "more".
  List<CheCommandInfo> _lastMatches = const [];
  int _lastShown = 0;
  int _pageSize = 5;

  /// The command the owner last opened or picked ("run it", "favorite it").
  CheCommandInfo? _voiceFocus;

  /// A spoken delete or cancel waiting for the owner's yes.
  Future<String> Function()? _voiceConfirm;

  Set<String> get _ids => {for (final c in _catalog.commands) c.id};

  /// The visible result of a spoken action: banner and haptic. Chat speaks it.
  String _say(String text, {bool ok = true}) {
    if (mounted) {
      setState(() {
        _status = text;
        _statusOk = ok;
      });
    }
    HapticFeedback.heavyImpact();
    if (!ok) HapticFeedback.vibrate();
    return text;
  }

  /// Reads [items] as a numbered list; each command with its state. With
  /// [start], the numbers continue the list already read ("more").
  String _numbered(List<Object> items, {int start = 0}) {
    _voiceList = start == 0 ? items : [..._voiceList.take(start), ...items];
    if (start == 0) {
      // A new list: "more" continues this one, not an earlier one.
      _lastMatches = [for (final item in items) if (item is CheCommandInfo) item];
      _lastShown = _lastMatches.length;
    }
    return [
      for (final (i, item) in items.indexed)
        switch (item) {
          CheCommandInfo c => '${start + i + 1}. ${c.slash}: ${_sentence(c.summary)} ${_state(c)}.',
          CheSavedWorkflow w => '${start + i + 1}. ${w.name}: ${w.steps.map((s) => '/${s.command}').join(', then ')}.',
          _ => '',
        },
    ].join(' ');
  }

  static String _sentence(String text) {
    final t = text.trim();
    return t.isEmpty || RegExp(r'[.!?]$').hasMatch(t) ? t : '$t.';
  }

  /// A command's state as CHE's catalog reports it, with what is missing.
  String _state(CheCommandInfo c) => c.status == CheCommandStatus.setupRequired && c.missing.isNotEmpty
      ? 'Needs setup: ${c.missing.map((m) => m.label).join(', ')}'
      : cheCommandStatusLabel(c.status);

  /// "3 ready, 2 need setup".
  String _tally(List<CheCommandInfo> items) {
    final ready = items.where((c) => c.canRun).length;
    final setup = items.where((c) => c.status == CheCommandStatus.setupRequired).length;
    final other = items.length - ready - setup;
    return [
      '$ready ready',
      if (setup > 0) '$setup need${setup == 1 ? 's' : ''} setup',
      if (other > 0) '$other not available now',
    ].join(', ');
  }

  Object? _fromList(String words) {
    final m = RegExp(r'^(?:number|option|result)?\s*(\S+)(?:\s+one)?$', caseSensitive: false).firstMatch(words.trim());
    final n = CheCommandVoice.numberFrom(m?.group(1));
    return n != null && n >= 1 && n <= _voiceList.length ? _voiceList[n - 1] : null;
  }

  /// The command the owner named, with any words after it as its input.
  ({CheCommandInfo command, String input})? _named(String words) {
    // "the trade chart command" names /trade-chart.
    final w = words.trim().replaceFirst(RegExp(r'^(?:the|my)\s+', caseSensitive: false), '').replaceFirst(RegExp(r'\s+command$', caseSensitive: false), '');
    if (RegExp(r'^(?:it|that|this)(?:\s+(?:one|command))?$', caseSensitive: false).hasMatch(w)) {
      final c = _voiceFocus;
      return c == null ? null : (command: c, input: '');
    }
    final picked = _fromList(w);
    if (picked is CheCommandInfo) return (command: picked, input: '');
    final match = cheMatchCommandWords(w, _ids);
    final c = match == null ? null : _catalog.byId(match.id);
    return c == null ? null : (command: c, input: match!.rest);
  }

  String _noSuch(String words) {
    // A group's name ("YouTube") is not one command: say so and list it.
    final group = _catalog.categoryNamed(words);
    if (group != null) {
      final members = _catalog.inCategory(group.id);
      final read = _readPage(members, 5);
      return '${group.title} is a group of ${members.length} commands, not one command. $read${_moreHint()} '
          'Say a number to hear one, or "run" and one name. Nothing was run.';
    }
    final near = _catalog.search(words).take(3).toList();
    return 'I don\'t have a command called "$words".${near.isEmpty ? '' : ' Closest: ${_numbered(near)} Say a number to hear one.'} Nothing was run.';
  }

  CheSavedWorkflow? _workflowNamed(String name, {bool templates = false}) {
    final want = name.trim().toLowerCase().replaceAll(RegExp(r'^(?:the|my)\s+'), '');
    if (want.isEmpty) return null;
    final picked = _fromList(want);
    if (picked is CheSavedWorkflow) return picked;
    final all = [..._catalog.workflows, if (templates) ..._catalog.templates];
    for (final w in all) {
      if (w.name.toLowerCase() == want) return w;
    }
    for (final w in all) {
      if (w.name.toLowerCase().contains(want) || want.contains(w.name.toLowerCase())) return w;
    }
    return null;
  }

  CheMission? _missionNamed(String name) {
    final want = name.trim().toLowerCase();
    final missions = _catalog.missions;
    if (want.isNotEmpty) {
      for (final m in missions) {
        if (m.name.toLowerCase().contains(want)) return m;
      }
      return null;
    }
    return missions.where((m) => !m.finished).firstOrNull ?? missions.firstOrNull;
  }

  String _unavailable(CheCommandInfo c) {
    final missing = c.missing.map((m) => m.label).join(', ');
    final setup = c.missing.map((m) => m.setup).where((s) => s.isNotEmpty).join(' ');
    return '${c.slash}: ${cheCommandStatusLabel(c.status)}.${missing.isEmpty ? '' : ' Missing: $missing.'}${setup.isEmpty ? '' : ' To set up: $setup'} Nothing was run.';
  }

  String _describe() {
    switch (_tab) {
      case 1:
        final all = [..._catalog.workflows, ..._catalog.templates];
        return 'Commands, Workflows tab. ${_catalog.workflows.length} saved workflow${_catalog.workflows.length == 1 ? '' : 's'}'
            '${_catalog.templates.isEmpty ? '' : ' and ${_catalog.templates.length} templates'}. ${_numbered(all)} '
            'Say "run" and a workflow\'s name, "build a workflow called" a name "with" its commands, or "show library".';
      case 2:
        final missions = _catalog.missions.take(3).toList();
        _voiceList = const [];
        return 'Commands, Activity tab. ${missions.isEmpty ? 'No workflow runs yet.' : [for (final (i, m) in missions.indexed) '${i + 1}. ${m.spoken}'].join(' ')}'
            '${_catalog.runs.isEmpty ? '' : ' Last command: /${_catalog.runs.first.command}, ${cheStepStatusLabel(_catalog.runs.first.status).toLowerCase()}.'}'
            '${missions.isEmpty ? '' : ' Say approve, retry, pause, resume or cancel.'}';
      default:
        final query = _query.trim();
        if (query.isNotEmpty) {
          final all = _matching(query, _statusFilter);
          final read = _readPage(all, 5);
          return 'Commands, ${all.length} matches for "$query". $read${_moreHint()} Say a number to hear one, or "run" and its name.';
        }
        final mine = <CheCommandInfo>{
          for (final id in [...widget.store.favorites, ...widget.store.recents]) ?_catalog.byId(id),
        }.take(5).toList();
        return '${_pageSummary()} Tabs: 1. Library, 2. Workflows, 3. Activity.'
            '${mine.isEmpty ? '' : ' Your commands: ${_numbered(mine)}'} Say "search for" and what you want to do, a command\'s name, or "back to chat".';
    }
  }

  Future<String?> _voice(String words) async {
    if (!mounted) return null;
    final v = CheCommandVoice.parse(words);
    final pending = _voiceConfirm;
    _voiceConfirm = null;
    if (pending != null) {
      if (v?.op == CheCommandVoiceOp.yes) return pending();
      if (v?.op == CheCommandVoiceOp.no) return _say('Okay. Nothing was changed.');
    }
    if (v == null) return null;
    final page = ModalRoute.of(context);
    final atTop = page?.isCurrent ?? true;
    switch (v.op) {
      case CheCommandVoiceOp.yes || CheCommandVoiceOp.no:
        return null; // Nothing asked here: Chat answers it (a held command's yes).
      case CheCommandVoiceOp.back:
        unawaited(Navigator.of(context).maybePop());
        return atTop ? 'Back to Chat.' : 'Back to Commands.';
      default:
        break;
    }
    if (_catalog.isEmpty) {
      return _say(_loadError.isEmpty ? 'The command list is still loading from CHE. Try again in a moment.' : 'Could not reach CHE: $_loadError. Nothing was changed.', ok: false);
    }
    if (!atTop && v.op != CheCommandVoiceOp.run && v.op != CheCommandVoiceOp.favorite && v.op != CheCommandVoiceOp.unfavorite) {
      // Details or the builder is open on top: return to the page first.
      Navigator.of(context).popUntil((route) => route == page || route.isFirst);
    }
    switch (v.op) {
      case CheCommandVoiceOp.repeat:
        return _status.isEmpty ? _say(_describe()) : _status;
      case CheCommandVoiceOp.describe:
        return _say(_describe());
      case CheCommandVoiceOp.tab:
        setState(() => _tab = switch (v.text) { 'workflows' => 1, 'activity' => 2, _ => 0 });
        return _say(_describe());
      case CheCommandVoiceOp.search:
        return _listByVoice(v.list ?? CheCommandListRequest(topic: v.text));
      case CheCommandVoiceOp.pick:
        final n = v.number ?? 0;
        if (n < 1 || n > _voiceList.length) {
          return _say(_voiceList.isEmpty ? 'I have not read a list yet. Say "what\'s on screen".' : 'There is no number $n. I read ${_voiceList.length}.', ok: false);
        }
        final item = _voiceList[n - 1];
        if (item is CheSavedWorkflow) {
          return _say('${item.name}: ${item.steps.map((s) => '/${s.command}${s.input.isEmpty ? '' : ' ${s.input}'}').join(', then ')}. Say "run ${item.name} workflow" to start it.');
        }
        final c = item as CheCommandInfo;
        _voiceFocus = c;
        unawaited(_openDetail(c));
        return _say('${c.spoken} Say "run it" or "favorite it".');
      case CheCommandVoiceOp.open:
        final named = _named(v.text);
        // Not a command's name ("show me YouTube"): list what matches it.
        // Explaining or listing never runs anything.
        if (named == null) {
          final topic = cheCommandSpeech(v.text);
          return _catalog.search(topic).isEmpty ? _say(_noSuch(v.text), ok: false) : _listByVoice(CheCommandListRequest(topic: topic));
        }
        _voiceFocus = named.command;
        unawaited(_openDetail(named.command));
        return _say('${named.command.spoken} Say "run it" or "favorite it".');
      case CheCommandVoiceOp.run:
        final named = _named(v.text);
        if (named == null) return _say(_noSuch(v.text), ok: false);
        final c = named.command;
        _voiceFocus = c;
        if (!c.canRun) return _say(_unavailable(c), ok: false);
        if (c.input?.required == true && named.input.isEmpty) {
          return _say('${c.slash} needs ${c.input!.hint.toLowerCase()}. Say it after the name, for example: "run ${c.id.replaceAll('-', ' ')} for …". Nothing was run.', ok: false);
        }
        await widget.store.noteUsed(c.id);
        if (!mounted) return null;
        // Back to Chat, where CHE runs it through her normal route and says
        // the real result (an approval command asks for a spoken yes there).
        CheCommandCenterVoice.handler = null;
        Navigator.of(context).popUntil((route) => route.isFirst);
        await widget.onRunInChat([c.slash, if (named.input.isNotEmpty) named.input].join(' '));
        return '';
      case CheCommandVoiceOp.favorite || CheCommandVoiceOp.unfavorite:
        final named = _named(v.text);
        if (named == null) return _say(_noSuch(v.text), ok: false);
        final c = named.command;
        final want = v.op == CheCommandVoiceOp.favorite;
        if (widget.store.isFavorite(c.id) != want) await widget.store.toggleFavorite(c.id);
        return _say(want ? '${c.slash} is in your favorites.' : '${c.slash} is not in your favorites.');
      case CheCommandVoiceOp.newWorkflow:
        unawaited(_openBuilder(CheSavedWorkflow(name: v.target, steps: [])));
        return _say('The workflow builder is open. By voice you can also say: build a workflow called website clients with lead scout, lead audit, pricing and lead proposal.');
      case CheCommandVoiceOp.buildWorkflow:
        final steps = <CheWorkflowStepDraft>[];
        for (final item in v.items) {
          final named = _named(item);
          if (named == null) return _say('I could not match "$item" to a command, so nothing was saved. ${_noSuch(item).replaceFirst(' Nothing was run.', '')}', ok: false);
          steps.add(CheWorkflowStepDraft(command: named.command.id, input: named.input));
        }
        final name = v.target.isNotEmpty ? v.target : '${steps.first.command} to ${steps.last.command}';
        return _saveByVoice(CheSavedWorkflow(id: _workflowNamed(name)?.id ?? '', name: name, steps: steps));
      case CheCommandVoiceOp.addStep:
        final w = _workflowNamed(v.target);
        if (w == null) return _say('I have no saved workflow called "${v.target}". Nothing was changed.', ok: false);
        final named = _named(v.text);
        if (named == null) return _say('${_noSuch(v.text).replaceFirst(' Nothing was run.', '')} Nothing was changed.', ok: false);
        return _saveByVoice(CheSavedWorkflow(id: w.id, name: w.name, steps: [
          for (final s in w.steps) s.copy(),
          CheWorkflowStepDraft(command: named.command.id, input: named.input),
        ]));
      case CheCommandVoiceOp.removeStep:
        final w = _workflowNamed(v.target);
        final n = v.number ?? 0;
        if (w == null) return _say('I have no saved workflow called "${v.target}". Nothing was changed.', ok: false);
        if (n < 1 || n > w.steps.length) return _say('${w.name} has ${w.steps.length} steps; there is no step $n. Nothing was changed.', ok: false);
        if (w.steps.length == 1) return _say('${w.name} has only that step. Say "delete ${w.name} workflow" to remove the whole workflow. Nothing was changed.', ok: false);
        return _saveByVoice(CheSavedWorkflow(id: w.id, name: w.name, steps: [
          for (final (i, s) in w.steps.indexed)
            if (i != n - 1) s.copy(),
        ]));
      case CheCommandVoiceOp.deleteWorkflow:
        final w = _workflowNamed(v.target);
        if (w == null) return _say('I have no saved workflow called "${v.target}". Nothing was deleted.', ok: false);
        // Owner rule: ask before deleting anything.
        _voiceConfirm = () async {
          try {
            await widget.client.delete(w.id);
            if (mounted) setState(() => _catalog = _withWorkflows([for (final x in _catalog.workflows) if (x.id != w.id) x]));
            return _say('Deleted the saved workflow "${w.name}". Past runs and their results stay.');
          } on Object catch (e) {
            return _say('CHE did not delete it: $e', ok: false);
          }
        };
        setState(() => _tab = 1);
        return _say('Delete the saved workflow "${w.name}"? Say yes to delete it, or no to keep it.');
      case CheCommandVoiceOp.runWorkflow:
        final w = _workflowNamed(v.target, templates: true);
        if (w == null) {
          return _say('I have no workflow called "${v.target}". ${_catalog.workflows.isEmpty ? 'There are no saved workflows yet.' : 'Saved: ${_numbered(_catalog.workflows)}'} Nothing was run.', ok: false);
        }
        setState(() => _busy = true);
        final result = await widget.client.run(w.id.isNotEmpty ? w : CheSavedWorkflow(name: w.name, steps: [for (final s in w.steps) s.copy()]));
        if (!mounted) return result.message;
        setState(() {
          _busy = false;
          if (result.ok) _tab = 2;
        });
        if (result.ok) unawaited(_refresh());
        return _say(result.ok ? result.message : 'CHE did not start it: ${result.message}', ok: result.ok);
      case CheCommandVoiceOp.activity:
        setState(() => _tab = 2);
        final m = v.target.isEmpty ? null : _missionNamed(v.target);
        return _say(m != null ? m.spoken : _describe());
      case CheCommandVoiceOp.approve || CheCommandVoiceOp.retry || CheCommandVoiceOp.pause || CheCommandVoiceOp.resume || CheCommandVoiceOp.cancel:
        return _controlByVoice(v);
      default:
        return null;
    }
  }

  /// Lists commands for a spoken or typed request: filters the library on
  /// screen, then reads up to the number asked for, each with its state,
  /// and answers a readiness question. States are re-read from CHE first
  /// ([fresh] means they were just read). Nothing is run.
  Future<String> _listByVoice(CheCommandListRequest r, {bool fresh = false}) async {
    if (r.more) return _moreByVoice(r.count);
    if (r.followUp && _voiceList.whereType<CheCommandInfo>().isEmpty && !(r.aboutIt && _voiceFocus != null)) {
      // Nothing read yet: answer about what the screen shows.
      return _listByVoice(CheCommandListRequest(topic: _query.trim(), readiness: true, only: r.only));
    }
    final ticket = ++_listTicket;
    final stale = fresh ? _staleNote() : await _freshStates();
    // Asked again while CHE was being reached: only the newest answer is read.
    if (!mounted || ticket != _listTicket) return '';
    final focus = _voiceFocus == null ? null : _catalog.byId(_voiceFocus!.id) ?? _voiceFocus;
    if (r.followUp && r.aboutIt && focus != null) {
      // "Is it ready?" about the command just picked.
      return _say('$stale${focus.slash}: ${_state(focus)}.${focus.missing.isEmpty ? '' : ' ${focus.missing.map((m) => m.setup).where((x) => x.isNotEmpty).join(' ')}'}'.trim());
    }
    if (r.followUp) return _say('$stale${_readinessOf([for (final c in _voiceList.whereType<CheCommandInfo>()) _catalog.byId(c.id) ?? c], r.only)}');

    final topic = r.topic.trim();
    final group = topic.isEmpty ? null : _catalog.categoryNamed(topic);
    final found = _matching(topic, '');
    final matches = _matching(topic, r.only);
    // The screen shows exactly what CHE reads, in the same order.
    _search.text = topic;
    setState(() {
      _tab = 0;
      _category = 'all';
      _query = topic;
      _statusFilter = matches.isEmpty ? '' : r.only;
    });
    _toTop();
    final what = group != null ? '${group.title} commands' : topic.isEmpty ? 'commands' : 'commands for "$topic"';
    if (found.isEmpty || matches.isEmpty) {
      // The screen no longer shows the list read before, so "more" and
      // numbers must not continue it.
      _voiceList = const [];
      _lastMatches = const [];
      _lastShown = 0;
    }
    if (found.isEmpty) return _say('${stale}No command matches "$topic". Try other words.', ok: false);
    if (matches.isEmpty) {
      return _say(r.only == 'ready'
          ? '${stale}None of the ${found.length} $what is ready: ${_tally(found)}.'
          : '${stale}All ${found.length} $what are ready.');
    }
    final limit = r.all ? 25 : r.count ?? (r.readiness ? 12 : 5);
    final shown = matches.take(limit).toList();
    final read = _readPage(matches, limit);
    final head = switch (r.only) {
      'ready' => '${matches.length} of the ${found.length} $what ${matches.length == 1 ? 'is' : 'are'} ready.',
      'setup' => '${matches.length} of the ${found.length} $what ${matches.length == 1 ? 'is' : 'are'} not ready.',
      _ => group != null
          ? '${group.title}: ${found.length} commands.'
          : topic.isEmpty
              ? 'CHE has ${found.length} commands.'
              : '${found.length} matches for "$topic".',
    };
    final tally = r.only.isEmpty && shown.length > 1 ? ' Of these ${shown.length}: ${_tally(shown)}.' : '';
    return _say('$stale$head $read$tally${_moreHint()} Say a number to hear one, or "run" and its name.'
        '${r.runAsked ? ' CHE runs one command at a time. Nothing was run.' : ''}');
  }

  /// "More": the next commands of the last list, numbered on from it.
  String _moreByVoice(int? count) {
    final heard = [for (final c in _voiceList.whereType<CheCommandInfo>()) c.id];
    final continues = heard.length == _lastShown && [for (final c in _lastMatches.take(_lastShown)) c.id].join(' ') == heard.join(' ');
    if (_lastMatches.isEmpty || !continues) {
      return _say('I have no list of commands to continue. Say "search for" and what you want to do.', ok: false);
    }
    final start = _lastShown;
    if (start >= _lastMatches.length) return _say('That was all ${_lastMatches.length}.');
    final next = _lastMatches.skip(start).take(count ?? _pageSize).toList();
    final read = _numbered(next, start: start);
    _lastShown = start + next.length;
    return _say('${start + 1} to $_lastShown of ${_lastMatches.length}. $read'
        '${_lastShown < _lastMatches.length ? _moreHint() : ' That is all of them.'}');
  }

  /// The commands for [topic] (every command when empty), only the ready
  /// or the not-ready ones for [only]: what the screen lists and CHE reads.
  List<CheCommandInfo> _matching(String topic, String only) {
    final found = topic.isEmpty ? _catalog.commands : _catalog.search(topic, limit: _catalog.commands.length);
    return switch (only) {
      'ready' => [for (final c in found) if (c.canRun) c],
      'setup' => [for (final c in found) if (!c.canRun) c],
      _ => found,
    };
  }

  /// Reads the first [size] of [matches] as a numbered list and remembers
  /// the rest for "more".
  String _readPage(List<CheCommandInfo> matches, int size) {
    final read = _numbered(matches.take(size).toList());
    _lastMatches = matches;
    _pageSize = size;
    return read;
  }

  String _moreHint() {
    final left = _lastMatches.length - _lastShown;
    return left > 0 ? ' Say "more" for the next ${left < _pageSize ? left : _pageSize}.' : '';
  }

  /// Which of the commands just read are ready, keeping their numbers.
  String _readinessOf(List<CheCommandInfo> read, String only) {
    final ready = [for (final (i, c) in read.indexed) if (c.canRun) '${i + 1}. ${c.slash}'];
    final notReady = [for (final (i, c) in read.indexed) if (!c.canRun) '${i + 1}. ${c.slash} (${_state(c)})'];
    final readyPart = ready.isEmpty ? 'none are ready.' : '${ready.length} ready: ${ready.join(', ')}.';
    final notPart = notReady.isEmpty ? 'all are ready.' : '${notReady.length} not ready: ${notReady.join('; ')}.';
    final both = notReady.isEmpty ? readyPart : ready.isEmpty ? notPart : '$readyPart $notPart';
    return 'Of those ${read.length}: ${switch (only) { 'ready' => readyPart, 'setup' => notPart, _ => both }}';
  }

  /// Re-reads the catalog when its states are older than
  /// [CheCommandCenterScreen.statesMaxAge], so the states CHE reads are
  /// current. Returns a note to say first when CHE could not be reached.
  Future<String> _freshStates() async {
    final at = _loadedAt;
    if (at == null || DateTime.now().difference(at) > widget.statesMaxAge) {
      await _refresh(timeout: const Duration(seconds: 4));
    }
    return _staleNote();
  }

  String _staleNote() => _loadError.isEmpty && !_fromCache
      ? ''
      : 'CHE could not be reached just now, so these states are from ${_fromCache ? 'the copy saved on this iPhone' : 'when this page last loaded'} and may be out of date. ';

  Future<String> _saveByVoice(CheSavedWorkflow draft) async {
    setState(() => _busy = true);
    try {
      final (saved, all) = await widget.client.save(draft);
      if (!mounted) return 'Saved.';
      setState(() {
        _catalog = _withWorkflows(all);
        _tab = 1;
      });
      final plan = await widget.client.describe(saved.name, saved.steps);
      return _say('Saved "${saved.name}": ${saved.steps.map((s) => '/${s.command}${s.input.isEmpty ? '' : ' ${s.input}'}').join(', then ')}.'
          '${plan.issues.isEmpty ? ' Say "run ${saved.name} workflow" to start it.' : ' Before it can run: ${plan.issues.join(' ')}'}'
          '${plan.approvals.isEmpty ? '' : ' It will wait for your approval at: ${plan.approvals.join(', ')}.'}');
    } on Object catch (e) {
      return _say('CHE did not save the workflow: $e', ok: false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String> _controlByVoice(CheCommandVoice v) async {
    final action = switch (v.op) {
      CheCommandVoiceOp.approve => 'approve',
      CheCommandVoiceOp.retry => 'retry',
      CheCommandVoiceOp.pause => 'pause',
      CheCommandVoiceOp.resume => 'resume',
      _ => 'cancel',
    };
    setState(() => _tab = 2);
    final mission = _missionNamed(v.target);
    if (mission == null) return _say(v.target.isEmpty ? 'There is no workflow run to $action.' : 'I found no workflow run called "${v.target}".', ok: false);
    String? stepId;
    if (action == 'approve' || action == 'retry') {
      final steps = mission.steps;
      final n = v.number;
      final candidates = [
        for (final (i, s) in steps.indexed)
          if (action == 'approve' ? s.awaitingApproval : s.failed) (i + 1, s),
      ];
      if (n != null) {
        if (n < 1 || n > steps.length) return _say('${mission.name} has ${steps.length} steps; there is no step $n.', ok: false);
        stepId = steps[n - 1].id;
      } else if (candidates.length == 1) {
        stepId = candidates.single.$2.id;
      } else if (candidates.isEmpty) {
        return _say(action == 'approve' ? 'No step of ${mission.name} is waiting for your approval yet.' : 'No step of ${mission.name} has failed.', ok: false);
      } else {
        return _say('Steps ${candidates.map((c) => c.$1).join(' and ')} of ${mission.name} ${action == 'approve' ? 'wait for your approval' : 'failed'}. Say "$action step" and its number.');
      }
    }
    if (action == 'cancel') {
      _voiceConfirm = () async {
        final result = await _controlCore(mission, 'cancel');
        return _say(result.ok ? result.message : 'CHE did not cancel it: ${result.message}', ok: result.ok);
      };
      return _say('Cancel "${mission.name}"? Steps that have not finished are cancelled; finished results are kept. Say yes to cancel it, or no to keep it running.');
    }
    final result = await _controlCore(mission, action, stepId: stepId);
    return _say(result.ok ? result.message : 'CHE did not $action it: ${result.message}', ok: result.ok);
  }

  // ── UI ───────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        backgroundColor: CheColors.bg,
        leading: IconButton(
          tooltip: 'Back to Chat',
          icon: const Icon(Icons.arrow_back_ios_new_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Text('Commands', style: CheType.title.copyWith(fontSize: 22, fontWeight: FontWeight.w800)),
        actions: [
          if (widget.onListen != null)
            IconButton(
              tooltip: 'Speak to CHE',
              icon: const Icon(Icons.mic_rounded),
              onPressed: widget.onListen,
            ),
          IconButton(
            tooltip: 'Read this page aloud',
            icon: const Icon(Icons.volume_up_rounded),
            onPressed: widget.onSpeak == null ? null : () => widget.onSpeak!(_pageSummary()),
          ),
          IconButton(
            tooltip: 'Refresh from CHE',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            _tabs(),
            if (_status.isNotEmpty) _banner(),
            if (_loadError.isNotEmpty || _loading || _fromCache) _quietNote(),
            Expanded(
              child: switch (_tab) {
                1 => _workflowsTab(),
                2 => _activityTab(),
                _ => _libraryTab(),
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _tabs() {
    const labels = ['Library', 'Workflows', 'Activity'];
    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 4, CheSpace.gutter, 8),
      child: Row(
        children: [
          for (final (i, label) in labels.indexed) ...[
            if (i > 0) const SizedBox(width: 8),
            Expanded(
              child: Semantics(
                button: true,
                selected: _tab == i,
                label: '$label tab, ${i + 1} of 3',
                excludeSemantics: true,
                child: InkWell(
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                  onTap: () {
                    HapticFeedback.selectionClick();
                    setState(() => _tab = i);
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
                    decoration: BoxDecoration(
                      color: _tab == i ? CheColors.accent.withValues(alpha: 0.18) : CheColors.surface,
                      borderRadius: BorderRadius.circular(CheRadius.pill),
                      border: Border.all(color: _tab == i ? CheColors.accent : CheColors.stroke),
                    ),
                    child: Text(
                      label,
                      textAlign: TextAlign.center,
                      style: CheType.label.copyWith(color: _tab == i ? CheColors.accent : CheColors.textDim),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _banner() {
    final color = _statusOk ? CheColors.success : CheColors.danger;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 8),
        padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(CheRadius.sm),
          border: Border.all(color: color.withValues(alpha: 0.5)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // A long spoken answer (a numbered list with states) scrolls
            // inside the banner, so the command list below stays usable.
            Expanded(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.3),
                child: Scrollbar(
                  controller: _bannerScroll,
                  child: SingleChildScrollView(key: ValueKey(_status), controller: _bannerScroll, child: Text(_status, style: CheType.body)),
                ),
              ),
            ),
            IconButton(
              tooltip: 'Hide this message',
              visualDensity: VisualDensity.compact,
              onPressed: () => setState(() => _status = ''),
              icon: const Icon(Icons.close_rounded, size: 18),
            ),
          ],
        ),
      ),
    );
  }

  /// Passive status: muted text, no speech, no forced announcement.
  Widget _quietNote() {
    final text = _loading
        ? 'Checking with CHE…'
        : _loadError.isNotEmpty
            ? (_catalog.isEmpty
                ? 'Could not reach CHE: $_loadError'
                : 'Could not reach CHE ($_loadError). Showing the last list CHE sent; statuses may be out of date.')
            : 'Showing the last list CHE sent.';
    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 6),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(text, style: CheType.caption.copyWith(color: _loadError.isNotEmpty ? CheColors.warning : CheColors.textDim)),
      ),
    );
  }

  Widget _libraryTab() {
    if (_catalog.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_loading ? 'Loading commands…' : 'No commands yet. Check that CHE is connected, then refresh.',
              style: CheType.bodyDim, textAlign: TextAlign.center),
        ),
      );
    }
    final query = _query.trim();
    final filtered = query.isNotEmpty || _statusFilter.isNotEmpty;
    final List<CheCommandInfo> shown = filtered
        ? _matching(query, _statusFilter)
        : _category == 'all'
            ? _catalog.commands
            : _catalog.inCategory(_category);
    final favorites = [for (final id in widget.store.favorites) ?_catalog.byId(id)];
    final recents = [for (final id in widget.store.recents) ?_catalog.byId(id)];
    final header = Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _search,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search_rounded),
              labelText: 'Search commands or describe a goal',
              hintText: 'For example: find website clients',
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      tooltip: 'Clear search',
                      icon: const Icon(Icons.close_rounded),
                      onPressed: () {
                        _search.clear();
                        setState(() {
                          _query = '';
                          _statusFilter = '';
                        });
                      },
                    ),
            ),
            onChanged: (v) {
              setState(() {
                _query = v;
                _statusFilter = '';
              });
              _toTop();
            },
          ),
          const SizedBox(height: 10),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _categoryChip('all', 'All', _catalog.commands.length),
                for (final c in _catalog.categories) _categoryChip(c.id, c.title, _catalog.inCategory(c.id).length),
              ],
            ),
          ),
        ],
      ),
    );
    final rows = <Widget>[];
    if (!filtered && _category == 'all') {
      if (favorites.isNotEmpty) {
        rows.add(const CheSectionHeader('Favorites'));
        rows.addAll(favorites.map(_tile));
      }
      if (recents.isNotEmpty) {
        rows.add(const CheSectionHeader('Recently used'));
        rows.addAll(recents.take(4).map(_tile));
      }
      for (final category in _catalog.categories) {
        rows.add(CheSectionHeader(category.title));
        rows.add(Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(category.summary, style: CheType.caption)));
        rows.addAll(_catalog.inCategory(category.id).map(_tile));
      }
    } else {
      final only = switch (_statusFilter) { 'ready' => 'ready ', 'setup' => 'not ready ', _ => '' };
      rows.add(CheSectionHeader(filtered
          ? '${shown.length} $only${query.isEmpty ? 'command${shown.length == 1 ? '' : 's'}' : 'match${shown.length == 1 ? '' : 'es'} for "$query"'}'
          : _catalog.categories.firstWhere((c) => c.id == _category).title));
      if (shown.isEmpty) {
        rows.add(Text('No command matches that yet. Try other words, or ask CHE in Chat.', style: CheType.bodyDim));
      }
      rows.addAll(shown.map(_tile));
    }
    return Column(
      children: [
        header,
        Expanded(
          child: ListView.builder(
            key: const ValueKey('command-library'),
            controller: _libraryScroll,
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 32),
            itemCount: rows.length,
            itemBuilder: (_, i) => rows[i],
          ),
        ),
      ],
    );
  }

  Widget _categoryChip(String id, String title, int count) {
    final selected = _category == id;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text('$title $count'),
        selected: selected,
        tooltip: '$title, $count commands',
        onSelected: (_) {
          HapticFeedback.selectionClick();
          setState(() {
            _category = id;
            _query = '';
            _statusFilter = '';
            _search.clear();
          });
          _toTop();
        },
      ),
    );
  }

  Widget _tile(CheCommandInfo c) => CheCommandTile(
        key: ValueKey('cmd-${c.id}'),
        command: c,
        favorite: widget.store.isFavorite(c.id),
        onOpen: () => _openDetail(c),
        onToggleFavorite: () async {
          final now = await widget.store.toggleFavorite(c.id);
          if (mounted) {
            setState(() {
              _status = now ? '${c.slash} added to favorites.' : '${c.slash} removed from favorites.';
              _statusOk = true;
            });
          }
        },
      );

  Widget _workflowsTab() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 32),
      children: [
        FilledButton.icon(
          onPressed: _catalog.isEmpty ? null : () => _openBuilder(),
          icon: const Icon(Icons.account_tree_rounded),
          label: const Text('Build a workflow'),
        ),
        const CheSectionHeader('Saved workflows'),
        if (_catalog.workflows.isEmpty)
          Text('No saved workflows yet. Build one, or start from a template below.', style: CheType.bodyDim),
        for (final w in _catalog.workflows) _workflowCard(w, saved: true),
        if (_catalog.templates.isNotEmpty) ...[
          const CheSectionHeader('Templates'),
          for (final t in _catalog.templates) _workflowCard(t, saved: false),
        ],
      ],
    );
  }

  Widget _workflowCard(CheSavedWorkflow w, {required bool saved}) {
    final chain = w.steps.map((s) => '/${s.command}').join(' → ');
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: CheColors.surface,
        borderRadius: BorderRadius.circular(CheRadius.md),
        border: Border.all(color: CheColors.stroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(header: true, child: Text(w.name, style: CheType.headline)),
          const SizedBox(height: 4),
          Text(chain, style: CheType.mono.copyWith(color: CheColors.textDim)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: saved
                ? [
                    FilledButton.icon(
                      onPressed: _busy ? null : () => _runSaved(w),
                      icon: const Icon(Icons.play_arrow_rounded),
                      label: Text('Run ${w.name}'),
                    ),
                    OutlinedButton.icon(
                      onPressed: () => _openBuilder(w),
                      icon: const Icon(Icons.edit_rounded),
                      label: const Text('Edit'),
                    ),
                    OutlinedButton.icon(
                      onPressed: () => _deleteSaved(w),
                      icon: const Icon(Icons.delete_outline_rounded),
                      label: const Text('Delete'),
                    ),
                  ]
                : [
                    OutlinedButton.icon(
                      onPressed: () => _openBuilder(CheSavedWorkflow(name: w.name, steps: [for (final s in w.steps) s.copy()])),
                      icon: const Icon(Icons.copy_all_rounded),
                      label: Text('Use template: ${w.name}'),
                    ),
                  ],
          ),
        ],
      ),
    );
  }

  Widget _activityTab() {
    final missions = _catalog.missions;
    final runs = _catalog.runs;
    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 32),
      children: [
        const CheSectionHeader('Workflow runs'),
        if (missions.isEmpty) Text('No workflow runs yet.', style: CheType.bodyDim),
        for (final m in missions)
          CheMissionCard(
            key: ValueKey('mission-${m.id}'),
            mission: m,
            busy: _busy,
            onControl: (action, {stepId}) => _control(m, action, stepId: stepId),
          ),
        const CheSectionHeader('Recent commands'),
        if (runs.isEmpty) Text('No commands run yet.', style: CheType.bodyDim),
        for (final r in runs)
          Semantics(
            label: '/${r.command}${r.input.isEmpty ? '' : ' ${r.input}'}: ${cheStepStatusLabel(r.status)}. ${r.reply}',
            excludeSemantics: true,
            child: Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: CheColors.surface,
                borderRadius: BorderRadius.circular(CheRadius.sm),
                border: Border.all(color: CheColors.stroke),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('/${r.command}${r.input.isEmpty ? '' : ' ${r.input}'}',
                            style: CheType.mono.copyWith(color: CheColors.accent)),
                      ),
                      ChePill(text: cheStepStatusLabel(r.status), color: cheStepColor(r.status)),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(r.reply, style: CheType.bodyDim),
                  if (r.source.isNotEmpty) Text('Handled by ${r.source}', style: CheType.caption),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
