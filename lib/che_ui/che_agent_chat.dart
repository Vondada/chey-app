// CHE agent chat — glowing composer, Agent/Chat toggle, conversation switcher,
// live "Thinking… 0.4s" timer, step lines, streaming replies, code cards.
// Built for speed: optimistic UI, per-frame batched rendering, trimmed history.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

import 'che_backend.dart';
import 'che_brain.dart';
import 'che_log.dart';
import 'che_models.dart';
import 'che_plugins.dart';
import 'che_transitions.dart';
import 'che_theme.dart';
import 'che_widgets.dart';

// ─────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────

class CheAgentController extends ChangeNotifier {
  CheAgentController({
    required this.backend,
    this.modes = const ['Agent', 'Chat'],
    this.historyLimit = 12,
    this.systemAddons,
    this.store,
    this.brain,
  }) {
    newConversation();
  }

  /// CHE's brain: facts + recall of past conversations (see che_brain.dart).
  final CheBrain? brain;

  /// Saves every conversation word for word (see che_log.dart).
  final CheConversationStore? store;

  /// Load saved conversations (call once at startup).
  Future<void> restore() async {
    if (store == null) return;
    final saved = await store!.loadAll();
    if (saved.isEmpty) return;
    conversations
      ..removeWhere((c) => c.messages.isEmpty)
      ..addAll(saved.where((s) => !conversations.any((c) => c.id == s.id)));
    conversations.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    if (current.messages.isEmpty) {
      current = CheConversation('c${DateTime.now().microsecondsSinceEpoch}_${_ids++}');
      conversations.insert(0, current);
    }
    notifyListeners();
  }

  /// Log a spoken exchange (from the "Chay" voice mode) into the current
  /// conversation so voice talks appear in the same log, word for word.
  void logVoiceTurn(String youSaid, String cheSaid) => logTurn(youSaid, cheSaid, source: 'voice');

  /// Log one finished exchange that happened outside this controller's own
  /// chat (e.g. the home screen chat or voice), word for word. CHE's
  /// ```che-remember facts are saved and she reflects every few turns.
  void logTurn(String youSaid, String cheSaid, {String source = 'chat'}) {
    if (youSaid.trim().isEmpty && cheSaid.trim().isEmpty) return;
    final voice = source == 'voice';
    final u = CheMessage.user(voice ? '🎙 $youSaid' : youSaid);
    final r = CheMessage.assistant()..text = cheSaid;
    current.messages..add(u)..add(r);
    if (current.title == 'New Chat') {
      final head = youSaid.length > 28 ? '${youSaid.substring(0, 28)}…' : youSaid;
      current.title = voice ? 'Voice: $head' : head;
    }
    current.updatedAt = DateTime.now();
    conversations
      ..remove(current)
      ..insert(0, current);
    store?.save(current);
    store?.remoteLog(current, u, r, source: source);
    if (brain != null) {
      for (final f in CheBrain.findRemember(cheSaid)) {
        brain!.addFact(f, source: 'che');
      }
      _maybeReflect(current);
    }
    notifyListeners();
  }

  final CheBackend backend;
  final List<String> modes;

  /// Only the last N messages are sent — smaller payload = faster replies.
  final int historyLimit;

  /// Returns extra instructions from installed plugins (optional).
  final List<String> Function()? systemAddons;

  final List<CheConversation> conversations = [];
  late CheConversation current;
  int modeIndex = 0;

  StreamSubscription<String>? _sub;
  _Cancel? _cancel;
  bool _pendingNotify = false;
  int _ids = 0;

  bool get busy => _sub != null;
  String get mode => modes[modeIndex];

  /// Set by the voice system: sleeping (wake-word only), listening, speaking.
  /// null = let the chat decide.
  CheOrbState? voiceState;
  void setVoiceState(CheOrbState? s) {
    voiceState = s;
    notifyListeners();
  }

  bool _justCompleted = false;

  /// What CHE's orb should show right now (spec: Sleeping, Awake, Listening,
  /// Thinking, Speaking, Working, Delegating, Waiting, Completed).
  CheOrbState get orbState {
    if (voiceState != null) return voiceState!;
    if (busy) {
      final last = current.messages.isNotEmpty ? current.messages.last : null;
      if (last != null && last.text.isNotEmpty) return CheOrbState.speaking;
      final running = last?.steps.where((s) => s.status == StepStatus.running).map((s) => s.label.toLowerCase()).join(' ') ?? '';
      if (running.contains('delegat') || running.contains('agent')) return CheOrbState.delegating;
      if ((last?.steps.length ?? 0) > 1) return CheOrbState.working;
      return CheOrbState.thinking;
    }
    if (_justCompleted) return CheOrbState.completed;
    return CheOrbState.awake;
  }

  void setMode(int i) {
    if (i == modeIndex) return;
    modeIndex = i;
    notifyListeners();
  }

