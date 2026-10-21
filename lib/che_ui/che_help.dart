// Universal "?" help (owner, 2026-10-20). Help is grounded in what is really on screen: each
// panel registers the controls it shows (name, what it does, how to say it), and the page's
// CheScreenReport (che_screen_awareness.dart) supplies the rest. Nothing is described that the
// screen does not report. "?" opens the help for the screen in front; "Show me" highlights the
// control; "Walk me through" steps through them; the Help Center lists every screen's help.
// Typed and spoken "what is this button?", "what does Emergency Stop do?", "show me the pause
// button" and "walk me through this screen" are answered from the same records (send.dart).
// Help never speaks on its own: it opens only when asked.
import 'package:flutter/material.dart';

import 'che_screen_awareness.dart';
import 'che_theme.dart';

class CheControlHelp {
  const CheControlHelp({required this.name, required this.does, this.say = '', this.caution = ''});

  /// The control's VoiceOver name, as on screen ("Emergency Stop").
  final String name;

  /// What it does when used.
  final String does;

  /// The words that do the same by voice, when there are some.
  final String say;

  /// What to know first (a risk, a confirmation), when there is something.
  final String caution;

  String get spoken => [
        '$name: ${_end(does)}',
        if (caution.isNotEmpty) _end(caution),
        if (say.isNotEmpty) 'By voice, say "$say".',
      ].join(' ');

  static String _end(String t) => RegExp(r'[.!?]$').hasMatch(t.trim()) ? t.trim() : '${t.trim()}.';
}

class CheHelpTopic {
  const CheHelpTopic({required this.title, required this.summary, required this.items});
  final String title;
  final String summary;
  final List<CheControlHelp> items;
}

class _Topic {
  _Topic(this.context, this.build);
  final BuildContext context;
  final CheHelpTopic Function() build;
}

class CheHelp {
  CheHelp._();
  static final _topics = <_Topic>[];
  static final _targets = <String, List<GlobalKey>>{};

  /// The control being explained right now, drawn with an outline by its [CheHelpTarget].
  static final highlighted = ValueNotifier<String?>(null);

  static Object register(BuildContext context, CheHelpTopic Function() build) {
    final t = _Topic(context, build);
    _topics.add(t);
    return t;
  }

  static void unregister(Object? token) => _topics.remove(token);

  static bool _shown(BuildContext c) {
    if (!c.mounted) return false;
    if (!TickerMode.valuesOf(c).enabled) return false;
    return ModalRoute.of(c)?.isCurrent ?? true;
  }

  /// The help for what is in front of the owner: registered topics first, then the page's own
  /// reported controls (named only, since the page did not say more).
  static List<CheHelpTopic> get shown {
    final topics = [for (final t in _topics) if (_shown(t.context)) t.build()];
    final report = CheScreenAwareness.current;
    if (report != null && report.controls.isNotEmpty) {
      final known = {for (final t in topics) for (final i in t.items) i.name.toLowerCase()};
      final rest = [for (final c in report.controls) if (!known.contains(c.toLowerCase())) CheControlHelp(name: c, does: 'a control on ${report.page}')];
      if (rest.isNotEmpty) topics.insert(0, CheHelpTopic(title: report.page, summary: report.detail, items: rest));
    }
    return topics;
  }

  /// Every topic that is open anywhere in the app (for the Help Center), the shown ones first.
  static List<CheHelpTopic> get everywhere {
    final out = [...shown];
    final titles = {for (final t in out) t.title};
    for (final t in _topics) {
      if (!t.context.mounted) continue;
      final topic = t.build();
      if (titles.add(topic.title)) out.add(topic);
    }
    return out;
  }

  static List<CheControlHelp> get _items => [for (final t in shown) ...t.items];

