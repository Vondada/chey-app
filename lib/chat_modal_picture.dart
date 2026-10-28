// A Modal GPU picture asked for in chat. The Worker starts the job and answers with its call id. This follows the job on
// the Worker's result route until the picture is saved to the Gallery, the Worker reports it failed, or the wait runs out.
// The job is kept on the Worker, so a wait that ends here loses nothing: the picture is still saved or marked failed
// there. No other engine is ever used.
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// The job id from a chat reply that started a Modal picture, or '' when it started none.
String cheModalPictureCallId(Map data) {
  if (data['provider_used'] != 'modal' || data['ok'] != true) return '';
  final id = '${data['call_id'] ?? ''}'.trim();
  return RegExp(r'^fc-[A-Za-z0-9]{8,64}$').hasMatch(id) ? id : '';
}

enum CheModalPictureState { saved, running, failed }

class CheModalPictureOutcome {
  const CheModalPictureOutcome(this.state, {this.mediaId = '', this.detail = ''});

  final CheModalPictureState state;
  final String mediaId;
  final String detail;

  /// The saved picture's image route on the Worker, the same one the Gallery uses.
  String get imagePath => mediaId.isEmpty ? '' : '/api/media/$mediaId/image';
}

/// One answer from the result route, read as the Worker sends it. 202 (running) and 503 (Modal missed the check) keep the
/// job waiting; a saved picture or any other answer ends the wait.
CheModalPictureOutcome cheModalPictureOutcome(int status, Object? decoded) {
  final json = decoded is Map ? decoded : const <Object?, Object?>{};
  if (status == 200) {
    final item = json['item'];
    final id = item is Map ? '${item['id'] ?? ''}' : '';
    if (id.isEmpty) return const CheModalPictureOutcome(CheModalPictureState.failed, detail: 'The Worker sent no picture.');
    return CheModalPictureOutcome(CheModalPictureState.saved, mediaId: id);
  }
  if (status == 202 || status == 503) return const CheModalPictureOutcome(CheModalPictureState.running);
  final detail = '${json['detail'] ?? ''}'.trim();
  return CheModalPictureOutcome(
    CheModalPictureState.failed,
    detail: detail.isEmpty ? 'The Worker did not finish the picture (status $status).' : detail,
  );
}

/// Follows [callId] until it is saved, fails, or [maxPolls] answers have come back still running. A network error is one
/// missed answer, not a failure. [wait] is replaceable so tests need no real delay.
Future<CheModalPictureOutcome> followCheModalPicture({
  required http.Client client,
  required String baseUrl,
  required Map<String, String> headers,
  required String callId,
  Duration interval = const Duration(seconds: 4),
  int maxPolls = 180,
  Future<void> Function(Duration)? wait,
}) async {
  Future<void> pause(Duration d) => wait == null ? Future<void>.delayed(d) : wait(d);
  for (var poll = 0; poll < maxPolls; poll++) {
    CheModalPictureOutcome? outcome;
    try {
      final res = await client.post(
        Uri.parse('$baseUrl/api/media/modal/result'),
        headers: headers,
        body: jsonEncode({'call_id': callId}),
      );
      Object? decoded;
      try {
        decoded = jsonDecode(res.body);
      } catch (_) {}
      outcome = cheModalPictureOutcome(res.statusCode, decoded);
    } catch (_) {
      outcome = null;
    }
    if (outcome != null && outcome.state != CheModalPictureState.running) return outcome;
    if (poll < maxPolls - 1) await pause(interval);
  }
  return const CheModalPictureOutcome(CheModalPictureState.running);
}
