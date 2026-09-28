// ignore_for_file: prefer_initializing_formals
// Data models shared by the CHE chat UI, backend adapter and plugin system.

import 'che_widgets.dart' show StepStatus;

class CheStep {
  CheStep(this.label, [this.status = StepStatus.running]);
  String label;
  StepStatus status;
}

enum CheRole { user, assistant }

class CheMessage {
  CheMessage._(this.role, this.text, {List<Object>? attachments})
      : attachments = attachments ?? const [],
        createdAt = DateTime.now();

  factory CheMessage.user(String text, [List<Object>? attachments]) =>
      CheMessage._(CheRole.user, text, attachments: attachments);
  factory CheMessage.assistant() => CheMessage._(CheRole.assistant, '');

  final CheRole role;
  String text;
  final List<Object> attachments; // whatever the existing photo picker returns
  DateTime createdAt;

  // assistant-only state
  final List<CheStep> steps = [];
  bool streaming = false;
  bool isError = false;
  String? errorText;
  int? thoughtMs; // time until the first token arrived
  DateTime? startedAt;

  bool get isUser => role == CheRole.user;

  /// Simple map for sending history to the Worker.
  Map<String, String> toJson() => {'role': isUser ? 'user' : 'assistant', 'content': text};
}

class CheConversation {
  CheConversation(this.id) : updatedAt = DateTime.now();
  final String id;
  String title = 'New Chat';
  final List<CheMessage> messages = [];
  DateTime updatedAt;
}

class CheRequest {
  CheRequest({
    required this.message,
    required this.mode,
    required this.history,
    required this.attachments,
    required void Function(String label) onStep,
    required bool Function() isCancelled,
    this.systemAddons = const [],
  })  : _onStep = onStep,
        _isCancelled = isCancelled;

  final String message;
  final String mode; // e.g. "Agent" or "Chat"
  final List<CheMessage> history; // already trimmed for speed
  final List<Object> attachments;

  /// Extra instructions contributed by installed plugins (see che_plugins.dart).
  final List<String> systemAddons;

  final void Function(String label) _onStep;
  final bool Function() _isCancelled;

  /// Show a progress line under "Thinking…" (e.g. "Searching markets…").
  void step(String label) => _onStep(label);
  bool isCancelled() => _isCancelled();
}
