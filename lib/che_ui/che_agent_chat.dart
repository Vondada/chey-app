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
