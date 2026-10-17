// REA investigations inside the Command Center (Commands → Activity → Open
// investigations, or any REA command's details): what CHE found when she
// investigated a package, repository, website or app, stage by stage, and
// the plan, build and checks that followed. Everything shown is CHE's own
// record (GET /api/rea/investigations). Actions are chat commands sent
// through the same chat turn as the Command Center's Run button, never a
// route of their own. Opening or refreshing these pages never makes CHE
// speak; Read this and the owner's own actions do.
import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoAlertDialog, CupertinoDialogAction, showCupertinoDialog;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_screen_awareness.dart';
import '../che_ui/che_theme.dart';
import 'che_command_client.dart';
import 'che_command_widgets.dart';
import 'che_rea_models.dart';
import 'che_rea_voice.dart';

/// Sends [message] through CHE's normal chat turn while this page stays
/// open. `sent` is false when Chat was still answering and took nothing;
/// `reply` is CHE's reply text when Chat shares it (Chat speaks it, as it
/// speaks every reply). `confirmed` is true only after the owner approved on
/// this page.
typedef CheSendInChat = Future<({bool sent, String reply})> Function(String message, {bool confirmed});

/// The question asked before a build; nothing is sent until the owner says yes.
String cheReaBuildQuestion(int features) =>
    '${features == 1 ? 'Build this feature' : 'Build these $features features'} into CHE as a draft pull request? '
    'Nothing merges or deploys without your separate yes.';

/// What Read this says about one investigation, from CHE's record only.
String cheReaSummary(CheReaInvestigation i) {
  final c = i.comparison;
  final compared = c != null || i.features.any((f) => f.che.status != CheReaCheStatus.unknown);
  final has = c?.has ?? i.countWith(CheReaCheStatus.has);
  final partial = c?.partial ?? i.countWith(CheReaCheStatus.partial);
  final missing = c?.missing ?? i.countWith(CheReaCheStatus.missing);
  final unknown = c?.unknown ?? (compared ? i.countWith(CheReaCheStatus.unknown) : 0);
  final plan = i.plan;
  final build = i.build;
  final v = i.verification;
  final passed = v?.checks.where((x) => x.state.toLowerCase() == 'passed').length ?? 0;
  return [
    '${i.title}, ${cheReaTargetKindLabel(i.target.kind)}${i.target.version.isEmpty ? '' : ', version ${i.target.version}'}.',
    '${cheReaStateLabel(i.state)}. ${i.stageText}.',
    i.features.isEmpty ? 'No features mapped yet.' : '${i.features.length} feature${i.features.length == 1 ? '' : 's'} mapped.',
    if (compared) 'Compared with CHE: she has $has, partly has $partial, is missing $missing${unknown > 0 ? ', $unknown unknown' : ''}.'
    else if (i.features.isNotEmpty) 'Not compared with CHE yet.',
    plan == null
        ? 'No plan yet.'
        : 'Plan: ${plan.features.length} feature${plan.features.length == 1 ? '' : 's'}, ${plan.steps.length} step${plan.steps.length == 1 ? '' : 's'}, ${plan.approved ? 'approved' : 'not approved yet'}.',
    build == null
        ? 'No build started.'
        : 'Build: ${build.state.isEmpty ? 'state not reported' : build.state}${build.prNumber == null ? '' : ', draft pull request ${build.prNumber}'}.',
    v == null
        ? 'Not verified yet.'
        : 'Verification ${cheReaVerificationStateLabel(v.state)}${v.checks.isEmpty ? '' : ': $passed of ${v.checks.length} checks passed'}.',
    if (i.limitations.isNotEmpty) '${i.limitations.length} limitation${i.limitations.length == 1 ? '' : 's'} recorded.',
  ].join(' ');
}

String _short(Object e) {
  final t = e is TimeoutException ? 'CHE did not answer in time' : e.toString();
  return t.length > 240 ? '${t.substring(0, 240)}…' : t;
}

final _bodyLarge = CheType.body.copyWith(fontSize: 17);
final _quiet = CheType.bodyDim.copyWith(fontSize: 14.5);

Color _stateColor(CheReaState s) => switch (s) {
      CheReaState.complete => CheColors.success,
      CheReaState.running || CheReaState.queued => CheColors.accent,
      CheReaState.failed => CheColors.danger,
      CheReaState.stalled || CheReaState.limited => CheColors.warning,
      CheReaState.unknown => CheColors.textDim,
    };

Color _stageColor(CheReaStageState s) => switch (s) {
      CheReaStageState.done => CheColors.success,
      CheReaStageState.running => CheColors.accent,
      CheReaStageState.failed || CheReaStageState.blocked => CheColors.danger,
      CheReaStageState.pending => CheColors.textFaint,
      CheReaStageState.skipped || CheReaStageState.unknown => CheColors.textDim,
    };

Color _cheColor(CheReaCheStatus s) => switch (s) {
      CheReaCheStatus.has => CheColors.success,
      CheReaCheStatus.partial => CheColors.warning,
      CheReaCheStatus.missing => CheColors.danger,
      CheReaCheStatus.unknown => CheColors.textDim,
    };

/// A section title: large, and a heading for VoiceOver's rotor.
class _Heading extends StatelessWidget {
  const _Heading(this.text, {this.top = 24});
  final String text;
  final double top;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(0, top, 0, 8),
        child: Semantics(header: true, child: Text(text, style: CheType.title.copyWith(fontSize: 21, color: CheColors.accent))),
      );
}

class _Subheading extends StatelessWidget {
  const _Subheading(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(0, 10, 0, 4),
        child: Semantics(header: true, child: Text(text, style: CheType.headline.copyWith(fontSize: 18))),
      );
}

