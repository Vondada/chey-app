// Local help and numbered selections from actual foreground widgets. No model,
// screenshot, entered field value or credential is sent anywhere.
import 'package:flutter/material.dart';
import 'che_screen_awareness.dart';
import 'che_screen_capture.dart';
import '../che_wake_match.dart';

class _GuideAction {
  const _GuideAction(this.label, this.context, this.invoke);
  final String label;
  final BuildContext context;
  final VoidCallback invoke;
}

class CheScreenGuide {
  CheScreenGuide._();
  static const tooltip = 'Help for this screen';
  static bool _open = false;

  static String description(CheScreenReport? report, String fallback) {
    if (report != null) {
      return CheScreenReport(page: report.page, tab: report.tab, tabs: report.tabs, detail: report.detail).spoken
        + (report.controls.isEmpty ? '' : ' Controls: ${report.controls.indexed.map((entry) => '${entry.$1 + 1}. ${entry.$2}').join('. ')}.');
    }
    return 'You are on $fallback. This page has not registered its individual controls for the guide yet. I will not guess button actions.';
  }

  static String _label(Element element) {
    final words = <String>[];
    void visit(Element e) {
      if (e.widget is EditableText) return;
      final w = e.widget;
      if (w is Text && w.data != null) words.add(w.data!);
      e.visitChildren(visit);
    }
    visit(element);
    return words.join(' ').trim();
  }

  static List<_GuideAction> _actions(BuildContext context) {
    if (CheScreenCapture.blocked) return [];
    Element root = context as Element;
    context.visitAncestorElements((e) { root = e; return true; });
    final actions = <_GuideAction>[];
    final labels = <String>{};
    void visit(Element e) {
      if (!e.mounted || actions.length >= 40 || e.widget is EditableText) return;
      final w = e.widget;
      VoidCallback? invoke;
      var label = '';
      if (w is IconButton) { invoke = w.onPressed; label = w.tooltip ?? ''; }
      if (w is ButtonStyleButton) { invoke = w.onPressed; label = _label(e); }
      if (w is ListTile) { invoke = w.onTap; label = _label(e); }
      final box = e.findRenderObject();
      final visible = box is RenderBox && box.attached && box.hasSize && box.size.longestSide > 0
        && (box.localToGlobal(Offset.zero) & box.size).overlaps(Offset.zero & MediaQuery.sizeOf(context));
      if (invoke != null && label.isNotEmpty && label != tooltip && visible
          && TickerMode.valuesOf(e).enabled && (ModalRoute.of(e)?.isCurrent ?? true) && labels.add(label)) {
        actions.add(_GuideAction(label, e, invoke));
        return;
      }
      e.visitChildren(visit);
    }
    root.visitChildren(visit);
    return actions;
  }

  static String focusedButton() {
    if (CheScreenCapture.blocked) return 'This is a protected screen. Button inspection is withheld.';
    final focus = FocusManager.instance.primaryFocus?.context;
    if (focus == null) return 'No button is focused. Open screen help and choose a numbered control.';
    var answer = '';
    focus.visitAncestorElements((e) {
      if (e.widget is IconButton) answer = (e.widget as IconButton).tooltip ?? '';
      if (e.widget is ButtonStyleButton) answer = _label(e);
      return answer.isEmpty;
    });
    return answer.isEmpty ? 'No labeled button is focused. Open screen help and choose a numbered control.' : 'The focused button is $answer. Its enabled action appears in screen help.';
  }

  static void open(BuildContext context, {required String fallback, required void Function(String) onRead}) {
    if (_open) return;
    _open = true;
    final actions = _actions(context);
    final known = CheScreenAwareness.current;
    final report = CheScreenCapture.blocked ? const CheScreenReport(page: 'Protected screen', detail: 'Sensitive content is withheld. Leave this screen to use control help.')
      : CheScreenReport(page: known?.page ?? fallback, tab: known?.tab ?? '', tabs: known?.tabs ?? [],
          detail: known?.detail ?? 'These are actual enabled controls visible on the current screen.', controls: actions.map((a) => a.label).toList());
    showModalBottomSheet<void>(context: context, showDragHandle: true, isScrollControlled: true,
      builder: (_) => _GuideSheet(report: report, actions: actions, onRead: onRead)).whenComplete(() => _open = false);
  }
}

class _GuideSheet extends StatefulWidget {
  const _GuideSheet({required this.report, required this.actions, required this.onRead});
  final CheScreenReport report;
  final List<_GuideAction> actions;
  final void Function(String) onRead;
  @override
  State<_GuideSheet> createState() => _GuideSheetState();
}

