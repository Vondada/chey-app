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
