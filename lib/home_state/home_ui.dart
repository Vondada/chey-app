part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (home ui).
extension _CheHomeUi on _CHEHomeState {
  Widget _homeMessage(int index, List<CheAgent> agents) {
    final item = messages[index];
    final text = item['text'] ?? '';
    if (item['role'] == 'user') {
      return CheHomeUserBubble(text: text, onLongPress: () => _showMessageActions(index));
    }
    final isLiveReply = _isSending && index == messages.length - 1 && _replyStartedAt != null;
    final display = CheUpdateProposal.stripBlocks(
      text.replaceAll(RegExp(r'```che-plugin[\s\S]*?(```|$)'), '').trim(),
    );
    final extras = <Widget>[
      if (!isLiveReply)
        for (final proposal in CheUpdateProposal.findInText(text))
          CheUpdateCard(
            proposal: proposal,
            tracker: _updates,
            baseUrl: () => cheAgentBaseUrl,
            headers: () => _authHeaders,
          ),
      if (!isLiveReply)
        for (final plugin in ChePluginRegistry.findInText(text))
          ChePluginOfferCard(registry: _skillPlugins, plugin: plugin),
      if (item['media_type'] == 'image' && (item['media_url'] ?? '').startsWith('https://'))
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: Image.network(
              item['media_url']!,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => const Padding(
                padding: EdgeInsets.all(12),
                child: Text('Generated image could not be displayed.'),
              ),
            ),
          ),
        ),
      if (item['media_type'] == 'video' && (item['media_url'] ?? '').startsWith('https://'))
        TextButton.icon(
          onPressed: () => launchUrl(Uri.parse(item['media_url']!), mode: LaunchMode.externalApplication),
          icon: const Icon(Icons.play_circle_outline),
          label: const Text('Open generated video'),
        ),
    ];
    return CheHomeAssistantMessage(
      text: display,
      streaming: isLiveReply,
      liveStart: isLiveReply ? _replyStartedAt : null,
      liveSteps: isLiveReply ? List.of(_liveSteps) : const [],
      finishedSteps: (item['steps'] ?? '').split('\n').where((l) => l.trim().isNotEmpty).toList(),
      thoughtMs: int.tryParse(item['thought_ms'] ?? ''),
      agents: agents,
      extras: extras,
      onTapAgent: (_) => _openOfficeFloor(),
      onRedo: _isSending ? null : () => _redoFrom(index),
      onLongPress: () => _showMessageActions(index),
    );
  }
}
