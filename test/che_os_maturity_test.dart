import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_request_session.dart';
import 'package:chey/che_owner_errors.dart';
import 'package:chey/che_bootstrap.dart';
import 'package:chey/che_capability_registry.dart';
import 'package:chey/che_local_brain.dart';

void main() {
  test('one request produces one accepted answer', () {
    final gate = CheRequestGate();
    final first = gate.begin();
    final second = gate.begin();
    expect(first.cancelled, isTrue);
    expect(gate.acceptLate(first.requestId), isFalse);
    gate.complete(second.requestId, 'hello');
    expect(second.visibleText, 'hello');
    expect(gate.acceptLate(second.requestId), isTrue);
  });

  test('rapid requests never accept an obsolete answer', () {
    final gate = CheRequestGate();
    final requests = List.generate(1000, (_) => gate.begin());
    expect(requests.map((r) => r.requestId).toSet(), hasLength(1000));
    for (final previous in requests.take(999)) {
      expect(gate.acceptLate(previous.requestId), isFalse);
      gate.complete(previous.requestId, 'obsolete');
    }
    expect(gate.current.visibleText, isEmpty);
    gate.complete(requests.last.requestId, 'current');
    expect(gate.current.visibleText, 'current');
  });

  test('owner chat never shows raw engine dumps', () {
    final error = CheOwnerError.fromRaw(
      'All AI engines failed (Groq 404 llama-3.3-70b-versatile | Pollinations ENOSPC no space left)',
    );
    expect(error.message.toLowerCase(), isNot(contains('all ai engines failed')));
    expect(error.message.toLowerCase(), isNot(contains('enospc')));
    expect(error.message.toLowerCase(), isNot(contains('engine')));
    expect(error.category, 'temporary_cloud_unavailable');
  });

  test('owner chat suppresses provider failover narration', () {
    expect(CheOwnerError.sanitizeReply("One moment, sir. I'm switching to a backup engine."), isEmpty);
    expect(CheOwnerError.sanitizeReply("I'm switching to another provider."), isEmpty);
    expect(CheOwnerError.sanitizeReply('Use a backup model for this design.'), 'Use a backup model for this design.');
  });

  test('a final failure keeps the Worker owner-safe detail instead of "still working"', () {
    final error = CheOwnerError.fromRaw(
      'CHE Agent error 503: {"detail":"I can\'t do that one right now, sir. Nothing was done, and I won\'t keep you waiting on it.","category":"authentication_required"}',
      status: 503,
    );
    expect(error.message, contains('Nothing was done'));
    expect(error.message.toLowerCase(), isNot(contains('still working')));
    final raw = CheOwnerError.fromRaw('CHE Agent error 503: {"detail":"All AI engines failed: groq 429"}', status: 503);
    expect(raw.message.toLowerCase(), isNot(contains('engine')));
  });

  test('capability registry distinguishes connected tools', () {
    final registry = CheCapabilityRegistry.fromRuntime(
      network: false,
      localBrain: true,
      stripeConfigured: false,
      smsConfigured: false,
      voiceHealthy: true,
    );
    expect(registry.canDoNow('chat'), isTrue);
    expect(registry.canDoNow('local_inference'), isTrue);
    expect(registry.byId('research')?.readiness, 'temporarily_unavailable');
    expect(registry.byId('stripe')?.readiness, 'not_connected');
  });

  test('bootstrap packet keeps CHE identity when the engine changes', () {
    final packet = CheBootstrapPacket(
      request: 'CHE, tell me what you can do.',
      capabilities: const ['chat', 'office', 'local_inference'],
      cloudHealth: 'degraded',
      localBrainHealth: 'ready',
      currentProvider: 'groq',
      currentModel: 'openai/gpt-oss-20b',
      projectSummary: 'Stabilize CHE production chat',
      agents: const ['Nova'],
      memory: const ['CHE is pronounced Chay'],
    );
    final groq = packet.compactPrompt();
    final local = CheBootstrapPacket(
      request: packet.request,
      capabilities: packet.capabilities,
      cloudHealth: 'down',
      localBrainHealth: 'active',
      currentProvider: 'local_brain',
      currentModel: cheDefaultLocalBrainModel.modelId,
      projectSummary: packet.projectSummary,
      agents: packet.agents,
      memory: packet.memory,
    ).compactPrompt(small: true);
    expect(groq, contains('Office Boss'));
    expect(local, contains('Office Boss'));
    expect(local, contains('Chay'));
    expect(local, contains('Stabilize CHE production chat'));
  });

  test('local brain metadata is pinned and licensed', () {
    expect(cheDefaultLocalBrainModel.license, 'Apache-2.0');
    expect(cheDefaultLocalBrainModel.quantization, 'Q4_K_M');
    expect(cheDefaultLocalBrainModel.runtime, 'llama.cpp-gguf');
    expect(cheDefaultLocalBrainModel.bytes, greaterThan(800 * 1024 * 1024));
    expect(
      localBrainStatusSpeech(
        const CheLocalBrainHealth(
          installed: true,
          loaded: true,
          available: true,
          status: 'ready',
        ),
      ),
      contains('running locally'),
    );
  });
}
