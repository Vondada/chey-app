part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (home ui).
extension _CheHomeUi on _CHEHomeState {
  Widget _homeMessage(int index, List<CheAgent> agents) {
    final item = messages[index];
    final text = item['text'] ?? '';
    if (item['role'] == 'user') {
      final bubble = CheHomeUserBubble(
        text: text,
        animate: index >= messages.length - 2,
        onLongPress: () => _showMessageActions(index),
      );
      final attachmentName = item['attachment_name'];
      final attachmentType = item['attachment_type'] ?? '';
      if (attachmentName == null || attachmentName.isEmpty) return bubble;

      Widget attachmentPreview;
      final encoded = item['attachment_base64'] ?? '';
      if (attachmentType == 'image' && encoded.isNotEmpty) {
        try {
          final bytes = base64Decode(encoded);
          attachmentPreview = Semantics(
            image: true,
            label: 'Photo you sent: $attachmentName',
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Image.memory(
                bytes,
                width: MediaQuery.sizeOf(context).width * 0.72,
                fit: BoxFit.cover,
                cacheWidth: 1200,
                errorBuilder: (_, _, _) => const SizedBox.shrink(),
              ),
            ),
          );
        } catch (_) {
          attachmentPreview = const SizedBox.shrink();
        }
      } else {
        final icon = attachmentType == 'video'
            ? Icons.videocam_rounded
            : attachmentType == 'audio'
                ? Icons.graphic_eq_rounded
                : Icons.attach_file_rounded;
        attachmentPreview = Semantics(
          label: '$attachmentType attachment you sent: $attachmentName',
          child: Container(
            constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: CheColors.panel,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: CheColors.accent.withValues(alpha: 0.35)),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, color: CheColors.accent),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  attachmentType == 'video'
                      ? '$attachmentName • CHE watches + listens'
                      : attachmentType == 'audio'
                          ? '$attachmentName • CHE listens'
                          : attachmentName,
                  overflow: TextOverflow.ellipsis,
                  style: kit.CheType.caption,
                ),
              ),
            ]),
          ),
        );
      }

      return Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Align(alignment: Alignment.centerRight, child: attachmentPreview),
          const SizedBox(height: 6),
          bubble,
        ],
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
      // Places CHE told the owner to go ("go to Supabase") become "Open
      // Supabase" actions that open inside CHE.
      if (!isLiveReply) CheChatLinkActions(links: _chatLinksIn(display, item['media_url'], text)),
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
    final seen = <String>{?skip};
    final out = <String>[];
    for (final m in _linkPattern.allMatches(text)) {
      final url = m.group(0)!.replaceAll(RegExp(r'[.,;:!?]+$'), '');
      if (seen.add(url)) out.add(url);
    }
    return out;
  }

  /// Destinations in a reply that get an "Open …" action. Links already
  /// shown as an image or an inline preview are left out.
  List<CheChatLink> _chatLinksIn(String display, String? mediaUrl, String raw) => cheChatLinks(
        display,
        skip: [mediaUrl, ..._inlineImageUrls(raw, mediaUrl), ..._inlinePageUrls(raw, mediaUrl)],
        ownBase: cheAgentBaseUrl,
      );

  /// The links in CHE's latest reply that has any, for "open it" by voice.
  List<CheChatLink> _recentChatLinks() {
    var checked = 0;
    for (var i = messages.length - 1; i >= 0 && checked < 6; i--) {
      final m = messages[i];
      if (m['role'] == 'user') continue;
      checked++;
      final raw = m['text'] ?? '';
      final display = CheUpdateProposal.stripBlocks(raw.replaceAll(RegExp(r'```che-plugin[\s\S]*?(```|$)'), '').trim());
      // Every link counts here, including ones shown as an inline preview
      // (which get no extra button), so "open it" can reach them too.
      final links = cheChatLinks('$display ${m['media_url'] ?? ''}', ownBase: cheAgentBaseUrl);
      if (links.isNotEmpty) return links;
    }
    return const [];
  }

  /// "Open Supabase", "open link 2", "open it in Safari", "what's the link",
  /// "copy the link": acts on the links CHE just gave and reports the result.
  Future<void> _runChatLinkCommand(String message, CheLinkVoiceCommand command) async {
    final link = command.link;
    final opens = command.action == CheLinkVoiceAction.open || command.action == CheLinkVoiceAction.openExternally;
    final external = command.action == CheLinkVoiceAction.openExternally;
    final reply = switch (command.action) {
      CheLinkVoiceAction.chooseFromList => CheLinkVoiceCommand.listAloud(command.links),
      CheLinkVoiceAction.readAddress => '${link.label}: ${link.url}',
      CheLinkVoiceAction.copyAddress => 'Copied the link for ${link.name}, sir.',
      _ => external || link.opensExternally || kIsWeb ? 'Opening ${link.name} in Safari, sir.' : 'Opening ${link.name} inside CHE, sir.',
    };
    if (command.action == CheLinkVoiceAction.copyAddress) {
      await Clipboard.setData(ClipboardData(text: link.url));
      HapticFeedback.lightImpact();
    }
    if (!mounted) return;
    _set(() => messages
      ..add({'role': 'user', 'text': message})
      ..add({'role': 'assistant', 'text': reply}));
    _scrollToBottom();
    if (opens) {
      // The opener announces what opens and any failure; the browser says
      // "Opening … inside CHE."
      await cheOpenChatLink(context, link, external: external);
      return;
    }
    await speakText(reply, record: false);
  }

  List<String> _inlineImageUrls(String text, String? skip) =>
      _inlineLinks(text, skip).where(_imagePattern.hasMatch).take(4).toList();

  List<String> _inlinePageUrls(String text, String? skip) => _inlineLinks(text, skip)
      .where((u) => !_imagePattern.hasMatch(u) && _pagePattern.hasMatch(u))
      .take(2)
      .toList();
}