  void newConversation() {
    if (conversations.isNotEmpty && current.messages.isEmpty) return; // reuse the empty one
    stop();
    current = CheConversation('c${DateTime.now().microsecondsSinceEpoch}_${_ids++}');
    conversations.insert(0, current);
    notifyListeners();
  }

  void open(CheConversation c) {
    if (identical(c, current)) return;
    stop();
    current = c;
    notifyListeners();
  }

  void deleteConversation(CheConversation c) {
    conversations.remove(c);
    store?.delete(c);
    if (identical(c, current)) {
      if (conversations.isEmpty) {
        current = CheConversation('c${DateTime.now().microsecondsSinceEpoch}_${_ids++}');
        conversations.add(current);
      } else {
        current = conversations.first;
      }
    }
    notifyListeners();
  }

  void send(String text, {List<Object> attachments = const []}) {
    text = text.trim();
    if ((text.isEmpty && attachments.isEmpty) || busy) return;
    HapticFeedback.mediumImpact();

    final user = CheMessage.user(text, List.of(attachments));
    current.messages.add(user);
    if (current.title == 'New Chat' && text.isNotEmpty) {
      current.title = text.length > 34 ? '${text.substring(0, 34).trimRight()}…' : text;
    }
    current.updatedAt = DateTime.now();
    conversations
      ..remove(current)
      ..insert(0, current);

    final reply = CheMessage.assistant()
      ..streaming = true
      ..startedAt = DateTime.now();
    reply.steps.add(CheStep(mode == 'Agent' ? 'Reading your request' : 'Thinking'));
    current.messages.add(reply);
    notifyListeners(); // user sees their message + CHE working instantly
    store?.save(current);

    _run(reply, user);
  }

  void _run(CheMessage reply, CheMessage user) {
    final cancel = _Cancel();
    _cancel = cancel;
    final all = current.messages.where((m) => !identical(m, reply) && !m.isError).toList();
    final history = all.length > historyLimit ? all.sublist(all.length - historyLimit) : all;

    final req = CheRequest(
      message: user.text,
      mode: mode,
      history: history,
      attachments: user.attachments,
      systemAddons: [
        ...?brain?.contextFor(user.text, conversations, exclude: current, recentReplies: _recentReplies()),
        ...?systemAddons?.call(),
        if (RegExp(r'\bplug-?ins?\b', caseSensitive: false).hasMatch(user.text)) chePluginAuthoringGuide.trim(),
      ],
      isCancelled: () => cancel.cancelled,
      onStep: (label) {
        if (cancel.cancelled) return;
        for (final s in reply.steps) {
          if (s.status == StepStatus.running) s.status = StepStatus.done;
        }
        reply.steps.add(CheStep(label));
        _notifySoon();
      },
    );

    var first = true;
    _sub = backend.reply(req).listen(
      (chunk) {
        if (cancel.cancelled) return;
        if (first) {
          first = false;
          reply.thoughtMs = DateTime.now().difference(reply.startedAt!).inMilliseconds;
          for (final s in reply.steps) {
            if (s.status == StepStatus.running) s.status = StepStatus.done;
          }
          HapticFeedback.selectionClick();
        }
        reply.text += chunk;
        _notifySoon();
      },
      onError: (Object e, StackTrace st) {
        reply
          ..isError = true
          ..errorText = _friendlyError(e);
        for (final s in reply.steps) {
          if (s.status == StepStatus.running) s.status = StepStatus.error;
        }
        _finish(reply);
      },
      onDone: () => _finish(reply),
      cancelOnError: true,
    );
  }

  List<String> _recentReplies() {
    final out = <String>[];
    for (final c in conversations) {
      for (final m in c.messages.reversed) {
        if (!m.isUser && !m.isError && !m.streaming && m.text.isNotEmpty) out.add(m.text);
        if (out.length >= 5) return out;
      }
    }
    return out;
  }

  /// Every [reflectEvery] finished exchanges, CHE privately reflects on the
  /// conversation in the background (never slows down a reply).
  final int reflectEvery = 4;
  final Map<String, int> _sinceReflect = {};
  bool _reflecting = false;

  Future<void> _maybeReflect(CheConversation conv) async {
    if (brain == null || _reflecting) return;
    final n = (_sinceReflect[conv.id] ?? 0) + 1;
    _sinceReflect[conv.id] = n;
    if (n < reflectEvery) return;
    _sinceReflect[conv.id] = 0;
    _reflecting = true;
    try {
      final buf = StringBuffer();
      final req = CheRequest(
        message: CheBrain.reflectionPrompt(conv),
        mode: 'Reflect',
        history: const [],
        attachments: const [],
        systemAddons: [brain!.soul],
        onStep: (_) {},
        isCancelled: () => false,
      );
      await for (final chunk in backend.reply(req).timeout(const Duration(seconds: 45))) {
        buf.write(chunk);
      }
      final text = buf.toString();
      for (final f in CheBrain.findRemember(text)) {
        await brain!.addFact(f, source: 'che');
      }
      await brain!.addReflection(text.replaceAll(RegExp(r'```che-remember[\s\S]*?```'), '').trim());
    } catch (_) {
      // reflection is best-effort
    } finally {
      _reflecting = false;
    }
  }

