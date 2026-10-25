// What CHE can truthfully say about the screen the owner is on. Each page
// registers a report of itself (page, selected tab, main controls) while it
// is shown; "What is on my screen?" is answered from the one that is really
// in front of the owner, never guessed by a model. When the screen on top
// does not report itself, CHE says so instead of describing the one below.

import 'package:flutter/widgets.dart';

class CheScreenReport {
  const CheScreenReport({required this.page, this.tab = '', this.tabs = const [], this.controls = const [], this.detail = ''});

  /// "Chat", "Commands", "Connections".
  final String page;

  /// The selected tab or view, when the page has tabs.
  final String tab;

  /// Every tab or view the page offers, in order.
  final List<String> tabs;

  /// The main controls on screen, by their VoiceOver names.
  final List<String> controls;

  /// What the page shows right now, in a sentence or two.
  final String detail;

  String get spoken {
    final parts = <String>[
      'You are on $page${tab.isEmpty ? '' : ', $tab ${tabs.isEmpty ? 'view' : 'tab'}'}.',
      if (tabs.length > 1) 'Tabs: ${[for (final (i, t) in tabs.indexed) '${i + 1}. $t'].join(', ')}.',
      if (detail.trim().isNotEmpty) _sentence(detail),
      if (controls.isNotEmpty) 'Controls: ${controls.join(', ')}.',
    ];
    return parts.join(' ');
  }

  static String _sentence(String t) {
    final s = t.trim();
    return RegExp(r'[.!?]$').hasMatch(s) ? s : '$s.';
  }
}

class _Entry {
  _Entry(this.context, this.report);
  final BuildContext context;
  final CheScreenReport Function() report;
}

class CheScreenAwareness {
  CheScreenAwareness._();
  static final _entries = <_Entry>[];

  /// Registers [report] for the page at [context] until [unregister].
  static Object register(BuildContext context, CheScreenReport Function() report) {
    final e = _Entry(context, report);
    _entries.add(e);
    return e;
  }

  static void unregister(Object? token) => _entries.remove(token);

  static bool _shown(BuildContext c) {
    if (!c.mounted) return false;
    // Pages behind another route, and rooms in a tab that is not selected,
    // have their tickers off.
    if (!TickerMode.valuesOf(c).enabled) return false;
    return ModalRoute.of(c)?.isCurrent ?? true;
  }

  /// The page in front of the owner, or null when none reports itself.
  static CheScreenReport? get current {
    for (final e in _entries.reversed) {
      if (_shown(e.context)) return e.report();
    }
    return null;
  }

  /// The spoken answer to "What is on my screen?".
  static String describe() {
    final now = current;
    if (now != null) return now.spoken;
    final below = _entries.reversed.where((e) => e.context.mounted).firstOrNull;
    return 'I can\'t tell exactly what is on your screen right now: the page in front of you does not report its contents to me yet, so I won\'t guess.'
        '${below == null ? '' : ' Behind it is ${below.report().page}.'} Say "go back" to return, then ask again.';
  }
}

/// "What is on my screen?" in the ways it is said.
bool cheAsksAboutScreen(String raw) {
  final t = raw.trim().toLowerCase().replaceAll('’', "'").replaceAll(RegExp(r'[.!?]+$'), '')
      .replaceFirst(RegExp(r'^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:che|chay|chey|shay)[\s,.:!]+'), '')
      .replaceFirst(RegExp(r'^(?:please|can you|could you)\s+'), '').trim();
  return RegExp(r"^(?:(?:tell me |say )?what(?:'s| is) on (?:my|the|this) (?:screen|page)(?: (?:right )?now)?|what am i looking at|what (?:screen|page) am i on|where am i(?: in the app)?|describe (?:my|the|this) (?:screen|page)|what do you see on (?:my|the) screen)$").hasMatch(t);
}
