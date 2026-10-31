// How a chat turn's stream ended, judged from the frames that arrived. Pure Dart: no Flutter, no network.
//
// The Worker builds the whole answer, and every action in it, before it sends the first byte. So a stream that stops
// before its done frame was cut off after the work ran. CHE therefore never says that nothing ran, and never re-runs
// the turn on its own: it says what it knows and points the owner at the record.

enum CheStreamEnd { done, cutOff, noFrames }

/// Counts the frames of one chat stream, so the end can be judged after the loop.
class CheStreamTally {
  int _frames = 0;
  bool _sawDone = false;
  bool _sawHeld = false;

  /// The request id the Worker put on its done frame, if the stream reached it.
  String requestId = '';

  void add(Map<String, dynamic> frame) {
    _frames += 1;
    final type = frame['type']?.toString();
    if (type == 'done') {
      _sawDone = true;
      requestId = frame['request_id']?.toString() ?? requestId;
    }
    // An owner-approval hold is a plain JSON answer with no type, and it is complete on its own.
    if (type == null && frame['held_for_owner'] == true) _sawHeld = true;
  }

  CheStreamEnd get end {
    if (_sawDone || _sawHeld) return CheStreamEnd.done;
    return _frames == 0 ? CheStreamEnd.noFrames : CheStreamEnd.cutOff;
  }
}

/// The text shown when a turn ends with no reply text. It states only what the stream shows.
String cheNoReplyMessage(CheStreamEnd end) {
  switch (end) {
    case CheStreamEnd.cutOff:
      return 'The reply was cut off before it finished, sir. Anything it started may already have run, so I have not run it again. Check the Command Center before you ask again.';
    case CheStreamEnd.noFrames:
      return "CHE's reply never arrived, sir. I cannot tell from here whether anything ran, so I will not say. Check the Command Center before you ask again.";
    case CheStreamEnd.done:
      return 'CHE finished but sent no reply text, sir. I cannot tell from here what ran, so I will not say. Check the Command Center before you ask again.';
  }
}

/// The reply to show for a finished or cut-off stream. A partial reply is kept, with a note that it was cut off.
String cheFinalReplyText(String reply, CheStreamEnd end) {
  final text = reply.trim();
  if (end == CheStreamEnd.done) return text.isEmpty ? cheNoReplyMessage(CheStreamEnd.done) : text;
  if (text.isEmpty) return cheNoReplyMessage(end);
  // A note written inside an unfinished code fence is hidden from the speech chunker, so the fence is closed first.
  final fences = RegExp(r'^\s*```', multiLine: true).allMatches(text).length;
  final body = fences.isOdd ? '$text\n```' : text;
  return '$body\n\n(The reply was cut off here, sir.)';
}