  void _finish(CheMessage reply) {
    reply.thoughtMs ??= DateTime.now().difference(reply.startedAt ?? DateTime.now()).inMilliseconds;
    reply.streaming = false;
    for (final s in reply.steps) {
      if (s.status == StepStatus.running) s.status = StepStatus.done;
    }
    _sub = null;
    _cancel = null;
    if (!reply.isError) {
      HapticFeedback.lightImpact();
      _justCompleted = true;
      Future<void>.delayed(const Duration(milliseconds: 1400), () {
        if (_disposed) return;
        _justCompleted = false;
        notifyListeners();
      });
    }
    notifyListeners();
    final conv = current.messages.contains(reply)
        ? current
        : conversations.firstWhere((c) => c.messages.contains(reply), orElse: () => current);
    conv.updatedAt = DateTime.now();
    store?.save(conv);
    final i = conv.messages.indexOf(reply);
    if (i > 0) store?.remoteLog(conv, conv.messages[i - 1], reply);
    if (brain != null && !reply.isError) {
      for (final f in CheBrain.findRemember(reply.text)) {
        brain!.addFact(f, source: 'che');
      }
      _maybeReflect(conv);
    }
  }

  void stop() {
    if (_sub == null) return;
    _cancel?.cancelled = true;
    _sub?.cancel();
    final last = current.messages.isNotEmpty ? current.messages.last : null;
    if (last != null && !last.isUser && last.streaming) {
      if (last.text.isEmpty) last.text = 'Stopped.';
      _finish(last);
    } else {
      _sub = null;
      _cancel = null;
      notifyListeners();
    }
  }

  /// Re-run the user message that produced [reply].
  void retry(CheMessage reply) {
    if (busy) return;
    final i = current.messages.indexOf(reply);
    if (i <= 0) return;
    final user = current.messages[i - 1];
    current.messages.removeRange(i - 1, i + 1);
    send(user.text, attachments: user.attachments);
  }

  /// Batch rapid token updates into one rebuild per frame (smooth at any speed).
  void _notifySoon() {
    if (_pendingNotify) return;
    _pendingNotify = true;
    SchedulerBinding.instance.scheduleFrameCallback((_) {
      _pendingNotify = false;
      notifyListeners();
    });
    SchedulerBinding.instance.scheduleFrame();
  }

  static String _friendlyError(Object e) {
    final s = e.toString();
    if (e is TimeoutException) return 'CHE took too long to answer. Tap retry.';
    if (s.contains('SocketException') || s.contains('HandshakeException')) {
      return 'No connection to CHE right now. Check your signal and tap retry.';
    }
    if (e is CheBackendException) return 'CHE hit an error (${e.statusCode}). Tap retry.';
    return 'Something went wrong. Tap retry.';
  }

  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    _cancel?.cancelled = true;
    _sub?.cancel();
    super.dispose();
  }
}

class _Cancel {
  bool cancelled = false;
}

// ─────────────────────────────────────────────────────────────────────────
// Orb — CHE's living presence. Every state from the spec animates differently.
// ─────────────────────────────────────────────────────────────────────────

enum CheOrbState { sleeping, awake, listening, thinking, speaking, working, delegating, waiting, completed }

extension CheOrbStateLabel on CheOrbState {
  String get label => switch (this) {
        CheOrbState.sleeping => 'Sleeping',
        CheOrbState.awake => 'Awake',
        CheOrbState.listening => 'Listening',
        CheOrbState.thinking => 'Thinking',
        CheOrbState.speaking => 'Speaking',
        CheOrbState.working => 'Working',
        CheOrbState.delegating => 'Delegating',
        CheOrbState.waiting => 'Waiting',
        CheOrbState.completed => 'Completed',
      };
}

class CheOrb extends StatefulWidget {
  const CheOrb({super.key, this.size = 28, this.label = false, this.active = false, this.state});
  final double size;
  final bool label;

  /// Legacy flag: true ≈ thinking, false ≈ awake (used when [state] is null).
  final bool active;
  final CheOrbState? state;
  @override
  State<CheOrb> createState() => _CheOrbState();
}