/// "Label: value", wrapping for large Dynamic Type.
class _Field extends StatelessWidget {
  const _Field(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text.rich(
          TextSpan(children: [
            TextSpan(text: '$label: ', style: _bodyLarge.copyWith(fontWeight: FontWeight.w700)),
            TextSpan(text: value, style: _bodyLarge),
          ]),
        ),
      );
}

/// A link shown as text (never opened from here): its label, then the address.
class _LinkText extends StatelessWidget {
  const _LinkText(this.link);
  final CheReaLink link;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (link.label.isNotEmpty) Text(link.label, style: _bodyLarge),
            if (link.url.isNotEmpty) SelectableText(link.url, style: CheType.mono.copyWith(fontSize: 14, color: CheColors.textDim)),
          ],
        ),
      );
}

class _Bullets extends StatelessWidget {
  const _Bullets(this.items, {this.numbered = false});
  final List<String> items;
  final bool numbered;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (i, item) in items.indexed)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text('${numbered ? '${i + 1}.' : '•'} $item', style: _bodyLarge),
            ),
        ],
      );
}

/// A message on the page: CHE's reply to an action (large), a result the
/// phone reports, or what Read this said. Dismissable.
class _MessagePanel extends StatelessWidget {
  const _MessagePanel({required this.text, required this.ok, required this.fromChe, required this.live, required this.onHide});
  final String text;
  final bool ok;
  final bool fromChe;
  final bool live;
  final VoidCallback onHide;

  @override
  Widget build(BuildContext context) {
    final color = !ok ? CheColors.danger : fromChe ? CheColors.accent : CheColors.success;
    return Semantics(
      liveRegion: live,
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.only(top: 12),
        padding: const EdgeInsets.fromLTRB(14, 12, 4, 12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(CheRadius.sm),
          border: Border.all(color: color.withValues(alpha: 0.5)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (fromChe) Text('CHE', style: CheType.label.copyWith(color: CheColors.accent)),
                  SelectableText(text, style: CheType.title.copyWith(fontSize: 20, fontWeight: FontWeight.w500, height: 1.35)),
                ],
              ),
            ),
            IconButton(
              tooltip: 'Hide this message',
              visualDensity: VisualDensity.compact,
              onPressed: onHide,
              icon: const Icon(Icons.close_rounded, size: 20),
            ),
          ],
        ),
      ),
    );
  }
}

// ── The list ───────────────────────────────────────────────────────────

class CheReaInvestigationsScreen extends StatefulWidget {
  const CheReaInvestigationsScreen({super.key, required this.client, required this.send, this.onSpeak});

  final CheCommandClient client;
  final CheSendInChat send;
  final void Function(String text)? onSpeak;

  @override
  State<CheReaInvestigationsScreen> createState() => _CheReaInvestigationsScreenState();
}

class _CheReaInvestigationsScreenState extends State<CheReaInvestigationsScreen> {
  CheReaInvestigationList? _list;
  bool _loading = true;
  String _error = '';
  String _status = '';
  bool _statusOk = true;
  Object? _screen;

  List<CheReaInvestigation> get _items => _list?.investigations ?? const [];

  @override
  void initState() {
    super.initState();
    CheReaVoice.register(_voice);
    _screen = CheScreenAwareness.register(context, _screenReport);
    unawaited(_load());
  }

  @override
  void dispose() {
    CheScreenAwareness.unregister(_screen);
    CheReaVoice.unregister(_voice);
    super.dispose();
  }

