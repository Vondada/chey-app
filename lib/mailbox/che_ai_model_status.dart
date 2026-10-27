// AI Model Status (owner rule, 2026-10-27: authorized AI spend is $0). Shown in the Keys tab
// from the `ai_model_status` field of GET /api/keys. It shows only what CHE's server verified:
// a provider is "connected" only after a recent check, a balance only when the provider
// reported it, and a cost only when it was measured. CHE never reads this aloud on her own;
// the owner chooses Read aloud.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';

class CheAiProviderStatus {
  const CheAiProviderStatus({
    required this.id,
    required this.name,
    required this.policy,
    required this.usage,
    required this.connected,
    required this.verification,
    required this.usedForCoding,
    this.currentModel,
    this.remainingAllowanceUsd,
    this.allowanceNote = '',
    this.requestsCompleted = 0,
    this.failedAttempts = 0,
    this.lastErrorClass,
    this.billedUsdVerified,
    this.circuit = 'closed',
    this.reason,
    this.rule = '',
    this.remedy,
  });

  final String id;
  final String name;
  final String policy;
  final String usage;
  final String connected;
  final String verification;
  final bool usedForCoding;
  final String? currentModel;
  final double? remainingAllowanceUsd;
  final String allowanceNote;
  final int requestsCompleted;
  final int failedAttempts;
  final String? lastErrorClass;
  final double? billedUsdVerified;
  final String circuit;
  final String? reason;
  final String rule;
  final String? remedy;

  static String? _text(Object? v) {
    final s = v is String ? v.trim() : '';
    return s.isEmpty ? null : s;
  }

  static double? _num(Object? v) => v is num ? v.toDouble() : null;

  factory CheAiProviderStatus.fromJson(Map<String, dynamic> json) => CheAiProviderStatus(
        id: '${json['id'] ?? ''}',
        name: _text(json['name']) ?? '${json['id'] ?? 'Provider'}',
        policy: _text(json['policy']) ?? 'blocked_billing_unverifiable',
        usage: _text(json['usage']) ?? 'blocked',
        // Anything but an explicit verified check reads as not verified.
        connected: json['connected'] == 'verified'
            ? 'verified'
            : json['connected'] == 'auth_failure'
                ? 'auth_failure'
                : 'not_verified',
        verification: _text(json['verification']) ?? 'none',
        usedForCoding: json['used_for_coding'] == true,
        currentModel: _text(json['current_model']),
        remainingAllowanceUsd: _num(json['remaining_allowance_usd']),
        allowanceNote: _text(json['allowance_note']) ?? '',
        requestsCompleted: (json['requests_completed'] as num?)?.toInt() ?? 0,
        failedAttempts: (json['failed_attempts'] as num?)?.toInt() ?? 0,
        lastErrorClass: _text(json['last_error_class']),
        billedUsdVerified: _num(json['billed_usd_verified']),
        circuit: _text(json['circuit']) ?? 'closed',
        reason: _text(json['reason']),
        rule: _text(json['rule']) ?? '',
        remedy: _text(json['remedy']),
      );

  String get usageWords => switch (usage) {
        'free' => 'Free',
        'credit_covered' => 'Covered by credits',
        _ => 'Blocked',
      };

  String get connectionWords => switch (connected) {
        'verified' => 'Connection verified',
        'auth_failure' => 'Key rejected',
        _ => 'Connection not verified',
      };

  static String words(String? value) => (value ?? '').replaceAll('_', ' ');

  /// One full sentence for VoiceOver and Read aloud.
  String get spokenLine {
    final parts = <String>['$name: $usageWords. $connectionWords.'];
    if (verification == 'owner_attested') parts.add('Free plan confirmed by you, not by a provider check.');
    if (currentModel != null) parts.add('Last finished by $currentModel.');
    if (requestsCompleted > 0 || failedAttempts > 0) {
      parts.add('$requestsCompleted completed and $failedAttempts failed coding attempts.');
    }
    if (remainingAllowanceUsd != null) {
      parts.add('Provider reports ${remainingAllowanceUsd!.toStringAsFixed(2)} dollars left.');
    }
    if (billedUsdVerified != null) {
      parts.add('Measured cost ${billedUsdVerified!.toStringAsFixed(2)} dollars.');
    }
    if (circuit == 'open') parts.add('Paused after ${words(lastErrorClass ?? 'failures')}.');
    if (usage == 'blocked' && reason != null) parts.add('Reason: ${words(reason)}.');
    return parts.join(' ');
  }
}

class CheAiModelStatus {
  const CheAiModelStatus({
    required this.authorizedSpendUsd,
    required this.paidFallback,
    required this.providers,
    required this.spoken,
    required this.ledgerSource,
    this.lastCompletedBy,
    this.lastState,
  });

  final double authorizedSpendUsd;
  final String paidFallback;
  final List<CheAiProviderStatus> providers;
  final String spoken;
  final String ledgerSource;
  final String? lastCompletedBy;
  final String? lastState;

