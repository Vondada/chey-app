part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (home ui).
extension _CheHomeUi on _CHEHomeState {
  Widget _homeMessage(int index, List<CheAgent> agents) {
    final item = messages[index];
    final text = item['text'] ?? '';
    if (item['role'] == 'user') {
      return CheHomeUserBubble(
        text: text,
        animate: index >= messages.length - 2,
        onLongPress: () => _showMessageActions(index),
      );
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
              // Images CHE made on her own server need the paired-device token.
              headers: item['media_url']!.startsWith(cheAgentBaseUrl) ? _authHeaders : null,
              fit: BoxFit.cover,
              // Decode at screen size, not full resolution, so images don't
              // stall scrolling.
              cacheWidth: (MediaQuery.sizeOf(context).width * MediaQuery.devicePixelRatioOf(context)).round(),
              errorBuilder: (_, _, _) => const Padding(
                padding: EdgeInsets.all(12),
                child: Text('Generated image could not be displayed.'),
              ),
            ),
          ),
        ),
      if ((item['media_type'] == 'video' || item['media_type'] == 'html' || item['media_type'] == 'page') &&
          (item['media_url'] ?? '').startsWith('https://'))
        CheInlinePreview(
          url: item['media_url']!,
          headers: item['media_url']!.startsWith(cheAgentBaseUrl) ? _authHeaders : const {},
          label: item['media_type'] == 'video' ? 'Video' : 'Page',
        ),
      // Anything the crew rendered and linked in the reply shows right here.
      if (!isLiveReply)
        for (final url in _inlineImageUrls(text, item['media_url']))
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: Image.network(
                url,
                headers: url.startsWith(cheAgentBaseUrl) ? _authHeaders : null,
                fit: BoxFit.cover,
                cacheWidth: (MediaQuery.sizeOf(context).width * MediaQuery.devicePixelRatioOf(context)).round(),
                errorBuilder: (_, _, _) => const SizedBox.shrink(),
              ),
            ),
          ),
      if (!isLiveReply)
        for (final url in _inlinePageUrls(text, item['media_url']))
          CheInlinePreview(
            url: url,
            headers: url.startsWith(cheAgentBaseUrl) ? _authHeaders : const {},
            label: url.contains('youtu') ? 'Video' : 'Page',
          ),
    ];
    return MediaQuery(
      data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(MediaQuery.textScalerOf(context).scale(1).clamp(1.15, double.infinity).toDouble())),
      child: CheHomeAssistantMessage(
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
      onReadAloud: display.trim().isEmpty ? null : () => speakText(display),
      onLongPress: () => _showMessageActions(index),
      ),
    );
  }

  static final RegExp _linkPattern = RegExp('https://[^\\s)\\]>"\'`]+', caseSensitive: false);
  static final RegExp _imagePattern = RegExp(r'\.(?:png|jpe?g|gif|webp)(?:\?|$)', caseSensitive: false);
  static final RegExp _pagePattern = RegExp(
    r'(?:youtube\.com/(?:watch|shorts)|youtu\.be/|\.pages\.dev|\.workers\.dev|/preview\b|\.html(?:\?|$)|claude\.ai/(?:public/)?artifact)',
    caseSensitive: false,
  );

  List<String> _inlineLinks(String text, String? skip) {
    final seen = <String>{if (skip != null) skip};
    final out = <String>[];
    for (final m in _linkPattern.allMatches(text)) {
      final url = m.group(0)!.replaceAll(RegExp(r'[.,;:!?]+$'), '');
      if (seen.add(url)) out.add(url);
    }
    return out;
  }

  List<String> _inlineImageUrls(String text, String? skip) =>
      _inlineLinks(text, skip).where(_imagePattern.hasMatch).take(4).toList();

  List<String> _inlinePageUrls(String text, String? skip) => _inlineLinks(text, skip)
      .where((u) => !_imagePattern.hasMatch(u) && _pagePattern.hasMatch(u))
      .take(2)
      .toList();
}

