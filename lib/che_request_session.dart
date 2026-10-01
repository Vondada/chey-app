/// One owner request produces one visible answer and one spoken answer.
class CheRequestSession {
  CheRequestSession(this.requestId);

  final String requestId;
  bool cancelled = false;
  String? generationState;
  String visibleText = '';
  bool spoken = false;

  bool get isActive => !cancelled;

  void cancel() {
    cancelled = true;
    generationState = 'cancelled';
  }

  bool accept(String incomingRequestId) {
    return !cancelled && incomingRequestId == requestId;
  }
}

class CheRequestGate {
  CheRequestSession? _current;

  CheRequestSession get current {
    return _current ??= CheRequestSession(_newId());
  }

  CheRequestSession begin() {
    _current?.cancel();
    _current = CheRequestSession(_newId());
    _current!.generationState = 'thinking';
    return _current!;
  }

  bool acceptLate(String requestId) => _current?.accept(requestId) ?? false;

  void complete(String requestId, String text) {
    if (!acceptLate(requestId)) return;
    _current!.visibleText = text;
    _current!.generationState = 'complete';
  }

  void markSpoken(String requestId) {
    if (!acceptLate(requestId)) return;
    _current!.spoken = true;
  }

  void cancelCurrent() => _current?.cancel();

  String _newId() => 'req_${DateTime.now().microsecondsSinceEpoch}';
}
