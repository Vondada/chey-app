import 'package:flutter_test/flutter_test.dart';
import 'package:chey/agents/che_agent_runtime.dart';

void main() {
  test('agent profile carries unique appearance, strengths, limitations and capabilities', () {
    final profile = CheAgentProfile.fromJson({
      'id': 'nova',
      'name': 'Nova',
      'role': 'Product / listings',
      'specialty': 'Product offers',
      'personality': 'Curious and fast.',
      'status': 'idle',
      'appearance': {
        'body_type': 'standard',
        'hair': 'waves',
        'outfit': 'jacket-teal',
      },
      'strengths': ['Product framing'],
      'limitations': ['Not the primary finance reviewer'],
      'capability_requirements': ['text'],
      'responsibilities': ['Draft listings'],
    });

    expect(profile.agent.appearance['hair'], 'waves');
    expect(profile.agent.appearance['outfit'], 'jacket-teal');
    expect(profile.strengths, ['Product framing']);
    expect(profile.limitations, ['Not the primary finance reviewer']);
    expect(profile.capabilityRequirements, ['text']);
  });

  test('agent skill preserves provenance for the profile card', () {
    final skill = CheAgentSkill.fromJson({
      'id': 's1',
      'name': 'Listing review',
      'trigger': 'review listing',
      'capabilities': ['text'],
      'uses': 4,
      'source': {
        'repo': 'owner/reference',
        'path': 'product/listing.md',
        'license': 'MIT',
      },
    });

    expect(skill.name, 'Listing review');
    expect(skill.sourceRepo, 'owner/reference');
    expect(skill.sourcePath, 'product/listing.md');
    expect(skill.sourceLicense, 'MIT');
    expect(skill.uses, 4);
  });
}