class _CheOrbState extends State<CheOrb> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 3))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  CheOrbState get _state => widget.state ?? (widget.active ? CheOrbState.thinking : CheOrbState.awake);

  @override
  Widget build(BuildContext context) {
    final s = widget.size;
    return SizedBox(
      width: s,
      height: s,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final t = CheMotion.reduced(context) ? 0.25 : _c.value;
          final st = _state;
          final base = switch (st) {
            CheOrbState.sleeping => CheColors.textFaint,
            CheOrbState.waiting => CheColors.warning,
            CheOrbState.completed => CheColors.success,
            CheOrbState.listening => CheColors.accentAlt,
            _ => CheColors.accent,
          };
          final breathe = 0.5 + 0.5 * math.sin(t * math.pi * 2 * (st == CheOrbState.sleeping ? 1 : 2));
          double scale = 1;
          if (st == CheOrbState.speaking) {
            scale = 1 + 0.06 * (math.sin(t * math.pi * 2 * 9).abs() * 0.6 + math.sin(t * math.pi * 2 * 5).abs() * 0.4);
          } else if (st == CheOrbState.sleeping) {
            scale = 0.94 + 0.02 * breathe;
          }
          final glow = switch (st) {
            CheOrbState.sleeping => 0.12,
            CheOrbState.awake => 0.3 + 0.15 * breathe,
            CheOrbState.completed => 0.7,
            _ => 0.45 + 0.25 * breathe,
          };
          return CustomPaint(
            painter: _OrbFxPainter(state: st, t: t, color: base),
            child: Center(
              child: Transform.scale(
                scale: scale,
                child: Container(
                  width: s * 0.78,
                  height: s * 0.78,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(
                      colors: [
                        base.withValues(alpha: st == CheOrbState.sleeping ? 0.45 : 0.95),
                        Color.lerp(base, Colors.black, 0.45)!.withValues(alpha: 0.9),
                        const Color(0xFF02110E),
                      ],
                      stops: const [0.0, 0.55, 1.0],
                      center: Alignment(-0.2 + 0.2 * breathe, -0.3),
                    ),
                    border: Border.all(color: base.withValues(alpha: 0.8), width: s > 60 ? 2 : 1),
                    boxShadow: [BoxShadow(color: base.withValues(alpha: glow), blurRadius: s * 0.5)],
                  ),
                  alignment: Alignment.center,
                  child: widget.label
                      ? Text('CHE',
                          style: CheType.display.copyWith(
                              fontSize: s * 0.18, color: const Color(0xFF02110E), letterSpacing: s * 0.025))
                      : null,
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Rings, arcs and satellites around the orb for each state.
class _OrbFxPainter extends CustomPainter {
  _OrbFxPainter({required this.state, required this.t, required this.color});
  final CheOrbState state;
  final double t;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.width * 0.39;
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = math.max(1.2, size.width * 0.025);
    switch (state) {
      case CheOrbState.listening:
        for (var i = 0; i < 3; i++) {
          final k = (t * 2 + i / 3) % 1.0;
          canvas.drawCircle(c, r * (1 + 0.28 * k), stroke..color = color.withValues(alpha: 0.6 * (1 - k)));
        }
      case CheOrbState.thinking:
        canvas.drawArc(Rect.fromCircle(center: c, radius: r * 1.14), t * math.pi * 4, math.pi * 0.7, false,
            stroke..color = color.withValues(alpha: 0.9));
        canvas.drawArc(Rect.fromCircle(center: c, radius: r * 1.14), t * math.pi * 4 + math.pi, math.pi * 0.35, false,
            stroke..color = CheColors.accentAlt.withValues(alpha: 0.7));
      case CheOrbState.working:
        canvas.drawCircle(c, r * 1.16, stroke..color = color.withValues(alpha: 0.18));
        final a = t * math.pi * 4;
        canvas.drawCircle(c + Offset(math.cos(a), math.sin(a)) * r * 1.16, size.width * 0.05, Paint()..color = color);
      case CheOrbState.delegating:
        canvas.drawCircle(c, r * 1.18, stroke..color = color.withValues(alpha: 0.15));
        for (var i = 0; i < 3; i++) {
          final a = t * math.pi * 2 + i * math.pi * 2 / 3;
          final p = c + Offset(math.cos(a), math.sin(a)) * r * 1.18;
          canvas.drawLine(c, p, Paint()
            ..color = color.withValues(alpha: 0.25)
            ..strokeWidth = 1);
          canvas.drawCircle(p, size.width * 0.045, Paint()..color = i == 0 ? color : CheColors.accentAlt);
        }
      case CheOrbState.speaking:
        for (var i = 0; i < 24; i++) {
          final a = i / 24 * math.pi * 2;
          final amp = 0.06 + 0.1 * math.sin(t * math.pi * 2 * 7 + i * 1.3).abs();
          final p1 = c + Offset(math.cos(a), math.sin(a)) * r * 1.08;
          final p2 = c + Offset(math.cos(a), math.sin(a)) * r * (1.08 + amp);
          canvas.drawLine(p1, p2, stroke..color = color.withValues(alpha: 0.7));
        }
      case CheOrbState.waiting:
        final blink = (math.sin(t * math.pi * 2) + 1) / 2;
        canvas.drawCircle(c, r * 1.14, stroke..color = color.withValues(alpha: 0.2 + 0.5 * blink));
      case CheOrbState.completed:
        canvas.drawCircle(c, r * (1.1 + 0.15 * ((t * 3) % 1.0)), stroke..color = color.withValues(alpha: 0.7 * (1 - (t * 3) % 1.0)));
      case CheOrbState.sleeping:
      case CheOrbState.awake:
        break;
    }
  }

  @override
  bool shouldRepaint(covariant _OrbFxPainter o) => o.t != t || o.state != state || o.color != color;
}

// ─────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────

class CheAgentChatScreen extends StatefulWidget {
  const CheAgentChatScreen({
    super.key,
    required this.controller,
    this.onAttach,
    this.onMic,
    this.micActive = false,
    this.pluginRegistry,
    this.quickActions = const [
      'Analyze the markets today',
      'Create an image concept',
      'Plan my week',
      'Build me a plugin',
    ],
  });

  final CheAgentController controller;

  /// Hook up the EXISTING photo picker; return the picked items (up to 20).
  final Future<List<Object>?> Function()? onAttach;

  /// Hook up the EXISTING voice / "Chay" wake-word toggle.
  final VoidCallback? onMic;
  final bool micActive;

  /// When set, plugins CHE writes in chat show an "Install" card.
  final ChePluginRegistry? pluginRegistry;
  final List<String> quickActions;

  @override
  State<CheAgentChatScreen> createState() => _CheAgentChatScreenState();
}

class _CheAgentChatScreenState extends State<CheAgentChatScreen> {
  final _input = TextEditingController();
  final _focus = FocusNode();
  final _scroll = ScrollController();
  final _modeKey = GlobalKey();
  final List<Object> _attachments = [];
  bool _stickToBottom = true;

  CheAgentController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.addListener(_onChange);
    _input.addListener(() => setState(() {}));
    _scroll.addListener(() {
      if (!_scroll.hasClients) return;
      final pos = _scroll.position;
      _stickToBottom = pos.maxScrollExtent - pos.pixels < 120;
    });
  }

  @override
  void didUpdateWidget(covariant CheAgentChatScreen old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, widget.controller)) {
      old.controller.removeListener(_onChange);
      widget.controller.addListener(_onChange);
    }
  }

  void _onChange() {
    if (!mounted) return;
    setState(() {});
    if (_stickToBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });
    }
  }

  @override
  void dispose() {
    c.removeListener(_onChange);
    _input.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send([String? preset]) {
    final text = preset ?? _input.text;
    if (text.trim().isEmpty && _attachments.isEmpty) return;
    _stickToBottom = true;
    c.send(text, attachments: List.of(_attachments));
    _input.clear();
    setState(_attachments.clear);
  }

  Future<void> _attach() async {
    if (widget.onAttach == null) return;
    final picked = await widget.onAttach!();
    if (picked == null || picked.isEmpty) return;
    setState(() {
      _attachments.addAll(picked);
      if (_attachments.length > 20) _attachments.removeRange(20, _attachments.length);
    });
  }

  Future<void> _pickMode() async {
    final v = await showCheMenu<int>(context, _modeKey, [
      for (var i = 0; i < c.modes.length; i++)
        CheMenuItem(
          value: i,
          label: c.modes[i],
          icon: i == 0 ? Icons.auto_awesome_rounded : Icons.chat_bubble_outline_rounded,
          trailing: i == c.modeIndex ? '✓' : null,
        ),
    ]);
    if (v != null) c.setMode(v);
  }

  void _openConversations() {
    HapticFeedback.selectionClick();
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _ConversationSheet(controller: c),
    );
  }

  @override
  Widget build(BuildContext context) {
    final msgs = c.current.messages;
    return Scaffold(
      backgroundColor: CheColors.bg,
      resizeToAvoidBottomInset: true,
      body: CheBackground(
        child: SafeArea(
          bottom: false,
          child: Column(children: [
            _topBar(context),
            Expanded(
              child: AnimatedSwitcher(
                duration: CheMotion.d(context, CheMotion.base),
                child: msgs.isEmpty
                    ? _EmptyState(
                        key: const ValueKey('empty'),
                        actions: widget.quickActions,
                        onPick: _send,
                        orbState: c.orbState,
                      )
                    : GestureDetector(
                        key: ValueKey(c.current.id),
                        onTap: () => _focus.unfocus(),
                        child: ListView.builder(
                          controller: _scroll,
                          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.md, CheSpace.gutter, CheSpace.xl),
                          itemCount: msgs.length,
                          itemBuilder: (context, i) {
                            final m = msgs[i];
                            return Padding(
                              padding: const EdgeInsets.only(bottom: CheSpace.lg),
                              child: m.isUser
                                  ? _UserBubble(message: m)
                                  : _AssistantMessage(
                                      message: m,
                                      onRetry: () => c.retry(m),
                                      registry: widget.pluginRegistry,
                                    ),
                            );
                          },
                        ),
                      ),
              ),
            ),
            _composer(context),
          ]),
        ),
      ),
    );
  }

  Widget _topBar(BuildContext context) {
    final canPop = Navigator.of(context).canPop();
    return Padding(
      padding: const EdgeInsets.fromLTRB(CheSpace.sm, CheSpace.xs, CheSpace.gutter, CheSpace.sm),
      child: Column(children: [
        Row(children: [
          if (canPop)
            IconButton(
              icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19, color: CheColors.text),
              onPressed: () => Navigator.of(context).maybePop(),
            )
          else
            const SizedBox(width: CheSpace.sm),
          CheOrb(size: 30, state: c.orbState),
          const SizedBox(width: CheSpace.sm),
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            ShaderMask(
              shaderCallback: (r) => CheColors.accentGradient.createShader(r),
              child: Text('CHE', style: CheType.display.copyWith(fontSize: 20, color: Colors.white)),
            ),
            AnimatedSwitcher(
              duration: CheMotion.d(context, CheMotion.fast),
              child: Text(c.orbState.label.toUpperCase(),
                  key: ValueKey(c.orbState), style: CheType.overline.copyWith(fontSize: 9, letterSpacing: 2)),
            ),
          ]),
          const Spacer(),
          SizedBox(
            width: 150,
            child: PillToggle(options: c.modes, index: c.modeIndex, onChanged: c.setMode, height: 34),
          ),
        ]),
        const SizedBox(height: CheSpace.sm),
        Row(children: [
          const SizedBox(width: CheSpace.sm),
          Expanded(
            child: ChePressable(
              onTap: _openConversations,
              child: Container(
                height: 38,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration: BoxDecoration(
                  color: CheColors.surface,
                  borderRadius: BorderRadius.circular(CheRadius.md),
                  border: Border.all(color: CheColors.stroke),
                ),
                child: Row(children: [
                  Expanded(
                    child: Text(c.current.title,
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
                  ),
                  const Icon(Icons.keyboard_arrow_down_rounded, size: 20, color: CheColors.textDim),
                ]),
              ),
            ),
          ),
          const SizedBox(width: CheSpace.sm),
          CheIconButton(icon: Icons.add_rounded, size: 38, onTap: c.newConversation, tooltip: 'New chat'),
        ]),
      ]),
    );
  }

  Widget _composer(BuildContext context) {
    final bottomInset = MediaQuery.of(context).viewPadding.bottom;
    final keyboardUp = MediaQuery.of(context).viewInsets.bottom > 0;
    final canSend = _input.text.trim().isNotEmpty || _attachments.isNotEmpty;
    return Padding(
      padding: EdgeInsets.fromLTRB(
          CheSpace.md, CheSpace.xs, CheSpace.md, (keyboardUp ? 0 : bottomInset) + CheSpace.sm),
      child: GlowCard(
        active: c.busy || _focus.hasFocus,
        radius: CheRadius.xl,
        padding: const EdgeInsets.fromLTRB(CheSpace.md, CheSpace.sm, CheSpace.sm, CheSpace.sm),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (_attachments.isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 6, top: 2),
                child: InputChip(
                  label: Text('${_attachments.length} attached', style: CheType.caption),
                  avatar: const Icon(Icons.photo_library_outlined, size: 16, color: CheColors.accent),
                  onDeleted: () => setState(_attachments.clear),
                  backgroundColor: CheColors.surfaceHi,
                  side: const BorderSide(color: CheColors.stroke),
                ),
              ),
            ),
          Focus(
            onFocusChange: (_) => setState(() {}),
            child: TextField(
              controller: _input,
              focusNode: _focus,
              minLines: 1,
              maxLines: 6,
              style: CheType.body,
              cursorColor: CheColors.accent,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: c.mode == 'Agent' ? 'Tell CHE what to build or do…' : 'Ask CHE anything…',
                hintStyle: CheType.body.copyWith(color: CheColors.textFaint),
                contentPadding: const EdgeInsets.symmetric(vertical: 8),
              ),
            ),
          ),
          const SizedBox(height: 4),
          Row(children: [
            ChePressable(
              key: _modeKey,
              onTap: _pickMode,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                  color: CheColors.accent.withValues(alpha: 0.10),
                  border: Border.all(color: CheColors.accent.withValues(alpha: 0.35)),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(c.mode, style: CheType.caption.copyWith(color: CheColors.accent, fontWeight: FontWeight.w700)),
                  const Icon(Icons.keyboard_arrow_down_rounded, size: 16, color: CheColors.accent),
                ]),
              ),
            ),
            const Spacer(),
            if (widget.onAttach != null)
              _ComposerIcon(icon: Icons.add_photo_alternate_outlined, onTap: _attach),
            if (widget.onMic != null)
              _ComposerIcon(
                icon: widget.micActive ? Icons.graphic_eq_rounded : Icons.mic_none_rounded,
                onTap: widget.onMic!,
                highlight: widget.micActive,
              ),
            const SizedBox(width: 4),
            _SendButton(
              busy: c.busy,
              enabled: canSend,
              onSend: () => _send(),
              onStop: c.stop,
            ),
          ]),
        ]),
      ),
    );
  }
}

