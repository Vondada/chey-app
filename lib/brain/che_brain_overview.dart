// The Brain Room as the owner approved it (2026-10-24, his original Brain Room reference): CHE's dark starry
// room with the glowing neural brain as the main attraction, a clean collapsible sidebar of sixteen sections, the
// glowing dashboard cards under the brain, Real-Time Learning, Live Activity, Search and Memory Details.
//
// It is a frame around the existing Brain (CheMemoryBrainRoom: the 3D neural space, its gestures, filters, brain
// switcher and list) and never replaces it. Every count, card, feed row and learning event comes from CHE's real
// records (the phone's Brain replica and the Worker lists, as CheMemoryDot) or the Brain Population Ledger
// (/api/brain/ledger). Empty data shows an empty state; an idle ledger says "Idle — waiting for work".
//
// First glance (owner, 2026-10-25 UI cleanup): seven category regions of one neural brain with real counts
// (che_brain_neural.dart); records appear only in one region sheet at a time. The record-level 3D constellation
// (the [brain] widget) stays mounted for its voice commands and opens only when the owner asks for it.
//
// Quiet by design (AGENTS.md): opening the room, switching sections, polling the ledger and new learning events
// never speak. Explicit voice commands and Read Aloud speak.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_hud.dart';
import '../home/che_memory_brain.dart' show CheMemoryDot;
import 'che_brain_list.dart';
import 'che_brain_neural.dart';
import 'che_brain_regions.dart';
import 'che_brain_sections.dart';
import 'che_brain_space.dart' show CheBrainSpaceController;
import 'che_brain_space_model.dart' show CheBrainAction;

/// Loads the Brain Population Ledger overview (/api/brain/ledger), as CheBrainLedgerClient.overview does.
typedef CheBrainLedgerLoader = Future<Map<String, dynamic>> Function();

/// What the overview keeps under the brain (the collapsed Real-Time Learning bar and the dashboard cards): the
/// Brain room's Soul & facts / Log chips sit above it.
const double cheBrainOverviewChipsInset = 10;

const _glass = Color(0xD9070B1C);
const _rimDim = Color(0x334F6BFF);

class CheBrainOverview extends StatefulWidget {
  const CheBrainOverview({
    super.key,
    required this.brain,
    required this.dots,
    this.brainLinks = const [],
    this.active = true,
    this.loadLearning,
    this.onReadAloud,
    this.onOpenEvidence,
    this.onOpenLedger,
    this.onOpenSource,
    this.initialSection = CheBrainNav.overview,
    this.clock,
    this.pollEvery = const Duration(seconds: 30),
  });

  /// The neural Brain (CheMemoryBrainRoom). Kept mounted while another section is open, paused when hidden.
  final Widget brain;
  final List<CheMemoryDot> dots;
  final List<Map<String, dynamic>> brainLinks;

  /// False when the Brain tab is hidden: no polling, no animation.
  final bool active;

  /// The ledger overview; null when CHE is not connected (the panel then says so).
  final CheBrainLedgerLoader? loadLearning;
  final Future<void> Function(String text)? onReadAloud;
  final CheOpenBrainEvidence? onOpenEvidence;

  /// Opens the full Brain Ledger page (More → Brain Ledger), when the app provides it.
  final VoidCallback? onOpenLedger;

  /// Opens a record's source screen (conversation, trade replay, project, agent desk) where the app has a route.
  final CheOpenBrainSource? onOpenSource;
  final CheBrainNav initialSection;

  /// Test clock; DateTime.now otherwise.
  final DateTime Function()? clock;
  final Duration pollEvery;

  /// True while a region sheet or a section covers the brain: the room's floating chips (CheInsightsRoom) hide so
  /// nothing stacks over the one open panel.
  static final ValueNotifier<bool> chromeHidden = ValueNotifier<bool>(false);

  /// The open Brain Room's voice handler (lib/home_state/send.dart), or null when it is not on screen.
  static Future<String?> Function(String words)? voiceHandler;

