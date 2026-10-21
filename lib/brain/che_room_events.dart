// The phone's rooms report what happened in them to CHE's Brain (owner, Build 2,
// 2026-10-20): a track the Music Room started, a Help explanation or
// walkthrough, a screen the owner asked about. One POST to the Worker's
// /api/brain/room-event, which writes the record with its source, status and
// time, so CHE can later answer "what happened in the Music Room today?".
//
// Fire and forget: a post never blocks, shows or speaks anything, and a failure
// is silent. A screen event carries only the screen's name, never its text or
// a picture (the screen is temporary unless the owner saves it).

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class CheRoomEvents {
  CheRoomEvents._();

  static const _path = '/api/brain/room-event';
  static int _sequence = 0;

  /// A stable key for one activity: the same activity retried keeps its key, so
  /// the Brain records it once. Letters, digits and dashes, as the Worker asks.
  static String keyFor(String prefix, DateTime at) {
    _sequence = (_sequence + 1) % 1000;
    final safe = prefix.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '-');
    return '$safe-${at.toUtc().microsecondsSinceEpoch}-$_sequence';
  }

  static String _clip(String text, int max) {
    final t = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    return t.length <= max ? t : t.substring(0, max).trimRight();
  }

  /// The Music Room started something for the owner ("play the song Blue in Green").
  static Map<String, String>? music(String query, {String detail = '', String kind = 'requested', DateTime? at}) {
    final title = _clip(query, 200);
    if (title.isEmpty || !const {'requested', 'played', 'paused', 'liked'}.contains(kind)) return null;
    return {
      'room': 'music',
      'kind': kind,
      'key': keyFor('music', at ?? DateTime.now()),
      'title': title,
      if (detail.trim().isNotEmpty) 'detail': _clip(detail, 600),
    };
  }

  /// Help explained something, or walked the owner through a screen.
  static Map<String, String>? help(String asked, {bool walkthrough = false, String screen = '', DateTime? at}) {
    final title = _clip(walkthrough ? 'Walkthrough of ${screen.trim().isEmpty ? 'the screen' : screen.trim()}' : asked, 200);
    if (title.isEmpty) return null;
    final where = screen.trim().isEmpty ? '' : ' on ${_clip(screen, 80)}';
    return {
      'room': 'help',
      'kind': walkthrough ? 'walkthrough' : 'explained',
      'key': keyFor('help', at ?? DateTime.now()),
      'title': title,
      'detail': walkthrough ? 'CHE walked the owner through the controls$where.' : 'CHE answered from the controls$where.',
    };
  }

  /// The owner asked about the screen in front of him: only its name is kept.
  static Map<String, String>? screen(String page, {DateTime? at}) {
    final title = _clip(page, 80);
    if (title.isEmpty) return null;
    return {'room': 'screen', 'kind': 'observed', 'key': keyFor('screen', at ?? DateTime.now()), 'title': title};
  }

  /// Sends one event. Returns true when the Worker accepted it; never throws.
  static Future<bool> post({
    required String baseUrl,
    required Map<String, String> headers,
    required Map<String, String>? event,
    http.Client? client,
    Duration timeout = const Duration(seconds: 8),
  }) async {
    if (event == null || baseUrl.trim().isEmpty || !headers.containsKey('Authorization')) return false;
    try {
      final uri = Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}$_path');
      final body = jsonEncode(event);
      final response = await (client == null ? http.post(uri, headers: headers, body: body) : client.post(uri, headers: headers, body: body)).timeout(timeout);
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