class _ComposerIcon extends StatelessWidget {
  const _ComposerIcon({required this.icon, required this.onTap, this.highlight = false});
  final IconData icon;
  final VoidCallback onTap;
  final bool highlight;
  @override
  Widget build(BuildContext context) => ChePressable(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: Icon(icon, size: 22, color: highlight ? CheColors.accent : CheColors.textDim),
        ),
      );
}

class _SendButton extends StatelessWidget {
  const _SendButton({required this.busy, required this.enabled, required this.onSend, required this.onStop});
  final bool busy;
  final bool enabled;
  final VoidCallback onSend;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final on = busy || enabled;
    return ChePressable(
      onTap: busy ? onStop : (enabled ? onSend : null),
      child: AnimatedContainer(
        duration: CheMotion.d(context, CheMotion.fast),
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: on ? CheColors.accentGradient : null,
          color: on ? null : CheColors.surfaceHi,
          boxShadow: on ? [BoxShadow(color: CheColors.accent.withValues(alpha: 0.5), blurRadius: 14)] : null,
        ),
        child: AnimatedSwitcher(
          duration: CheMotion.d(context, CheMotion.fast),
          transitionBuilder: (c, a) => ScaleTransition(scale: a, child: c),
          child: Icon(
            busy ? Icons.stop_rounded : Icons.arrow_upward_rounded,
            key: ValueKey(busy),
            size: 20,
            color: on ? const Color(0xFF02110E) : CheColors.textFaint,
          ),
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.message});
  final CheMessage message;

