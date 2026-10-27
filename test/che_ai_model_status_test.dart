import 'package:chey/mailbox/che_ai_model_status.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _payload() => {
      'authorized_spend_usd': 0,
      'paid_fallback': 'disabled',
      'ledger_source': 'che-mailbox',
      'spoken': 'Authorized AI spend is zero dollars, and paid fallback is off.',
      'last_session': {'session_id': 'ocr-0000beef', 'state': 'pr_open', 'completed_by_model': 'openrouter/qwen/qwen3-coder:free'},
      'providers': [
        {
          'id': 'openrouter', 'name': 'OpenRouter', 'policy': 'verified_zero_cost', 'usage': 'free', 'connected': 'verified',
          'verification': 'runtime', 'used_for_coding': true, 'current_model': 'openrouter/qwen/qwen3-coder:free',
          'remaining_allowance_usd': null, 'allowance_note': 'Not exposed by the provider.', 'requests_completed': 3,
          'failed_attempts': 2, 'billed_usd_verified': 0, 'circuit': 'closed',
        },
        {
          'id': 'groq', 'name': 'Groq', 'policy': 'blocked_billing_unverifiable', 'usage': 'blocked', 'connected': 'something_else',
          'used_for_coding': true, 'reason': 'billing_unverifiable', 'remedy': 'Confirm the Free plan, then add groq to CHE_CODING_FREE_PROVIDERS.',
        },
        {'id': 'openai', 'name': 'OpenAI API', 'usage': 'blocked', 'connected': 'verified', 'reason': 'paid_provider_spend_not_authorized'},
      ],
    };

void main() {
  test('parses the server status and never upgrades an unknown connection to verified', () {
    final status = CheAiModelStatus.fromJson(_payload())!;
    expect(status.authorizedSpendUsd, 0);
    expect(status.providers, hasLength(3));
    expect(status.providers[1].connected, 'not_verified');
    expect(status.providers[0].billedUsdVerified, 0);
    expect(status.providers[0].remainingAllowanceUsd, isNull, reason: 'no balance unless the provider reported one');
    expect(status.freeForCoding.map((p) => p.id), ['openrouter']);
    expect(status.summary, contains(r'Authorized AI spend $0. Paid fallback off.'));
    expect(status.summary, contains('Verified free for coding: OpenRouter.'));
    expect(status.summary, contains('Last job finished by openrouter/qwen/qwen3-coder:free.'));
    expect(status.providers[1].spokenLine, contains('Blocked. Connection not verified. Reason: billing unverifiable.'));
    expect(CheAiModelStatus.fromJson(null), isNull);
    expect(CheAiModelStatus.fromJson('nope'), isNull);
  });

  test('without a readable runner record it says so instead of inventing status', () {
    final status = CheAiModelStatus.fromJson({'authorized_spend_usd': 0, 'ledger_source': 'unavailable', 'providers': []})!;
    expect(status.summary, contains('No provider is verified free for coding yet.'));
    expect(status.summary, contains('No runner record could be read yet.'));
    expect(status.readAloudText, startsWith(r'Authorized AI spend $0.'));
  });

  testWidgets('the card stays silent until Read aloud, labels every control, and lists providers', (tester) async {
    final spoken = <String>[];
    final status = CheAiModelStatus.fromJson(_payload())!;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheAiModelStatusCard(status: status, onReadAloud: spoken.add))));
    expect(spoken, isEmpty, reason: 'nothing is spoken when the card appears');
    expect(find.bySemanticsLabel('Read the AI model status aloud'), findsOneWidget);
    expect(find.bySemanticsLabel('Show every AI provider with its cost status'), findsOneWidget);
    await tester.tap(find.text('Read aloud'));
    await tester.pump();
    expect(spoken, ['Authorized AI spend is zero dollars, and paid fallback is off.']);
    await tester.tap(find.text('Providers'));
    await tester.pumpAndSettle();
    expect(find.text('Groq'), findsOneWidget);
    expect(find.textContaining('Billed: not verifiable'), findsWidgets);
    expect(find.textContaining('Allowance left: Not exposed by the provider.'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^OpenRouter: Free\. Connection verified\.')), findsOneWidget);
    await tester.tap(find.text('Groq'));
    await tester.pump();
    expect(spoken.last, startsWith('Groq: Blocked.'));
  });

  testWidgets('paused free providers are excluded from visible availability and success indicators', (tester) async {
    final payload = _payload();
    final provider = (payload['providers'] as List).first as Map;
    provider['circuit'] = 'open';
    provider['last_error_class'] = 'billing_risk';
    final status = CheAiModelStatus.fromJson(payload)!;
    expect(status.freeForCoding, isEmpty);
    expect(status.summary, contains('No provider is verified free for coding yet.'));
    expect(status.summary, isNot(contains('Verified free for coding: OpenRouter')));
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: CheAiModelStatusCard(status: status))));
    expect(find.bySemanticsLabel('No free model verified'), findsOneWidget);
    expect(find.bySemanticsLabel('Free model available'), findsNothing);
  });
}