  /// The control on screen whose name best matches [words], or null.
  static CheControlHelp? find(String words, {int minScore = 10}) {
    final w = words.toLowerCase().replaceAll(RegExp(r'\b(?:the|button|switch|toggle|control|this|that)\b'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
    if (w.isEmpty) return null;
    CheControlHelp? best;
    var score = 0;
    for (final i in _items) {
      final n = i.name.toLowerCase();
      final s = n == w ? 100 : n.contains(w) ? 60 + w.length : w.contains(n) ? 50 + n.length : w.split(' ').where((x) => x.length > 2 && n.contains(x)).length * 10;
      if (s > score) { score = s; best = i; }
    }
    return score >= minScore ? best : null;
  }

  // Every mounted control with this name is kept: the same panel can be open in a room and on a
  // pushed page, and per-strategy controls repeat. The one on the screen in front is chosen.
  static void target(String name, GlobalKey key) => (_targets[name.toLowerCase()] ??= []).add(key);
  static void untarget(String name, GlobalKey key) {
    final list = _targets[name.toLowerCase()];
    list?.remove(key);
    if (list != null && list.isEmpty) _targets.remove(name.toLowerCase());
  }

  static BuildContext? _onScreen(String name) {
    for (final k in (_targets[name.toLowerCase()] ?? const <GlobalKey>[]).reversed) {
      final c = k.currentContext;
      if (c != null && _shown(c)) return c;
    }
    return null;
  }

  /// Whether the control can be outlined on the screen in front of the owner.
  static bool canHighlight(String name) => _onScreen(name) != null;

  /// Outlines the control and scrolls it into view. Returns false, and outlines nothing, when it is not on screen.
  static Future<bool> highlight(String name) async {
    final c = _onScreen(name);
    if (c == null) return false;
    highlighted.value = name.toLowerCase();
    await Scrollable.ensureVisible(c, duration: const Duration(milliseconds: 300), alignment: 0.3);
    return true;
  }

  static void clear() => highlighted.value = null;

  /// The answer to a help question, from the screen's own records. Null when it is not one.
  static String? answer(CheHelpRequest r) {
    final items = _items;
    final page = CheScreenAwareness.current?.page;
    final where = page ?? 'this screen';
    if (r.kind == CheHelpKind.center) return 'Opening the Help Center: help for every screen that is open.';
    if (r.kind == CheHelpKind.step) return step(r.name);
    if (r.kind == CheHelpKind.walkthrough) {
      return items.isEmpty ? 'This screen does not list its controls to me yet, so I cannot walk you through it.' : 'Walking you through $where: ${items.length} controls. Say "next" or use the Next button.';
    }
    if (r.name.isNotEmpty) {
      final hit = find(r.name);
      if (hit == null) {
        return 'I do not see a control called "${r.name}" on $where.${items.isEmpty ? '' : ' On this screen: ${_list(items)}.'}';
      }
      if (r.kind != CheHelpKind.show) return hit.spoken;
      if (!canHighlight(hit.name)) return 'I cannot outline ${hit.name} on this screen, but here is what it does. ${hit.spoken}';
      highlight(hit.name);
      return 'Highlighted. ${hit.spoken}';
    }
    final lit = highlighted.value;
    final current = lit == null ? null : items.where((i) => i.name.toLowerCase() == lit).firstOrNull;
    if (current != null) return current.spoken;
    if (items.isEmpty) return 'This screen does not list its controls to me yet, so I will not guess what a button does.';
    return 'On $where: ${[for (final (n, i) in items.indexed) '${n + 1}. ${i.name}: ${i.does}'].join('. ')}. Say "show me" and a name to highlight one.';
  }

  // The walkthrough in progress, so spoken "next", "back" and "done" move it like its buttons.
  static List<CheControlHelp> _walk = const [];
  static int _walkAt = 0;
  static void Function()? _walkShow;
  static void Function()? _walkHide;
  static bool get walking => _walk.isNotEmpty;

  static void _endWalk() {
    _walkHide?.call();
    _walk = const [];
    _walkShow = null;
    _walkHide = null;
    clear();
  }

  /// "next", "back" or "done" in the walkthrough; the answer says which step it is on.
  static String step(String dir) {
    if (!walking) return 'There is no walkthrough running. Say "walk me through this screen" to start one.';
    if (dir == 'done') {
      _endWalk();
      return 'Walkthrough finished.';
    }
    final to = _walkAt + (dir == 'back' ? -1 : 1);
    if (to < 0) return 'This is the first step. ${_walk[_walkAt].spoken}';
    if (to >= _walk.length) {
      final n = _walk.length;
      _endWalk();
      return 'That was the last of the $n controls. Walkthrough finished.';
    }
    _walkAt = to;
    _walkShow?.call();
    return 'Step ${_walkAt + 1} of ${_walk.length}. ${_walk[_walkAt].spoken}';
  }

  static String _list(List<CheControlHelp> items) => [for (final (n, i) in items.indexed) '${n + 1}. ${i.name}'].join(', ');
}

enum CheHelpKind { explain, show, walkthrough, center, step }

class CheHelpRequest {
  const CheHelpRequest(this.kind, [this.name = '']);
  final CheHelpKind kind;
  final String name;
}

/// "What is this button?", "what does Emergency Stop do?", "show me the pause button",
/// "walk me through this screen", "open the help center", "help". Null for anything else.
CheHelpRequest? cheHelpIntent(String raw) {
  final t = raw.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.!?]+$'), '')
      .replaceFirst(RegExp(r'^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:che|chay|chey|shay)[\s,.:!]+'), '')
      .replaceFirst(RegExp(r'^(?:please|can you|could you)\s+'), '').trim();
  if (RegExp(r'^(?:open |show me |go to )?(?:the )?help cent(?:er|re)$').hasMatch(t)) return const CheHelpRequest(CheHelpKind.center);
  if (CheHelp.walking) {
    final m = RegExp(r'^(?:go )?(next|back|previous|done|stop|finish(?:ed)?|that.?s enough)(?: step| one| please)?$').firstMatch(t);
    if (m != null) return CheHelpRequest(CheHelpKind.step, switch (m.group(1)!) { 'next' => 'next', 'back' || 'previous' => 'back', _ => 'done' });
  }
  if (RegExp(r'^(?:walk me through|give me a tour of|show me around) (?:this|the|my) (?:screen|page|room)$').hasMatch(t)) return const CheHelpRequest(CheHelpKind.walkthrough);
  if (RegExp(r"^(?:help|help me|i need help)(?: (?:with|on) (?:this|the) (?:screen|page|room))?$|^how do i use (?:this|the) (?:screen|page|room)$|^explain (?:this|the) (?:screen|page|room)$|^what (?:is|are|'s) (?:this|that|these) (?:button|buttons|switch|control|controls)(?: for| do)?$|^what (?:does|do) (?:this|that) (?:button|switch|control) do$").hasMatch(t)) {
    return const CheHelpRequest(CheHelpKind.explain);
  }
  final what = RegExp(r"^what (?:does|do|is) (?:the )?(.+?)(?: button| switch| control)? (?:do|for|mean)$").firstMatch(t);
  // A market or strategy question is not help, unless it names a control on screen ("the Strategy switch").
  if (what != null && (CheHelp.find(what.group(0)!.replaceFirst(RegExp(r'^what (?:does|do|is) '), '').replaceFirst(RegExp(r' (?:do|for|mean)$'), ''), minScore: 50) != null || !RegExp(r'\b(?:market|price|strategy|trade|stock|nq|mnq|it|you|che)\b').hasMatch(what.group(1)!))) {
    return CheHelpRequest(CheHelpKind.explain, what.group(1)!.trim());
  }
  final show = RegExp(r'^(?:show me|where is|highlight|point to) (?:the )?(.+?) (?:button|switch|control)$').firstMatch(t);
  if (show != null) return CheHelpRequest(CheHelpKind.show, show.group(1)!.trim());
  return null;
}

/// Wraps a control so help can outline it and scroll to it.
class CheHelpTarget extends StatefulWidget {
  const CheHelpTarget({super.key, required this.name, required this.child});
  final String name;
  final Widget child;

