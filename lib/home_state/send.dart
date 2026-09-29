part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (send).
extension _CheHomeSend on _CHEHomeState {
  Future<bool> _openExternalAppByVoice(String message) async {
    var requested = message.trim().toLowerCase();

    const wakePrefixes = ['chay ', 'chey ', 'shay ', 'chai ', 'chee ', 'chi ', 'che '];
    for (final prefix in wakePrefixes) {
      if (requested.startsWith(prefix)) {
        requested = requested.substring(prefix.length).trim();
        break;
      }
    }

    String? appName;
    const actionPrefixes = ['open ', 'launch ', 'go to ', 'watch ', 'use ', 'show me '];
    for (final prefix in actionPrefixes) {
      if (requested.startsWith(prefix)) {
        appName = requested.substring(prefix.length).trim();
        break;
      }
    }
    if (appName == null || appName.isEmpty) return false;
    // "Use Grok and GPT together…" is an AI-layer command, not an app switch:
    // only short remainders name an app.
    if (appName.replaceAll(RegExp(r'[.!?]+$'), '').split(RegExp(r'\s+')).length > 3) return false;

    final embeddedApp = cheAppForName(appName);
    if (embeddedApp != null && mounted) {
      controller.clear();
      _set(() {
        messages.add({
          'role': 'assistant',
          'text': 'Opening ${embeddedApp.name} inside CHE, sir.',
        });
      });
      await Navigator.of(context).push(
        CupertinoPageRoute<void>(
          builder: (_) => CheEmbeddedAppScreen(app: embeddedApp),
        ),
      );
      return true;
    }

    // Apps with no web version: say so honestly. iWebTV goes to the Theater,
    // which asks the owner before opening the app itself.
    final noWeb = cheNoWebVersionReason(appName);
    if (noWeb != null && mounted) {
      controller.clear();
      _set(() => messages.add({'role': 'assistant', 'text': noWeb}));
      await speakText(noWeb);
      if (appName.contains('iweb')) _openAssistantHub(tab: 9);
      return true;
    }

    final targets = <String, List<Uri>>{
      'settings': [Uri.parse('app-settings:')],
      'iphone settings': [Uri.parse('app-settings:')],
      'maps': [Uri.parse('maps://')],
      'apple maps': [Uri.parse('maps://')],
      'messages': [Uri.parse('sms:')],
      'text messages': [Uri.parse('sms:')],
      'phone': [Uri.parse('tel:')],
      'mail': [Uri.parse('mailto:')],
      'email': [Uri.parse('mailto:')],
      'music': [Uri.parse('music://')],
      'apple music': [Uri.parse('music://')],
      'safari': [Uri.parse('https://www.google.com')],
      'youtube': [
        Uri.parse('youtube://'),
        Uri.parse('https://www.youtube.com'),
      ],
      'github': [
        Uri.parse('github://'),
        Uri.parse('https://github.com'),
      ],
      'tradingview': [
        Uri.parse('tradingview://'),
        Uri.parse('https://www.tradingview.com'),
      ],
      'ninjatrader': [
        Uri.parse('https://ninjatrader.com'),
      ],
    };

    List<Uri>? candidates;
    String? matchedName;

    for (final entry in targets.entries) {
      if (appName == entry.key || appName.contains(entry.key)) {
        candidates = entry.value;
        matchedName = entry.key;
        break;
      }
    }

    if (candidates == null) return false;

    for (final uri in candidates) {
      try {
        final opened = await launchUrl(
          uri,
          mode: LaunchMode.externalApplication,
        );
        if (opened) {
          controller.clear();
          if (mounted) {
            _set(() {
              messages.add({
                'role': 'assistant',
                'text': 'Opening ${matchedName ?? appName!}, sir.',
              });
            });
          }
          return true;
        }
      } catch (_) {}
    }

    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'I could not open ${matchedName ?? appName} on this iPhone.',
          ),
        ),
      );
    }
    return true;
  }

  Future<bool> _handleLocalNavigation(String message) async {
    final lower = message.toLowerCase();

    if (RegExp(r'\b(open|show|go to)\s+(my\s+)?memories?\b').hasMatch(lower)) {
      _openAssistantHub(tab: 0);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(insights?|suggestions?|learned knowledge)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 1);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(markets?|trading|stocks?|futures?|crypto)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 2);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(business|cash flow|customers?|leads?|billing)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 3);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(devices?|connections?|screen|identity)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 4);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(music|playlists?)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 5);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(create|innovation|creator)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 6);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(office|team|coworkers?|partners?|workplace)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 7);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(apps?|app portal|web apps?|services?)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 8);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(the\s+)?(theater|theatre|cinema|movie room)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 9);
      return true;
    }
    if (RegExp(r'\b(set ?up|fix|open|configure)\s+(the\s+|my\s+)?wake ?word\b').hasMatch(lower)) {
      await speakText(cheWakeSetupSteps);
      await _openWakeSetup();
      return true;
    }

    return false;
  }

  List<Map<String, String>> _recentHistoryExcluding(String currentMessage) {
    final source = List<Map<String, String>>.from(messages);
    if (source.isNotEmpty &&
        source.last['role'] == 'user' &&
        (source.last['text'] ?? '').trim() == currentMessage.trim()) {
      source.removeLast();
    }
    final recent = source.length > 14
        ? source.sublist(source.length - 14)
        : source;
    return recent
        .map(
          (item) => {
            'role': item['role'] == 'assistant' ? 'assistant' : 'user',
            'content': item['text'] ?? '',
          },
        )
        .toList();
  }

  Future<void> _runVaultCommand(CheVaultCommand command) async {
    final vault = CheVault.instance;
    var shown = '';
    var spoken = '';
    switch (command.kind) {
      case 'save':
        await vault.save(CheVaultEntry(site: command.site, password: command.password, username: command.username));
        spoken = 'Saved your ${command.site} password in CHE\'s vault on this iPhone, sir.';
        shown = spoken;
      case 'read':
        final entry = await vault.find(command.site);
        if (entry == null) {
          spoken = 'I don\'t have a ${command.site} password saved, sir.';
          shown = spoken;
        } else {
          shown = '${entry.site}\n${entry.username.isEmpty ? '' : 'Username: ${entry.username}\n'}Password: ${entry.password}';
          spoken = 'Your ${entry.site} password is ${entry.password.split('').join(' ')}';
        }
      case 'import':
        final picked = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['csv'], withData: true);
        final bytes = picked?.files.single.bytes;
        if (bytes == null) {
          spoken = 'No file picked, sir. Export your passwords from Apple’s Passwords app as a CSV, then say “import my passwords”.';
        } else {
          final count = await vault.importCsv(utf8.decode(bytes, allowMalformed: true));
          spoken = count == 0
              ? 'That file didn’t have any logins I could read, sir.'
              : 'Imported $count logins into CHE’s vault on this iPhone, sir. Please delete the exported CSV file now, since it isn’t encrypted.';
        }
        shown = spoken;
      case 'delete':
        // Deleting always needs the owner's yes (owner rule).
        final sure = await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: Text('Delete your ${command.site} password?'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('No, keep it')),
              FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Yes, delete')),
            ],
          ),
        );
        if (sure != true) {
          spoken = 'Kept your ${command.site} password, sir.';
          shown = spoken;
          break;
        }
        spoken = await vault.delete(command.site)
            ? 'Deleted your ${command.site} password, sir.'
            : 'There was no ${command.site} password saved, sir.';
        shown = spoken;
      case 'list':
        final sites = await vault.sites();
        spoken = sites.isEmpty
            ? 'No passwords are saved in CHE\'s vault yet, sir.'
            : 'I have passwords for: ${[for (var i = 0; i < sites.length; i++) '${i + 1}. ${sites[i]}'].join(', ')}.';
        shown = spoken;
    }
    if (!mounted) return;
    HapticFeedback.mediumImpact();
    // Shown in a private sheet with large text, never added to the chat.
    unawaited(showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => Semantics(
        liveRegion: true,
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: SelectableText(shown, style: const TextStyle(fontSize: 24, height: 1.4)),
        ),
      ),
    ));
    // On-device voice only, so a password is never sent to a cloud voice.
    try {
      await flutterTts.speak(spoken);
    } catch (_) {}
  }

  String? _credentialAccessReply(String message) {
    final text = message.trim().toLowerCase();
    final direct = RegExp(
      r'^(?:my\s+)?(?:passwords?|passcodes?|login\s+credentials?|security\s+codes?)\??$',
    ).hasMatch(text);
    final explicit = RegExp(
      r'^(?:show|open|find|read|tell\s+me|give\s+me|what(?:\s+is|\s+are)?|where(?:\s+is|\s+are)?)\s+(?:my\s+)?(?:passwords?|passcodes?|login\s+credentials?|security\s+codes?)\b',
    ).hasMatch(text);
    if (!direct && !explicit) return null;
    return 'Your passwords live only in CHE’s vault on this iPhone, sir. '
        'Say “what passwords do you have” or “what’s my Gmail password”.';
  }

  String _sanitizeCheReply(String value) {
    // ```che-remember blocks stay: the chat shows them as "Saved to brain".
    final reply = value.trim();
    if (reply.isEmpty) return reply;
    final lower = reply.toLowerCase();
    final genericWakePrompt = lower.contains('[assistant name]') ||
        (lower.contains('start the conversation') &&
            (lower.contains('say "hey') ||
                lower.contains("say 'hey") ||
                lower.contains('say “hey')));
    if (genericWakePrompt) {
      return 'I’m awake, sir. What do you need?';
    }
    return reply;
  }

  Future<void> sendMessage({bool fromVoice = false}) async {
    if (await _controlAutonomy(controller.text.trim())) return;
    if (_isSending) return;
    if (_isSpeaking) await _interruptSpeechAndListen(resumeListening: false);

    final typedMessage = controller.text.trim();
    final message = typedMessage.isEmpty && _pendingAttachment != null
        ? 'Analyze this attachment.'
        : typedMessage;
    if (message.isEmpty) return;

    // Password vault: handled entirely on the phone. The words never go to
    // the CHE server, an AI provider, chat history or memory.
    final vaultCommand = CheVaultCommand.parse(message);
    if (vaultCommand != null) {
      if (mounted) _set(() => controller.clear());
      await _runVaultCommand(vaultCommand);
      return;
    }

    // Voice navigation inside the CHE browser/app that is open right now.
    final browserVoice = CheBrowserActions.voice;
    if (browserVoice != null && _pendingAttachment == null) {
      final reply = await browserVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        await speakText(reply);
        return;
      }
    }

    if (await _openExternalAppByVoice(message)) {
      return;
    }

    if (await _handleLocalNavigation(message)) {
      controller.clear();
      return;
    }

    final credentialReply = _credentialAccessReply(message);
    if (credentialReply != null) {
      if (!mounted) return;
      _set(() {
        messages.add({'role': 'user', 'text': message});
        messages.add({'role': 'assistant', 'text': credentialReply});
        controller.clear();
      });
      _scrollToBottom();
      await speakText(credentialReply);
      return;
    }

    if (await _handleConnectedCommand(message)) {
      controller.clear();
      return;
    }

    if (!await _ensurePaired()) return;

    if (_realtimeVoice?.connected == true) {
      if (!mounted) return;
      _set(() {
        messages.add({'role': 'user', 'text': message});
        controller.clear();
      });
      _scrollToBottom();
      await _realtimeVoice!.sendText(message);
      return;
    }

    if (speech.isListening) {
      await speech.stop();
    }

    if (!mounted) return;

    _isSending = true;

    _set(() {
      isListening = false;
      messages.add({
        'role': 'user',
        'text': message,
      });
      controller.clear();
      _liveSteps.clear();
      _replyStartedAt = DateTime.now();
      _lastUserMessage = message;
      _stopRequested = false;
    });

    _scrollToBottom();

    if (message.toLowerCase().startsWith('remember that ')) {
      final memory = message.substring(14).trim();
      await saveMemory(memory);

      const reply = 'Got it. I saved that securely, sir.';

      if (!mounted) return;

      _set(() {
        messages.add({
          'role': 'assistant',
          'text': reply,
        });
        _isSending = false;
      });

      _scrollToBottom();
      await speakText(reply);
      return;
    }

    int? assistantIndex;

    try {
      final history = _recentHistoryExcluding(message);

      assistantIndex = messages.length;

      _set(() {
        messages.add({
          'role': 'assistant',
          'text': '',
        });
      });

      _scrollToBottom();

      final uiBatcher = CheStreamBatcher((partialReply) {
        final index = assistantIndex;
        if (!mounted || index == null || index >= messages.length) return;
        _set(() => messages[index]['text'] = _sanitizeCheReply(partialReply));
        _scrollToBottom();
      });
      late final String reply;
      try {
        reply = await _streamCheResponse(
          message,
          history,
          onPartial: uiBatcher.add,
        );
        uiBatcher.flush();
      } finally {
        uiBatcher.dispose();
      }

      final stopped = _stopRequested;
      _stopRequested = false;
      final finalReply = reply.isEmpty
          ? (stopped ? 'Stopped.' : 'I could not generate a response, sir.')
          : _sanitizeCheReply(reply);

      if (!mounted) return;

      _set(() {
        if (assistantIndex != null && assistantIndex < messages.length) {
          messages[assistantIndex]['text'] = finalReply;
          if (_liveSteps.isNotEmpty) {
            messages[assistantIndex]['steps'] = _liveSteps.map((step) => step.text).join('\n');
          }
          if (_replyStartedAt != null) {
            messages[assistantIndex]['thought_ms'] =
                '${DateTime.now().difference(_replyStartedAt!).inMilliseconds}';
          }
          if (_streamMediaUrl != null) {
            messages[assistantIndex]['media_url'] = _streamMediaUrl!;
            messages[assistantIndex]['media_type'] = _streamMediaType ?? 'image';
          }
        }
        _isSending = false;
      });

      _scrollToBottom();

      _brainLog.logTurn(message, reply.isEmpty ? finalReply : reply,
          source: fromVoice ? 'voice' : 'chat');

      _justCompleted = true;
      Future<void>.delayed(const Duration(milliseconds: 1400), () {
        if (mounted) _set(() => _justCompleted = false);
      });

      if (!stopped) await speakText(_spokenText(finalReply));
    } on _CHEAgentException catch (e) {
      final errorReply = e.message;

      if (!mounted) return;

      _set(() {
        if (assistantIndex != null && assistantIndex < messages.length) {
          messages[assistantIndex]['text'] = errorReply;
        } else {
          messages.add({
            'role': 'assistant',
            'text': errorReply,
          });
        }
        _isSending = false;
      });

      _scrollToBottom();
      await speakText(errorReply);
    } catch (_) {
      const errorReply =
          'I could not connect to my secure Agent gateway, sir.';

      if (!mounted) return;

      _set(() {
        if (assistantIndex != null && assistantIndex < messages.length) {
          messages[assistantIndex]['text'] = errorReply;
        } else {
          messages.add({
            'role': 'assistant',
            'text': errorReply,
          });
        }
        _isSending = false;
      });

      _scrollToBottom();
      await speakText(errorReply);
    } finally {
      _isSending = false;
    }
  }

  Future<void> _showMessageActions(int index) async {
    if (index < 0 || index >= messages.length) return;
    final item = messages[index];
    final isUser = item['role'] == 'user';
    final text = item['text'] ?? '';
    HapticFeedback.selectionClick();
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: CheColors.panel,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.copy_rounded),
              title: const Text('Copy'),
              onTap: () async {
                await Clipboard.setData(ClipboardData(text: text));
                if (sheetContext.mounted) Navigator.pop(sheetContext);
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy_all_rounded),
              title: const Text('Copy whole conversation'),
              onTap: () async {
                final all = messages
                    .map((m) => '${m['role'] == 'user' ? 'You' : 'CHE'}: ${m['text'] ?? ''}')
                    .join('\n\n');
                await Clipboard.setData(ClipboardData(text: all));
                if (sheetContext.mounted) Navigator.pop(sheetContext);
              },
            ),
            if (!isUser && !_isSending)
              ListTile(
                leading: const Icon(Icons.refresh_rounded),
                title: const Text('Retry'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  String? prompt;
                  for (var i = index - 1; i >= 0; i--) {
                    if (messages[i]['role'] == 'user') {
                      prompt = messages[i]['text'];
                      break;
                    }
                  }
                  prompt ??= _lastUserMessage;
                  if (prompt == null || prompt.trim().isEmpty) return;
                  controller.text = prompt;
                  unawaited(sendMessage());
                },
              ),
            if (isUser && !_isSending)
              ListTile(
                leading: const Icon(Icons.edit_rounded),
                title: const Text('Edit and resend'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  controller.text = text;
                },
              ),
          ],
        ),
      ),
    );
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.jumpTo(
        _scrollController.position.maxScrollExtent,
      );
    });
  }
}

