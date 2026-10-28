// A Modal GPU picture started in chat is followed to the Gallery (lib/chat_modal_picture.dart). Every network call here is
// a mock; no GPU runs and nothing is billed.
import 'dart:convert';

import 'package:chey/chat_modal_picture.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _callId = 'fc-abcdef123456';

http.Response _json(int status, Map<String, Object?> body) => http.Response(jsonEncode(body), status);

void main() {
  test('a reply that started a Modal picture gives its job id; any other reply gives none', () {
    expect(cheModalPictureCallId({'provider_used': 'modal', 'ok': true, 'call_id': _callId}), _callId);
    expect(cheModalPictureCallId({'provider_used': 'workers_ai', 'ok': true, 'call_id': _callId}), '');
    expect(cheModalPictureCallId({'provider_used': 'modal', 'ok': false, 'call_id': _callId}), '');
    expect(cheModalPictureCallId({'provider_used': 'modal', 'ok': true, 'call_id': 'not an id'}), '');
    expect(cheModalPictureCallId({'provider_used': 'modal', 'ok': true}), '');
  });

  test('the result route answers: saved, still running, or failed with the Worker reason', () {
    final saved = cheModalPictureOutcome(200, {'item': {'id': 'abc'}});
    expect(saved.state, CheModalPictureState.saved);
    expect(saved.imagePath, '/api/media/abc/image');

    expect(cheModalPictureOutcome(202, {'state': 'running'}).state, CheModalPictureState.running);
    expect(cheModalPictureOutcome(503, {'detail': 'Modal did not answer'}).state, CheModalPictureState.running);

    final failed = cheModalPictureOutcome(502, {'detail': 'The picture failed its hash check.'});
    expect(failed.state, CheModalPictureState.failed);
    expect(failed.detail, 'The picture failed its hash check.');
    expect(cheModalPictureOutcome(404, {'detail': 'No Modal picture has that call id.'}).state, CheModalPictureState.failed);
    expect(cheModalPictureOutcome(200, {}).state, CheModalPictureState.failed);
  });

  test('a job that finishes after two running answers is saved, with one wait between answers', () async {
    final answers = [
      _json(202, {'state': 'running', 'call_id': _callId}),
      _json(202, {'state': 'running', 'call_id': _callId}),
      _json(200, {'item': {'id': 'pic-1'}}),
    ];
    var posts = 0;
    final waits = <Duration>[];
    final client = MockClient((request) async {
      expect(request.url.path, '/api/media/modal/result');
      expect(jsonDecode(request.body), {'call_id': _callId});
      return answers[posts++];
    });
    final outcome = await followCheModalPicture(
      client: client,
      baseUrl: 'https://worker.example',
      headers: const {},
      callId: _callId,
      interval: const Duration(seconds: 3),
      wait: (d) async => waits.add(d),
    );
    expect(outcome.state, CheModalPictureState.saved);
    expect(outcome.mediaId, 'pic-1');
    expect(posts, 3);
    expect(waits, [const Duration(seconds: 3), const Duration(seconds: 3)]);
  });

  test('a failed job ends the wait at once, with the reason', () async {
    var posts = 0;
    final client = MockClient((request) async {
      posts++;
      return _json(502, {'detail': 'Modal reported the picture failed. Nothing was saved.'});
    });
    final outcome = await followCheModalPicture(
      client: client,
      baseUrl: 'https://worker.example',
      headers: const {},
      callId: _callId,
      wait: (_) async {},
    );
    expect(outcome.state, CheModalPictureState.failed);
    expect(outcome.detail, contains('Nothing was saved'));
    expect(posts, 1);
  });

  test('a network error is one missed answer, not a failure; the next answer still counts', () async {
    var posts = 0;
    final client = MockClient((request) async {
      posts++;
      if (posts == 1) throw http.ClientException('connection reset');
      return _json(200, {'item': {'id': 'pic-2'}});
    });
    final outcome = await followCheModalPicture(
      client: client,
      baseUrl: 'https://worker.example',
      headers: const {},
      callId: _callId,
      wait: (_) async {},
    );
    expect(outcome.state, CheModalPictureState.saved);
    expect(posts, 2);
  });

  test('when the wait runs out, the job is reported as still running, not as saved', () async {
    var posts = 0;
    final client = MockClient((request) async {
      posts++;
      return _json(202, {'state': 'running', 'call_id': _callId});
    });
    final outcome = await followCheModalPicture(
      client: client,
      baseUrl: 'https://worker.example',
      headers: const {},
      callId: _callId,
      maxPolls: 4,
      wait: (_) async {},
    );
    expect(outcome.state, CheModalPictureState.running);
    expect(outcome.mediaId, isEmpty);
    expect(posts, 4);
  });
}