  /// Parses a Brain Room phrase into a section, a search or a learning question. Null: not a Brain Room phrase.
  static CheBrainOverviewCommand? parse(String words) {
    final t = words.toLowerCase().replaceAll(RegExp(r'[^a-z0-9& ]'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim().replaceFirst(RegExp(r'^(?:hey )?(?:che|chey|chay) '), '');
    if (t.isEmpty) return null;
    final brainSaid = RegExp(r'\bbrain\b').hasMatch(t);
    if (RegExp(r'^(?:what s|whats|what is|what are) (?:in )?(?:the |my |your )?brain(?: regions)?$|^describe (?:the |my |your )?brain$|^(?:read|list|what are) (?:the )?(?:brain )?regions$|^(?:read|list) (?:the |my |your )?brain$').hasMatch(t)) {
      return CheBrainOverviewCommand(null, summary: true, explicitBrain: brainSaid);
    }
    if (RegExp(r'^(?:go back|back|close|close it|close (?:the |this )?(?:sheet|region|list|panel)|back to (?:the )?brain|go back to (?:the )?brain)$').hasMatch(t)) {
      return const CheBrainOverviewCommand(null, close: true);
    }
    if (RegExp(r'^(?:show|open)(?: me)? (?:the )?(?:detailed |full |record )?constellation$|^(?:show )?(?:every|all) (?:the )?records? in (?:the |my )?brain$|^detailed (?:brain )?view$').hasMatch(t)) {
      return const CheBrainOverviewCommand(null, constellation: true, explicitBrain: true);
    }
    if (RegExp(r'^(?:show|open|back to)(?: me)? (?:the )?(?:brain )?regions$').hasMatch(t)) return const CheBrainOverviewCommand(null, constellation: false);
    final lobeOpen = RegExp(r'^(?:open|show|go to|read)(?: me)? (?:the |my |your )?(.+?)(?: in (?:the|my|your) brain)?$').firstMatch(t);
    if (lobeOpen != null) {
      final name = lobeOpen.group(1)!.trim();
      final lobe = cheBrainLobeFromWords(name);
      if (lobe != null) {
        final region = RegExp(r'\d|^(?:region|number) ').hasMatch(name) ? null : cheBrainRegionFromWords(name);
        final only = region != null && lobe.regions.length > 1 && lobe.regions.contains(region) ? region : null;
        return CheBrainOverviewCommand(null, lobe: lobe, only: only, explicitBrain: brainSaid);
      }
    }
    final search = RegExp(r'^(?:search|find|look up)(?: in)? (?:my |your |the |che s |ches )?brain (?:for|about) (.{1,80})$').firstMatch(t) ??
        RegExp(r'^search (?:my |your |the )?(?:memories|brain) (?:for|about) (.{1,80})$').firstMatch(t);
    if (search != null) return CheBrainOverviewCommand(CheBrainNav.search, query: search.group(1)!.trim());
    if (RegExp(r'^what (?:is|s|are) (?:che|you|she) (?:learning|learning right now|learning now)$|^what (?:is|s) (?:the brain|your brain) learning$|^show (?:me )?(?:the )?real ?time learning$').hasMatch(t)) {
      return const CheBrainOverviewCommand(null, learning: true);
    }
    if (RegExp(r'^(?:open|show|go to)(?: me)? (?:the |my )?(?:brain|brain overview|brain room)$|^brain overview$').hasMatch(t)) return const CheBrainOverviewCommand(CheBrainNav.overview);
    if (RegExp(r'^(?:open |show |go to )?(?:the |my )?(?:sidebar|brain menu)$|^(?:open|show) (?:the )?(?:brain )?sections$').hasMatch(t)) return const CheBrainOverviewCommand(null, sidebar: true);
    final open = RegExp(r'^(?:open|show|go to)(?: me)? (?:the |my |your )?(.+?)(?: in (?:the|my) brain)?$').firstMatch(t);
    if (open == null) return null;
    final name = open.group(1)!.replaceAll(' and ', ' & ').trim();
    for (final s in CheBrainNav.values) {
      final label = s.label.toLowerCase();
      if (name == label || name == label.replaceAll(' & ', ' ') || (s == CheBrainNav.activity && name == 'activity') || (s == CheBrainNav.library && name == 'library')) {
        return CheBrainOverviewCommand(s);
      }
    }
    return null;
  }

  @override
  State<CheBrainOverview> createState() => _CheBrainOverviewState();
}

class CheBrainOverviewCommand {
  const CheBrainOverviewCommand(this.section, {this.query, this.learning = false, this.sidebar = false, this.lobe, this.only, this.summary = false, this.close = false, this.constellation, this.explicitBrain = false});
  final CheBrainNav? section;
  final String? query;
  final bool learning;
  final bool sidebar;

  /// Opens one first-glance region's sheet ("open memory in the brain"), optionally narrowed to one record region.
  final CheBrainLobe? lobe;
  final CheBrainRegion? only;

  /// "What's in the brain": the regions as a numbered list with their real counts.
  final bool summary;

  /// "Go back" / "close": closes the open sheet or section. Not a Brain phrase when nothing is open.
  final bool close;

  /// True shows the detailed record constellation, false returns to the regions.
  final bool? constellation;

  /// The words named the Brain, so the phrase may open the Brain from another screen.
  final bool explicitBrain;
}

class _CheBrainOverviewState extends State<CheBrainOverview> {
  late CheBrainNav _nav = widget.initialSection;
  bool _sidebarOpen = false;
  bool _learningOpen = false;

  // First glance: the region sheet open (one at a time), and whether the record constellation is shown instead.
  CheBrainLobe? _lobe;
  CheBrainRegion? _lobeOnly;
  bool _constellation = false;
  Map<CheBrainLobe, CheBrainLobeStat> _lobes = const {};
  CheBrainLearning _learning = const CheBrainLearning();
  Timer? _poll;
  bool _loading = false;

  // Derived from the records: recomputed only when they change.
  int _sig = 0;
  List<CheBrainLink> _links = const [];
  Map<CheBrainRegion, int> _regions = const {};

  final _query = TextEditingController();
  CheBrainSearchScope _scope = CheBrainSearchScope.all;
  CheBrainActivityFilter _filter = CheBrainActivityFilter.all;

  DateTime get _now => widget.clock?.call() ?? DateTime.now();

  @override
  void initState() {
    super.initState();
    _derive();
    CheBrainOverview.voiceHandler = _voice;
    CheBrainSpaceController.regionOpener = _openRegion;
    CheBrainSpaceController.beforeCommand = _beforeSpaceCommand;
    _syncPolling();
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncChrome());
  }

  @override
  void didUpdateWidget(covariant CheBrainOverview old) {
    super.didUpdateWidget(old);
    _derive();
    if (old.active != widget.active || old.loadLearning != widget.loadLearning) _syncPolling();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _query.dispose();
    if (CheBrainOverview.voiceHandler == _voice) CheBrainOverview.voiceHandler = null;
    if (CheBrainSpaceController.regionOpener == _openRegion) CheBrainSpaceController.regionOpener = null;
    if (CheBrainSpaceController.beforeCommand == _beforeSpaceCommand) CheBrainSpaceController.beforeCommand = null;
    // After the frame (a listener must not rebuild while the tree is being torn down), and only when no other Brain
    // Room took over.
    if (CheBrainOverview.chromeHidden.value) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (CheBrainOverview.voiceHandler == null) CheBrainOverview.chromeHidden.value = false;
      });
    }
    super.dispose();
  }

  void _derive() {
    final sig = Object.hash(Object.hashAll([for (final d in widget.dots) Object.hash(d.id, d.verification, d.status, d.region, d.category)]),
        Object.hashAll([for (final l in widget.brainLinks) Object.hash(l['source'], l['target'])]));
    if (sig == _sig && _regions.isNotEmpty) return;
    _sig = sig;
    _links = cheBrainLinks(widget.dots, brainLinks: widget.brainLinks);
    _regions = cheBrainRegionCounts(widget.dots);
    _lobes = cheBrainLobeStats(widget.dots, now: _now);
  }

  /// Hides the room's floating chips while a sheet or a section covers the brain.
  void _syncChrome() {
    if (!mounted) return;
    final hidden = _lobe != null || _nav != CheBrainNav.overview;
    if (CheBrainOverview.chromeHidden.value != hidden) CheBrainOverview.chromeHidden.value = hidden;
  }

  @override
  void setState(VoidCallback fn) {
    super.setState(fn);
    _syncChrome();
  }

  // A spoken camera command for the record constellation ("zoom in", "fly to the trading region") shows it first,
  // so the owner never commands an invisible view. Reading and opening commands leave the regions on screen.
  static const _visualActions = {
    CheBrainAction.inside, CheBrainAction.filter, CheBrainAction.clearFilter, CheBrainAction.find, CheBrainAction.openSelected,
    CheBrainAction.expand, CheBrainAction.collapse, CheBrainAction.zoomIn, CheBrainAction.zoomOut, CheBrainAction.fit,
    CheBrainAction.centerChe, CheBrainAction.centerSelected, CheBrainAction.openWorker, CheBrainAction.lens, CheBrainAction.list,
    CheBrainAction.space, CheBrainAction.region, CheBrainAction.rotate,
  };

  void _beforeSpaceCommand(CheBrainAction action) {
    if (!mounted || !_visualActions.contains(action) || (_constellation && _lobe == null && _nav == CheBrainNav.overview)) return;
    setState(() {
      _constellation = true;
      _lobe = null;
      _nav = CheBrainNav.overview;
    });
  }

  /// Opens one region's sheet (only one is ever open; a second replaces the first).
  void _openLobe(CheBrainLobe l, {CheBrainRegion? only}) {
    HapticFeedback.selectionClick();
    setState(() {
      _nav = CheBrainNav.overview;
      _sidebarOpen = false;
      _constellation = false;
      _lobe = l;
      _lobeOnly = only;
    });
  }

  void _closeLobe() {
    if (_lobe == null) return;
    HapticFeedback.selectionClick();
    setState(() {
      _lobe = null;
      _lobeOnly = null;
    });
  }

  String _lobesSpoken() {
    final total = widget.dots.length;
    return 'Your brain holds $total record${total == 1 ? '' : 's'} in ${CheBrainLobe.values.length} regions. ${cheBrainLobesSpoken(_lobes)}. '
        'Say open, then a region name or number, to hear its records.';
  }

  // Polls only while the room is on screen; a hidden tab costs nothing.
  void _syncPolling() {
    _poll?.cancel();
    _poll = null;
    if (!widget.active || widget.loadLearning == null) return;
    unawaited(_refreshLearning());
    _poll = Timer.periodic(widget.pollEvery, (_) => unawaited(_refreshLearning()));
  }

  Future<void> _refreshLearning() async {
    final load = widget.loadLearning;
    if (load == null || _loading) return;
    _loading = true;
    try {
      final next = CheBrainLearning.fromLedger(await load(), fetchedAt: _now);
      if (!mounted) return;
      // Real events that arrived since the last look light their region up (never on the first load: an old
      // event is not new learning).
      final fresh = next.newSince(_learning);
      setState(() => _learning = next);
      final space = CheBrainSpaceController.current;
      for (final region in {for (final e in fresh) e.region}) {
        space?.illuminate(region);
      }
    } catch (e) {
      if (!mounted) return;
      final msg = '$e'.replaceFirst('Exception: ', '');
      setState(() => _learning = CheBrainLearning(events: _learning.events, connections: _learning.connections, totals: _learning.totals, fetchedAt: _learning.fetchedAt, error: msg));
    } finally {
      _loading = false;
    }
  }

  void _open(CheBrainNav nav, {bool closeSidebar = true}) {
    HapticFeedback.selectionClick();
    setState(() {
      _nav = nav;
      if (closeSidebar) _sidebarOpen = false;
    });
  }

  Future<String?> _voice(String words) async {
    final cmd = CheBrainOverview.parse(words);
    if (cmd == null) return null;
    if (cmd.close) {
      if (_lobe != null) {
        final name = _lobe!.label;
        _closeLobe();
        return 'Closed $name. Back at the brain: ${CheBrainLobe.values.length} regions.';
      }
      if (_nav != CheBrainNav.overview) {
        _open(CheBrainNav.overview);
        return 'Back at the brain overview.';
      }
      return null;
    }
    if (cmd.summary) {
      setState(() => _lobe = null);
      return _lobesSpoken();
    }
    if (cmd.constellation != null) {
      setState(() {
        _constellation = cmd.constellation!;
        _lobe = null;
        _nav = CheBrainNav.overview;
      });
      return cmd.constellation!
          ? 'Showing the detailed constellation of every record. Say show the brain regions to go back.'
          : 'Showing the brain regions. ${cheBrainLobesSpoken(_lobes)}.';
    }
    if (cmd.lobe != null) {
      final l = cmd.lobe!;
      _openLobe(l, only: cmd.only);
      final list = cheBrainLobeRecords(l, widget.dots, only: cmd.only);
      final stat = _lobes[l] ?? const CheBrainLobeStat();
      final scope = cmd.only == null ? '' : ' Showing ${cmd.only!.label.toLowerCase()} only: ${list.length} record${list.length == 1 ? '' : 's'}.';
      return 'Opened ${cheBrainLobeSummary(l, stat, list)}$scope Say go back to return to the brain.';
    }
    if (cmd.sidebar) {
      setState(() => _sidebarOpen = true);
      return 'The Brain sections are open: ${[for (final (i, s) in CheBrainNav.values.indexed) '${i + 1}, ${s.label}'].join('; ')}.';
    }
    if (cmd.learning) {
      if (widget.loadLearning != null) await _refreshLearning();
      _open(CheBrainNav.activity);
      setState(() => _learningOpen = true);
      return _learningSpoken();
    }
    final nav = cmd.section!;
    if (nav == CheBrainNav.search) {
      _query.text = cmd.query ?? '';
      _scope = CheBrainSearchScope.all;
      _open(nav);
      final r = cheBrainSearchScoped(widget.dots, _query.text, _scope);
      if (r.results.isEmpty) return 'Nothing in the Brain matches "${_query.text}".';
      final top = r.results.take(3).map((d) => d.title).join('; ');
      return '${r.results.length} result${r.results.length == 1 ? '' : 's'} for "${_query.text}". Newest: $top.';
    }
    _open(nav);
    return _spokenFor(nav);
  }

  String _learningSpoken() {
    final l = _learning;
    if (widget.loadLearning == null) return 'I cannot read my learning ledger until CHE is connected on this iPhone.';
    final head = l.headline(_now);
    if (l.events.isEmpty) return head;
    return '$head ${[for (final e in l.events.take(3)) '${e.kind}: ${e.title}, ${e.time.isEmpty ? cheBrainAgo(e.at, now: _now) : e.time}, ${e.status.isEmpty ? 'status not recorded' : e.status}'].join('. ')}.';
  }

  String _spokenFor(CheBrainNav nav) {
    switch (nav) {
      case CheBrainNav.overview:
        return _lobesSpoken();
      case CheBrainNav.activity:
        final a = cheBrainActivity(widget.dots, limit: 3);
        final links = _learning.connections;
        final linked = links.isEmpty ? '' : ' ${links.length} new connection${links.length == 1 ? '' : 's'}. Newest: ${links.first.fromLabel} and ${links.first.toLabel}, ${links.first.reason}.';
        return a.isEmpty ? 'Live Activity: no dated records yet.$linked' : 'Live Activity. Newest: ${a.map((d) => '${d.title}, ${cheBrainAgo(d.at, now: _now)}').join('; ')}.$linked';
      case CheBrainNav.search:
        return 'Search the Brain. Say search my brain for, then the words.';
      case CheBrainNav.connections:
        final c = cheBrainLinkCounts(_links);
        return 'Connections: ${c[CheBrainLinkStrength.verified]} strong, ${c[CheBrainLinkStrength.developing]} developing, ${c[CheBrainLinkStrength.weak]} weak.';
      case CheBrainNav.verification:
        final v = _regions[CheBrainRegion.verified]!;
        return 'Verification: $v of ${widget.dots.length} records verified, ${_regions[CheBrainRegion.errors]} failed or disputed.';
      case CheBrainNav.analytics:
        return 'Analytics: ${widget.dots.length} records and ${_links.length} connections.';
      default:
        final list = cheBrainNavRecords(nav, widget.dots);
        return list.isEmpty
            ? '${nav.label}: no records on this phone yet.'
            : '${nav.label}: ${list.length} record${list.length == 1 ? '' : 's'}. Newest: ${list.take(2).map((d) => d.title).join('; ')}.';
    }
  }

  void _details(CheMemoryDot d) {
    HapticFeedback.selectionClick();
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheBrainRecordDetails(
        dot: d,
        links: _links,
        onReadAloud: widget.onReadAloud,
        onOpenEvidence: widget.onOpenEvidence,
        onOpenSource: widget.onOpenSource,
        now: _now,
      ),
    ));
  }

  /// A region's own page: its real records, newest first, each opening Memory Details. Voice ("open the memory
  /// region"), VoiceOver (the region labels) and touch all come here.
  void _openRegion(CheBrainRegion r) {
    if (!mounted) return;
    if (r != CheBrainRegion.verified) {
      final l = cheBrainLobeOfRegion(r);
      _openLobe(l, only: l.regions.length > 1 ? r : null);
      return;
    }
    HapticFeedback.selectionClick();
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheBrainRegionDetails(
        region: r,
        dots: widget.dots,
        links: _links,
        onReadAloud: widget.onReadAloud,
        onOpenEvidence: widget.onOpenEvidence,
        onOpenSource: widget.onOpenSource,
        now: _now,
      ),
    ));
  }

  /// One CONNECTION_CREATED event's page: both records, the reason, the status and when.
  void _openConnection(CheBrainConnectionEvent e) {
    HapticFeedback.selectionClick();
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheBrainConnectionDetails(
        event: e,
        dots: widget.dots,
        links: _links,
        onReadAloud: widget.onReadAloud,
        onOpenEvidence: widget.onOpenEvidence,
        onOpenSource: widget.onOpenSource,
        now: _now,
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final wide = media.size.width >= 720;
    final scaled = media.copyWith(textScaler: media.textScaler.clamp(minScaleFactor: 1.0, maxScaleFactor: 1.25));
    final onOverview = _nav == CheBrainNav.overview;
    final body = Stack(
      children: [
        // The brain stays mounted (its camera and selection survive a section visit) but stops animating when hidden.
        Offstage(
          offstage: !onOverview,
          child: TickerMode(enabled: onOverview && widget.active, child: _overviewBody()),
        ),
        if (!onOverview) Positioned.fill(child: KeyedSubtree(key: ValueKey('brain-section-${_nav.name}'), child: _section())),
        if (!wide && _sidebarOpen) ...[
          Positioned.fill(
            child: Semantics(
              button: true,
              label: 'Close the Brain sections',
              excludeSemantics: true,
              child: GestureDetector(onTap: () => setState(() => _sidebarOpen = false), child: const ColoredBox(color: Color(0x99000000))),
            ),
          ),
          Positioned(top: 0, bottom: 0, left: 0, width: 248, child: _sidebar(overlay: true)),
        ],
      ],
    );
    return MediaQuery(
      data: scaled,
      child: Material(
        type: MaterialType.transparency,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(wide),
            Expanded(
              child: wide && _sidebarOpen ? Row(children: [SizedBox(width: 232, child: _sidebar()), Expanded(child: body)]) : body,
            ),
          ],
        ),
      ),
    );
  }

  // ─── Header ───────────────────────────────────────────────────────────────

  Widget _header(bool wide) {
    final live = _learning.isActive(_now);
    return SizedBox(
      height: 48,
      child: Row(
        children: [
          _iconButton(Icons.grid_view_rounded, _sidebarOpen ? 'Hide the Brain sections' : 'Show the Brain sections: overview, activity, search and thirteen more', () {
            HapticFeedback.selectionClick();
            setState(() => _sidebarOpen = !_sidebarOpen);
          }, key: const ValueKey('brain-sidebar-toggle'), on: _sidebarOpen),
          if (_nav != CheBrainNav.overview)
            _iconButton(Icons.arrow_back_rounded, 'Back to the Brain overview', () => _open(CheBrainNav.overview), key: const ValueKey('brain-back')),
          Expanded(
            child: Semantics(
              header: true,
              label: _nav == CheBrainNav.overview ? 'CHE Brain' : 'CHE Brain, ${_nav.label}',
              excludeSemantics: true,
              child: Align(
                alignment: Alignment.centerLeft,
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: CheChromeText(_nav == CheBrainNav.overview ? 'CHE BRAIN' : _nav.label.toUpperCase(), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, letterSpacing: 2.2), maxLines: 1),
                ),
              ),
            ),
          ),
          Semantics(
            label: live ? 'Live: CHE is learning now' : (widget.loadLearning == null ? 'Learning feed not connected' : 'Idle: waiting for work'),
            excludeSemantics: true,
            child: Container(
              key: const ValueKey('brain-live-pill'),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                color: (live ? const Color(0xFFFF4FC8) : Colors.white24).withValues(alpha: .14),
                border: Border.all(color: (live ? const Color(0xFFFF4FC8) : Colors.white38).withValues(alpha: .6)),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Container(width: 7, height: 7, decoration: BoxDecoration(shape: BoxShape.circle, color: live ? const Color(0xFFFF4FC8) : Colors.white54)),
                const SizedBox(width: 6),
                Text(live ? 'Live' : 'Idle', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: live ? const Color(0xFFFFB8E8) : Colors.white70)),
              ]),
            ),
          ),
          if (_nav == CheBrainNav.overview && _lobe == null) ...[
            _iconButton(_constellation ? Icons.blur_on_rounded : Icons.hub_rounded, _constellation ? 'Back to the brain regions' : 'Show the detailed constellation of every record', () {
              HapticFeedback.selectionClick();
              setState(() => _constellation = !_constellation);
            }, key: const ValueKey('brain-constellation-toggle'), on: _constellation),
            if (widget.onReadAloud != null)
              _iconButton(Icons.volume_up_rounded, 'Read the brain aloud', () => unawaited(widget.onReadAloud!(_lobesSpoken())), key: const ValueKey('brain-read-aloud')),
          ],
          _iconButton(Icons.search_rounded, 'Search the Brain', () => _open(CheBrainNav.search), key: const ValueKey('brain-header-search'), on: _nav == CheBrainNav.search),
          const SizedBox(width: 4),
        ],
      ),
    );
  }

  Widget _iconButton(IconData icon, String label, VoidCallback onTap, {Key? key, bool on = false}) => Semantics(
        button: true,
        selected: on,
        label: label,
        excludeSemantics: true,
        child: IconButton(
          key: key,
          tooltip: label,
          constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
          icon: Icon(icon, size: 21, color: on ? CheHud.ice : Colors.white70),
          onPressed: onTap,
        ),
      );

  // ─── Sidebar ──────────────────────────────────────────────────────────────

  Widget _sidebar({bool overlay = false}) {
    return Container(
      key: const ValueKey('brain-sidebar'),
      decoration: BoxDecoration(
        color: overlay ? const Color(0xFF050816) : _glass,
        border: const Border(right: BorderSide(color: _rimDim)),
      ),
      child: SafeArea(
        top: false,
        right: false,
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: 6),
          children: [
            for (final s in CheBrainNav.values) _sideItem(s),
            if (widget.onOpenLedger != null) ...[
              const Divider(color: _rimDim, height: 16),
              ListTile(
                dense: true,
                leading: const Icon(Icons.history_rounded, size: 20, color: Colors.white70),
                title: const Text('Full Brain Ledger', style: TextStyle(color: Colors.white70, fontSize: 14)),
                onTap: widget.onOpenLedger,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _sideItem(CheBrainNav s) {
    final on = s == _nav;
    return Semantics(
      button: true,
      selected: on,
      label: '${s.label}. ${s.meaning}',
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey('brain-nav-${s.name}'),
        onTap: () => _open(s),
        child: Container(
          height: 44,
          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            color: on ? s.color.withValues(alpha: .16) : null,
            border: on ? Border.all(color: s.color.withValues(alpha: .55)) : null,
          ),
          child: Row(children: [
            Icon(s.icon, size: 20, color: on ? s.color : Colors.white70),
            const SizedBox(width: 12),
            Expanded(child: Text(s.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14.5, color: on ? Colors.white : Colors.white.withValues(alpha: .82), fontWeight: on ? FontWeight.w600 : FontWeight.w400))),
          ]),
        ),
      ),
    );
  }

  // ─── Overview: seven regions, one sheet at a time ────────────────────────

  Widget _overviewBody() {
    final lobe = _lobe;
    return PopScope(
      // The system back gesture closes the open sheet first, then leaves the room as before.
      canPop: lobe == null,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _closeLobe();
      },
      child: LayoutBuilder(builder: (context, c) {
        final sheetHeight = c.maxHeight * .72;
        return Stack(
          fit: StackFit.expand,
          children: [
            // The record constellation: mounted (its voice commands and camera survive), shown only on request.
            Offstage(
              offstage: !_constellation,
              child: TickerMode(enabled: _constellation, child: widget.brain),
            ),
            if (!_constellation)
              Positioned.fill(
                child: ExcludeSemantics(
                  // While a sheet is open VoiceOver stays in the sheet: one panel, nothing behind it to wander into.
                  excluding: lobe != null,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        child: TickerMode(
                          enabled: lobe == null,
                          child: CheBrainNeuralView(key: const ValueKey('brain-neural'), stats: _lobes, selected: lobe, onOpen: (l) => lobe == l ? _closeLobe() : _openLobe(l)),
                        ),
                      ),
                      _statusLine(),
                    ],
                  ),
                ),
              ),
            if (lobe != null) ...[
              Positioned.fill(
                bottom: sheetHeight - 12,
                child: Semantics(
                  button: true,
                  label: 'Close ${lobe.label} and go back to the brain',
                  excludeSemantics: true,
                  child: GestureDetector(key: const ValueKey('brain-lobe-barrier'), onTap: _closeLobe, child: const ColoredBox(color: Color(0x66000000))),
                ),
              ),
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                height: sheetHeight,
                child: CheBrainLobeSheet(
                  key: const ValueKey('brain-lobe-sheet'),
                  lobe: lobe,
                  initialOnly: _lobeOnly,
                  dots: widget.dots,
                  stat: _lobes[lobe] ?? const CheBrainLobeStat(),
                  now: _now,
                  onClose: _closeLobe,
                  onOpenRecord: _details,
                  onReadAloud: widget.onReadAloud,
                ),
              ),
            ],
          ],
        );
      }),
    );
  }

  /// One quiet line under the brain: totals and what CHE is learning. Muted text, never announced on its own;
  /// activating it opens Live Activity.
  Widget _statusLine() {
    final total = widget.dots.length;
    final verified = _regions[CheBrainRegion.verified] ?? 0;
    final fresh = _lobes.values.fold<int>(0, (a, s) => a + s.fresh);
    final learning = widget.loadLearning == null ? 'Learning feed not connected' : (_learning.isActive(_now) ? 'Learning now' : 'Idle, waiting for work');
    final text = '${_fmt(total)} record${total == 1 ? '' : 's'} · ${_fmt(verified)} verified${fresh > 0 ? ' · $fresh new today' : ''} · $learning';
    return Semantics(
      button: true,
      label: '$text. Opens Live Activity.',
      excludeSemantics: true,
      child: InkWell(
        key: const ValueKey('brain-status'),
        onTap: () => _open(CheBrainNav.activity),
        child: Padding(
          // Leaves the right side to the room's Soul & facts and Log chips.
          padding: const EdgeInsets.fromLTRB(18, 10, 196, 14),
          child: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, height: 1.3, color: Colors.white60)),
        ),
      ),
    );
  }

  Widget _learningPanel() {
    final l = _learning;
    final now = _now;
    final live = l.isActive(now);
    final head = widget.loadLearning == null ? 'Learning feed not connected: CHE shows it once this iPhone is paired.' : l.headline(now);
    final events = l.events.take(_learningOpen ? 5 : 0).toList();
    return Container(
      key: const ValueKey('brain-learning'),
      margin: const EdgeInsets.fromLTRB(10, 4, 10, 6),
      decoration: BoxDecoration(
        color: _glass,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: (live ? const Color(0xFFFF4FC8) : const Color(0xFF6E5BFF)).withValues(alpha: .45)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: _learningOpen,
            label: 'Real-Time Learning. $head',
            excludeSemantics: true,
            child: InkWell(
              key: const ValueKey('brain-learning-toggle'),
              borderRadius: BorderRadius.circular(16),
              onTap: () => setState(() => _learningOpen = !_learningOpen),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
                child: Row(children: [
                  Icon(Icons.auto_awesome_rounded, size: 18, color: live ? const Color(0xFFFF8FD8) : const Color(0xFFB9A8FF)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const Text('Real-Time Learning', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: Colors.white)),
                      Text(head, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Colors.white70)),
                    ]),
                  ),
                  if (l.events.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Text('${l.events.length} recent', style: const TextStyle(fontSize: 11.5, color: Colors.white54)),
                    ),
                  Icon(_learningOpen ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: Colors.white60),
                ]),
              ),
            ),
          ),
          if (_learningOpen) ...[
            if (l.totals.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
                child: Text(
                  '${l.totals['knowledge'] ?? 0} knowledge · ${l.totals['procedures'] ?? 0} procedures · ${l.totals['capabilities'] ?? 0} verified capabilities · ${l.totals['pending'] ?? 0} pending · ${l.totals['failed'] ?? 0} failed',
                  style: const TextStyle(fontSize: 11.5, color: Colors.white60),
                ),
              ),
            for (final e in events) _learningRow(e, now),
            if (events.isEmpty)
              const Padding(
                padding: EdgeInsets.fromLTRB(12, 0, 12, 10),
                child: Text('Nothing has entered the Brain yet. Nothing is shown until something really does.', style: TextStyle(fontSize: 12, color: Colors.white60)),
              ),
            const SizedBox(height: 4),
          ],
        ],
      ),
    );
  }

  Widget _learningRow(CheBrainLearningEvent e, DateTime now) {
    final p = e.progress;
    return Semantics(
      label: e.spoken.isNotEmpty ? e.spoken : '${e.kind}. ${e.title}. ${e.time}. ${e.sourceWords}. ${e.status}.',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 2, 12, 8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(margin: const EdgeInsets.only(top: 5), width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: e.region.color, boxShadow: [BoxShadow(color: e.region.color, blurRadius: 6)])),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${e.kind} · ${e.title}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: Colors.white)),
              Text('${e.time.isEmpty ? cheBrainAgo(e.at, now: now) : e.time} · ${e.category}${e.subcategory.isEmpty ? '' : ' › ${e.subcategory}'} · ${e.sourceWords}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5, color: Colors.white54)),
              if (p != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(value: p, minHeight: 3, backgroundColor: Colors.white10, color: e.region.color),
                  ),
                ),
            ]),
          ),
          const SizedBox(width: 8),
          _chip(e.status.isEmpty ? 'Not recorded' : e.status, e.region.color),
        ]),
      ),
    );
  }

  // ─── Sections ─────────────────────────────────────────────────────────────

  Widget _section() => switch (_nav) {
    CheBrainNav.activity => _activity(),
    CheBrainNav.search => _search(),
    CheBrainNav.connections => _connections(),
    CheBrainNav.verification => _verification(),
    CheBrainNav.analytics => _analytics(),
    CheBrainNav.overview => const SizedBox.shrink(),
    _ => _recordSection(_nav),
  };

  Widget _sectionIntro(CheBrainNav s, String count) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
        child: Semantics(
          label: '${s.label}. $count. ${s.meaning}',
          excludeSemantics: true,
          child: Row(children: [
            Icon(s.icon, color: s.color, size: 20),
            const SizedBox(width: 8),
            Expanded(child: Text(s.meaning, style: const TextStyle(fontSize: 13, color: Colors.white70))),
            Text(count, style: TextStyle(fontSize: 13, color: s.color, fontWeight: FontWeight.w700)),
          ]),
        ),
      );

  Widget _empty(String text) => Padding(
        padding: const EdgeInsets.all(24),
        child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white60, fontSize: 14)),
      );

  Widget _recordSection(CheBrainNav s) {
    final list = cheBrainNavRecords(s, widget.dots);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _sectionIntro(s, '${list.length} record${list.length == 1 ? '' : 's'}'),
      if (s == CheBrainNav.learningTasks && _learning.totals.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Text('The learning ledger: ${_learning.totals['pending'] ?? 0} pending, ${_learning.totals['failed'] ?? 0} failed to index.', style: const TextStyle(fontSize: 12.5, color: Colors.white60)),
        ),
      Expanded(
        child: list.isEmpty
            ? _empty('No ${s.label.toLowerCase()} records on this phone yet. The Brain fills as CHE works; nothing is invented.')
            : ListView.builder(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 24),
                itemCount: list.length,
                itemBuilder: (_, i) => _recordTile(list[i]),
              ),
      ),
    ]);
  }

  Widget _connectionRow(CheBrainConnectionEvent e) {
    final when = e.time.isEmpty ? cheBrainAgo(e.at, now: _now) : e.time;
    const color = Color(0xFFB98BFF);
    return Semantics(
      button: true,
      label: 'Connection created: ${e.fromLabel} and ${e.toLabel}. Reason: ${e.reason}. ${e.statusWords}. $when. Opens the connection.',
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey('brain-connection-${e.id}'),
        borderRadius: BorderRadius.circular(14),
        onTap: () => _openConnection(e),
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: _glass, borderRadius: BorderRadius.circular(14), border: Border.all(color: color.withValues(alpha: .35))),
          child: Row(children: [
            const Icon(Icons.hub_rounded, color: color, size: 26),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Connection created', style: TextStyle(fontSize: 14.5, color: Colors.white, fontWeight: FontWeight.w600)),
                Text('${e.fromLabel}  ↔  ${e.toLabel}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: Colors.white70)),
                const SizedBox(height: 3),
                Text('$when · ${e.reason}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5, color: Colors.white54)),
              ]),
            ),
            _chip(e.statusWords, color),
          ]),
        ),
      ),
    );
  }

  Widget _activity() {
    final onlyLinks = _filter == CheBrainActivityFilter.connections;
    final list = onlyLinks ? const <CheMemoryDot>[] : cheBrainActivity(widget.dots, filter: _filter);
    final links = _filter == CheBrainActivityFilter.all ? _learning.connections.take(3).toList() : onlyLinks ? _learning.connections : const <CheBrainConnectionEvent>[];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      // Real-Time Learning lives here now (it used to sit under the brain as a stacked panel).
      _learningPanel(),
      SizedBox(
        height: 46,
        // A plain row in a scroller (not a lazy list): every filter exists for VoiceOver and voice, even off screen.
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          child: Row(children: [
            for (final f in CheBrainActivityFilter.values)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: Semantics(
                  button: true,
                  selected: f == _filter,
                  label: 'Show ${f.label.toLowerCase()} activity',
                  excludeSemantics: true,
                  child: ChoiceChip(
                    key: ValueKey('brain-activity-${f.name}'),
                    label: Text(f.label),
                    selected: f == _filter,
                    onSelected: (_) => setState(() => _filter = f),
                  ),
                ),
              ),
          ]),
        ),
      ),
      Expanded(
        child: list.isEmpty && links.isEmpty
            ? _empty(onlyLinks
                ? (widget.loadLearning == null
                    ? 'Connections come from the Brain Ledger, which is read once this iPhone is paired with CHE.'
                    : 'No connection has been recorded yet. One appears when CHE really links two records.')
                : _filter == CheBrainActivityFilter.all
                ? 'No dated activity on this phone yet.'
                : 'No ${_filter.label.toLowerCase()} activity yet.')
            : ListView.builder(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 24),
                itemCount: links.length + list.length,
                itemBuilder: (_, i) => i < links.length ? _connectionRow(links[i]) : _recordTile(list[i - links.length], activity: true),
              ),
      ),
    ]);
  }

  String _activityVerb(CheMemoryDot d) => switch (cheBrainRegionOf(d)) {
    CheBrainRegion.research => 'Research',
    CheBrainRegion.memories => 'Memory saved',
    CheBrainRegion.conversations => 'Conversation',
    CheBrainRegion.media => 'Media saved',
    CheBrainRegion.creative => 'Creative work',
    CheBrainRegion.trading => 'Trading research',
    CheBrainRegion.coding => 'Coding',
    CheBrainRegion.agents => d.outcome == 'done' ? 'Agent task completed' : 'Agent work',
    CheBrainRegion.errors => 'Failed',
    _ => 'Knowledge',
  };

  Widget _recordTile(CheMemoryDot d, {bool activity = false, String query = ''}) {
    final region = cheBrainRegionOf(d);
    final status = cheBrainStatusOf(d);
    final thumb = cheBrainThumbnailOf(d);
    final title = activity ? _activityVerb(d) : d.title;
    final line = activity ? d.title : d.body.replaceAll(RegExp(r'\s+'), ' ');
    final matches = query.isEmpty ? 0 : cheBrainMatchCount(d, query);
    return Semantics(
      button: true,
      label: '$title. ${activity ? d.title : ''} ${region.label}. ${status.label}. ${cheBrainAgo(d.at, now: _now)}.${matches > 0 ? ' $matches match${matches == 1 ? '' : 'es'}.' : ''} Opens the record.',
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey('brain-record-${d.id}'),
        borderRadius: BorderRadius.circular(14),
        onTap: () => _details(d),
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(color: _glass, borderRadius: BorderRadius.circular(14), border: Border.all(color: region.color.withValues(alpha: .28))),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _thumb(region, thumb, 64),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14.5, color: Colors.white, fontWeight: FontWeight.w600))),
                  if (matches > 0) _chip('$matches match${matches == 1 ? '' : 'es'}', const Color(0xFFB98BFF)),
                ]),
                const SizedBox(height: 2),
                if (query.isNotEmpty)
                  Text.rich(
                    TextSpan(children: [
                      for (final (t, hit) in cheBrainHighlight(line, query, window: 96))
                        TextSpan(
                          text: t,
                          style: hit ? const TextStyle(color: Colors.white, backgroundColor: Color(0xCCE0284A), fontWeight: FontWeight.w700) : null,
                        ),
                    ]),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13, color: Colors.white70),
                  )
                else
                  Text(line, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: Colors.white70)),
                const SizedBox(height: 4),
                Row(children: [
                  Text(cheBrainAgo(d.at, now: _now), style: const TextStyle(fontSize: 11.5, color: Colors.white54)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Wrap(alignment: WrapAlignment.end, spacing: 4, runSpacing: 4, children: [
                      _chip(region.label, region.color),
                      _chip(status.label, status == CheBrainStatus.verified ? const Color(0xFF2EE57A) : status == CheBrainStatus.failed ? CheBrainRegion.errors.color : Colors.white54),
                    ]),
                  ),
                ]),
              ]),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _search() {
    final q = _query.text;
    final r = cheBrainSearchScoped(widget.dots, q, _scope);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 2, 12, 6),
        child: TextField(
          key: const ValueKey('brain-search-field'),
          controller: _query,
          autofocus: q.isEmpty,
          textInputAction: TextInputAction.search,
          onChanged: (_) => setState(() {}),
          style: const TextStyle(fontSize: 16, color: Colors.white),
          decoration: InputDecoration(
            hintText: 'Search memories, conversations, media, research, knowledge',
            hintStyle: const TextStyle(color: Colors.white38, fontSize: 14),
            prefixIcon: const Icon(Icons.search_rounded, color: Colors.white70),
            suffixIcon: q.isEmpty ? null : IconButton(tooltip: 'Clear the search', icon: const Icon(Icons.close_rounded), onPressed: () => setState(_query.clear)),
            filled: true,
            fillColor: const Color(0x22A0B4FF),
            contentPadding: const EdgeInsets.symmetric(vertical: 10),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(999), borderSide: const BorderSide(color: _rimDim)),
            enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(999), borderSide: const BorderSide(color: _rimDim)),
          ),
        ),
      ),
      if (q.trim().isNotEmpty)
        SizedBox(
          height: 44,
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Row(children: [
              for (final s in CheBrainSearchScope.values)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Semantics(
                    button: true,
                    selected: s == _scope,
                    label: '${s.label}: ${r.counts[s]} results',
                    excludeSemantics: true,
                    child: ChoiceChip(
                      key: ValueKey('brain-search-scope-${s.name}'),
                      label: Text('${s.label} (${r.counts[s]})'),
                      selected: s == _scope,
                      onSelected: (_) => setState(() => _scope = s),
                    ),
                  ),
                ),
            ]),
          ),
        ),
      Expanded(
        child: q.trim().isEmpty
            ? _empty('Type or say "search my brain for", then the words. Results come only from records on this phone.')
            : r.results.isEmpty
            ? _empty('Nothing in the Brain matches "$q"${_scope == CheBrainSearchScope.all ? '' : ' in ${_scope.label}'}.')
            : ListView.builder(
                padding: const EdgeInsets.fromLTRB(10, 4, 10, 24),
                itemCount: r.results.length,
                itemBuilder: (_, i) => _recordTile(r.results[i], query: q),
              ),
      ),
    ]);
  }

  Widget _connections() {
    final counts = cheBrainLinkCounts(_links);
    final sorted = [..._links]..sort((a, b) => b.strength.index.compareTo(a.strength.index));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _sectionIntro(CheBrainNav.connections, '${_links.length} links'),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
        child: Wrap(spacing: 8, runSpacing: 6, children: [
          for (final s in CheBrainLinkStrength.values.reversed)
            Semantics(
              label: '${s.label}: ${counts[s]}. ${s.meaning}',
              excludeSemantics: true,
              child: _chip('${s.label} ${counts[s]}', s.color),
            ),
        ]),
      ),
      Expanded(
        child: sorted.isEmpty
            ? _empty('No connections yet: records connect once they share a recorded relationship or topic.')
            : ListView.builder(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 24),
                itemCount: sorted.length.clamp(0, 400),
                itemBuilder: (_, i) {
                  final l = sorted[i];
                  return Semantics(
                    button: true,
                    label: '${l.strength.label} connection: ${l.a.title} and ${l.b.title}. Opens ${l.a.title}.',
                    excludeSemantics: true,
                    child: ListTile(
                      dense: true,
                      onTap: () => _details(l.a),
                      leading: Icon(Icons.hub_rounded, color: l.strength.color, size: 20),
                      title: Text('${l.a.title}  ↔  ${l.b.title}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 13.5)),
                      trailing: _chip(l.strength.label, l.strength.color),
                    ),
                  );
                },
              ),
      ),
    ]);
  }

  Widget _verification() {
    final groups = {for (final s in CheBrainStatus.values) s: <CheMemoryDot>[]};
    for (final d in widget.dots) {
      groups[cheBrainStatusOf(d)]!.add(d);
    }
    for (final g in groups.values) {
      g.sort((a, b) => (b.at ?? DateTime(0)).compareTo(a.at ?? DateTime(0)));
    }
    final order = [CheBrainStatus.verified, CheBrainStatus.pending, CheBrainStatus.unverified, CheBrainStatus.failed];
    return ListView(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 24),
      children: [
        _sectionIntro(CheBrainNav.verification, '${groups[CheBrainStatus.verified]!.length} verified'),
        for (final s in order) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 10, 6, 6),
            child: Semantics(header: true, child: Text('${s.label} · ${groups[s]!.length}', style: const TextStyle(fontSize: 15, color: Colors.white, fontWeight: FontWeight.w700))),
          ),
          if (groups[s]!.isEmpty) Padding(padding: const EdgeInsets.only(left: 6, bottom: 4), child: Text('None.', style: const TextStyle(color: Colors.white54))),
          for (final d in groups[s]!.take(25)) _recordTile(d),
          if (groups[s]!.length > 25) Padding(padding: const EdgeInsets.only(left: 6), child: Text('and ${groups[s]!.length - 25} more (search to find one).', style: const TextStyle(color: Colors.white54, fontSize: 12.5))),
        ],
      ],
    );
  }

  Widget _analytics() {
    final total = widget.dots.length;
    final now = _now;
    final weeks = List<int>.filled(8, 0);
    var undated = 0;
    for (final d in widget.dots) {
      final at = d.at;
      if (at == null) {
        undated++;
        continue;
      }
      final w = now.difference(at).inDays ~/ 7;
      if (w >= 0 && w < 8) weeks[7 - w]++;
    }
    final maxWeek = weeks.fold<int>(1, (a, b) => b > a ? b : a);
    final maxRegion = _regions.values.fold<int>(1, (a, b) => b > a ? b : a);
    final links = cheBrainLinkCounts(_links);
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 24),
      children: [
        _sectionIntro(CheBrainNav.analytics, '$total records'),
        const Text('Records by region', style: TextStyle(fontSize: 15, color: Colors.white, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        for (final r in CheBrainRegion.values)
          Semantics(
            label: '${r.label}: ${_regions[r]}',
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(children: [
                SizedBox(width: 104, child: Text(r.label, style: TextStyle(color: r.color, fontSize: 13))),
                Expanded(
                  child: LayoutBuilder(
                    builder: (_, c) => Align(
                      alignment: Alignment.centerLeft,
                      child: Container(
                        height: 10,
                        width: c.maxWidth * (_regions[r]! / maxRegion),
                        decoration: BoxDecoration(color: r.color.withValues(alpha: .75), borderRadius: BorderRadius.circular(5), boxShadow: [BoxShadow(color: r.color.withValues(alpha: .4), blurRadius: 6)]),
                      ),
                    ),
                  ),
                ),
                SizedBox(width: 52, child: Text(_fmt(_regions[r]!), textAlign: TextAlign.right, style: const TextStyle(color: Colors.white, fontSize: 13, fontFeatures: [FontFeature.tabularFigures()]))),
              ]),
            ),
          ),
        const SizedBox(height: 16),
        const Text('New records per week (last 8 weeks)', style: TextStyle(fontSize: 15, color: Colors.white, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Semantics(
          label: 'New records per week, oldest first: ${weeks.join(', ')}.${undated > 0 ? ' $undated records have no date.' : ''}',
          excludeSemantics: true,
          child: SizedBox(
            height: 96,
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              for (final (i, n) in weeks.indexed)
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 3),
                    child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                      Text('$n', style: const TextStyle(fontSize: 10.5, color: Colors.white60)),
                      const SizedBox(height: 2),
                      Container(height: 70 * n / maxWeek + 1, decoration: BoxDecoration(color: CheHud.ice.withValues(alpha: i == 7 ? .9 : .5), borderRadius: BorderRadius.circular(3))),
                    ]),
                  ),
                ),
            ]),
          ),
        ),
        if (undated > 0) Padding(padding: const EdgeInsets.only(top: 4), child: Text('$undated record${undated == 1 ? '' : 's'} have no recorded date and are not in the chart.', style: const TextStyle(fontSize: 12, color: Colors.white54))),
        const SizedBox(height: 16),
        const Text('Knowledge strength', style: TextStyle(fontSize: 15, color: Colors.white, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        for (final s in CheBrainLinkStrength.values.reversed)
          Semantics(
            label: '${s.label}: ${links[s]} links. ${s.meaning}',
            excludeSemantics: true,
            child: ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: Container(width: 12, height: 12, decoration: BoxDecoration(shape: BoxShape.circle, color: s.color, boxShadow: [BoxShadow(color: s.color, blurRadius: 6)])),
              title: Text('${s.label} · ${links[s]}', style: const TextStyle(color: Colors.white, fontSize: 14)),
              subtitle: Text(s.meaning, style: const TextStyle(color: Colors.white54, fontSize: 12)),
            ),
          ),
      ],
    );
  }
}

