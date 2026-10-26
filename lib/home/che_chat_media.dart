// Saved pictures and videos that CHE brings up in the chat. A video shows its own saved thumbnail as a tappable tile
// (the Create room tile, with its play mark and VoiceOver label) that opens the video in the Creation viewer. A
// picture gets an "Open in Create room" button. Links are built only from a saved media ID on CHE's own server.
import 'dart:convert';

import 'package:flutter/material.dart';

import '../che_creations.dart';

final _savedId = RegExp(r'^[0-9a-fA-F-]{8,64}$');

String? _idOf(Object? raw) {
  final id = '${raw ?? ''}'.trim();
  return _savedId.hasMatch(id) ? id : null;
}

/// The media fields of a stream's done line, as strings for the chat message. Empty when the reply names no media.
/// `media` (a library answer's list) is kept only for videos: a picture in it is already shown by media_url.
Map<String, String> cheChatMediaExtra(Map<String, dynamic> data) {
  final out = <String, String>{};
  final id = _idOf(data['media_id']);
  if (id != null) out['media_id'] = id;
  final thumb = _idOf(data['thumbnail_media_id']);
  if (thumb != null) out['thumbnail_media_id'] = thumb;
  final title = '${data['media_title'] ?? ''}'.trim();
  if (title.isNotEmpty) out['media_title'] = title.length > 80 ? title.substring(0, 80) : title;
  final list = data['media'];
  if (list is List) {
    final videos = <Map<String, String>>[
      for (final e in list)
        if (e is Map && '${e['media_type'] ?? ''}' == 'video' && _idOf(e['media_id']) != null)
          {
            'media_id': _idOf(e['media_id'])!,
            'title': '${e['media_title'] ?? e['title'] ?? ''}'.trim(),
            if (_idOf(e['thumbnail_media_id']) != null) 'thumbnail_media_id': _idOf(e['thumbnail_media_id'])!,
          },
    ];
    if (videos.isNotEmpty) out['media_list'] = jsonEncode(videos);
  }
  return out;
}

/// The saved videos a chat reply shows: its single video fields and its library list, one entry per media ID.
List<Map<String, dynamic>> cheChatVideos(Map<String, String> item) {
  final found = <String, Map<String, dynamic>>{};
  void add(Map<String, dynamic> entry) {
    final id = _idOf(entry['media_id']);
    if (id == null || found.containsKey(id)) return;
    final title = '${entry['title'] ?? ''}'.trim();
    found[id] = {
      'id': id,
      'kind': 'video',
      'title': title.isEmpty ? 'Video' : title,
      if (_idOf(entry['thumbnail_media_id']) != null) 'thumbnail_media_id': _idOf(entry['thumbnail_media_id']),
    };
  }

  if (item['media_type'] == 'video') {
    add({'media_id': item['media_id'], 'title': item['media_title'], 'thumbnail_media_id': item['thumbnail_media_id']});
  }
  final raw = item['media_list'] ?? '';
  if (raw.isNotEmpty) {
    try {
      final list = jsonDecode(raw);
      if (list is List) {
        for (final e in list) {
          if (e is Map) add(Map<String, dynamic>.from(e));
        }
      }
    } catch (_) {
      // A malformed list shows nothing; the reply text still says what was found.
    }
  }
  return found.values.toList();
}

/// The media a chat reply brings up under its text: video thumbnails (tap to open) and an "Open in Create room" button
/// for a saved picture. Nothing when the reply names no saved media.
class CheChatMediaExtras extends StatelessWidget {
  const CheChatMediaExtras({super.key, required this.item, required this.baseUrl, required this.headers});

  final Map<String, String> item;
  final String baseUrl;
  final Map<String, String> headers;

  @override
  Widget build(BuildContext context) {
    final videos = cheChatVideos(item);
    final pictureId = item['media_type'] == 'image' ? _idOf(item['media_id']) : null;
    if (videos.isEmpty && pictureId == null) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (videos.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: CheCreationsTiles(items: videos, baseUrl: baseUrl, headers: headers),
          ),
        if (pictureId != null)
          TextButton.icon(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => CheCreationViewer(
                item: {'id': pictureId, 'kind': 'image', 'title': item['media_title'] ?? 'Picture'},
                baseUrl: baseUrl,
                headers: headers,
              ),
            )),
            icon: const Icon(Icons.open_in_full_rounded, size: 18),
            label: const Text('Open in Create room'),
          ),
      ],
    );
  }
}
