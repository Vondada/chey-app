// Local, accessible screen-aware help. Uses the same registered screen facts
// CHE already uses for "what is on my screen"; never asks an AI to guess UI.
import 'package:flutter/material.dart';
import 'che_screen_awareness.dart';

class CheScreenGuide {
  CheScreenGuide._();

  static String description(CheScreenReport? report, String fallback) {
    if (report != null) {
      return CheScreenReport(page: report.page, tab: report.tab, tabs: report.tabs, detail: report.detail).spoken
      + (report.controls.isEmpty ? '' : ' Controls: ${report.controls.indexed.map((entry) => '${entry.$1 + 1}. ${entry.$2}').join('. ')}.');
    }
    return 'You are on $fallback. This page has not registered '
      'its individual controls for the guide yet. Use the VoiceOver labels '
      'or ask CHE to describe the current screen. I will not guess button actions.';
  }

  static void open(
    BuildContext context, {
    required String fallback,
    required void Function(String) onRead,
  }) {
    final report = CheScreenAwareness.current;
    final title = report?.page ?? fallback;
    final words = description(report, fallback);
    final controls = report?.controls ?? const <String>[];
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                const Icon(Icons.help_outline, semanticLabel: 'Screen help'),
                const SizedBox(width: 10),
                Expanded(child: Text('Help: $title',
                  style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700))),
              ]),
              const SizedBox(height: 14),
              SelectableText(words, style: const TextStyle(fontSize: 17)),
              if (controls.isNotEmpty) ...[
                const SizedBox(height: 12),
                const Text('What is on this screen',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                for (final entry in controls.indexed)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text('${entry.$1 + 1}. ${entry.$2}',
                      style: const TextStyle(fontSize: 16)),
                  ),
              ],
              const SizedBox(height: 18),
              const Text('You can also ask CHE by voice or typing: '
                '"What is on my screen?" or "How do I use this screen?" '
                'The guide never places a trade or changes a setting.',
                style: TextStyle(fontSize: 15)),
              const SizedBox(height: 14),
              Wrap(spacing: 8, runSpacing: 8, children: [
                OutlinedButton.icon(
                  onPressed: () => onRead(words),
                  icon: const Icon(Icons.volume_up_outlined),
                  label: const Text('Read this'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(sheetContext),
                  child: const Text('Close help'),
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