// ─── Shared bits ──────────────────────────────────────────────────────────

String _fmt(int n) {
  final s = '$n';
  final out = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) out.write(',');
    out.write(s[i]);
  }
  return out.toString();
}

Widget _chip(String text, Color color) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(999), color: color.withValues(alpha: .14), border: Border.all(color: color.withValues(alpha: .55))),
      child: Text(text, style: TextStyle(fontSize: 11, color: Color.lerp(color, Colors.white, .35), fontWeight: FontWeight.w600)),
    );

/// A record's picture: its own image when it names one (loaded from that URL), otherwise its region's glyph.
Widget _thumb(CheBrainRegion region, String? url, double size) {
  final glyph = Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(12),
      gradient: RadialGradient(colors: [region.color.withValues(alpha: .45), const Color(0xFF070B1C)]),
      border: Border.all(color: region.color.withValues(alpha: .5)),
    ),
    child: Icon(region.icon, color: Color.lerp(region.color, Colors.white, .3), size: size * .42),
  );
  if (url == null) return glyph;
  return ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: Image.network(url, width: size, height: size, fit: BoxFit.cover, errorBuilder: (_, _, _) => glyph),
  );
}

/// Memory Details (the reference's detail screen): the record's picture or glyph, its title, region and verification,
/// when it was saved, where it came from, its type and confidence (only when recorded), its evidence, and the records
/// it really connects to.
class CheBrainRecordDetails extends StatelessWidget {
  const CheBrainRecordDetails({super.key, required this.dot, this.links = const [], this.onReadAloud, this.onOpenEvidence, this.onOpenSource, this.now});

