// Response Details → Personality (owner, 2026-10-21): under a reply, the owner can open what shaped it:
// which Soul version was on record, which model or CHE handler answered, and whether the Soul actually
// reached the words. It is opened by the owner only. Nothing here is spoken on its own (owner rule, 2026-10-11).
import 'dart:convert';

import 'package:flutter/material.dart';

import 'che_theme.dart';

/// The provenance a done event carries: `soul`, `served_by` and `source`, or null when none came.
Map<String, dynamic>? cheResponseDetails(Object? data) {
  if (data is! Map) return null;
  final soul = data['soul'];
  final servedBy = data['served_by'];
  if (soul is! Map && servedBy is! Map) return null;
  return {
    if (soul is Map) 'soul': Map<String, dynamic>.from(soul),
    if (servedBy is Map) 'served_by': Map<String, dynamic>.from(servedBy),
    if (data['source'] != null) 'source': '${data['source']}',
  };
}

/// The details as the message store keeps them (a string), or null.
String? cheResponseDetailsJson(Map<String, dynamic>? details) => details == null ? null : jsonEncode(details);

Map<String, dynamic>? cheResponseDetailsFromJson(String? raw) {
  if (raw == null || raw.isEmpty) return null;
  try {
    final decoded = jsonDecode(raw);
    return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
  } catch (_) {
    return null;
  }
}

/// The plain sentences the owner reads or hears, in order. Pure, so the wording is tested directly.
List<String> cheResponseDetailLines(Map<String, dynamic> details) {
  final soul = details['soul'] is Map ? Map<String, dynamic>.from(details['soul']) : const <String, dynamic>{};
  final servedBy = details['served_by'] is Map ? Map<String, dynamic>.from(details['served_by']) : null;
  final source = details['source']?.toString() ?? '';
  final lines = <String>[];

  final version = soul['version'];
  final hash = soul['hash']?.toString() ?? '';
  if (version != null) {
    lines.add(soul['soul_loaded'] == true
        ? 'Soul on record: version $version${hash.isEmpty ? '' : ', fingerprint $hash'}.'
        : 'No Soul record came with this reply.');
  }

  final route = soul['route']?.toString() ?? '';
  final reason = soul['reason']?.toString() ?? '';
  if (soul['soul_applied'] == true) {
    lines.add('The Soul shaped this reply. Its manner came from version $version.');
  } else if (route == 'cache') {
    lines.add('The Soul did not shape this reply: it came from the answer cache. ${reason.isEmpty ? '' : reason}'.trim());
  } else if (soul.isNotEmpty) {
    lines.add('The Soul did not shape this reply${reason.isEmpty ? '.' : ': $reason'}');
  }

  if (servedBy != null) {
    final model = servedBy['model']?.toString() ?? 'an unnamed model';
    lines.add('Answered by the model $model.');
    lines.add(servedBy['fallback'] == true
        ? 'This was a fallback engine, used after the first choice did not answer.'
        : 'This was the first engine chosen; no fallback was used.');
  } else if (route == 'cache') {
    lines.add('Answered from CHE\'s saved answers, with no model call.');
  } else if (source.isNotEmpty) {
    lines.add('Answered by the CHE handler $source, with no model call.');
  } else {
    lines.add('Answered without a model call.');
  }
  return lines;
}

/// A quiet button under the reply. Opening it shows the lines in a sheet; nothing is announced by itself.
class CheResponseDetailsButton extends StatelessWidget {
  const CheResponseDetailsButton({super.key, required this.details});

  final Map<String, dynamic> details;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Semantics(
        button: true,
        label: 'Response details: personality',
        hint: 'Shows which Soul version, model or handler, and fallback shaped this reply',
        child: TextButton(
          onPressed: () => showModalBottomSheet<void>(
            context: context,
            isScrollControlled: true,
            builder: (_) => CheResponseDetailsSheet(details: details),
          ),
          child: Text('Response details', style: CheType.label),
        ),
      ),
    );
  }
}

class CheResponseDetailsSheet extends StatelessWidget {
  const CheResponseDetailsSheet({super.key, required this.details});

  final Map<String, dynamic> details;

  @override
  Widget build(BuildContext context) {
    final lines = cheResponseDetailLines(details);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 16, CheSpace.gutter, CheSpace.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(header: true, child: Text('Personality', style: CheType.label)),
            const SizedBox(height: 12),
            for (final line in lines)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Semantics(label: line, child: ExcludeSemantics(child: Text(line, style: CheType.body))),
              ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => Navigator.of(context).maybePop(),
                child: Text('Close', style: CheType.label),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