  /// Quiet: loading shows muted text and never speaks.
  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final list = await widget.client.reaInvestigations();
      if (!mounted) return;
      setState(() {
        _list = list;
        _error = '';
      });
    } on Object catch (e) {
      if (mounted) setState(() => _error = _short(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  CheScreenReport _screenReport() => CheScreenReport(
        page: 'Investigations',
        detail: _list == null
            ? (_loading ? 'The investigations are still loading from CHE' : 'No investigations: ${_error.isEmpty ? 'CHE has not sent any' : _error}')
            : '${_items.length} investigation${_items.length == 1 ? '' : 's'}${_items.isEmpty ? '' : '; newest: ${_items.first.title}, ${cheReaStateLabel(_items.first.state)}'}',
        controls: const ['Back to Commands', 'Read this list aloud', 'Refresh investigations', 'One button per investigation'],
      );

  String _numbered() => [
        for (final (i, inv) in _items.indexed)
          '${i + 1}. ${inv.title}, ${cheReaTargetKindLabel(inv.target.kind)}: ${cheReaStateLabel(inv.state)}, ${inv.stageText}.',
      ].join(' ');

  String _summary() {
    if (_list == null) {
      return _loading ? 'Investigations are still loading from CHE.' : 'Investigations. Could not reach CHE: ${_error.isEmpty ? 'no answer' : _error}.';
    }
    if (_items.isEmpty) return 'Investigations. There are no investigations yet. Ask CHE in Chat to investigate a package, repository, website or app.';
    return 'Investigations. ${_items.length} investigation${_items.length == 1 ? '' : 's'}, newest first. ${_numbered()} '
        'Say a number to open one, "refresh", or "back".';
  }

  /// The visible result of a spoken request: banner and haptic. Chat speaks it.
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

  Future<void> _open(CheReaInvestigation inv) async {
    HapticFeedback.selectionClick();
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheReaInvestigationScreen(client: widget.client, investigation: inv, send: widget.send, onSpeak: widget.onSpeak),
    ));
    if (mounted) unawaited(_load());
  }

  Future<String?> _voice(String words) async {
    if (!mounted) return null;
    final v = CheReaVoiceRequest.parse(words);
    if (v == null) return null;
    switch (v.op) {
      case CheReaVoiceOp.yes || CheReaVoiceOp.no:
        return null;
      case CheReaVoiceOp.back:
        unawaited(Navigator.of(context).maybePop());
        return 'Back to Commands.';
      case CheReaVoiceOp.describe:
        return _say(_summary());
      case CheReaVoiceOp.refresh:
        await _load();
        return _error.isEmpty ? _say('Refreshed. ${_summary()}') : _say('Could not reach CHE: $_error. The list was not updated.', ok: false);
      case CheReaVoiceOp.pick:
        final n = v.numbers.firstOrNull ?? 0;
        if (n < 1 || n > _items.length) {
          return _say(_items.isEmpty ? 'There are no investigations to open.' : 'There is no number $n. ${_numbered()}', ok: false);
        }
        final inv = _items[n - 1];
        unawaited(_open(inv));
        return _say('Opened ${inv.title}. ${cheReaStateLabel(inv.state)}. ${inv.stageText}. Say "read this" to hear it, or "map features", "compare with CHE", "plan", "build" or "verify".');
      default:
        return _say('Open an investigation first. ${_items.isEmpty ? 'There are none yet.' : '${_numbered()} Say a number to open one.'} Nothing was sent.', ok: false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        backgroundColor: CheColors.bg,
        leading: IconButton(
          tooltip: 'Back to Commands',
          icon: const Icon(Icons.arrow_back_ios_new_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Text('Investigations', style: CheType.title.copyWith(fontSize: 22, fontWeight: FontWeight.w800)),
        actions: [
          IconButton(
            tooltip: 'Read this list aloud',
            icon: const Icon(Icons.volume_up_rounded),
            onPressed: () {
              final text = _say(_summary());
              widget.onSpeak?.call(text);
            },
          ),
          IconButton(
            tooltip: 'Refresh investigations',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          key: const ValueKey('rea-list'),
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 4, CheSpace.gutter, 32),
          children: [
            if (_status.isNotEmpty)
              _MessagePanel(text: _status, ok: _statusOk, fromChe: false, live: true, onHide: () => setState(() => _status = '')),
            if (_loading || _error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _loading ? 'Checking with CHE…' : 'Could not reach CHE: $_error${_list == null ? '' : '. Showing the last list CHE sent.'}',
                  style: _quiet.copyWith(color: _error.isNotEmpty && !_loading ? CheColors.warning : CheColors.textDim),
                ),
              ),
            const _Heading('Investigations', top: 12),
            if (_list != null && _items.isEmpty)
              Text('No investigations yet. Ask CHE in Chat to investigate a package, repository, website or app.', style: _bodyLarge),
            for (final inv in _items) _tile(inv),
            if ((_list?.capabilities ?? const []).isNotEmpty) ...[
              const _Heading('What REA can inspect'),
              for (final c in _list!.capabilities)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    '${c.label.isEmpty ? c.id : c.label}: ${c.available ? 'available' : 'not available${c.needs.isEmpty ? '' : '; needs ${c.needs.join(', ')}'}'}.',
                    style: _bodyLarge.copyWith(color: c.available ? CheColors.text : CheColors.textDim),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _tile(CheReaInvestigation inv) {
    final kind = cheReaTargetKindLabel(inv.target.kind);
    final state = cheReaStateLabel(inv.state);
    return Padding(
      key: ValueKey('rea-${inv.id}'),
      padding: const EdgeInsets.only(bottom: 10),
      child: Semantics(
        button: true,
        label: '${inv.title}, $kind. $state. ${inv.stageText}.',
        hint: 'Opens the investigation',
        onTap: () => _open(inv),
        excludeSemantics: true,
        child: Material(
          color: CheColors.surface,
          borderRadius: BorderRadius.circular(CheRadius.md),
          child: InkWell(
            borderRadius: BorderRadius.circular(CheRadius.md),
            onTap: () => _open(inv),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(CheRadius.md),
                border: Border.all(color: _stateColor(inv.state).withValues(alpha: 0.45)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(inv.title, style: CheType.headline.copyWith(fontSize: 19)),
                  const SizedBox(height: 4),
                  Text(kind, style: _quiet),
                  const SizedBox(height: 8),
                  Wrap(spacing: 6, runSpacing: 6, children: [ChePill(text: state, color: _stateColor(inv.state))]),
                  const SizedBox(height: 6),
                  Text(inv.stageText, style: _bodyLarge),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ── One investigation ──────────────────────────────────────────────────

class CheReaInvestigationScreen extends StatefulWidget {
  const CheReaInvestigationScreen({super.key, required this.client, required this.investigation, required this.send, this.onSpeak});

  final CheCommandClient client;
  final CheReaInvestigation investigation;
  final CheSendInChat send;
  final void Function(String text)? onSpeak;

  @override
  State<CheReaInvestigationScreen> createState() => _CheReaInvestigationScreenState();
}

class _CheReaInvestigationScreenState extends State<CheReaInvestigationScreen> {
  late CheReaInvestigation _inv = widget.investigation;

  /// Features chosen for "Plan selected"; starts as the current plan's.
  late final Set<String> _selected = {...?widget.investigation.plan?.features};
  bool _loading = false;
  String _loadError = '';
  bool _busy = false;

  /// What is waiting for CHE's answer (muted, not announced).
  String _waiting = '';
  String _message = '';
  bool _messageOk = true;
  bool _messageFromChe = false;
  bool _messageLive = true;
  Object? _screen;

  /// A spoken build waiting for the owner's yes.
  Future<String> Function()? _voiceConfirm;

  /// Answers the build dialog while it is open ('voice-yes' / 'voice-no').
  void Function(String answer)? _answerDialog;

  static final _safeId = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

  @override
  void initState() {
    super.initState();
    CheReaVoice.register(_voice);
    _screen = CheScreenAwareness.register(context, _screenReport);
    unawaited(_refresh());
  }

  @override
  void dispose() {
    CheScreenAwareness.unregister(_screen);
    CheReaVoice.unregister(_voice);
    super.dispose();
  }

  /// Quiet: muted text while CHE is asked, never speech.
  Future<void> _refresh() async {
    if (_inv.id.isEmpty || _loading) return;
    setState(() => _loading = true);
    try {
      final fresh = await widget.client.reaInvestigation(_inv.id);
      if (!mounted) return;
      setState(() {
        _inv = fresh;
        _loadError = '';
        _selected.removeWhere((id) => fresh.featureById(id) == null);
      });
    } on Object catch (e) {
      if (mounted) setState(() => _loadError = _short(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  CheScreenReport _screenReport() => CheScreenReport(
        page: 'Investigation of ${_inv.title}',
        detail: cheReaSummary(_inv),
        controls: const ['Back to investigations', 'Read this', 'Map features', 'Compare with CHE', 'Plan selected', 'Build', 'Verify', 'Refresh'],
      );

  static const _options = ['Map features', 'Compare with CHE', 'Plan selected', 'Build', 'Verify', 'Refresh', 'Read this'];

  String get _optionsText => 'Options: ${[for (final (i, o) in _options.indexed) '${i + 1}. $o'].join(', ')}. '
      'Say a number or its name. Say "read the features" to hear the feature map, or "select features" and their numbers to choose them for the plan.';

  List<String> get _chosen => [
        for (final f in _inv.features)
          if (_selected.contains(f.id) && _safeId.hasMatch(f.id)) f.id,
      ];

  int get _planFeatures => _inv.plan?.features.length ?? 0;

  // ── Results ──────────────────────────────────────────────────────────

  void _show(String text, {bool ok = true, bool fromChe = false, bool live = true}) {
    if (!mounted) return;
    setState(() {
      _message = text;
      _messageOk = ok;
      _messageFromChe = fromChe;
      _messageLive = live;
    });
  }

  /// A result the phone reports: on screen with a haptic, and spoken when
  /// a button did it (a spoken request's answer is spoken by Chat).
  String _result(String text, {bool ok = true, bool byVoice = false}) {
    _show(text, ok: ok);
    HapticFeedback.heavyImpact();
    if (!ok) HapticFeedback.vibrate();
    if (!byVoice) widget.onSpeak?.call(text);
    return text;
  }

  /// Sends one REA command through CHE's normal chat turn and shows her
  /// reply here, large. Chat speaks the reply as it speaks every reply; this
  /// page adds no second voice. Returns what is left to say (empty when
  /// CHE has answered).
  Future<String> _send(String command, {bool confirmed = false, bool byVoice = false}) async {
    if (!_safeId.hasMatch(_inv.id)) return _result('This investigation has no valid id from CHE, so nothing was sent.', ok: false, byVoice: byVoice);
    if (_busy) return _result('CHE is still answering the last action, so "$command" was not sent.', ok: false, byVoice: byVoice);
    HapticFeedback.mediumImpact();
    setState(() {
      _busy = true;
      _waiting = 'Sent "$command" to CHE. Waiting for her answer…';
    });
    try {
      final r = await widget.send(command, confirmed: confirmed);
      if (!mounted) return '';
      if (!r.sent) {
        return _result('CHE is still answering another message in Chat, so "$command" was not sent. Try again when she finishes.', ok: false, byVoice: byVoice);
      }
      final reply = r.reply.trim();
      _show(reply.isEmpty ? 'Sent "$command" to CHE. Her answer is in Chat.' : reply, fromChe: reply.isNotEmpty);
      HapticFeedback.heavyImpact();
      unawaited(_refresh());
      return '';
    } on Object catch (e) {
      return _result('"$command" did not reach CHE: ${_short(e)}', ok: false, byVoice: byVoice);
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _waiting = '';
        });
      }
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────

  Future<String> _mapFeatures({bool byVoice = false}) => _send('/rea-features ${_inv.id}', byVoice: byVoice);
  Future<String> _compare({bool byVoice = false}) => _send('/rea-compare ${_inv.id}', byVoice: byVoice);
  Future<String> _verify({bool byVoice = false}) => _send('/rea-verify ${_inv.id}', byVoice: byVoice);

  Future<String> _plan({bool byVoice = false}) async {
    final ids = _chosen;
    if (ids.isEmpty) {
      return _result(
          _inv.features.isEmpty
              ? 'There are no features to plan yet. Use Map features first. Nothing was sent.'
              : 'Choose at least one feature in the feature map first. Nothing was sent.',
          ok: false,
          byVoice: byVoice);
    }
    return _send('/rea-rebuild ${_inv.id} ${ids.join(' ')}', byVoice: byVoice);
  }

  String get _noPlan => 'There is no plan to build yet. Choose features in the feature map, then use Plan selected. Nothing was sent.';

  Future<void> _buildPressed() async {
    final n = _planFeatures;
    if (n == 0) {
      _result(_noPlan, ok: false);
      return;
    }
    HapticFeedback.mediumImpact();
    final answer = await showCupertinoDialog<String>(
      context: context,
      builder: (ctx) {
        _answerDialog = (a) => Navigator.of(ctx).pop(a);
        return CupertinoAlertDialog(
          title: const Text('Build into CHE?'),
          content: Text([
            cheReaBuildQuestion(n),
            if (_planNames.isNotEmpty) 'Features: ${_planNames.join(', ')}.',
          ].join('\n\n')),
          actions: [
            CupertinoDialogAction(onPressed: () => Navigator.pop(ctx, 'cancel'), child: const Text('Cancel')),
            CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx, 'build'), child: const Text('Build')),
          ],
        );
      },
    );
    _answerDialog = null;
    if (!mounted) return;
    // A spoken yes or no answered the dialog and has already acted.
    if (answer == 'voice-yes' || answer == 'voice-no') return;
    if (answer != 'build') {
      _result('Build cancelled. Nothing was sent.');
      return;
    }
    await _send('/rea-build ${_inv.id}', confirmed: true);
  }

  List<String> get _planNames => [for (final id in _inv.plan?.features ?? const <String>[]) _inv.featureById(id)?.title ?? id];

  void _read() {
    final text = cheReaSummary(_inv);
    // Read This is shown as well as spoken, without a second announcement.
    _show(text, live: false);
    widget.onSpeak?.call(text);
  }

  // ── Voice ────────────────────────────────────────────────────────────

  String _say(String text, {bool ok = true}) {
    _show(text, ok: ok);
    HapticFeedback.heavyImpact();
    if (!ok) HapticFeedback.vibrate();
    return text;
  }

  String _featureLine(int i, CheReaFeature f) =>
      '${i + 1}. ${f.title}: ${cheReaCheStatusLabel(f.che.status)}${f.complexity == CheReaComplexity.unknown ? '' : ', ${f.complexity.name} complexity'}'
      '${_selected.contains(f.id) ? ', chosen for the plan' : ''}.';

  String _featureDetail(int i, CheReaFeature f) => [
        'Feature ${i + 1} of ${_inv.features.length}: ${f.title}.',
        if (f.purpose.isNotEmpty) 'Purpose: ${f.purpose}',
        if (f.operatedBy.isNotEmpty) 'Operated by: ${f.operatedBy}',
        '${cheReaCheStatusLabel(f.che.status)}.',
        if (f.complexity != CheReaComplexity.unknown) 'Complexity ${f.complexity.name}.',
        if (f.unknowns.isNotEmpty) 'Unknowns: ${f.unknowns.join('; ')}.',
        _selected.contains(f.id) ? 'It is chosen for the plan.' : 'Say "select feature ${i + 1}" to choose it for the plan.',
      ].join(' ');

  /// Feature numbers as said (1-based) to ids, or the first bad number.
  ({List<String> ids, int? bad}) _featuresNumbered(List<int> numbers) {
    final ids = <String>[];
    for (final n in numbers) {
      if (n < 1 || n > _inv.features.length) return (ids: const [], bad: n);
      ids.add(_inv.features[n - 1].id);
    }
    return (ids: ids, bad: null);
  }

  Future<String?> _voice(String words) async {
    if (!mounted) return null;
    final v = CheReaVoiceRequest.parse(words);
    final pending = _voiceConfirm;
    _voiceConfirm = null;
    final dialog = _answerDialog;
    if (dialog != null && (v?.op == CheReaVoiceOp.yes || v?.op == CheReaVoiceOp.no)) {
      // The build question is on screen: a spoken answer counts as pressing it.
      dialog(v!.op == CheReaVoiceOp.yes ? 'voice-yes' : 'voice-no');
      if (v.op == CheReaVoiceOp.no) return _say('Build cancelled. Nothing was sent.');
      return _send('/rea-build ${_inv.id}', confirmed: true, byVoice: true);
    }
    if (pending != null) {
      if (v?.op == CheReaVoiceOp.yes) return pending();
      if (v?.op == CheReaVoiceOp.no) return _say('Build cancelled. Nothing was sent.');
    }
    if (v == null) return null;
    switch (v.op) {
      case CheReaVoiceOp.yes || CheReaVoiceOp.no:
        return null; // Nothing asked here.
      case CheReaVoiceOp.back:
        unawaited(Navigator.of(context).maybePop());
        return 'Back to investigations.';
      case CheReaVoiceOp.describe:
        return _say('${cheReaSummary(_inv)} $_optionsText');
      case CheReaVoiceOp.refresh:
        return _refreshByVoice();
      case CheReaVoiceOp.pick:
        final n = v.numbers.firstOrNull ?? 0;
        if (n < 1 || n > _options.length) return _say('There is no option $n. $_optionsText', ok: false);
        return _option(n - 1);
      case CheReaVoiceOp.mapFeatures:
        return _mapFeatures(byVoice: true);
      case CheReaVoiceOp.compare:
        return _compare(byVoice: true);
      case CheReaVoiceOp.verify:
        return _verify(byVoice: true);
      case CheReaVoiceOp.listFeatures:
        if (_inv.features.isEmpty) return _say('No features are mapped yet. Say "map features" to ask CHE to map them.');
        return _say('${_inv.features.length} features. ${[for (final (i, f) in _inv.features.indexed) _featureLine(i, f)].join(' ')} '
            'Say "feature" and a number to hear one, or "select features" and their numbers.');
      case CheReaVoiceOp.feature:
        final n = v.numbers.firstOrNull ?? 0;
        if (n < 1 || n > _inv.features.length) return _say('There is no feature $n. ${_inv.features.length} are mapped.', ok: false);
        return _say(_featureDetail(n - 1, _inv.features[n - 1]));
      case CheReaVoiceOp.select:
        final picked = _featuresNumbered(v.numbers);
        if (picked.bad != null) return _say('There is no feature ${picked.bad}. ${_inv.features.length} are mapped. Nothing was chosen.', ok: false);
        setState(() => _selected.addAll(picked.ids));
        return _say('Chosen for the plan: ${[for (final id in _chosen) _inv.featureById(id)!.title].join(', ')}. Say "plan selected" to plan them.');
      case CheReaVoiceOp.clear:
        setState(_selected.clear);
        return _say('No features are chosen for the plan now.');
      case CheReaVoiceOp.plan:
        if (v.numbers.isNotEmpty) {
          final picked = _featuresNumbered(v.numbers);
          if (picked.bad != null) return _say('There is no feature ${picked.bad}. ${_inv.features.length} are mapped. Nothing was sent.', ok: false);
          setState(() => _selected
            ..clear()
            ..addAll(picked.ids));
        }
        return _plan(byVoice: true);
      case CheReaVoiceOp.build:
        return _buildByVoice();
    }
  }

  Future<String> _option(int i) async => switch (i) {
        0 => await _mapFeatures(byVoice: true),
        1 => await _compare(byVoice: true),
        2 => await _plan(byVoice: true),
        3 => _buildByVoice(),
        4 => await _verify(byVoice: true),
        5 => await _refreshByVoice(),
        _ => _say('${cheReaSummary(_inv)} $_optionsText'),
      };

  Future<String> _refreshByVoice() async {
    await _refresh();
    return _loadError.isEmpty ? _say('Refreshed. ${cheReaSummary(_inv)}') : _say('Could not reach CHE: $_loadError. The page was not updated.', ok: false);
  }

  String _buildByVoice() {
    final n = _planFeatures;
    if (n == 0) return _say(_noPlan, ok: false);
    // Owner rule for /rea-build: ask first; only a plain yes next sends it.
    _voiceConfirm = () => _send('/rea-build ${_inv.id}', confirmed: true, byVoice: true);
    return _say('${cheReaBuildQuestion(n)}${_planNames.isEmpty ? '' : ' Features: ${_planNames.join(', ')}.'} Say yes to build, or no to cancel.');
  }

  // ── UI ───────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final i = _inv;
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(
        backgroundColor: CheColors.bg,
        leading: IconButton(
          tooltip: 'Back to investigations',
          icon: const Icon(Icons.arrow_back_ios_new_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Text('Investigation', style: CheType.title.copyWith(fontSize: 22, fontWeight: FontWeight.w800)),
      ),
      body: SafeArea(
        child: ListView(
          key: const ValueKey('rea-detail'),
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 4, CheSpace.gutter, 40),
          children: [
            Semantics(header: true, child: Text(i.title, style: CheType.title)),
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: [
              ChePill(text: cheReaStateLabel(i.state), color: _stateColor(i.state)),
              ChePill(text: cheReaTargetKindLabel(i.target.kind), color: CheColors.accentAlt),
            ]),
            const SizedBox(height: 8),
            Text(i.stageText, style: _bodyLarge),
            if (_loading || _loadError.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  _loading ? 'Checking with CHE…' : 'Could not reach CHE ($_loadError). Showing the last record CHE sent.',
                  style: _quiet.copyWith(color: _loadError.isNotEmpty && !_loading ? CheColors.warning : CheColors.textDim),
                ),
              ),
            const SizedBox(height: 14),
            _actions(),
            if (_waiting.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_waiting, style: _quiet)),
            if (_message.isNotEmpty)
              _MessagePanel(
                text: _message,
                ok: _messageOk,
                fromChe: _messageFromChe,
                live: _messageLive,
                onHide: () => setState(() => _message = ''),
              ),
            ..._target(),
            ..._stages(),
            ..._sources(),
            ..._screenshots(),
            ..._features(),
            ..._architecture(),
            ..._comparison(),
            ..._proposals(),
            ..._planSection(),
            ..._buildSection(),
            ..._verification(),
            ..._limitations(),
          ],
        ),
      ),
    );
  }

  Widget _actions() {
    final chosen = _chosen.length;
    Widget button(String label, IconData icon, VoidCallback onPressed, {bool filled = true, bool alwaysOn = false}) {
      final enabled = alwaysOn || !_busy;
      return filled
          ? FilledButton.icon(onPressed: enabled ? onPressed : null, icon: Icon(icon), label: Text(label))
          : OutlinedButton.icon(onPressed: enabled ? onPressed : null, icon: Icon(icon), label: Text(label));
    }

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        // Read this is never disabled.
        button('Read this', Icons.volume_up_rounded, _read, filled: false, alwaysOn: true),
        button('Map features', Icons.travel_explore_rounded, _mapFeatures),
        button('Compare with CHE', Icons.compare_arrows_rounded, _compare),
        button(chosen == 0 ? 'Plan selected' : 'Plan selected: $chosen feature${chosen == 1 ? '' : 's'}', Icons.account_tree_rounded, _plan),
        button('Build', Icons.construction_rounded, _buildPressed),
        button('Verify', Icons.verified_rounded, _verify),
        button('Refresh', Icons.refresh_rounded, _refresh, filled: false, alwaysOn: true),
      ],
    );
  }

  List<Widget> _target() {
    final t = _inv.target;
    final updated = _inv.updatedAt ?? _inv.createdAt;
    return [
      const _Heading('Target'),
      _Field('Name', t.label.isEmpty ? 'Not reported' : t.label),
      _Field('Kind', cheReaTargetKindLabel(t.kind)),
      _Field('Version', t.version.isEmpty ? 'Not reported' : t.version),
      if (t.url.isNotEmpty) ...[
        Text('Link:', style: _bodyLarge.copyWith(fontWeight: FontWeight.w700)),
        SelectableText(t.url, style: CheType.mono.copyWith(fontSize: 14.5, color: CheColors.textDim)),
      ] else
        const _Field('Link', 'None reported'),
      if (updated != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Last updated ${_when(updated)}', style: _quiet)),
    ];
  }

  static String _when(DateTime t) {
    final l = t.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${l.year}-${two(l.month)}-${two(l.day)} at ${two(l.hour)}:${two(l.minute)}';
  }

  List<Widget> _stages() {
    final all = _inv.stages;
    return [
      const _Heading('Stage progress'),
      for (final (n, s) in all.indexed)
        Semantics(
          label: 'Stage ${n + 1} of ${all.length}, ${s.label}: ${cheReaStageStateLabel(s.state)}'
              '${s.id == _inv.stageId ? '. Current stage' : ''}${s.note.isEmpty ? '' : '. ${s.note}'}',
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Icon(s.state == CheReaStageState.done ? Icons.check_circle_rounded : Icons.circle, size: 14, color: _stageColor(s.state)),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${n + 1}. ${s.label}${s.id == _inv.stageId ? ' (current)' : ''}',
                          style: _bodyLarge.copyWith(fontWeight: s.id == _inv.stageId ? FontWeight.w700 : FontWeight.w400)),
                      Text(cheReaStageStateLabel(s.state), style: CheType.label.copyWith(fontSize: 14, color: _stageColor(s.state))),
                      if (s.note.isNotEmpty) Text(s.note, style: _quiet),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
    ];
  }

  List<Widget> _sources() => [
        const _Heading('Sources'),
        if (_inv.sources.isEmpty) Text('No sources recorded yet.', style: _bodyLarge),
        for (final s in _inv.sources) _LinkText(s),
      ];

  List<Widget> _screenshots() {
    final shots = _inv.screenshots;
    return [
      const _Heading('Screenshots'),
      // Only what the browser run really captured; never a stand-in preview.
      if (shots.isEmpty) Text('No screenshots were captured.', style: _bodyLarge),
      for (final (n, s) in shots.indexed)
        _ScreenshotView(
          key: ValueKey('rea-shot-${s.file}'),
          uri: widget.client.reaFileUri(_inv.id, s.file),
          headers: widget.client.reaFileHeaders(),
          label: 'Screenshot ${n + 1} of ${shots.length}${s.label.isEmpty ? '' : ', ${s.label}'}',
        ),
    ];
  }

  List<Widget> _features() {
    final features = _inv.features;
    return [
      _Heading('Feature map${features.isEmpty ? '' : ' (${features.length})'}'),
      if (features.isEmpty) Text('No features mapped yet. Use Map features to ask CHE to map them.', style: _bodyLarge),
      for (final (n, f) in features.indexed) _featureCard(n, f),
    ];
  }

  Widget _featureCard(int n, CheReaFeature f) {
    final chosen = _selected.contains(f.id);
    String list(List<String> items) => items.join(', ');
    // A Material card, so the checkbox row's ink shows on it.
    return Padding(
      key: ValueKey('rea-feature-${f.id}'),
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: CheColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(CheRadius.md),
          side: BorderSide(color: chosen ? CheColors.accent : CheColors.stroke),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(header: true, child: Text('${n + 1}. ${f.title}', style: CheType.headline.copyWith(fontSize: 19))),
              const SizedBox(height: 6),
              Wrap(spacing: 6, runSpacing: 6, children: [
                ChePill(text: cheReaCheStatusLabel(f.che.status), color: _cheColor(f.che.status)),
                ChePill(text: f.complexity == CheReaComplexity.unknown ? 'complexity not rated' : '${f.complexity.name} complexity', color: CheColors.accentAlt),
              ]),
              CheckboxListTile(
                value: chosen,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                title: Text('Choose "${f.title}" for the plan', style: _bodyLarge),
                onChanged: (on) {
                  HapticFeedback.selectionClick();
                  setState(() => on == true ? _selected.add(f.id) : _selected.remove(f.id));
                },
              ),
              if (f.purpose.isNotEmpty) _Field('Purpose', f.purpose),
              if (f.userSees.isNotEmpty) _Field('What you see', f.userSees),
              _Field('How it is operated', f.operatedBy.isEmpty ? 'Not reported' : f.operatedBy),
              if (f.inputs.isNotEmpty) _Field('Inputs', list(f.inputs)),
              if (f.outputs.isNotEmpty) _Field('Outputs', list(f.outputs)),
              if (f.components.isNotEmpty) _Field('Built from', list(f.components)),
              if (f.dependencies.isNotEmpty) _Field('Depends on', list(f.dependencies)),
              if (f.cost.isNotEmpty) _Field('Cost', f.cost),
              if (f.feasibleOk != null || f.feasibleNote.isNotEmpty)
                _Field('Can CHE build it', '${f.feasibleOk == null ? 'not assessed' : f.feasibleOk! ? 'yes' : 'no'}${f.feasibleNote.isEmpty ? '' : '. ${f.feasibleNote}'}'),
              const _Subheading('Evidence'),
              if (f.evidence.isEmpty) Text('No evidence recorded.', style: _bodyLarge),
              for (final e in f.evidence) _LinkText(e),
              const _Subheading('Unknowns'),
              if (f.unknowns.isEmpty) Text('None recorded.', style: _bodyLarge) else _Bullets(f.unknowns),
              _Subheading('CHE status: ${cheReaCheStatusLabel(f.che.status)}'),
              if (f.che.evidence.isEmpty) Text('No evidence recorded for this answer.', style: _bodyLarge),
              for (final e in f.che.evidence) _LinkText(e),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _architecture() {
    Widget finding(CheReaFinding a) => Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (a.label.isNotEmpty) Text(a.label, style: _bodyLarge.copyWith(fontWeight: FontWeight.w700)),
              if (a.detail.isNotEmpty) Text(a.detail, style: _bodyLarge),
              for (final e in a.evidence) _LinkText(e),
            ],
          ),
        );
    return [
      const _Heading('Architecture findings'),
      for (final (kind, title) in const [
        (CheReaFindingKind.observed, 'Observed'),
        (CheReaFindingKind.inferred, 'Inferred'),
        (CheReaFindingKind.unknown, 'Unknown'),
      ]) ...[
        _Subheading(title),
        if (!_inv.architecture.any((a) => a.kind == kind)) Text('None recorded.', style: _bodyLarge),
        for (final a in _inv.architecture)
          if (a.kind == kind) finding(a),
      ],
    ];
  }

  List<Widget> _comparison() {
    final c = _inv.comparison;
    return [
      const _Heading('Comparison with CHE'),
      if (c == null)
        Text('Not compared yet. Use Compare with CHE.', style: _bodyLarge)
      else ...[
        _Field('CHE has', '${c.has}'),
        _Field('CHE partly has', '${c.partial}'),
        _Field('CHE is missing', '${c.missing}'),
        _Field('Unknown', '${c.unknown}'),
      ],
    ];
  }

  List<Widget> _proposals() => [
        const _Heading('Proposals'),
        if (_inv.proposals.isEmpty) Text('No proposals yet.', style: _bodyLarge),
        for (final p in _inv.proposals)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${p.name.isEmpty ? _inv.featureById(p.featureId)?.title ?? p.featureId : p.name}${p.featureId.isEmpty ? '' : ' (${p.featureId})'}',
                    style: _bodyLarge.copyWith(fontWeight: FontWeight.w700)),
                if (p.why.isNotEmpty) Text(p.why, style: _bodyLarge),
              ],
            ),
          ),
      ];

  List<Widget> _planSection() {
    final p = _inv.plan;
    return [
      const _Heading('Plan'),
      if (p == null)
        Text('No plan yet. Choose features in the feature map, then use Plan selected.', style: _bodyLarge)
      else ...[
        _Field('Features', _planNames.isEmpty ? 'None' : _planNames.join(', ')),
        _Field('Approved', p.approved ? 'Yes' : 'Not yet'),
        const _Subheading('Steps'),
        if (p.steps.isEmpty) Text('No steps recorded.', style: _bodyLarge) else _Bullets(p.steps, numbered: true),
        const _Subheading('Acceptance criteria'),
        if (p.acceptance.isEmpty) Text('None recorded.', style: _bodyLarge) else _Bullets(p.acceptance),
      ],
    ];
  }

  List<Widget> _buildSection() {
    final b = _inv.build;
    return [
      const _Heading('Build'),
      if (b == null)
        Text('No build started.', style: _bodyLarge)
      else ...[
        _Field('Coding job', b.jobId.isEmpty ? 'Not reported' : b.jobId),
        _Field('State', b.state.isEmpty ? 'Not reported' : b.state),
        _Field('Draft pull request', b.prNumber == null ? 'None yet' : '#${b.prNumber}'),
        if (b.prUrl.isNotEmpty) SelectableText(b.prUrl, style: CheType.mono.copyWith(fontSize: 14.5, color: CheColors.textDim)),
        if (b.note.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(b.note, style: _bodyLarge)),
      ],
    ];
  }

  List<Widget> _verification() {
    final v = _inv.verification;
    return [
      const _Heading('Verification'),
      if (v == null)
        Text('Not verified yet.', style: _bodyLarge)
      else ...[
        _Field('State', cheReaVerificationStateLabel(v.state)),
        if (v.checks.isEmpty) Text('No checks recorded.', style: _bodyLarge),
        for (final c in v.checks)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${c.name.isEmpty ? 'Check' : c.name}: ${c.state.isEmpty ? 'state not reported' : c.state}', style: _bodyLarge),
                if (c.url.isNotEmpty) SelectableText(c.url, style: CheType.mono.copyWith(fontSize: 14, color: CheColors.textDim)),
              ],
            ),
          ),
        if (v.note.isNotEmpty) Text(v.note, style: _bodyLarge),
      ],
    ];
  }

  List<Widget> _limitations() => [
        const _Heading('Limitations'),
        if (_inv.limitations.isEmpty) Text('No limitations recorded.', style: _bodyLarge) else _Bullets(_inv.limitations),
      ];
}

/// One captured screenshot, loaded from CHE with the paired-device headers.
/// When it cannot be loaded the page says so in words.
class _ScreenshotView extends StatelessWidget {
  const _ScreenshotView({super.key, required this.uri, required this.headers, required this.label});
  final Uri? uri;
  final Map<String, String> headers;
  final String label;

  @override
  Widget build(BuildContext context) {
    Widget failed(String why) => Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: CheColors.surface,
            borderRadius: BorderRadius.circular(CheRadius.sm),
            border: Border.all(color: CheColors.warning.withValues(alpha: 0.5)),
          ),
          child: Text('$label could not be shown: $why', style: _bodyLarge.copyWith(color: CheColors.warning)),
        );
    final u = uri;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (u == null)
            failed('this iPhone is not connected to CHE, or the file name CHE sent is not valid.')
          else
            ClipRRect(
              borderRadius: BorderRadius.circular(CheRadius.sm),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 460),
                child: Image.network(
                  u.toString(),
                  headers: headers,
                  fit: BoxFit.contain,
                  semanticLabel: '$label, captured by CHE',
                  errorBuilder: (_, _, _) => failed('CHE did not send the image.'),
                ),
              ),
            ),
          const SizedBox(height: 4),
          ExcludeSemantics(child: Text(label, style: _quiet)),
        ],
      ),
    );
  }
}
