// CHE backend adapter — plugs the new UI into the EXISTING Cloudflare Worker.
// No new packages (uses dart:io). Handles three response styles automatically:
//   • text/event-stream (SSE)  → tokens appear the instant they arrive (fastest)
//   • text/plain streamed body → chunks appear as they arrive
//   • application/json         → full reply, revealed in < 0.5s
// One shared keep-alive HttpClient is reused, so there is no reconnect cost
// per message.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'che_models.dart';

abstract class CheBackend {
  /// Emit text chunks for the reply. Call `req.step('…')` to show progress lines.
  Stream<String> reply(CheRequest req);

  /// Wrap an existing `Future<String>` API call (no backend change needed).
  static CheBackend fromFuture(Future<String> Function(CheRequest req) call) => _FutureBackend(call);

  /// Wrap an existing streaming call.
  static CheBackend fromStream(Stream<String> Function(CheRequest req) call) => _StreamBackend(call);
}

class CheBackendException implements Exception {
  CheBackendException(this.statusCode, this.body);
  final int statusCode;
  final String body;
  @override
  String toString() => 'CHE backend error $statusCode: $body';
}

/// Reveals an already-complete reply almost instantly (≈0.45s max) so it still
/// feels alive without making the user wait.
Stream<String> cheFastReveal(String full, CheRequest req) async* {
  if (full.length <= 60) {
    yield full;
    return;
  }
  const frames = 16;
  final step = (full.length / frames).ceil();
  for (var i = 0; i < full.length; i += step) {
    if (req.isCancelled()) return;
    yield full.substring(i, math.min(i + step, full.length));
    await Future<void>.delayed(const Duration(milliseconds: 28));
  }
}

class _FutureBackend implements CheBackend {
  _FutureBackend(this.call);
  final Future<String> Function(CheRequest req) call;
  @override
  Stream<String> reply(CheRequest req) async* {
    final full = await call(req);
    if (req.isCancelled()) return;
    yield* cheFastReveal(full, req);
  }
}

class _StreamBackend implements CheBackend {
  _StreamBackend(this.call);
  final Stream<String> Function(CheRequest req) call;
  @override
  Stream<String> reply(CheRequest req) => call(req);
}

/// Talks straight to the CHE Worker. Configure `endpoint`, `headers` and
/// `buildBody` to match what the Worker already expects.
class CheWorkerBackend implements CheBackend {
  CheWorkerBackend({
    required this.endpoint,
    required this.buildBody,
    this.headers = const {},
    this.extractText,
    this.timeout = const Duration(seconds: 60),
  });

  final Uri endpoint;
  final Map<String, String> headers;
  final Map<String, dynamic> Function(CheRequest req) buildBody;

  /// Optional: pull the reply text out of a JSON body / SSE payload. If null,
  /// common shapes are tried (reply, text, content, message, response, delta,
  /// OpenAI choices[0].delta.content / message.content, Anthropic delta.text).
  final String? Function(dynamic json)? extractText;
  final Duration timeout;

  static final HttpClient _client = HttpClient()
    ..idleTimeout = const Duration(seconds: 90)
    ..connectionTimeout = const Duration(seconds: 8)
    ..autoUncompress = true;

  /// Call once at app start to open the TLS connection early (saves ~100–300ms
  /// on the first message).
  Future<void> warmUp() async {
    try {
      final r = await _client.openUrl('HEAD', endpoint).timeout(const Duration(seconds: 5));
      final res = await r.close().timeout(const Duration(seconds: 5));
      await res.drain<void>();
    } catch (_) {/* warm-up is best-effort */}
  }

  @override
  Stream<String> reply(CheRequest req) async* {
    final r = await _client.postUrl(endpoint).timeout(timeout);
    r.headers.contentType = ContentType.json;
    r.headers.set(HttpHeaders.acceptHeader, 'text/event-stream, application/json, text/plain');
    headers.forEach((k, v) => r.headers.set(k, v));
    r.add(utf8.encode(jsonEncode(buildBody(req))));
    final res = await r.close().timeout(timeout);

    if (res.statusCode >= 400) {
      final body = await res.transform(utf8.decoder).join();
      throw CheBackendException(res.statusCode, body);
    }

    final mime = res.headers.contentType?.mimeType ?? '';
    if (mime == 'text/event-stream') {
      await for (final line in res.transform(utf8.decoder).transform(const LineSplitter())) {
        if (req.isCancelled()) return;
        if (!line.startsWith('data:')) {
          if (line.startsWith('event:') && line.contains('step')) continue;
          continue;
        }
        final data = line.substring(5).trim();
        if (data.isEmpty || data == '[DONE]') continue;
        dynamic decoded;
        try {
          decoded = jsonDecode(data);
        } catch (_) {
          yield data; // plain text SSE
          continue;
        }
        // Optional progress events from the Worker: {"step":"Searching markets…"}
        if (decoded is Map && decoded['step'] is String) {
          req.step(decoded['step'] as String);
          continue;
        }
        final piece = _extract(decoded);
        if (piece != null && piece.isNotEmpty) yield piece;
      }
    } else if (mime.startsWith('text/plain')) {
      await for (final chunk in res.transform(utf8.decoder)) {
        if (req.isCancelled()) return;
        yield chunk;
      }
    } else {
      final body = await res.transform(utf8.decoder).join();
      String full;
      try {
        full = _extract(jsonDecode(body)) ?? body;
      } catch (_) {
        full = body;
      }
      yield* cheFastReveal(full, req);
    }
  }

  String? _extract(dynamic j) {
    if (extractText != null) return extractText!(j);
    if (j is String) return j;
    if (j is! Map) return null;
    for (final k in ['reply', 'text', 'content', 'message', 'response', 'output', 'delta', 'answer']) {
      final v = j[k];
      if (v is String) return v;
      if (v is Map && v['text'] is String) return v['text'] as String;
      if (v is Map && v['content'] is String) return v['content'] as String;
    }
    final choices = j['choices'];
    if (choices is List && choices.isNotEmpty) {
      final c = choices.first;
      if (c is Map) {
        final d = c['delta'];
        if (d is Map && d['content'] is String) return d['content'] as String;
        final m = c['message'];
        if (m is Map && m['content'] is String) return m['content'] as String;
        if (c['text'] is String) return c['text'] as String;
      }
    }
    return null;
  }
}
