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

  test('owner chat never shows raw engine dumps', () {
    final error = CheOwnerError.fromRaw(
      'All AI engines failed (Groq 404 llama-3.3-70b-versatile | Pollinations ENOSPC no space left)',
    );
    expect(error.message.toLowerCase(), isNot(contains('all ai engines failed')));
    expect(error.message.toLowerCase(), isNot(contains('enospc')));
    expect(error.message.toLowerCase(), isNot(contains('engine')));
    expect(error.category, 'temporary_cloud_unavailable');
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