  @override
  Widget build(BuildContext context) {
    final maxW = MediaQuery.of(context).size.width * 0.8;
    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxW),
        child: TweenAnimationBuilder<double>(
          tween: Tween(begin: 0.9, end: 1),
          duration: CheMotion.d(context, CheMotion.base),
          curve: CheMotion.spring,
          builder: (_, s, child) => Transform.scale(scale: s, alignment: Alignment.bottomRight, child: child),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(CheRadius.lg),
                topRight: Radius.circular(CheRadius.lg),
                bottomLeft: Radius.circular(CheRadius.lg),
                bottomRight: Radius.circular(6),
              ),
              gradient: LinearGradient(colors: [
                CheColors.accent.withValues(alpha: 0.20),
                CheColors.accentAlt.withValues(alpha: 0.12),
              ]),
              border: Border.all(color: CheColors.accent.withValues(alpha: 0.4)),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              if (message.attachments.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.photo_library_outlined, size: 14, color: CheColors.accent),
                    const SizedBox(width: 4),
                    Text('${message.attachments.length} attached', style: CheType.caption),
                  ]),
                ),
              if (message.text.isNotEmpty) SelectableText(message.text, style: CheType.body),
            ]),
          ),
        ),
      ),
    );
  }
}

class _AssistantMessage extends StatefulWidget {
  const _AssistantMessage({required this.message, required this.onRetry, this.registry});
  final CheMessage message;
  final VoidCallback onRetry;
  final ChePluginRegistry? registry;
  @override
  State<_AssistantMessage> createState() => _AssistantMessageState();
}

