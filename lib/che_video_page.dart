// Recent videos. Empty until a render returns a file.

import 'package:flutter/material.dart';

class CheVideoPage extends StatelessWidget {
  const CheVideoPage({super.key, this.videos = const []});

  final List<Map<String, String>> videos;

  @override
  Widget build(BuildContext context) {
    final realVideos = videos
        .where((video) => (video['media_url'] ?? '').trim().isNotEmpty)
        .toList(growable: false);
    return Scaffold(
      appBar: AppBar(title: const Text('Recent videos')),
      body: realVideos.isEmpty
          ? const Center(child: Text('No videos yet.'))
          : ListView(
              children: [
                for (final video in realVideos)
                  Semantics(
                    label:
                        '${video['title'] ?? 'Untitled'} video file. ${video['media_url']}',
                    child: ListTile(
                      title: Text(video['title'] ?? 'Untitled'),
                      subtitle: Text(video['media_url']!),
                    ),
                  ),
              ],
            ),
    );
  }
}