class _GuideSheetState extends State<_GuideSheet> {
  Object? _voiceToken;
  bool _selected = false;
  @override
  void initState() {
    super.initState();
    _voiceToken = CheScreenAwareness.registerVoice(context, _voice);
  }
  @override
  void dispose() {
    CheScreenAwareness.unregister(_voiceToken);
    super.dispose();
  }

  Future<String> _pick(int index, {bool highlight = false}) async {
    if (_selected) return 'That selection is already being handled.';
    if (index < 0 || index >= widget.actions.length) return 'That number is not in this screen’s guide.';
    final action = widget.actions[index];
    // Discovery never bypasses an app's dedicated consequential-action/approval flow.
    if (!highlight && RegExp(r'\b(?:delete|remove|clear|buy|sell|submit|purchase|pay|subscribe|approve|authorize|install|place|send|order|enable|activate|execute|start|resume|stop|pause|run|connect|disconnect|revoke|transfer|launch|apply|save|confirm)\b', caseSensitive: false).hasMatch(action.label)) {
      return '${action.label} uses its own explicit action and confirmation flow. The help guide will not execute it.';
    }
    _selected = true;
    Navigator.pop(context);
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (!action.context.mounted || !(ModalRoute.of(action.context)?.isCurrent ?? true) || !TickerMode.valuesOf(action.context).enabled) return 'The screen changed; no control was activated.';
    final box = action.context.findRenderObject();
    if (highlight && box is RenderBox && box.attached && box.hasSize) {
      final rect = box.localToGlobal(Offset.zero) & box.size;
      final overlay = Overlay.maybeOf(action.context, rootOverlay: true);
      if (overlay == null) return 'The control cannot be highlighted here.';
      final entry = OverlayEntry(builder: (_) => IgnorePointer(child: Stack(children: [Positioned.fromRect(rect: rect.inflate(3), child: DecoratedBox(decoration: BoxDecoration(border: Border.all(color: Colors.amber, width: 3), borderRadius: BorderRadius.circular(8))))])));
      overlay.insert(entry);
      Future<void>.delayed(const Duration(seconds: 2), entry.remove);
      return 'Highlighted ${action.label}.';
    }
    action.invoke();
    return 'Selected ${action.label}. Any network result is reported by that control.';
  }

  Future<String?> _voice(String raw) async {
    final text = (cheWakeRemainder(raw) ?? raw).toLowerCase().replaceAll(RegExp(r'[.!?,]'), '').trim();
    if (RegExp(r'^(?:close (?:the )?help|go back)$').hasMatch(text)) { Navigator.pop(context); return 'Closed help.'; }
    if (RegExp(r'^(?:read (?:this|help|the options)|repeat)$').hasMatch(text)) return CheScreenGuide.description(widget.report, 'current screen');
    final match = RegExp(r'^(?:(open|select|choose|show|highlight) )?(?:number |option )?(one|two|three|four|five|six|seven|eight|nine|ten|[1-9][0-9]?)$').firstMatch(text);
    if (match == null) return null;
    const numbers = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10};
    return _pick((numbers[match[2]] ?? int.tryParse(match[2]!) ?? 0) - 1, highlight: match[1] == 'highlight' || match[1] == 'show');
  }

  @override
  Widget build(BuildContext context) => SafeArea(child: SingleChildScrollView(
    padding: const EdgeInsets.fromLTRB(20, 12, 20, 24), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Help: ${widget.report.page}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
      const SizedBox(height: 12),
      SelectableText(CheScreenGuide.description(widget.report, 'current screen'), style: const TextStyle(fontSize: 17)),
      const Text('Say “number two” to select, or “highlight two” to locate a control. Purchases, orders, deletion and other consequential actions keep their dedicated confirmation flows.'),
      for (final entry in widget.actions.indexed) ListTile(
        title: Text('${entry.$1 + 1}. ${entry.$2.label}'),
        onTap: () async { final read = widget.onRead; final reply = await _pick(entry.$1); read(reply); },
        trailing: IconButton(tooltip: 'Highlight ${entry.$2.label}', icon: const Icon(Icons.my_location),
          onPressed: () async { final read = widget.onRead; final reply = await _pick(entry.$1, highlight: true); read(reply); }),
      ),
      OutlinedButton.icon(onPressed: () => widget.onRead(CheScreenGuide.description(widget.report, 'current screen')), icon: const Icon(Icons.volume_up_outlined), label: const Text('Read this')),
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('Close help')),
    ]),
  ));
}