class _AssistantMessageState extends State<_AssistantMessage> {
  bool _showSteps = false;

  @override
  Widget build(BuildContext context) {
    final m = widget.message;
    final waiting = m.streaming && m.text.isEmpty;
    final stepsVisible = waiting || _showSteps;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(padding: const EdgeInsets.only(top: 2), child: CheOrb(size: 24, active: m.streaming)),
      const SizedBox(width: CheSpace.md),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (waiting)
            _LiveTimer(start: m.startedAt ?? DateTime.now())
          else if (m.thoughtMs != null && m.steps.isNotEmpty)
            GestureDetector(
              onTap: () => setState(() => _showSteps = !_showSteps),
              child: Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text('Thought ${_fmt(m.thoughtMs!)}', style: CheType.caption),
                  AnimatedRotation(
                    turns: _showSteps ? 0.25 : 0,
                    duration: CheMotion.d(context, CheMotion.fast),
                    child: const Icon(Icons.chevron_right_rounded, size: 16, color: CheColors.textDim),
                  ),
                ]),
              ),
            ),
          AnimatedSize(
            duration: CheMotion.d(context, CheMotion.base),
            curve: CheMotion.curve,
            alignment: Alignment.topLeft,
            child: stepsVisible
                ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    for (final s in m.steps) StepLine(label: s.label, status: s.status),
                    const SizedBox(height: 4),
                  ])
                : const SizedBox(width: double.infinity),
          ),
          if (m.text.isNotEmpty) CheRichText(text: m.text, streaming: m.streaming),
          if (!m.streaming && widget.registry != null)
            for (final p in ChePluginRegistry.findInText(m.text))
              ChePluginOfferCard(registry: widget.registry!, plugin: p),
          if (m.isError) ...[
            const SizedBox(height: 6),
            Text(m.errorText ?? 'Something went wrong.',
                style: CheType.bodyDim.copyWith(color: CheColors.danger)),
            const SizedBox(height: 6),
            _ActionChip(icon: Icons.refresh_rounded, label: 'Retry', onTap: widget.onRetry),
          ] else if (!m.streaming && m.text.isNotEmpty) ...[
            const SizedBox(height: 6),
            Row(children: [
              _ActionChip(
                icon: Icons.copy_rounded,
                label: 'Copy',
                onTap: () {
                  Clipboard.setData(ClipboardData(text: m.text));
                  ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                      const SnackBar(content: Text('Copied'), duration: Duration(milliseconds: 900)));
                },
              ),
              const SizedBox(width: 6),
              _ActionChip(icon: Icons.refresh_rounded, label: 'Redo', onTap: widget.onRetry),
            ]),
          ],
        ]),
      ),
    ]);
  }

  static String _fmt(int ms) => ms < 10000 ? '${(ms / 1000).toStringAsFixed(1)}s' : '${(ms / 1000).round()}s';
}

