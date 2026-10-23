// Performance watch (owner, 2026-10-22): when the Worker measures CHE slower than her budget, /api/state carries
// `performance: {status: 'slow', note}`. The app shows that note as one quiet, muted line under the status banner.
// It never speaks and is not a live region (AGENTS.md: passive status stays silent); "performance report" or
// /che-performance reads the numbers aloud on request.
import 'package:flutter/material.dart';

/// The note to show, or null while CHE is within budget (or the Worker sends nothing).
String? chePerformanceNote(Object? field) {
  if (field is! Map || field['status'] != 'slow') return null;
  final note = '${field['note'] ?? ''}'.trim();
  return note.isEmpty ? null : note;
}

class ChePerformanceNote extends StatelessWidget {
  const ChePerformanceNote({super.key, required this.note});
  final String note;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: const Color(0xFF0B201D),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Semantics(
        label: 'Performance: $note',
        child: ExcludeSemantics(
          child: Text(note, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Color(0xFFB8C7C3))),
        ),
      ),
    );
  }
}