  @override
  State<CheHelpTarget> createState() => _CheHelpTargetState();
}

class _CheHelpTargetState extends State<CheHelpTarget> {
  final _key = GlobalKey();

  @override
  void initState() {
    super.initState();
    CheHelp.target(widget.name, _key);
  }

  @override
  void dispose() {
    CheHelp.untarget(widget.name, _key);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<String?>(
        valueListenable: CheHelp.highlighted,
        builder: (context, lit, child) {
          final on = lit == widget.name.toLowerCase();
          return Semantics(
            key: _key,
            hint: on ? 'Highlighted by help' : null,
            // Drawn over the control, so wrapping a control never changes its size or the layout around it.
            child: Container(
              foregroundDecoration: on
                  ? BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFFFD166), width: 3))
                  : null,
              child: child,
            ),
          );
        },
        child: widget.child,
      );
}

/// The "?" button: help for the screen in front of the owner.
class CheHelpButton extends StatelessWidget {
  const CheHelpButton({super.key, this.color, this.dense = false});
  final Color? color;

  /// A smaller button for a status strip.
  final bool dense;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: 'Help for this screen',
        excludeSemantics: true,
        child: IconButton(
          tooltip: 'Help',
          visualDensity: dense ? VisualDensity.compact : null,
          iconSize: dense ? 20 : null,
          icon: Icon(Icons.help_outline_rounded, color: color),
          onPressed: () => showCheHelp(context),
        ),
      );
}

