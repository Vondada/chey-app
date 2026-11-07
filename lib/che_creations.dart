// Recent creations (owner, 2026-10-22): the Create room shows the pictures and videos CHE made, read
// from the Worker's media library, so the owner can see them and play them. The list loads only when
// the room is shown, and nothing here speaks on its own (owner rule, 2026-10-11).
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'che_ui/che_hud.dart';
import 'home/che_inline_preview.dart';

/// The pictures and videos in the Worker's media library, in the order it keeps them.
List<Map<String, dynamic>> cheCreationsFrom(Object? decoded) {
  if (decoded is! Map || decoded['items'] is! List) return const [];
  return [
    for (final item in decoded['items'] as List)
      if (item is Map &&
          _isPictureOrVideo(item) &&
          '${item['id'] ?? ''}'.trim().isNotEmpty)
        Map<String, dynamic>.from(item),
  ];
}

// A saved picture is a creation even when the owner uploaded it (kind 'upload', image MIME type); a document is not.
bool _isPictureOrVideo(Map item) =>
    item['kind'] == 'video' || item['kind'] == 'image' || '${item['mime_type'] ?? ''}'.startsWith('image/');

/// The file a creation plays or shows on the CHE server, or null when it has no id.
String? cheCreationFileUrl(String baseUrl, Map<String, dynamic> item) {
  final id = '${item['id'] ?? ''}'.trim();
  if (id.isEmpty) return null;
  return '$baseUrl/api/media/$id/${item['kind'] == 'video' ? 'video' : 'image'}';
}

/// The picture on a tile: a video's saved thumbnail, or the picture itself.
String? cheCreationThumbUrl(String baseUrl, Map<String, dynamic> item) {
  if (item['kind'] != 'video') return cheCreationFileUrl(baseUrl, item);
  final thumb = '${item['thumbnail_media_id'] ?? ''}'.trim();
  return thumb.isEmpty ? null : '$baseUrl/api/media/$thumb/image';
}

/// Loads the library when shown, then lists it. Failure is said quietly, on screen.
class CheCreationsStrip extends StatefulWidget {
  const CheCreationsStrip({super.key, required this.baseUrl, required this.headers, this.active = true});

  final String baseUrl;
  final Map<String, String> headers;
  final bool active;

  @override
  State<CheCreationsStrip> createState() => _CheCreationsStripState();
}

class _CheCreationsStripState extends State<CheCreationsStrip> {
  List<Map<String, dynamic>> _items = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.active) unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant CheCreationsStrip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final response = await http
          .get(Uri.parse('${widget.baseUrl}/api/media'), headers: widget.headers)
          .timeout(const Duration(seconds: 12));
      if (response.statusCode != 200) throw StateError('status ${response.statusCode}');
      final items = cheCreationsFrom(jsonDecode(response.body));
      if (!mounted) return;
      setState(() {
        _items = items;
        _loading = false;
        _error = null;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not load your pictures and videos. Pull to refresh the room.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    const quiet = TextStyle(color: Colors.white60, fontSize: 12, height: 1.4);
    if (_loading) return const Text('Loading your pictures and videos…', style: quiet);
    if (_error != null) return Text(_error!, style: quiet);
    if (_items.isEmpty) {
      return const Text('Nothing made yet. Ask CHE for a picture or a video, and it appears here.', style: quiet);
    }
    return CheCreationsTiles(items: _items.take(24).toList(), baseUrl: widget.baseUrl, headers: widget.headers);
  }
}

/// The creations as small tiles in a row. A video shows its thumbnail with a play mark.
class CheCreationsTiles extends StatelessWidget {
  const CheCreationsTiles({super.key, required this.items, required this.baseUrl, required this.headers});

  final List<Map<String, dynamic>> items;
  final String baseUrl;
  final Map<String, String> headers;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 150,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: items.length,
        separatorBuilder: (_, _) => const SizedBox(width: 12),
        itemBuilder: (context, index) => _CreationTile(item: items[index], baseUrl: baseUrl, headers: headers),
      ),
    );
  }
}

class _CreationTile extends StatelessWidget {
  const _CreationTile({required this.item, required this.baseUrl, required this.headers});

  final Map<String, dynamic> item;
  final String baseUrl;
  final Map<String, String> headers;