  static CheAiModelStatus? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final json = Map<String, dynamic>.from(raw);
    final rows = json['providers'] is List
        ? (json['providers'] as List)
            .whereType<Map>()
            .map((e) => CheAiProviderStatus.fromJson(Map<String, dynamic>.from(e)))
            .toList(growable: false)
        : const <CheAiProviderStatus>[];
    final last = json['last_session'] is Map ? Map<String, dynamic>.from(json['last_session'] as Map) : const <String, dynamic>{};
    return CheAiModelStatus(
      authorizedSpendUsd: (json['authorized_spend_usd'] as num?)?.toDouble() ?? 0,
      paidFallback: '${json['paid_fallback'] ?? 'disabled'}',
      providers: rows,
      spoken: '${json['spoken'] ?? ''}'.trim(),
      ledgerSource: '${json['ledger_source'] ?? 'unavailable'}',
      lastCompletedBy: CheAiProviderStatus._text(last['completed_by_model']),
      lastState: CheAiProviderStatus._text(last['state']),
    );
  }

  List<CheAiProviderStatus> get freeForCoding =>
      providers.where((p) => p.usedForCoding && p.usage != 'blocked' && p.circuit != 'open').toList(growable: false);

  String get summary {
    final spend = authorizedSpendUsd == 0 ? r'$0' : '\$${authorizedSpendUsd.toStringAsFixed(2)}';
    final free = freeForCoding;
    final head = 'Authorized AI spend $spend. Paid fallback ${paidFallback == 'disabled' ? 'off' : paidFallback}.';
    final body = free.isEmpty
        ? 'No provider is verified free for coding yet.'
        : 'Verified free for coding: ${free.map((p) => p.name).join(', ')}.';
    final last = lastCompletedBy != null
        ? ' Last job finished by $lastCompletedBy.'
        : lastState != null
            ? ' Last job: ${CheAiProviderStatus.words(lastState)}.'
            : '';
    final source = ledgerSource == 'che-mailbox' ? '' : ' No runner record could be read yet.';
    return '$head $body$last$source';
  }

  /// What Read aloud says: the server's spoken text, or the summary and rows when it gave none.
  String get readAloudText =>
      spoken.isNotEmpty ? spoken : [summary, ...providers.map((p) => p.spokenLine)].join(' ');
}

/// The compact card in the Keys tab. Read aloud speaks only when the owner chooses it.
class CheAiModelStatusCard extends StatelessWidget {
  const CheAiModelStatusCard({super.key, required this.status, this.onReadAloud});

  final CheAiModelStatus status;
  final void Function(String text)? onReadAloud;

  void _details(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      builder: (c) => SafeArea(
        child: DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.8,
          builder: (_, controller) => ListView(
            controller: controller,
            padding: const EdgeInsets.all(16),
            children: [
              Semantics(header: true, child: Text('AI Model Status', style: CheType.title)),
              const SizedBox(height: 8),
              Text(status.summary, style: CheType.body),
              const SizedBox(height: 12),
              for (final p in status.providers) _ProviderTile(provider: p, onReadAloud: onReadAloud),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final free = status.freeForCoding.isNotEmpty;
    return Card(
      color: CheColors.surface,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(free ? Icons.verified_rounded : Icons.block_rounded,
                  color: free ? CheColors.success : CheColors.warning, semanticLabel: free ? 'Free model available' : 'No free model verified'),
              const SizedBox(width: 8),
              Expanded(child: Semantics(header: true, child: Text('AI Model Status', style: CheType.label))),
            ]),
            const SizedBox(height: 4),
            Text(status.summary, style: CheType.bodyDim),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: [
              if (onReadAloud != null)
                Semantics(
                  button: true,
                  label: 'Read the AI model status aloud',
                  excludeSemantics: true,
                  child: OutlinedButton.icon(
                    onPressed: () {
                      HapticFeedback.selectionClick();
                      onReadAloud!(status.readAloudText);
                    },
                    icon: const Icon(Icons.volume_up_rounded),
                    label: const Text('Read aloud'),
                  ),
                ),
              Semantics(
                button: true,
                label: 'Show every AI provider with its cost status',
                excludeSemantics: true,
                child: OutlinedButton.icon(
                  onPressed: () => _details(context),
                  icon: const Icon(Icons.menu_book_rounded),
                  label: const Text('Providers'),
                ),
              ),
            ]),
          ],
        ),
      ),
    );
  }
}

class _ProviderTile extends StatelessWidget {
  const _ProviderTile({required this.provider, this.onReadAloud});

  final CheAiProviderStatus provider;
  final void Function(String text)? onReadAloud;

  @override
  Widget build(BuildContext context) {
    final p = provider;
    final ok = p.usage != 'blocked' && p.circuit != 'open';
    final lines = <String>[
      '${p.usageWords} · ${p.connectionWords}${p.verification == 'owner_attested' ? ' · owner-confirmed plan' : ''}',
      if (p.currentModel != null) 'Model: ${p.currentModel}',
      'Attempts: ${p.requestsCompleted} completed, ${p.failedAttempts} failed',
      p.remainingAllowanceUsd != null
          ? 'Allowance left: \$${p.remainingAllowanceUsd!.toStringAsFixed(2)} (provider-reported)'
          : 'Allowance left: ${p.allowanceNote.isEmpty ? 'not exposed by the provider' : p.allowanceNote}',
      p.billedUsdVerified != null ? 'Billed: \$${p.billedUsdVerified!.toStringAsFixed(2)} (measured)' : 'Billed: not verifiable',
      if (!ok && p.reason != null) 'Why blocked: ${CheAiProviderStatus.words(p.reason)}',
      if (!ok && p.remedy != null) p.remedy!,
    ];
    return Semantics(
      button: onReadAloud != null,
      label: '${p.spokenLine}${onReadAloud != null ? ' Double tap to hear it.' : ''}',
      excludeSemantics: true,
      child: Card(
        color: CheColors.surfaceHi,
        child: ListTile(
          leading: Icon(ok ? Icons.check_circle_rounded : Icons.block_rounded,
              color: ok ? CheColors.success : CheColors.warning),
          title: Text(p.name, style: CheType.label),
          subtitle: Text(lines.join('\n'), style: CheType.caption),
          onTap: onReadAloud == null ? null : () => onReadAloud!(p.spokenLine),
        ),
      ),
    );
  }
}
