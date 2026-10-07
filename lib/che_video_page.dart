// Recent videos. Empty until a render returns a file.

import 'package:flutter/material.dart';

class CheVideoPage extends StatelessWidget {
  const CheVideoPage({super.key, this.videos = const []});

  final List<Map<String, String>> videos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Recent videos')),
      body: videos.isEmpty
          ? const Center(child: Text('No videos yet. A file has not come back.'))
          : ListView(
              children: [
                for (final video in videos)
                  ListTile(
                    title: Text(video['title'] ?? 'Untitled'),
                    subtitle: Text(video['link']?.isNotEmpty == true ? video['link']! : (video['media_url'] ?? '')),
                  ),
              ],
            ),
    );
  }
}
