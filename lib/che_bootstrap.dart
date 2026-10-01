class CheBootstrapPacket {
  const CheBootstrapPacket({
    required this.request,
    required this.capabilities,
    required this.cloudHealth,
    required this.localBrainHealth,
    required this.currentProvider,
    required this.currentModel,
    this.projectSummary = '',
    this.memory = const [],
    this.agents = const [],
  });

  final String request;
  final List<String> capabilities;
  final String cloudHealth;
  final String localBrainHealth;
  final String currentProvider;
  final String currentModel;
  final String projectSummary;
  final List<String> memory;
  final List<String> agents;

  String compactPrompt({bool small = false}) {
    final buf = StringBuffer()
      ..writeln('You are CHE (Cognitive Horizon Engine), pronounced Chay.')
      ..writeln('You are the owner\'s primary assistant and Office Boss.')
      ..writeln('Office agents report to you: Nova, Atlas, Mira, Knox, Sage, Lyra, Iris.')
      ..writeln('Act with authorized tools. Do not claim work that did not happen.')
      ..writeln('Capabilities: ${capabilities.join(', ')}.')
      ..writeln('Runtime: cloud=$cloudHealth local=$localBrainHealth provider=$currentProvider model=$currentModel.');
    if (projectSummary.isNotEmpty) buf.writeln('Active project: $projectSummary');
    if (agents.isNotEmpty) buf.writeln('Active agents: ${agents.join(', ')}');
    if (memory.isNotEmpty) {
      buf.writeln('Relevant memory:');
      for (final line in memory.take(small ? 4 : 8)) {
        buf.writeln('- $line');
      }
    }
    if (request.isNotEmpty) buf.writeln('Owner request: $request');
    return buf.toString();
  }
}