  @override
  Widget build(BuildContext context) {
    final isVideo = item['kind'] == 'video';
    final kind = isVideo ? 'Video' : 'Picture';
    final title = '${item['title'] ?? kind}'.trim();
    final thumb = cheCreationThumbUrl(baseUrl, item);
    final hud = cheHudActive;
    // HUD glass: an empty pane of glass while the picture loads, and an ice rim round every tile.
    final Widget placeholder = hud
        ? const CheGlass(radius: 14, shadow: false, child: SizedBox.expand())
        : const ColoredBox(color: Color(0xFF222428));
    return Semantics(
      button: true,
      excludeSemantics: true,
      label: '$kind: $title. Tap to ${isVideo ? 'play' : 'view'}.',
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (_) => CheCreationViewer(item: item, baseUrl: baseUrl, headers: headers),
        )),
        child: SizedBox(
          width: 132,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: SizedBox(
                  height: 96,
                  width: 132,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      thumb == null
                          ? placeholder
                          : Image.network(
                              thumb,
                              headers: headers,
                              fit: BoxFit.cover,
                              cacheWidth: 300,
                              errorBuilder: (_, _, _) => placeholder,
                            ),
                      if (isVideo)
                        const Center(child: Icon(Icons.play_circle_fill, color: Colors.white, size: 36)),
                      if (hud)
                        DecoratedBox(
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(color: CheHud.ice.withValues(alpha: 0.45)),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 12, height: 1.3),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The address a saved video plays from. The iPhone's player fetches a video in byte ranges and never repeats the
/// app's Authorization header on those requests, so a video on CHE's own server is played from a signed play link
/// (`POST /api/media/<id>/link`, valid six hours for that one video) instead of the token-protected address.
Future<String> cheVideoPlayUrl(String fileUrl, Map<String, String> headers, {http.Client? client}) async {
  final link = Uri.parse(fileUrl.replaceFirst(RegExp(r'/video$'), '/link'));
  if (!fileUrl.endsWith('/video') || !headers.containsKey('Authorization')) return fileUrl;
  final c = client ?? http.Client();
  try {
    final res = await c.post(link, headers: headers).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('play link ${res.statusCode}');
    final url = '${(jsonDecode(res.body) as Map)['url'] ?? ''}';
    if (!url.startsWith('https://')) throw Exception('no play link');
    return url;
  } finally {
    if (client == null) c.close();
  }
}

/// Plays a saved video from its play link; says so quietly on screen if the link cannot be had.
class CheVideoPlayLink extends StatefulWidget {
  const CheVideoPlayLink({super.key, required this.fileUrl, required this.headers});

  /// While a video's link could not be had, the voice navigator (home_state/send.dart) passes the owner's words here:
  /// "try again" retries, "what happened" reads the problem. Anything else returns null and goes to the chat.
  static Future<String?> Function(String words)? voiceHandler;

  final String fileUrl;
  final Map<String, String> headers;

  @override
  State<CheVideoPlayLink> createState() => _CheVideoPlayLinkState();
}

/// The video viewer's spoken commands while its link failed: 'retry', 'read', or null (not for the viewer).
String? cheVideoLinkCommand(String words) {
  final t = words.toLowerCase().replaceAll(RegExp(r"[^a-z' ]"), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  if (RegExp(r'^(?:(?:che|please) )?(?:try (?:it |that |the video )?again|retry|reload(?: the video)?|play (?:it|the video) again)(?: please)?$').hasMatch(t)) return 'retry';
  if (RegExp(r"^(?:what happened|what's wrong|what is wrong|read (?:it|the screen|the error))$").hasMatch(t)) return 'read';
  return null;
}

class _CheVideoPlayLinkState extends State<CheVideoPlayLink> {
  late Future<String> _url = cheVideoPlayUrl(widget.fileUrl, widget.headers);
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    CheVideoPlayLink.voiceHandler = _voice;
  }

  @override
  void dispose() {
    if (CheVideoPlayLink.voiceHandler == _voice) CheVideoPlayLink.voiceHandler = null;
    super.dispose();
  }

  Future<String?> _voice(String words) async {
    if (!_failed) return null;
    final command = cheVideoLinkCommand(words);
    if (command == 'retry') {
      _retry();
      return 'Trying the video again.';
    }
    if (command == 'read') return 'This video could not be opened right now. Say try again to retry.';
    return null;
  }

  void _retry() {
    if (!mounted) return;
    setState(() {
      _failed = false;
      _url = cheVideoPlayUrl(widget.fileUrl, widget.headers);
    });
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<String>(
      future: _url,
      builder: (context, snap) {
        _failed = snap.hasError;
        if (snap.hasError) {
          return Column(mainAxisSize: MainAxisSize.min, children: [
            const Text('This video could not be opened right now. Say "try again", or tap below.'),
            TextButton(onPressed: _retry, child: const Text('Try again')),
          ]);
        }
        if (!snap.hasData) return const SizedBox(height: 360, child: Center(child: CircularProgressIndicator()));
        return CheInlinePreview(url: snap.data!, label: 'Video', height: 360);
      },
    );
  }
}

/// One creation, full size: a video plays here, a picture is shown here. Back returns to the room.
class CheCreationViewer extends StatelessWidget {
  const CheCreationViewer({super.key, required this.item, required this.baseUrl, required this.headers});

  final Map<String, dynamic> item;
  final String baseUrl;
  final Map<String, String> headers;

  @override
  Widget build(BuildContext context) {
    final isVideo = item['kind'] == 'video';
    final title = '${item['title'] ?? (isVideo ? 'Video' : 'Picture')}'.trim();
    final url = cheCreationFileUrl(baseUrl, item);
    final body = url == null
        ? const Center(child: Text('This creation has no file.'))
        : isVideo
            ? Padding(
                padding: const EdgeInsets.all(16),
                child: CheVideoPlayLink(fileUrl: url, headers: headers),
              )
            : Center(
                child: InteractiveViewer(
                  child: Image.network(
                    url,
                    headers: headers,
                    fit: BoxFit.contain,
                    errorBuilder: (_, _, _) => const Text('This picture could not be shown.'),
                  ),
                ),
              );
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: body,
    );
  }
}