Future<void> showCheHelp(BuildContext context) {
  // Read before the sheet opens: once it is up, the page behind it is no longer the current route.
  final topics = CheHelp.shown;
  final page = CheScreenAwareness.current?.page ?? 'this screen';
  final outlinable = {for (final t in topics) for (final i in t.items) if (CheHelp.canHighlight(i.name)) i.name};
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: const Color(0xFF0B1416),
    builder: (ctx) => _CheHelpSheet(outer: context, topics: topics, page: page, outlinable: outlinable),
  );
}

class _CheHelpSheet extends StatelessWidget {
  const _CheHelpSheet({required this.outer, required this.topics, required this.page, required this.outlinable});
  final Set<String> outlinable;
  final BuildContext outer;
  final List<CheHelpTopic> topics;
  final String page;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: ListView(padding: const EdgeInsets.all(16), shrinkWrap: true, children: [
          Semantics(header: true, child: Text('Help: $page', style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800))),
          const SizedBox(height: 4),
          Text('Ask by voice or typing: "what is this button?", "what does Emergency Stop do?", "show me the pause button".', style: TextStyle(color: CheColors.textDim)),
          const SizedBox(height: 10),
          Wrap(spacing: 8, children: [
            FilledButton.icon(
              onPressed: topics.isEmpty ? null : () { Navigator.pop(context); unawaitedWalk(outer, items: [for (final t in topics) ...t.items]); },
              icon: const Icon(Icons.directions_walk_rounded),
              label: const Text('Walk me through'),
            ),
            OutlinedButton.icon(
              onPressed: () { Navigator.pop(context); Navigator.of(outer).push(CheHelpCenter.route(screen: topics)); },
              icon: const Icon(Icons.menu_book_rounded),
              label: const Text('Help Center'),
            ),
          ]),
          if (topics.isEmpty) const Padding(padding: EdgeInsets.only(top: 12), child: Text('This screen does not list its controls to me yet, so I will not guess what its buttons do.', style: TextStyle(color: Colors.white))),
          for (final t in topics) ...[
            const SizedBox(height: 14),
            Text(t.title, style: const TextStyle(color: Color(0xFFFFD166), fontSize: 16, fontWeight: FontWeight.w800)),
            if (t.summary.isNotEmpty) Text(t.summary, style: TextStyle(color: CheColors.textDim)),
            for (final i in t.items)
              Semantics(
                label: i.spoken,
                excludeSemantics: true,
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(i.name, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                  subtitle: Text([i.does, if (i.caution.isNotEmpty) i.caution, if (i.say.isNotEmpty) 'Say: "${i.say}"'].join('\n'), style: const TextStyle(color: Color(0xFFB8C7C4))),
                  trailing: outlinable.contains(i.name)
                      ? TextButton(
                          onPressed: () { Navigator.pop(context); CheHelp.highlight(i.name); },
                          child: const Text('Show me'),
                        )
                      : null,
                ),
              ),
          ],
        ]),
      ),
    );
  }
}