  final CheMemoryDot dot;
  final List<CheBrainLink> links;
  final Future<void> Function(String text)? onReadAloud;
  final CheOpenBrainEvidence? onOpenEvidence;

  /// Opens the screen that holds the record's source; null where the app gives no route (the page then says so).
  final CheOpenBrainSource? onOpenSource;
  final DateTime? now;

  /// Opens one source screen and says what really happened (the owner pressed it, so it is read aloud).
  Future<void> _openSource(BuildContext context, CheBrainSourceLink link) async {
    HapticFeedback.selectionClick();
    final open = onOpenSource;
    var opened = false;
    if (open != null) {
      try {
        opened = await open(link);
      } catch (_) {
        opened = false;
      }
    }
    final said = opened ? '${link.label}: opened.' : 'I could not open that screen: ${link.label.replaceFirst('Open ', '').trim()} has no route in CHE right now.';
    if (!opened && context.mounted) {
      HapticFeedback.heavyImpact();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(said, style: const TextStyle(fontSize: 16))));
    }
    await onReadAloud?.call(said);
  }

  @override
  Widget build(BuildContext context) {
    final d = dot;
    final region = cheBrainRegionOf(d);
    final status = cheBrainStatusOf(d);
    final evidence = cheBrainEvidenceOf(d);
    final related = cheBrainRelated(d, links);
    final sources = cheBrainSourceLinksOf(d);
    final at = d.at?.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    final saved = at == null ? 'Not recorded' : '${months[at.month - 1]} ${at.day}, ${at.year} · ${at.hour % 12 == 0 ? 12 : at.hour % 12}:${two(at.minute)} ${at.hour < 12 ? 'AM' : 'PM'}';
    final facts = <(IconData, String, String)>[
      (Icons.schedule_rounded, 'Saved', saved),
      (Icons.person_outline_rounded, 'Source', cheBrainOriginOf(d)),
      (Icons.verified_outlined, 'Type', cheBrainTrustOf(d)),
      if (d.region.isNotEmpty) (Icons.folder_outlined, 'Folder', d.path.isEmpty ? d.region : '${d.region} / ${d.path}'),
      if (cheBrainIsSimulated(d)) (Icons.science_outlined, 'Mode', 'Simulated or paper, not a live or broker result'),
    ];
    final spoken = [
      d.title,
      '${region.label}. ${status.label}.',
      for (final (_, k, v) in facts) '$k: $v.',
      if (d.confidence != null) 'Confidence ${(d.confidence! * 100).round()} percent.',
      evidence.isEmpty ? 'No evidence links are recorded.' : 'Evidence: ${evidence.map((e) => e.label).join(', ')}.',
      if (related.isNotEmpty) 'Connected to ${related.length} records.',
      sources.isEmpty ? cheBrainNoSourceScreen : 'Source screens: ${sources.map((x) => x.label.replaceFirst('Open ', '')).join(', ')}.',
      d.body,
    ].join(' ');
    return Scaffold(
      backgroundColor: const Color(0xFF02050A),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text('Memory Details'),
        actions: [
          if (onReadAloud != null) IconButton(tooltip: 'Read aloud', icon: const Icon(Icons.volume_up_rounded), onPressed: () => onReadAloud!(spoken)),
        ],
      ),
      body: ListView(
        key: const ValueKey('brain-record-details'),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: _glass, borderRadius: BorderRadius.circular(18), border: Border.all(color: region.color.withValues(alpha: .4))),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _thumb(region, cheBrainThumbnailOf(d), 108),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Semantics(header: true, child: Text(d.title, style: const TextStyle(fontSize: 19, color: Colors.white, fontWeight: FontWeight.w700))),
                  const SizedBox(height: 8),
                  Wrap(spacing: 6, runSpacing: 6, children: [
                    _chip(region.label, region.color),
                    _chip(status.label, status == CheBrainStatus.verified ? const Color(0xFF2EE57A) : status == CheBrainStatus.failed ? CheBrainRegion.errors.color : Colors.white60),
                  ]),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(color: _glass, borderRadius: BorderRadius.circular(16), border: Border.all(color: _rimDim)),
            child: Column(children: [
              for (final (icon, k, v) in facts)
                Semantics(
                  label: '$k: $v',
                  excludeSemantics: true,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 7),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Icon(icon, size: 17, color: Colors.white54),
                      const SizedBox(width: 10),
                      SizedBox(width: 74, child: Text(k, style: const TextStyle(color: Colors.white60, fontSize: 13.5))),
                      Expanded(child: Text(v, style: const TextStyle(color: Colors.white, fontSize: 14))),
                    ]),
                  ),
                ),
              if (d.confidence != null)
                Semantics(
                  label: 'Confidence: ${(d.confidence! * 100).round()} percent, as recorded',
                  excludeSemantics: true,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 7),
                    child: Row(children: [
                      const Icon(Icons.insights_rounded, size: 17, color: Colors.white54),
                      const SizedBox(width: 10),
                      const SizedBox(width: 74, child: Text('Confidence', style: TextStyle(color: Colors.white60, fontSize: 13.5))),
                      Text('${(d.confidence! * 100).round()}%', style: const TextStyle(color: Color(0xFF2EE57A), fontSize: 14, fontWeight: FontWeight.w700)),
                      const SizedBox(width: 10),
                      Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: d.confidence!.clamp(0, 1), minHeight: 4, color: const Color(0xFF2EE57A), backgroundColor: Colors.white10))),
                    ]),
                  ),
                ),
            ]),
          ),
          const SizedBox(height: 14),
          Semantics(header: true, child: const Text('Evidence', style: TextStyle(fontSize: 16, color: Colors.white, fontWeight: FontWeight.w700))),
          if (evidence.isEmpty)
            const Padding(padding: EdgeInsets.only(top: 4), child: Text('No evidence links are recorded for this record.', style: TextStyle(color: Colors.white60)))
          else
            for (final e in evidence) CheEvidenceTile(evidence: e, onOpenEvidence: onOpenEvidence),
          const SizedBox(height: 14),
          Semantics(header: true, child: const Text('Source screen', style: TextStyle(fontSize: 16, color: Colors.white, fontWeight: FontWeight.w700))),
          const SizedBox(height: 4),
          if (sources.isEmpty)
            const Text(cheBrainNoSourceScreen, key: ValueKey('brain-source-none'), style: TextStyle(color: Colors.white60))
          else if (onOpenSource == null)
            const Text('Source screens open from the Brain Room in the app; this view has no route to them.', style: TextStyle(color: Colors.white60))
          else
            Wrap(spacing: 8, runSpacing: 6, children: [
              for (final link in sources)
                Semantics(
                  button: true,
                  label: link.label,
                  excludeSemantics: true,
                  child: OutlinedButton.icon(
                    key: ValueKey('brain-source-${link.kind.name}'),
                    onPressed: () => _openSource(context, link),
                    icon: Icon(switch (link.kind) {
                      CheBrainSourceKind.conversation => Icons.forum_rounded,
                      CheBrainSourceKind.trade => Icons.replay_rounded,
                      CheBrainSourceKind.project => Icons.account_tree_rounded,
                      CheBrainSourceKind.agentDesk => Icons.business_center_rounded,
                    }, size: 18),
                    label: Text(link.label),
                  ),
                ),
            ]),
          const SizedBox(height: 14),
          Semantics(header: true, child: Text('Related · ${related.length}', style: const TextStyle(fontSize: 16, color: Colors.white, fontWeight: FontWeight.w700))),
          const SizedBox(height: 6),
          if (related.isEmpty)
            const Text('No connections recorded for this record yet.', style: TextStyle(color: Colors.white60))
          else
            SizedBox(
              height: 150,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: related.length,
                separatorBuilder: (_, _) => const SizedBox(width: 10),
                itemBuilder: (context, i) {
                  final (r, strength) = related[i];
                  final rr = cheBrainRegionOf(r);
                  return Semantics(
                    button: true,
                    label: '${rr.label}: ${r.title}. ${strength.label} connection. Opens it.',
                    excludeSemantics: true,
                    child: GestureDetector(
                      key: ValueKey('brain-related-${r.id}'),
                      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => CheBrainRecordDetails(dot: r, links: links, onReadAloud: onReadAloud, onOpenEvidence: onOpenEvidence, onOpenSource: onOpenSource, now: now),
                      )),
                      child: SizedBox(
                        width: 96,
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          _thumb(rr, cheBrainThumbnailOf(r), 80),
                          const SizedBox(height: 4),
                          Text(rr.label, style: const TextStyle(fontSize: 12, color: Colors.white)),
                          Text('${strength.label} · ${cheBrainAgo(r.at, now: now)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: strength.color)),
                        ]),
                      ),
                    ),
                  );
                },
              ),
            ),
          const SizedBox(height: 14),
          SelectableText(d.body, style: const TextStyle(fontSize: 14.5, color: Colors.white70, height: 1.35)),
        ],
      ),
    );
  }
}