class _LiveTimer extends StatefulWidget {
  const _LiveTimer({required this.start});
  final DateTime start;
  @override
  State<_LiveTimer> createState() => _LiveTimerState();
}

class _LiveTimerState extends State<_LiveTimer> {
  Timer? _t;
  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ms = DateTime.now().difference(widget.start).inMilliseconds;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: ThinkingShimmer(text: 'Thinking…  ${(ms / 1000).toStringAsFixed(1)}s', style: CheType.caption),
    );
  }
}

class _ActionChip extends StatelessWidget {
  const _ActionChip({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => ChePressable(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(CheRadius.pill),
            color: CheColors.surface,
            border: Border.all(color: CheColors.stroke),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 14, color: CheColors.textDim),
            const SizedBox(width: 5),
            Text(label, style: CheType.caption),
          ]),
        ),
      );
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({super.key, required this.actions, required this.onPick, this.orbState = CheOrbState.awake});
  final List<String> actions;
  final CheOrbState orbState;
  final void Function(String) onPick;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter, vertical: CheSpace.xxl),
      child: Column(children: [
        CheOrb(size: 120, label: true, state: orbState),
        const SizedBox(height: CheSpace.xl),
        const Text('What should we build?', style: CheType.title, textAlign: TextAlign.center),
        const SizedBox(height: CheSpace.sm),
        const Text('Ask, plan, create or run a task. CHE works fast and shows every step.',
            style: CheType.bodyDim, textAlign: TextAlign.center),
        const SizedBox(height: CheSpace.xl),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: CheSpace.sm,
          runSpacing: CheSpace.sm,
          children: [
            for (final a in actions)
              ChePressable(
                onTap: () => onPick(a),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(CheRadius.pill),
                    color: CheColors.surface,
                    border: Border.all(color: CheColors.accent.withValues(alpha: 0.3)),
                  ),
                  child: Text(a, style: CheType.label),
                ),
              ),
          ],
        ),
      ]),
    );
  }
}

class _ConversationSheet extends StatelessWidget {
  const _ConversationSheet({required this.controller});
  final CheAgentController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final list = controller.conversations;
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const SizedBox(height: 10),
              Container(
                  width: 38,
                  height: 4,
                  decoration: BoxDecoration(color: CheColors.stroke, borderRadius: BorderRadius.circular(2))),
              Padding(
                padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.lg, CheSpace.sm, CheSpace.sm),
                child: Row(children: [
                  const Expanded(child: Text('Conversations', style: CheType.headline)),
                  TextButton.icon(
                    onPressed: () {
                      controller.newConversation();
                      Navigator.pop(context);
                    },
                    icon: const Icon(Icons.add_rounded, color: CheColors.accent),
                    label: Text('New', style: CheType.label.copyWith(color: CheColors.accent)),
                  ),
                ]),
              ),
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: list.length,
                  itemBuilder: (context, i) {
                    final conv = list[i];
                    final sel = identical(conv, controller.current);
                    return Dismissible(
                      key: ValueKey(conv.id),
                      direction: DismissDirection.endToStart,
                      background: Container(
                        alignment: Alignment.centerRight,
                        padding: const EdgeInsets.only(right: 20),
                        color: CheColors.danger.withValues(alpha: 0.2),
                        child: const Icon(Icons.delete_outline_rounded, color: CheColors.danger),
                      ),
                      onDismissed: (_) => controller.deleteConversation(conv),
                      child: ListTile(
                        onTap: () {
                          controller.open(conv);
                          Navigator.pop(context);
                        },
                        leading: Icon(sel ? Icons.radio_button_checked : Icons.chat_bubble_outline_rounded,
                            color: sel ? CheColors.accent : CheColors.textDim, size: 20),
                        title: Text(conv.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
                        subtitle: Text('${conv.messages.length} messages', style: CheType.caption),
                        trailing: IconButton(
                          tooltip: 'Read full log',
                          icon: const Icon(Icons.description_outlined, color: CheColors.textDim, size: 20),
                          onPressed: () {
                            final nav = Navigator.of(context);
                            nav.pop();
                            nav.push(CheRoute(builder: (_) => CheTranscriptScreen(conversation: conv)));
                          },
                        ),
                      ),
                    );
                  },
                ),
              ),
            ]),
          ),
        );
      },
    );
  }
}
