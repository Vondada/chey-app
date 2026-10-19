// "Understood as" under a reply (issue #345): how CHE read a turn with a money or
// delete hold, or with several steps and a "don't". Quiet text only: it is never
// spoken by itself (owner rule, 2026-10-11), and VoiceOver reads it when the owner
// moves to it. CHE still acts on his own words, not on this line.
import 'package:flutter/material.dart';

import 'che_theme.dart';

/// The Worker's `understood_as` from a done event or a held reply, or null.
String? cheUnderstoodAs(Object? data) {
  if (data is! Map) return null;
  final text = data['understood_as']?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

class CheUnderstoodAs extends StatelessWidget {
  const CheUnderstoodAs({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final line = 'Understood as: $text';
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      // One focus stop with the whole line; no live region, so nothing is announced on its own.
      child: Semantics(
        container: true,
        label: line,
        excludeSemantics: true,
        child: Text(line, style: CheType.bodyDim),
      ),
    );
  }
}