/// Steps through the controls on screen, outlining each, with Back, Next and Done (also by voice).
void unawaitedWalk(BuildContext context, {List<CheControlHelp>? items}) {
  final steps = items ?? [for (final t in CheHelp.shown) ...t.items];
  final m = ScaffoldMessenger.maybeOf(context);
  if (steps.isEmpty || m == null) return;
  void show() {
    final i = CheHelp._walkAt;
    final item = CheHelp._walk[i];
    CheHelp.highlight(item.name);
    m.clearMaterialBanners();
    m.showMaterialBanner(MaterialBanner(
      backgroundColor: const Color(0xFF13262A),
      content: Semantics(
        liveRegion: true,
        child: Text('Step ${i + 1} of ${CheHelp._walk.length}. ${item.spoken}', style: const TextStyle(color: Colors.white, fontSize: 16)),
      ),
      actions: [
        if (i > 0) TextButton(onPressed: () => CheHelp.step('back'), child: const Text('Back')),
        if (i < CheHelp._walk.length - 1) TextButton(onPressed: () => CheHelp.step('next'), child: const Text('Next')),
        TextButton(onPressed: () => CheHelp.step('done'), child: const Text('Done')),
      ],
    ));
  }
  CheHelp._walk = steps;
  CheHelp._walkAt = 0;
  CheHelp._walkShow = show;
  CheHelp._walkHide = m.clearMaterialBanners;
  show();
}

/// Every screen's help that is open in the app now, in one place.
class CheHelpCenter extends StatelessWidget {
  const CheHelpCenter({super.key, this.screen = const []});

  /// The help of the screen it was opened from, read before this page covered it.
  final List<CheHelpTopic> screen;

  static Route<void> route({List<CheHelpTopic> screen = const []}) =>
      MaterialPageRoute(builder: (_) => CheHelpCenter(screen: screen), settings: const RouteSettings(name: 'help_center'));

  @override
  Widget build(BuildContext context) {
    final titles = {for (final t in screen) t.title};
    final topics = [...screen, for (final t in CheHelp.everywhere) if (titles.add(t.title)) t];
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white, title: const Text('Help Center')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Help for every screen that is open. Ask by voice or typing at any time: "what is this button?", "show me the Emergency Stop button", "walk me through this screen", "take me back to my meeting".',
            style: TextStyle(color: CheColors.textDim)),
        if (topics.isEmpty) const Padding(padding: EdgeInsets.only(top: 12), child: Text('No screen has listed its controls yet.', style: TextStyle(color: Colors.white))),
        for (final t in topics)
          ExpansionTile(
            title: Text(t.title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
            subtitle: t.summary.isEmpty ? null : Text(t.summary, style: TextStyle(color: CheColors.textDim)),
            children: [for (final i in t.items) ListTile(title: Text(i.name, style: const TextStyle(color: Colors.white)), subtitle: Text(i.spoken, style: const TextStyle(color: Color(0xFFB8C7C4))))],
          ),
      ]),
    );
  }
}
