// One activity feed of what CHE and the Office really did, newest first,
// readable aloud line by line or all at once.

import 'package:flutter/material.dart';

import '../che_ui/che_theme.dart';

class CheActivityFeedSheet extends StatelessWidget {
  const CheActivityFeedSheet({super.key, required this.events, required this.onSpeak});

  final List<Map<String, dynamic>> events;
  final Future<void> Function(String text) onSpeak;

  String _when(String? iso) {
    final at = DateTime.tryParse(iso ?? '')?.toLocal();
    if (at == null) return '';
    final diff = DateTime.now().difference(at);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
    if (diff.inHours < 24) return '${diff.inHours} h ago';
    return '${diff.inDays} d ago';
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.8,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.lg, CheSpace.sm, CheSpace.sm),
          child: Row(children: [
            Expanded(
              child: Semantics(header: true, child: Text('What happened', style: CheType.title)),
            ),
            TextButton.icon(
              onPressed: events.isEmpty
                  ? null
                  : () => onSpeak(events.take(10).map((e) => e['line']).join(' ')),
              icon: const Icon(Icons.volume_up_rounded),
              label: const Text('Read all'),
            ),
          ]),
        ),
        Expanded(
          child: events.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(CheSpace.xl),
                  child: Text(
                    'Nothing yet. Give CHE or the Office a task and it shows up here.',
                    style: CheType.body.copyWith(fontSize: 18),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xl),
                  itemCount: events.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final line = events[i]['line']?.toString() ?? '';
                    final when = _when(events[i]['at']?.toString());
                    return Semantics(
                      button: true,
                      label: '${i + 1}. $line $when. Double tap to hear it.',
                      excludeSemantics: true,
                      onTap: () => onSpeak(line),
                      child: ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(line, style: CheType.body.copyWith(fontSize: 18)),
                        subtitle: when.isEmpty ? null : Text(when, style: CheType.caption),
                        trailing: IconButton(
                          tooltip: 'Read aloud',
                          onPressed: () => onSpeak(line),
                          icon: const Icon(Icons.volume_up_rounded, color: CheColors.accent),
                        ),
                        onTap: () => onSpeak(line),
                      ),
                    );
                  },
                ),
        ),
      ]),
    );
  }
}
