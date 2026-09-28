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
  void logVoiceTurn(String youSaid, String cheSaid) {
    final u = CheMessage.user('🎙 $youSaid');
    final r = CheMessage.assistant()..text = cheSaid;
    current.messages..add(u)..add(r);
    if (current.title == 'New Chat') current.title = 'Voice: ${youSaid.length > 28 ? '${youSaid.substring(0, 28)}…' : youSaid}';
    current.updatedAt = DateTime.now();
    store?.save(current);
    store?.remoteLog(current, u, r, source: 'voice');
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
                        base.withOpacity(st == CheOrbState.sleeping ? 0.45 : 0.95),
                        Color.lerp(base, Colors.black, 0.45)!.withOpacity(0.9),
                        const Color(0xFF02110E),
                      ],
                      stops: const [0.0, 0.55, 1.0],
                      center: Alignment(-0.2 + 0.2 * breathe, -0.3),
                    ),
                    border: Border.all(color: base.withOpacity(0.8), width: s > 60 ? 2 : 1),
                    boxShadow: [BoxShadow(color: base.withOpacity(glow), blurRadius: s * 0.5)],
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
          canvas.drawCircle(c, r * (1 + 0.28 * k), stroke..color = color.withOpacity(0.6 * (1 - k)));
        }
      case CheOrbState.thinking:
        canvas.drawArc(Rect.fromCircle(center: c, radius: r * 1.14), t * math.pi * 4, math.pi * 0.7, false,
            stroke..color = color.withOpacity(0.9));
        canvas.drawArc(Rect.fromCircle(center: c, radius: r * 1.14), t * math.pi * 4 + math.pi, math.pi * 0.35, false,
            stroke..color = CheColors.accentAlt.withOpacity(0.7));
      case CheOrbState.working:
        canvas.drawCircle(c, r * 1.16, stroke..color = color.withOpacity(0.18));
        final a = t * math.pi * 4;
        canvas.drawCircle(c + Offset(math.cos(a), math.sin(a)) * r * 1.16, size.width * 0.05, Paint()..color = color);
      case CheOrbState.delegating:
        canvas.drawCircle(c, r * 1.18, stroke..color = color.withOpacity(0.15));
        for (var i = 0; i < 3; i++) {
          final a = t * math.pi * 2 + i * math.pi * 2 / 3;
          final p = c + Offset(math.cos(a), math.sin(a)) * r * 1.18;
          canvas.drawLine(c, p, Paint()
            ..color = color.withOpacity(0.25)
            ..strokeWidth = 1);
          canvas.drawCircle(p, size.width * 0.045, Paint()..color = i == 0 ? color : CheColors.accentAlt);
        }
      case CheOrbState.speaking:
        for (var i = 0; i < 24; i++) {
          final a = i / 24 * math.pi * 2;
          final amp = 0.06 + 0.1 * math.sin(t * math.pi * 2 * 7 + i * 1.3).abs();
          final p1 = c + Offset(math.cos(a), math.sin(a)) * r * 1.08;
          final p2 = c + Offset(math.cos(a), math.sin(a)) * r * (1.08 + amp);
          canvas.drawLine(p1, p2, stroke..color = color.withOpacity(0.7));
        }
      case CheOrbState.waiting:
        final blink = (math.sin(t * math.pi * 2) + 1) / 2;
        canvas.drawCircle(c, r * 1.14, stroke..color = color.withOpacity(0.2 + 0.5 * blink));
      case CheOrbState.completed:
        canvas.drawCircle(c, r * (1.1 + 0.15 * ((t * 3) % 1.0)), stroke..color = color.withOpacity(0.7 * (1 - (t * 3) % 1.0)));
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