/// One region's page (lane brain-visual): its name, real count and verified share, a way to fly the neural brain there,
/// Read Aloud, and its real records newest first, each opening Memory Details. An empty region says so.
class CheBrainRegionDetails extends StatelessWidget {
  const CheBrainRegionDetails({
    super.key,
    required this.region,
    required this.dots,
    this.links = const [],
    this.onReadAloud,
    this.onOpenEvidence,
    this.onOpenSource,
    this.now,
  });

  final CheBrainRegion region;
  final List<CheMemoryDot> dots;
  final List<CheBrainLink> links;
  final Future<void> Function(String text)? onReadAloud;
  final CheOpenBrainEvidence? onOpenEvidence;
  final CheOpenBrainSource? onOpenSource;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final r = region;
    final list = cheBrainRegionRecords(r, dots);
    final verified = list.where(cheBrainIsVerifiedRecord).length;
    final summary = list.isEmpty
        ? 'The ${r.label} region has no records on this phone yet. Nothing is shown until CHE really records something here.'
        : '${r.label} region: ${list.length} record${list.length == 1 ? '' : 's'}, $verified verified. Newest: ${list.take(3).map((d) => d.title).join('; ')}.';
    return Scaffold(
      backgroundColor: const Color(0xFF02050A),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text('${r.label} region'),
        actions: [
          if (onReadAloud != null) IconButton(tooltip: 'Read aloud', icon: const Icon(Icons.volume_up_rounded), onPressed: () => onReadAloud!(summary)),
        ],
      ),
      body: Column(
        key: ValueKey('brain-region-details-${r.name}'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: _glass,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: r.color.withValues(alpha: .5)),
                boxShadow: [BoxShadow(color: r.color.withValues(alpha: .25), blurRadius: 16)],
              ),
              child: Row(children: [
                Icon(r.icon, color: r.color, size: 30),
                const SizedBox(width: 12),
                Expanded(
                  child: Semantics(
                    label: summary,
                    excludeSemantics: true,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(_fmt(list.length), style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, color: Colors.white)),
                      Text(list.isEmpty ? 'no records yet' : '${list.length == 1 ? 'record' : 'records'} · $verified verified', style: const TextStyle(fontSize: 13, color: Colors.white70)),
                    ]),
                  ),
                ),
                if (list.isNotEmpty)
                  Semantics(
                    button: true,
                    label: 'Fly to the ${r.label} region in the brain',
                    excludeSemantics: true,
                    child: TextButton.icon(
                      key: const ValueKey('brain-region-fly'),
                      onPressed: () {
                        final space = CheBrainSpaceController.current;
                        final said = space == null ? 'The neural brain is not on screen, so I cannot fly there.' : space.flyToRegion(r);
                        Navigator.of(context).maybePop();
                        onReadAloud?.call(said);
                      },
                      icon: const Icon(Icons.travel_explore_rounded, size: 18),
                      label: const Text('Fly there'),
                    ),
                  ),
              ]),
            ),
          ),
          Expanded(
            child: list.isEmpty
                ? Padding(padding: const EdgeInsets.all(24), child: Text(summary, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white60, fontSize: 15)))
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
                    itemCount: list.length,
                    itemBuilder: (context, i) {
                      final d = list[i];
                      final status = cheBrainStatusOf(d);
                      return Semantics(
                        button: true,
                        label: '${d.title}. ${status.label}. ${cheBrainAgo(d.at, now: now)}. Opens the record.',
                        excludeSemantics: true,
                        child: ListTile(
                          key: ValueKey('brain-region-record-${d.id}'),
                          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                            builder: (_) => CheBrainRecordDetails(dot: d, links: links, onReadAloud: onReadAloud, onOpenEvidence: onOpenEvidence, onOpenSource: onOpenSource, now: now),
                          )),
                          leading: _thumb(cheBrainRegionOf(d), cheBrainThumbnailOf(d), 44),
                          title: Text(d.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 14.5)),
                          subtitle: Text('${cheBrainAgo(d.at, now: now)} · ${status.label}', style: const TextStyle(color: Colors.white54, fontSize: 12)),
                          trailing: const Icon(Icons.chevron_right_rounded, color: Colors.white38),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

