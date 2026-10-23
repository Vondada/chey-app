// Which account a chart, position, balance, order, alert or P&L figure belongs to (owner, 2026-10-23).
// Every trading surface in the side-by-side view carries one of these three labels in words and an
// icon, never colour alone: MY ACCOUNT, CHE PAPER ACCOUNT or LIVE ACCOUNT. CHE's paper account and
// the owner's accounts never share a figure.
import 'package:flutter/material.dart';

enum CheAccountKind { mine, chePaper, live }

extension CheAccountKindLabel on CheAccountKind {
  /// The words every surface shows.
  String get label => switch (this) {
        CheAccountKind.mine => 'MY ACCOUNT',
        CheAccountKind.chePaper => 'CHE PAPER ACCOUNT',
        CheAccountKind.live => 'LIVE ACCOUNT',
      };

  /// What the label means, for VoiceOver and Read Aloud.
  String get spoken => switch (this) {
        CheAccountKind.mine => 'My account. Your own trades.',
        CheAccountKind.chePaper => 'CHE paper account. Simulated trades only; no money moves.',
        CheAccountKind.live => 'Live account. Real money. Orders stay disabled until broker approval and testing are verified.',
      };

  IconData get icon => switch (this) {
        CheAccountKind.mine => Icons.person_rounded,
        CheAccountKind.chePaper => Icons.science_outlined,
        CheAccountKind.live => Icons.warning_amber_rounded,
      };

  /// A colour that pairs with the words and icon; it never carries the meaning by itself.
  Color get color => switch (this) {
        CheAccountKind.mine => const Color(0xFF6CB4FF),
        CheAccountKind.chePaper => const Color(0xFFE9C46A),
        CheAccountKind.live => const Color(0xFFFF5C7A),
      };
}

/// The labelled band at the top of each pane: icon, words, and a border style that differs per
/// account (solid for mine, dashed-look double rule for CHE paper, thick for live).
class CheAccountBand extends StatelessWidget {
  const CheAccountBand({super.key, required this.kind, this.detail = ''});

  final CheAccountKind kind;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final c = kind.color;
    return Semantics(
      container: true,
      header: true,
      label: '${kind.label}. ${kind.spoken}${detail.isEmpty ? '' : ' $detail'}',
      excludeSemantics: true,
      child: Container(
        key: Key('account_band_${kind.name}'),
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: c.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: c, width: kind == CheAccountKind.live ? 3 : 1.5),
        ),
        child: Row(children: [
          Icon(kind.icon, color: c, size: 20),
          const SizedBox(width: 8),
          Flexible(
            child: Text(kind.label, style: TextStyle(color: c, fontWeight: FontWeight.w900, fontSize: 14, letterSpacing: 1.1)),
          ),
          if (kind == CheAccountKind.chePaper) ...[
            const SizedBox(width: 6),
            Text('SIMULATED', style: TextStyle(color: c, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.8)),
          ],
          if (detail.isNotEmpty) ...[
            const SizedBox(width: 8),
            Expanded(
              child: Text(detail, textAlign: TextAlign.end, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70, fontSize: 12)),
            ),
          ],
        ]),
      ),
    );
  }
}