/// One CONNECTION_CREATED event (lane brain-visual): the two records CHE linked, the reason, the link's status, where
/// the link came from and when. A record that is on this phone opens its Memory Details; one that is not says so.
class CheBrainConnectionDetails extends StatelessWidget {
  const CheBrainConnectionDetails({
    super.key,
    required this.event,
    required this.dots,
    this.links = const [],
    this.onReadAloud,
    this.onOpenEvidence,
    this.onOpenSource,
    this.now,
  });

  final CheBrainConnectionEvent event;
  final List<CheMemoryDot> dots;
  final List<CheBrainLink> links;
  final Future<void> Function(String text)? onReadAloud;
  final CheOpenBrainEvidence? onOpenEvidence;
  final CheOpenBrainSource? onOpenSource;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final e = event;
    final when = e.time.isEmpty ? cheBrainAgo(e.at, now: now) : e.time;
    final spoken = 'Connection created $when: ${e.fromLabel} and ${e.toLabel}. Reason: ${e.reason}. It is a ${e.statusWords}, from the ${e.originWords}.';
    Widget side(String label, String id, String title) {
      final dot = cheBrainDotForNodeId(id, dots);
      return Semantics(
        button: dot != null,
        label: dot == null ? '$label: ${title.isEmpty ? id : title}. This record is not on this phone yet.' : '$label: ${dot.title}. Opens the record.',
        excludeSemantics: true,
        child: ListTile(
          key: ValueKey('brain-connection-side-$id'),
          onTap: dot == null
              ? null
              : () => Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => CheBrainRecordDetails(dot: dot, links: links, onReadAloud: onReadAloud, onOpenEvidence: onOpenEvidence, onOpenSource: onOpenSource, now: now),
                  )),
          leading: Icon(dot == null ? Icons.cloud_outlined : cheBrainRegionOf(dot).icon, color: dot == null ? Colors.white38 : cheBrainRegionOf(dot).color),
          title: Text(dot?.title ?? (title.isEmpty ? id : title), style: const TextStyle(color: Colors.white, fontSize: 15)),
          subtitle: Text(dot == null ? '$label · id $id · not on this phone yet' : '$label · ${cheBrainRegionOf(dot).label}', style: const TextStyle(color: Colors.white54, fontSize: 12)),
          trailing: dot == null ? null : const Icon(Icons.chevron_right_rounded, color: Colors.white38),
        ),
      );
    }

    return Scaffold(
      backgroundColor: const Color(0xFF02050A),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text('Connection'),
        actions: [
          if (onReadAloud != null) IconButton(tooltip: 'Read aloud', icon: const Icon(Icons.volume_up_rounded), onPressed: () => onReadAloud!(spoken)),
        ],
      ),
      body: ListView(
        key: const ValueKey('brain-connection-details'),
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
        children: [
          Semantics(header: true, child: const Padding(padding: EdgeInsets.fromLTRB(4, 0, 4, 6), child: Text('Connection created', style: TextStyle(fontSize: 19, color: Colors.white, fontWeight: FontWeight.w700)))),
          side('From', e.fromId, e.fromTitle),
          side('To', e.toId, e.toTitle),
          const Divider(color: _rimDim),
          for (final (k, v) in [('Reason', e.reason.isEmpty ? 'Not recorded' : e.reason), ('Status', e.statusWords), ('From', e.originWords), ('When', when)])
            Semantics(
              label: '$k: $v',
              excludeSemantics: true,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SizedBox(width: 74, child: Text(k, style: const TextStyle(color: Colors.white60, fontSize: 13.5))),
                  Expanded(child: Text(v, style: const TextStyle(color: Colors.white, fontSize: 14))),
                ]),
              ),
            ),
        ],
      ),
    );
  }
}
