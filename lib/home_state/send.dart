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
      final isGrok = embeddedApp.name == 'Grok';
      _set(() {
        messages.add({
          'role': 'assistant',
          'text': isGrok
              ? 'Opening native Grok chat through CHE, sir.'
              : 'Opening ${embeddedApp.name} inside CHE, sir.',
        });
      });
      // The owner said "open X": that utterance is the permission, so the
      // Worker's gate won't ask about this app again on later turns.
      unawaited(CheAppPermissions.grant(embeddedApp.name));
      if (isGrok) {
        await CheGrokChatScreen.open(
          context,
          baseUrl: cheAgentBaseUrl,
          deviceToken: _deviceToken ?? '',
          onOpenWeb: () {
            CheEmbeddedAppScreen.open(context, app: embeddedApp);
          },
        );
      } else {
        await CheEmbeddedAppScreen.open(context, app: embeddedApp);
      }
      return true;
    }

    // Apps with no web version: say so honestly. iWebTV goes to the Theater,
    // which asks the owner before opening the app itself.
    final noWeb = cheNoWebVersionReason(appName);
    if (noWeb != null && mounted) {
      controller.clear();
      _set(() => messages.add({'role': 'assistant', 'text': noWeb}));
      await speakText(noWeb);
      if (appName.contains('iweb')) _openAssistantHub(tab: 8);
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
          // Same rule as the embedded apps: the spoken "open X" grants it.
          unawaited(CheAppPermissions.grant(matchedName ?? appName));
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

  Future<void> _openAppVersionDetails() async {
    final installed = await CheInstalledBuild.read().timeout(const Duration(seconds: 2), onTimeout: () => null);
    if (!mounted) return;
    final reply = installed == null
        ? 'Opening CHE app and update details. The native installed version and build could not be read; I will not substitute the latest published version.'
        : 'Opening CHE app and update details. This iPhone reports installed CHE version ${installed.version}, build ${installed.build}. A Shorebird patch is listed separately when available.';
    _set(() { messages.add({'role': 'assistant', 'text': reply}); });
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
      content: Text(reply, style: const TextStyle(fontSize: 18)),
      duration: const Duration(seconds: 10),
    ));
    HapticFeedback.mediumImpact();
    unawaited(speakText(reply, record: false, readOnDemand: true));
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CheMobileUpdateScreen(
      baseUrl: cheAgentBaseUrl, onSpeak: (text) => speakText(text, record: false, readOnDemand: true),
    )));
    return;
  }

  Future<bool> _handleLocalNavigation(String message) async {
    final lower = message.toLowerCase();

    if (CheVideo.isRecentCommand(message)) {
      await speakText('Opening recent videos, sir.', record: false, show: true);
      if (!mounted) return true;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => CheVideoPage(videos: List<Map<String, String>>.from(_recentVideos)),
        ),
      );
      return true;
    }
    final updateCommand = RegExp(
      r'^(?:(?:chay|chey|shay|che)[, ]+)?(?:please\s+)?(?:update yourself|check\s+(?:for\s+)?(?:(?:an|any|my|the|new|che)\s+)*updates?|install (?:the )?che update|download (?:the )?che update)(?:,?\s+please)?\s*[.!?]*$',
      caseSensitive: false,
    );
    // "Diagnose Rithmic", "why isn't Rithmic connecting": the four checks on this phone, read out with their real
    // results. The password never leaves the phone and is never spoken.
    if (cheRithmicDiagnoseCommand(message)) {
      await speakText('Checking Rithmic: the saved login, the automatic reconnect, the connection and the login answer.', record: false, show: true);
      final checks = await cheRithmicDiagnose();
      await speakText(cheRithmicDiagnosisText(checks), record: false, show: true);
      return true;
    }
    if (updateCommand.hasMatch(message.trim())) {
      await speakText('Checking CHE updates now, sir.', record: false, show: true);
      if (!mounted) return true;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => CheMobileUpdateScreen(
            baseUrl: cheAgentBaseUrl,
            onSpeak: (text) => speakText(text, record: false, readOnDemand: true),
            announceRequestedCheck: true,
          ),
        ),
      );
      return true;
    }
    final rollbackCommand = RegExp(
      r'^(?:(?:chay|chey|shay|che)[, ]+)?(?:roll back|rollback|go back)(?: to)? (?:the )?(?:previous|last)(?: working)? (?:che )?build\s*[.!?]*$',
      caseSensitive: false,
    );
    if (rollbackCommand.hasMatch(message.trim())) {
      await speakText(
        'Opening CHE previous verified builds. I will ask before SideStore opens an older build, sir.',
        record: false,
        show: true,
      );
      if (!mounted) return true;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => CheMobileUpdateScreen(
            baseUrl: cheAgentBaseUrl,
            onSpeak: (text) => speakText(text, record: false, readOnDemand: true),
            rollback: true,
          ),
        ),
      );
      return true;
    }

    if (RegExp(r'\b(open|show|go to|start)\s+(the\s+|my\s+)?(character|avatar)\s+(generator|creator|maker|builder)\b').hasMatch(lower) ||
        RegExp(r'^\W*(?:(?:che|chey|chay)[,:]?\s+)?(character|avatar)\s+generator\W*$').hasMatch(lower)) {
      _openCharacterGenerator();
      return true;
    }
    // Brain Room phrases off the Brain screen ("search my brain for red", "show live activity", "what is CHE
    // learning"): open the Brain, then let its handler answer, so the same words work everywhere.
    final brainPhrase = CheBrainOverview.voiceHandler == null ? CheBrainOverview.parse(message) : null;
    if (brainPhrase != null && (brainPhrase.query != null || brainPhrase.learning || brainPhrase.section == CheBrainNav.activity)) {
      if (_assistantHubOpen && mounted) Navigator.of(context).pop();
      _openAssistantHub(tab: 0);
      for (var i = 0; i < 14 && CheBrainOverview.voiceHandler == null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
      final handler = CheBrainOverview.voiceHandler;
      final reply = handler == null ? 'I opened your brain, sir, but it did not finish loading. Ask again in a moment.' : (await handler(message)) ?? '';
      if (mounted) _set(() => controller.clear());
      if (reply.isNotEmpty) await speakText(reply, record: false);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(my\s+)?(memories?|brain|brain constellation)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 0);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(insights?|suggestions?|learned knowledge)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 0);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(markets?|trading|stocks?|futures?|crypto)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 1);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(business|cash flow|customers?|leads?|billing)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 2);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(devices?|connections?|screen|identity)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 3);
      return true;
    }
    // Music Studio's recording workspace (owner, 2026-10-24): "record my vocals", "open the beat maker", "my songs".
    if (CheRecordingStudio.voiceHandler == null) {
      final rec = RegExp(r'\b(?:open|show|go to)\s+(?:the\s+|my\s+)?(recording studio|music studio|studio recorder|beat maker|my songs|mixer|mastering)\b').firstMatch(lower);
      final takeNow = RegExp(r'\b(record (my )?(vocals?|voice|a song|a take)|start recording (my )?(vocals?|a song)|new recording|make a beat|play the beat)\b').hasMatch(lower);
      if (rec != null || takeNow) {
        final name = rec?.group(1) ?? '';
        // With words to act on, the studio says the real result itself; otherwise CHE says where she went.
        if (!takeNow) await speakText('Opening the Recording Studio${name.isEmpty || name.endsWith('studio') ? '' : ', $name'}.', record: false);
        if (!mounted) return true;
        unawaited(_openRecordingStudio(
          tab: name == 'beat maker' ? 2 : name == 'my songs' ? 1 : name == 'mixer' ? 3 : name == 'mastering' ? 5 : 0,
          say: takeNow ? message : null,
        ));
        return true;
      }
    }
    // The video series moved to Film Studio with the rest of video (2026-10-24).
    if (RegExp(r'\b(open|show|go to)\s+(the\s+|my\s+)?(street smart explainers|video series|series studio|series panel)\b').hasMatch(lower)) {
      await speakText('Opening Film Studio. The video series, Street Smart Explainers, is at the top.', record: false);
      if (!mounted) return true;
      unawaited(_openFilmStudio());
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(music|playlists?)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 4);
      return true;
    }
    // Creative Studio (Create tab): a studio by name scrolls to it; "create new" opens the Create New choices.
    final studio = RegExp(r'\b(?:open|show|go to)\s+(?:the\s+|my\s+)?(creative studio|code studio|coding studio|art (?:and|&) character studio|character studio|art studio|projects)\b')
        .firstMatch(lower);
    if (studio != null) {
      final name = studio.group(1)!;
      _openCreativeStudio(
        section: name.startsWith('code') || name.startsWith('coding')
            ? CheStudioSection.code
            : name.contains('art') || name.contains('character')
                ? CheStudioSection.art
                : name == 'projects'
                    ? CheStudioSection.projects
                    : null,
      );
      return true;
    }
    // Creation by voice from any screen, all inside CHE (owner, 2026-10-24: never a website in ordinary use).
    final wake = r'^\W*(?:(?:che|chey|chay)[,:]?\s+)?';
    if (RegExp('$wake(?:create|make|build)(?: me)? (?:a |an )?(?:new )?(?:person|character|human|avatar)\\W*\$').hasMatch(lower)) {
      _openCreativeStudio(say: 'create a person');
      return true;
    }
    if (RegExp('$wake(?:continue|resume|keep) (?:creating|building|my creation|the creation)\\W*\$').hasMatch(lower)) {
      final said = await _continueCreating();
      await speakText(said, record: false);
      return true;
    }
    // Connect GPU (owner, 2026-10-25): CHE opens the notebook in her browser and verifies the GPU from her Worker.
    // The owner's own words are the permission to open Colab; CheGpuConnect.start enforces and records it.
    final gpuConnect = CheGpuConnect.instance;
    if (cheGpuConnectCommand(message) || (gpuConnect.waitingForOwner && cheGpuContinueCommand(message))) {
      _configureGpuConnect();
      final said = cheGpuConnectCommand(message) ? gpuConnect.start(message) : gpuConnect.ownerContinue();
      await _showGpuBrowser();
      await speakText(said, record: false, show: true);
      return true;
    }
    final gpuAccount = cheGpuAccountFromWords(message);
    if (gpuAccount != null) {
      await CheGpuAccount.save(gpuAccount);
      await speakText('Saved. CHE uses $gpuAccount for Colab.', record: false, show: true);
      return true;
    }
    if (RegExp('$wake(?:open|show)(?: my| the)? gpu browser\\W*\$').hasMatch(lower)) {
      unawaited(Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) =>
        CheGpuBrowser(baseUrl: cheAgentBaseUrl, headers: _authHeaders,
          onRead: (text) => speakText(text, record: false, readOnDemand: true)))));
      await speakText('Opening GPU Browser.', record: false);
      return true;
    }
    if (RegExp('$wake(?:open|show|connect)(?: to)? (?:my |the )?(?:cloud computer|creation engine)\\W*\$').hasMatch(lower)) {
      _openCreationEngine();
      await speakText('Opening your Cloud Computer.', record: false);
      return true;
    }
    if (RegExp(r'^\W*(?:(?:che|chey|chay)[,:]?\s+)?(?:create (?:something )?new|new creation|start a new creation)\W*$').hasMatch(lower)) {
      _openCreativeStudio(createNew: true);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(create|innovation|creator)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 5);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(office|team|coworkers?|partners?|workplace)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 6);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(apps?|app portal|web apps?|services?)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 7);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(the\s+)?(theater|theatre|cinema|movie room)\b').hasMatch(lower)) {
      _openAssistantHub(tab: 8);
      return true;
    }
    final codeFocus = RegExp(r"\bshow\s+me\s+([a-z0-9_-]+)(?:'s|’s)\s+code\b", caseSensitive: false).firstMatch(message);
    if (codeFocus != null) {
      _workshopFocusAgent = codeFocus.group(1);
      _openAssistantHub(tab: 9);
      return true;
    }
    if (RegExp(r'\b(open|show|go to)\s+(the\s+)?(workshop|build room|code workshop)\b').hasMatch(lower)) {
      _workshopFocusAgent = null;
      _openAssistantHub(tab: 9);
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
    // First request after a relaunch: the home chat is empty, but the owner may
    // be answering what CHE said just before the app closed ("No, strawberry
    // Sprite."). The last turns of the conversation her log restored are that
    // request's history while they are still fresh (che_agent_chat.dart).
    if (source.isEmpty) return _brainLog.restoredTurnsForHistory();
    // Earlier names, requirements and approvals remain part of this request.
    // The Worker selects an engine that can receive the complete history.
    return source
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
        // Face ID before speaking/showing a vault password (TTL skips re-prompt).
        final unlocked = await CheVaultAuth.instance.ensureUnlocked(
          reason: 'Use Face ID to show this saved password',
          freshFaceId: true,
        );
        if (!unlocked) {
          spoken = 'Face ID was cancelled — I did not reveal your password, sir.';
          shown = spoken;
          break;
        }
        final entry = await vault.find(command.site);
        if (entry == null) {
          spoken = 'I don\'t have a ${command.site} password saved, sir.';
          shown = spoken;
        } else {
          shown = '${entry.site}\n${entry.username.isEmpty ? '' : 'Username: ${entry.username}\n'}Password: ${entry.password}';
          spoken = 'Your ${entry.site} password is ${entry.password.split('').join(' ')}';
        }
      case 'import':
        final unlocked = await CheVaultAuth.instance.ensureUnlocked(
          reason: 'Use Face ID before importing passwords into CHE',
          freshFaceId: true,
        );
        if (!unlocked) {
          spoken = 'Face ID was cancelled — I did not import any passwords, sir.';
          shown = spoken;
          break;
        }
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
        final unlocked = await CheVaultAuth.instance.ensureUnlocked(
          reason: 'Use Face ID to delete this saved password',
          freshFaceId: true,
        );
        if (!unlocked) {
          spoken = 'Face ID was cancelled — I kept that saved password, sir.';
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
      // A password on screen: "look at my screen" refuses while this is open.
      builder: (sheetContext) => CheSensitiveScreen(
        child: Semantics(
          liveRegion: true,
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: SelectableText(shown, style: const TextStyle(fontSize: 24, height: 1.4)),
          ),
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

  /// The Music Room's record of a music request (owner, 2026-10-20): what the
  /// owner asked for and that CHE opened the search. It is observed, not a
  /// verified play: which video then played is not known here. It syncs to
  /// the Worker's Brain, where it is related to the rest of what CHE knows.
  Future<void> _rememberMusicRequest(CheVideoVoiceCommand command) async {
    // Build 2 (owner, 2026-10-20): the Worker records it in the Music Room with its source and time, and the
    // phone's Brain receives it on its next sync. Only when that post fails is it written here, so it is not lost.
    if (await _postRoomEvent(CheRoomEvents.music(command.query,
        detail: 'The owner asked CHE to play "${command.query}". CHE opened a YouTube search for it in her browser; which video then played is not recorded.'))) {
      return;
    }
    final at = DateTime.now().toUtc().toIso8601String();
    try {
      await _brainReplica.remember(
        id: 'room:music:request:$at',
        kind: 'room_request',
        region: 'YouTube and Media',
        path: 'Music Room/request',
        title: 'Music request: ${command.query}',
        body: 'The owner asked CHE to play "${command.query}". CHE opened a YouTube search for it in her browser. '
            'Which video then played is not recorded here.\n\nStatus: observed.\nSource room: Music Room. Recorded $at.',
        verification: 'observed',
        source: {
          'kind': 'room_event',
          'room': 'music',
          'room_label': 'Music Room',
          'event_kind': 'request',
          'status': 'observed',
          'refs': {'query': command.query, 'url': command.url},
          'at': at,
        },
      );
    } catch (_) {
      // A Brain write never blocks the music itself.
    }
  }

  /// One room's activity for CHE's Brain (owner, Build 2): fire and forget, silent, no UI. True when accepted.
  Future<bool> _postRoomEvent(Map<String, String>? event) =>
      CheRoomEvents.post(baseUrl: cheAgentBaseUrl, headers: _authHeaders, event: event);

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

  String _applyScreenCommand(ScreenCommand command) {
    switch (command.op) {
      case ScreenOp.clearChips:
        _screenChipsHidden = true;
        return 'Suggestions hidden, sir.';
      case ScreenOp.showChips:
        _screenChipsHidden = false;
        return 'Suggestions are back, sir.';
      case ScreenOp.addChip:
        final label = command.text.trim();
        final current = _homeSuggestions.isNotEmpty ? _homeSuggestions : _skillPlugins.quickActions();
        _homeSuggestions = <String>[
          label,
          ...current.where((item) => item.toLowerCase() != label.toLowerCase()),
        ].take(3).toList(growable: false);
        _screenChipsHidden = false;
        return 'Added "$label" to the suggestions, sir.';
      case ScreenOp.removeChip:
        final label = command.text.trim();
        final current = _homeSuggestions.isNotEmpty ? _homeSuggestions : _skillPlugins.quickActions();
        final shown = current.take(3).toList(growable: false);
        final kept = shown.where((item) => item.toLowerCase() != label.toLowerCase()).toList(growable: false);
        final removed = kept.length != shown.length;
        _homeSuggestions = kept;
        _screenChipsHidden = false;
        return removed ? 'Removed "$label" from the suggestions, sir.' : 'I do not see "$label" in the suggestions.';
      case ScreenOp.openCommands:
        // Navigation now happens directly in sendMessage, not in a frame callback.
        return 'Opening Commands, sir.';
      case ScreenOp.searchCommands:
        return command.text.isEmpty ? 'Opening Commands, sir.' : 'Opening Commands for "${command.text}", sir.';
      case ScreenOp.openConnections:
        return switch (command.text) {
          'youtube' => 'Opening CHE Connections to connect YouTube, sir.',
          'broker' => 'Opening CHE Connections to connect NinjaTrader, sir.',
          'gmail' => 'Opening CHE Connections to connect Gmail, sir.',
          'drive' => 'Opening CHE Connections to connect Google Drive, sir.',
          'calendar' => 'Opening CHE Connections to connect Google Calendar, sir.',
          'google_ads' => 'Opening CHE Connections to connect Google Ads, sir.',
          _ => 'Opening CHE Connections, sir.',
        };
      case ScreenOp.changeVoice:
        return 'Opening CHE Voice Settings, sir.';
      case ScreenOp.naturalVoice:
        return 'Opening your CHE voice choices, sir.';
      case ScreenOp.openAtlas:
        return 'Opening the Knowledge Atlas, sir.';
      case ScreenOp.openRenderBench:
        return command.text == 'run' ? 'Opening the rendering benchmark and measuring, sir.' : 'Opening the rendering benchmark, sir.';
      case ScreenOp.clearChat:
        messages.clear();
        _brainLog.dropRestoredContext();
        return 'Chat cleared, sir.';
      case ScreenOp.removeLast:
        if (messages.isEmpty) return 'There is no message to remove, sir.';
        messages.removeLast();
        return 'Removed the last message, sir.';
      case ScreenOp.hideGreeting:
        _screenGreetingHidden = true;
        return 'Greeting hidden, sir.';
      case ScreenOp.showGreeting:
        _screenGreetingHidden = false;
        return 'Greeting is back, sir.';
    }
  }

  Future<Map<String, dynamic>> _pollVideoTask(String taskId) async {
    Map<String, dynamic> last = <String, dynamic>{
      'ok': true,
      'pending': true,
      'task_id': taskId,
      'error': 'Video is still rendering.',
    };
    for (var attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) await Future<void>.delayed(const Duration(milliseconds: 1500));
      final uri = Uri.parse('$cheAgentBaseUrl/api/video/line').replace(queryParameters: {'task_id': taskId});
      final response = await http.get(uri, headers: _authHeaders).timeout(const Duration(seconds: 10));
      final decoded = jsonDecode(response.body.isEmpty ? '{}' : response.body);
      last = decoded is Map ? Map<String, dynamic>.from(decoded) : <String, dynamic>{};
      final mediaUrl = '${last['media_url'] ?? ''}'.trim();
      if (response.statusCode == 200 && last['ok'] == true && CheVideo.isMediaUrl(mediaUrl)) return last;
      if (response.statusCode != 202 || last['pending'] != true) return last;
    }
    return last;
  }

  Future<bool> _handleVideoGenerationCommand(String message) async {
    if (_pendingAttachment != null) return false;
    final topic = CheVideo.topicFromCommand(message);
    if (topic == null) return false;
    if (!await _ensurePaired()) return true;
    if (_isSending) return true;
    _isSending = true;

    if (mounted) {
      _set(() {
        messages.add({'role': 'user', 'text': message});
        controller.clear();
      });
      _scrollToBottom();
    }

    String reply;
    // A finished file rides on the reply, so the chat plays it inline (the same as a video from chat).
    var videoUrl = '';
    try {
      final response = await http
          .post(
            Uri.parse('$cheAgentBaseUrl/api/video/line'),
            headers: {..._authHeaders, 'Content-Type': 'application/json'},
            body: jsonEncode({'topic': topic}),
          )
          .timeout(const Duration(seconds: 35));
      final decoded = jsonDecode(response.body.isEmpty ? '{}' : response.body);
      var data = decoded is Map ? Map<String, dynamic>.from(decoded) : <String, dynamic>{};
      var mediaUrl = '${data['media_url'] ?? ''}'.trim();
      final taskId = '${data['task_id'] ?? ''}'.trim();
      if (response.statusCode == 202 && data['pending'] == true && taskId.isNotEmpty) {
        data = await _pollVideoTask(taskId);
        mediaUrl = '${data['media_url'] ?? ''}'.trim();
      }
      if (data['ok'] == true && CheVideo.isMediaUrl(mediaUrl)) {
        _recentVideos.insert(0, {'title': topic, 'media_url': mediaUrl});
        videoUrl = mediaUrl;
        reply = 'Your video is ready, sir.';
      } else if (data['pending'] == true) {
        reply = 'The video is still rendering, sir. No finished file is available yet.';
      } else {
        final error = '${data['error'] ?? data['detail'] ?? ''}'.trim();
        reply = error.isNotEmpty ? error : 'The video renderer did not return a finished file.';
      }
    } catch (error) {
      reply = 'The video server did not return a file. Please try again.';
    } finally {
      _isSending = false;
    }

    if (mounted) {
      _set(() => messages.add({
            'role': 'assistant',
            'text': reply,
            if (videoUrl.isNotEmpty) 'media_url': videoUrl,
            if (videoUrl.isNotEmpty) 'media_type': 'video',
          }));
      _scrollToBottom();
    }
    await speakText(reply, record: false);
    return true;
  }

  Future<void> sendMessage({bool fromVoice = false}) async {
    if (await _controlAutonomy(controller.text.trim())) return;
    if (_isSending) return;
    // Navigating to Commands must not wait for a potentially stalled voice
    // playback to stop. Open the page first, then interrupt the old clip.
    final earlyCommand = _pendingAttachment == null ? parseScreenCommand(controller.text.trim()) : null;
    final quickCommandsRoute = earlyCommand?.op == ScreenOp.openCommands ||
        earlyCommand?.op == ScreenOp.searchCommands ||
        earlyCommand?.op == ScreenOp.openConnections ||
        earlyCommand?.op == ScreenOp.changeVoice ||
        earlyCommand?.op == ScreenOp.naturalVoice ||
        earlyCommand?.op == ScreenOp.openAtlas ||
        earlyCommand?.op == ScreenOp.openRenderBench;
    if (_isSpeaking && !quickCommandsRoute) {
      await _interruptSpeechAndListen(resumeListening: false);
    }

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

    // Security Intelligence: a password, key or token typed or spoken into ordinary chat never leaves the phone.
    if (_pendingAttachment == null && cheChatLooksSecret(message)) {
      if (mounted) _set(() => controller.clear());
      await speakText('That looks like a password, key or token, so I did not send it anywhere. To keep a password, say save my password for, then the site; it stays in your Face ID vault on this iPhone. Keys go in the Keys tab.', record: false, show: true);
      return;
    }

    // The Command Center, while it is open, answers its own voice routes
    // first (search, numbered options, run, favorite, workflows, run
    // controls). Its reply is on its banner; CHE says it here. An empty
    // reply means the command went to Chat, which speaks the real result.
    final commandsVoice = CheCommandCenterVoice.handler;
    if (commandsVoice != null && _pendingAttachment == null && !cheIsAppStatusRequest(message)) {
      final reply = await commandsVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false);
        return;
      }
    }

    // The Security Room, while open, opens its lists, searches and reads entries by voice.
    final securityVoice = CheSecurityRoomVoice.handler;
    if (securityVoice != null && _pendingAttachment == null && !cheIsAppStatusRequest(message)) {
      final reply = await securityVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // The Invention 3D viewer and the Invention Studio page, while open, take rotate, zoom, colour, "show me" and 3D.
    for (final inventionVoice in [CheInventionViewer.voiceHandler, CheInventionStudioPage.voiceHandler]) {
      if (inventionVoice == null || _pendingAttachment != null) continue;
      final reply = await inventionVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false);
        return;
      }
    }

    // The Recording Studio, while it is open, takes record, play, stop, effects, mixing, mastering and export.
    final recordingVoice = CheRecordingStudio.voiceHandler;
    if (recordingVoice != null && _pendingAttachment == null) {
      final reply = await recordingVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false);
        return;
      }
    }

    // Trade Replay, while it is open, takes play, pause, back or forward 10 seconds, restart and read.
    final replayVoice = CheTradeReplayPage.voiceHandler;
    if (replayVoice != null && _pendingAttachment == null) {
      final reply = await replayVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false);
        return;
      }
    }

    // The Brain Room, while it is on screen, opens its sections, searches the Brain and says what CHE is learning.
    final brainRoomVoice = CheBrainOverview.voiceHandler;
    if (brainRoomVoice != null && _pendingAttachment == null && !cheIsAppStatusRequest(message)) {
      final reply = await brainRoomVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false);
        return;
      }
    }

    // The Live 3D Studio, while it is open, takes viewport moves, edits, undo, redo, save and generate.
    final gpuVoice = CheGpuBrowser.voiceHandler;
    if (gpuVoice != null && _pendingAttachment == null) {
      final reply = await gpuVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }
    final liveVoice = CheLiveStudio.voiceHandler;
    if (liveVoice != null && _pendingAttachment == null) {
      final reply = await liveVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // The Code Studio workspace and the project manager, while open, take their own spoken actions.
    for (final pageVoice in [CheCodeWorkspace.voiceHandler, CheProjectManager.voiceHandler]) {
      if (pageVoice == null || _pendingAttachment != null) continue;
      final reply = await pageVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false);
        return;
      }
    }

    // The Creative Studio, while it is on screen, takes its numbered choices and named actions by voice or typing.
    final studioVoice = CheCreativeStudio.voiceHandler;
    if (studioVoice != null && _pendingAttachment == null && CheCharacterGenerator.voiceHandler == null && CheLiveStudio.voiceHandler == null) {
      final reply = await studioVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // CHE World population, while it is open (it sits above the Character Generator), takes read, refresh and the
    // crowd viewer by voice or typing.
    final populationVoice = CheWorldPopulationPanel.voiceHandler;
    if (populationVoice != null && _pendingAttachment == null) {
      final reply = await populationVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // The Character Generator, while it is open, takes every one of its actions and settings by voice or typing.
    final generatorVoice = CheCharacterGenerator.voiceHandler;
    if (generatorVoice != null && _pendingAttachment == null) {
      final reply = await generatorVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // The rendering benchmark, while it is open, answers run, read and copy.
    final benchVoice = CheRenderBenchScreen.voiceHandler;
    if (benchVoice != null && _pendingAttachment == null) {
      final reply = await benchVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // The natural-voice picker, while it is open, takes the same spoken control.
    final pickerVoice = CheCloudVoicePickerVoice.handler;
    if (pickerVoice != null && _pendingAttachment == null) {
      final reply = await pickerVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // The Connections page takes its own spoken control while it is the open route.
    final connectionsVoice = CheConnectionsVoice.handler;
    if (connectionsVoice != null && _pendingAttachment == null) {
      final reply = await connectionsVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // The Knowledge Atlas page, while it is open, answers its own spoken routes (its cards,
    // levels, quiz and numbered list); anything else goes on to Chat as usual.
    final atlasVoice = CheKnowledgeAtlasVoice.handler;
    if (atlasVoice != null && _pendingAttachment == null) {
      final reply = await atlasVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        if (reply.isNotEmpty) await speakText(reply, record: false, show: true);
        return;
      }
    }

    // Direct screen edits are applied on-device before any model routing.
    final screenCommand = _pendingAttachment == null ? parseScreenCommand(message) : null;
    if (screenCommand != null) {
      // Open the real page immediately. A deferred callback could leave the
      // owner in Chat, so the next local search went to the web/model.
      if (screenCommand.op == ScreenOp.openCommands || screenCommand.op == ScreenOp.searchCommands ||
          screenCommand.op == ScreenOp.openConnections || screenCommand.op == ScreenOp.changeVoice ||
          screenCommand.op == ScreenOp.naturalVoice || screenCommand.op == ScreenOp.openAtlas ||
          screenCommand.op == ScreenOp.openRenderBench) {
        if (!mounted) return;
        final reply = _applyScreenCommand(screenCommand);
        _set(() {
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': reply});
        });
        HapticFeedback.mediumImpact();
        if (screenCommand.op == ScreenOp.openConnections) {
          unawaited(_openConnections(autoConnect: screenCommand.text));
        } else if (screenCommand.op == ScreenOp.changeVoice) {
          _openVoiceSelector();
        } else if (screenCommand.op == ScreenOp.naturalVoice) {
          _openNaturalVoicePicker();
        } else if (screenCommand.op == ScreenOp.openAtlas) {
          _openKnowledgeAtlas();
        } else if (screenCommand.op == ScreenOp.openRenderBench) {
          _openRenderBench(autoRun: screenCommand.text == 'run');
        } else {
          unawaited(_openCommandCenter(
            search: screenCommand.op == ScreenOp.searchCommands ? screenCommand.text : '',
            list: screenCommand.list,
          ));
        }
        if (_isSpeaking) await _interruptSpeechAndListen(resumeListening: false);
        // A requested search speaks its numbered results (or a real failure)
        // from the Command Center, not a misleading "Opening..." preamble.
        // A spoken connect speaks its real result from the Connections page;
        // this "Opening..." line would cut across it.
        final connectsNow = screenCommand.op == ScreenOp.openConnections && screenCommand.text.isNotEmpty;
        if (!connectsNow && (screenCommand.op == ScreenOp.openCommands ||
            screenCommand.op == ScreenOp.openConnections ||
            screenCommand.op == ScreenOp.changeVoice ||
            screenCommand.op == ScreenOp.naturalVoice ||
            screenCommand.op == ScreenOp.openAtlas || screenCommand.op == ScreenOp.openRenderBench)) {
          await speakText(reply, record: false, show: true);
        }
        return;
      }
      var reply = '';
      if (mounted) {
        _set(() {
          reply = _applyScreenCommand(screenCommand);
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': reply});
        });
      } else {
        reply = _applyScreenCommand(screenCommand);
      }
      HapticFeedback.mediumImpact();
      await speakText(reply, record: false);
      return;
    }

    // CHE adjusts her own UI on the spot ("dark mode", "bigger text",
    // "volume down"), on the phone, confirmed aloud.
    final uiCommand = _pendingAttachment == null ? CheUiVoiceCommand.parse(message) : null;
    if (uiCommand != null) {
      if (mounted) _set(() => controller.clear());
      final reply = await uiCommand.apply(CheUiPreferences.instance);
      if (uiCommand.kind == 'handsFree') unawaited(_applyHandsFreeChange());
      HapticFeedback.mediumImpact();
      if (mounted) {
        _set(() => messages
          ..add({'role': 'user', 'text': message})
          ..add({'role': 'assistant', 'text': reply}));
      }
      await speakText(reply, record: false);
      return;
    }

    // Voice navigation inside the CHE browser/app that is open right now.
    final browserVoice = CheBrowserActions.voice;
    if (browserVoice != null && _pendingAttachment == null && !cheIsAppStatusRequest(message)) {
      final reply = await browserVoice(message);
      if (reply != null) {
        if (mounted) _set(() => controller.clear());
        await speakText(reply);
        return;
      }
    }

    // "Take me back to my last meeting", "show my meetings", "open the meeting about my app":
    // reopen existing meetings by id (che_meetings.dart); nothing is restarted.
    final meetingNav = _pendingAttachment != null ? null : cheMeetingNavIntent(message);
    if (meetingNav != null) {
      await _navigateMeetings(message, meetingNav);
      return;
    }

    // In the Meeting Room: "read the suggestions", "what's the recommendation",
    // "read suggestion 2", "who's at the table" are answered from its scene.
    final meetingRoom = CheMeetingRoom.current.value;
    final roomAnswer = meetingRoom == null || _pendingAttachment != null ? null : cheMeetingRoomAnswer(meetingRoom, message);
    if (roomAnswer != null) {
      if (mounted) {
        _set(() {
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': roomAnswer});
        });
      }
      HapticFeedback.mediumImpact();
      await speakText(roomAnswer, record: false);
      return;
    }

    // In the Simulation Lab: "what's the best design", "why were designs eliminated", "how many simulations ran".
    final simLab = CheSimLabPage.current.value;
    final simAnswer = simLab == null || _pendingAttachment != null ? null : simLab.answer(message);
    if (simAnswer != null) {
      if (mounted) {
        _set(() {
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': simAnswer});
        });
      }
      HapticFeedback.mediumImpact();
      await speakText(simAnswer, record: false);
      return;
    }

    // In the Plan Room: "sort by cheapest", "show premium", "what comes first".
    final planRoom = ChePlanRoom.current.value;
    final planAnswer = planRoom == null || _pendingAttachment != null ? null : planRoom.answer(message);
    if (planAnswer != null) {
      if (mounted) {
        _set(() {
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': planAnswer});
        });
      }
      HapticFeedback.mediumImpact();
      await speakText(planAnswer, record: false);
      return;
    }

    // "Look at my screen" (owner, 2026-10-20): CHE takes a picture of her own
    // screen and sends it with this turn, with the page's report, so the
    // Worker's vision reads what is really there. A password or vault page
    // on screen refuses the picture; a failure is said aloud, never guessed.
    // Shown as large text on the page in front and spoken, for a blind or deaf owner.
    Future<void> sayHere(String reply, {bool failed = false}) async {
      if (mounted) {
        _set(() {
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': reply});
        });
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
          content: Text(reply, style: const TextStyle(fontSize: 18, height: 1.3)),
          duration: const Duration(seconds: 10),
        ));
      }
      failed ? HapticFeedback.heavyImpact() : HapticFeedback.mediumImpact();
      await speakText(reply, record: false);
    }

    // "Share my screen" / "stop sharing my screen" (owner, 2026-10-20): the
    // iPhone's Screen Broadcast sheet, with CHE's extension chosen. iOS lets
    // only the owner start or stop it there; CHE says what to choose.
    final shareAsk = _pendingAttachment == null && cheAsksToShareScreen(message);
    final stopAsk = _pendingAttachment == null && !shareAsk && cheAsksToStopSharing(message);
    if (shareAsk || stopAsk) {
      final share = await CheScreenShare.status();
      if (!share.available) {
        await sayHere('Cross-app screen sharing is temporarily disabled for privacy, sir, because other apps may show passwords or other secrets. '
            'I can still see CHE\'s own screen: say "look at my screen".', failed: true);
      } else if (stopAsk && !share.active) {
        await sayHere('Screen sharing is already off, sir.');
      } else if (shareAsk && share.active) {
        await sayHere('Your screen is already shared with me, sir. Go to any app, come back, and say "look at my screen". Say "stop sharing my screen" to end it.');
      } else if (await CheScreenShare.showPicker()) {
        await sayHere(stopAsk
            ? 'The iPhone\'s Screen Broadcast sheet is open, sir. Choose Stop Broadcast to end sharing. The red indicator at the top of the screen ends it too.'
            : 'The iPhone\'s Screen Broadcast sheet is open, sir, with CHE Screen chosen. Choose Start Broadcast. '
                'A red indicator shows while sharing is on, and I only look when you say "look at my screen".');
      } else {
        await sayHere('I could not open the iPhone\'s Screen Broadcast sheet, sir. In Control Center, hold Screen Recording and choose CHE Screen.', failed: true);
      }
      return;
    }

    if (_pendingAttachment == null && cheAsksToLookAtScreen(message)) {
      // Cross-app frames can contain unknown passwords. This privacy gate
      // never forwards one, even if a legacy native extension is installed.
      // CHE's own visible Flutter screen stays capturable.
      final shot = await CheScreenCapture.capture();
      if (!shot.ok) {
        await sayHere('I did not look, sir: ${shot.reason}.', failed: true);
        return;
      }
      HapticFeedback.lightImpact();
      final look = shot.shared
          ? 'The owner asked CHE to look at his screen. The attached image is a frame of his whole iPhone screen from screen sharing '
              '(${shot.width}x${shot.height}${shot.at == null ? '' : ', taken ${shot.at!.toIso8601String()}'}'
              '${shot.beforeSwitch ? ', just before he switched back to CHE' : ''}); it can show any app.'
          : 'The owner asked CHE to look at his screen. The attached image is a picture of CHE\'s own app '
              '(${shot.width}x${shot.height}); web pages and videos inside it appear blank. Page report: ${CheScreenAwareness.describe()}';
      _set(() {
        _pendingAttachment = {'name': shot.shared ? 'shared-screen.jpg' : 'che-screen.png', 'media_type': 'image', 'base64': shot.base64};
        // The browser's page text, when it is open, stays with the picture.
        _pendingScreenContext = [if ((_pendingScreenContext ?? '').trim().isNotEmpty) _pendingScreenContext!, look].join('\n\n');
      });
    }

    // "What is on my screen?": answered from the page really in front of the
    // owner (its registered page, tab and controls), never a model's guess.
    // Pages with their own voice routes (Commands, the browser) answered above.
    if (_pendingAttachment == null && cheAsksAboutScreen(message)) {
      final reply = CheScreenAwareness.describe();
      // The Screen room keeps only which screen he asked about and when (owner, Build 2).
      final page = CheScreenAwareness.current?.page ?? '';
      if (page.isNotEmpty) unawaited(_postRoomEvent(CheRoomEvents.screen(page)));
      if (mounted) {
        final onChat = _shellTab == 1 && (ModalRoute.of(context)?.isCurrent ?? true);
        _set(() {
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': reply});
        });
        // Large visible text on whatever page is in front, for a deaf owner too.
        if (!onChat) {
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
            content: Text(reply, style: const TextStyle(fontSize: 18, height: 1.3)),
            duration: const Duration(seconds: 10),
          ));
        }
      }
      HapticFeedback.mediumImpact();
      await speakText(reply, record: false);
      return;
    }

    // Universal help (owner, 2026-10-20): "what is this button?", "what does Emergency Stop do?",
    // "show me the pause button", "walk me through this screen", "open the help center". Answered
    // from the controls the screen in front really reports (che_ui/che_help.dart), never a guess.
    final helpAsk = _pendingAttachment == null ? cheHelpIntent(message) : null;
    if (helpAsk != null) {
      // Read before anything opens over the screen the owner is asking about.
      final helpScreen = CheHelp.shown;
      final reply = CheHelp.answer(helpAsk) ?? '';
      // What he asked Help about, for the Brain's Help records (owner, Build 2). Steps and the Help Center itself are not activity.
      if (reply.isNotEmpty && helpAsk.kind != CheHelpKind.step && helpAsk.kind != CheHelpKind.center) {
        unawaited(_postRoomEvent(CheRoomEvents.help(message,
            walkthrough: helpAsk.kind == CheHelpKind.walkthrough, screen: CheScreenAwareness.current?.page ?? '')));
      }
      if (mounted) {
        final onChat = _shellTab == 1 && (ModalRoute.of(context)?.isCurrent ?? true);
        _set(() {
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': reply});
        });
        if (helpAsk.kind == CheHelpKind.center) {
          unawaited(Navigator.of(context).push(CheHelpCenter.route(screen: helpScreen)));
        } else if (helpAsk.kind == CheHelpKind.walkthrough) {
          unawaitedWalk(context);
        } else if (!onChat) {
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
            content: Text(reply, style: const TextStyle(fontSize: 18, height: 1.3)),
            duration: const Duration(seconds: 10),
          ));
        }
      }
      HapticFeedback.mediumImpact();
      await speakText(reply, record: false);
      return;
    }

    // One-step video search in CHE's own browser: "search YouTube for jazz",
    // "find new videos about Mars", "play lofi beats video". Inside the
    // browser, "read the videos" / "play number one" / "pause" take over.
    final videoCommand = _pendingAttachment == null ? CheVideoVoiceCommand.parse(message) : null;
    if (videoCommand != null) {
      // Shown as large chat text as well as spoken, for a deaf owner too.
      if (mounted) {
        _set(() {
          controller.clear();
          messages.add({'role': 'user', 'text': message});
        });
      }
      HapticFeedback.mediumImpact();
      if (videoCommand.music) unawaited(_rememberMusicRequest(videoCommand));
      await speakText(videoCommand.spoken);
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => CheBrowserScreen(initialUrl: videoCommand.url, title: 'YouTube'),
        ),
      );
      return;
    }

    // Links CHE just gave: "open Supabase", "open it", "open link 2",
    // "open it in Safari", "what's the link".
    final linkCommand = _pendingAttachment == null ? CheLinkVoiceCommand.parse(message, _recentChatLinks()) : null;
    if (linkCommand != null) {
      if (mounted) _set(() => controller.clear());
      await _runChatLinkCommand(message, linkCommand);
      return;
    }

    // Brain space: "take me inside", "show my research memories", "find my
    // memory about …", "open this memory", "expand this cluster", "back out".
    final brainCommand = _pendingAttachment == null ? CheBrainCommand.parse(message) : null;
    if (brainCommand != null && await _runBrainCommand(message, brainCommand)) return;

    // "show the agent conversations", "open group chats", "what did the
    // agents say": every AI/agent conversation as group chats.
    if (_pendingAttachment == null &&
        RegExp(r"^(?:(?:che|chey|chay)[,:]?\s+)?(?:show|open|read)(?: me)? (?:the |my )?(?:(?:agent|agents|ai|ais|office|war room|crew) (?:conversations|group chats|chats|messages)|group chats)\b|^what did (?:the )?(?:agents|crew|ais) say", caseSensitive: false)
            .hasMatch(message.trim())) {
      if (mounted) _set(() => controller.clear());
      await speakText('Opening the agent conversations, sir.', record: false);
      _openConversations();
      return;
    }

    // Trading Room live chart: "show me the E-mini", "switch to Tesla on the
    // 1 minute", "read the price". Opens the room and speaks the result.
    final chartCommand = _pendingAttachment == null ? CheChartCommand.parse(message) : null;
    if (chartCommand != null) {
      if (mounted) _set(() => controller.clear());
      await _runChartCommand(message, chartCommand);
      return;
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

    if (await _handleVideoGenerationCommand(message)) return;

    if (!await _ensurePaired()) return;

    // Keep a lightweight visual receipt in the chat. Images stay visible in
    // the owner's bubble; video/audio show an attachment card. The server gets
    // the original attachment through _pendingAttachment below.
    final attachmentForBubble = _pendingAttachment == null
        ? null
        : Map<String, String>.from(_pendingAttachment!);

    Map<String, String> outgoingUserMessage() {
      final item = <String, String>{'role': 'user', 'text': message};
      final attachment = attachmentForBubble;
      if (attachment == null) return item;
      item['attachment_name'] = attachment['name'] ?? 'attachment';
      item['attachment_type'] = attachment['media_type'] ?? 'document';
      if ((attachment['media_type'] ?? '') == 'image') {
        item['attachment_base64'] = attachment['base64'] ?? '';
      }
      return item;
    }

    // Realtime voice is text/audio-only. A turn with an attachment must go
    // through the normal multimodal HTTP path so CHE actually sees/hears it.
    if (_realtimeVoice?.connected == true &&
        !_realtimeVoice!.guardedOutput &&
        _pendingAttachment == null &&
        !isInstalledSkillRequest(message)) {
      if (!mounted) return;
      _set(() {
        messages.add(outgoingUserMessage());
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
      messages.add(outgoingUserMessage());
      controller.clear();
      _liveSteps.clear();
      _replyStartedAt = DateTime.now();
      _lastUserMessage = message;
      _stopRequested = false;
    });
    // This request's own session: only a stop tapped while this request is in flight can say "Stopped." below.
    final requestSession = _requestGate.begin();

    _scrollToBottom();

    if (message.toLowerCase().startsWith('remember that ')) {
      final memory = message.substring(14).trim();
      final outcome = await saveMemory(memory);

      final reply = _CheHomeMemory.memorySaveSpeech(outcome);

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
      _sendHeldSpeechNext();
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

      // Batch visual updates while speaking the first finished sentence as soon
      // as it streams in (time-to-first-spoken).
      final uiBatcher = CheStreamBatcher((partialReply) {
        final index = assistantIndex;
        if (!mounted || index == null || index >= messages.length) return;
        _set(() => messages[index]['text'] = _sanitizeCheReply(partialReply));
        _scrollToBottom();
      });
      final speechChunker = CheSpeechChunker();
      // One spoken turn for the whole reply: each chunk's audio is requested
      // the moment the chunk streams in (while earlier chunks still play),
      // and the mic is resumed once after the last chunk, not per sentence.
      CheSpeechPipeline<CheVoiceClip>? replySpeech;
      var replySpeechOpened = false;
      void enqueueSpoken(String chunk) {
        final spoken = _spokenText(chunk);
        if (spoken.isEmpty || !mounted || _stopRequested) return;
        if (!replySpeechOpened) {
          replySpeechOpened = true;
          // A story the owner asked for uses CHE's expressive story voice.
          replySpeech = _openSpeechTurn(purpose: cheVoicePurposeFor(message));
        }
        replySpeech?.add(spoken);
      }

      late final String reply;
      final firstWords = CheLatency.begin(CheLatency.firstReply);
      var heardFirstWords = false;
      try {
        reply = await _streamCheResponse(
          message,
          history,
          onPartial: (partialReply) {
            if (!heardFirstWords) {
              heardFirstWords = true;
              firstWords.end();
            }
            uiBatcher.add(partialReply);
            final clean = _sanitizeCheReply(partialReply);
            for (final chunk in speechChunker.addCumulative(clean)) {
              enqueueSpoken(chunk);
            }
          },
        );
        uiBatcher.flush();
      } finally {
        uiBatcher.dispose();
      }

      final stopped = requestSession.cancelled;
      _stopRequested = false;
      final finalReply = reply.isEmpty
          ? (stopped ? 'Stopped.' : 'I could not generate a response, sir.')
          : _sanitizeCheReply(reply);

      for (final chunk in speechChunker.addCumulative(finalReply)) {
        enqueueSpoken(chunk);
      }
      for (final chunk in speechChunker.flush()) {
        enqueueSpoken(chunk);
      }

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
          if (_streamUnderstoodAs != null) {
            messages[assistantIndex]['understood_as'] = _streamUnderstoodAs!;
          }
          final details = cheResponseDetailsJson(_streamResponseDetails);
          if (details != null) messages[assistantIndex]['response_details'] = details;
          if (_streamRecordIds.isNotEmpty) messages[assistantIndex]['record_ids'] = _streamRecordIds.join('\n');
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
      // The Worker turns this exchange into a brain memory right after the
      // reply; fetch it so the new neuron appears in the Brain in real time.
      Future<void>.delayed(const Duration(milliseconds: 2500), () {
        if (mounted) unawaited(_loadAgentState(silent: true));
      });

      if (stopped) {
        replySpeech?.cancel();
        _pendingVoicePreviewId = null;
      } else {
        replySpeech?.close();
        final previewId = _pendingVoicePreviewId;
        _pendingVoicePreviewId = null;
        final generation = _speechTurn;
        Future<void> playPreview() async {
          if (mounted && previewId != null && generation == _speechTurn) {
            unawaited(_playPendingVoicePreview(requestedVoiceId: previewId));
          }
        }
        final finished = replySpeech?.afterPlayback(playPreview) ?? playPreview();
        if (fromVoice && _realtimeVoice?.guardedOutput == true) {
          // The next queued owner turn must not wait for playback. The speech
          // pipeline owns its cleanup and new speech interrupts it immediately.
          unawaited(finished);
        } else {
          await finished;
        }

      }
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
    } catch (error) {
      final detail = error.toString().trim();
      final errorReply = CheOwnerError.fromRaw(detail.isEmpty ? 'gateway unreachable' : detail).message;

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
      // Words he spoke over this answer go next, with this reply in history.
      _sendHeldSpeechNext();
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
              leading: const Icon(Icons.translate_rounded),
              title: Text("Translate to ${cheLanguageByCode(_translateTarget).name}"),
              onTap: () {
                Navigator.pop(sheetContext);
                unawaited(_translateText(text));
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

  /// Returns false when the command needs the Brain on screen and it is not,
  /// so ordinary phrases ("back out") fall through to other handlers.
  Future<bool> _runBrainCommand(String message, CheBrainCommand command) async {
    const needsBrainOnScreen = {
      CheBrainAction.backOut, CheBrainAction.openSelected, CheBrainAction.expand, CheBrainAction.collapse, CheBrainAction.agentStatus,
      CheBrainAction.zoomIn, CheBrainAction.zoomOut, CheBrainAction.fit, CheBrainAction.back, CheBrainAction.centerSelected, CheBrainAction.lens,
    };
    var space = CheBrainSpaceController.current;
    if (space == null) {
      // Off the Brain screen only explicit brain/memory phrases open it, so
      // "go deeper" or "overview" in ordinary chat still reach CHE's AI.
      if (needsBrainOnScreen.contains(command.action) || !RegExp(r'\b(?:brain|memor)', caseSensitive: false).hasMatch(message)) return false;
      if (_brainCommandBusy) return true;
      _brainCommandBusy = true;
      if (mounted) _set(() => controller.clear());
      // The hub may be open on another tab: close it, then open the Brain.
      if (_assistantHubOpen && mounted) Navigator.of(context).pop();
      _openAssistantHub(tab: 0);
      for (var i = 0; i < 12 && CheBrainSpaceController.current == null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
      space = CheBrainSpaceController.current;
      _brainCommandBusy = false;
    } else if (mounted) {
      _set(() => controller.clear());
    }
    final reply = space == null
        ? 'I opened your brain, sir, but it has no memories to show yet.'
        : space.execute(command);
    HapticFeedback.selectionClick();
    if (mounted) {
      _set(() => messages
        ..add({'role': 'user', 'text': message})
        ..add({'role': 'assistant', 'text': reply}));
    }
    await speakText(reply, record: false);
    return true;
  }

  void _openConversations() {
    HapticFeedback.selectionClick();
    unawaited(CheConversationsScreen.open(
      context,
      baseUrl: () => cheAgentBaseUrl,
      headers: () => _authHeaders,
      onOpenFlagstaff: () => unawaited(_openMailbox()),
      onReadAloud: (t) => speakText(t, record: false, readOnDemand: true),
    ));
  }

  Future<void> _runChartCommand(String message, CheChartCommand command) async {
    if (command.symbol != null) CheLiveChart.symbol.value = command.symbol!;
    if (command.interval != null) CheLiveChart.interval.value = command.interval!;
    // "turn on VWAP", "hide Bollinger": the Trading Room charts listen and save it; CHE says the new state.
    final reply = command.changesIndicators
        ? await CheLiveChart.applyIndicatorCommand(command)
        : command.readPrice
        ? await CheLiveChart.readPrice(cheAgentBaseUrl, _authHeaders, command.symbol ?? CheLiveChart.symbol.value)
        : 'Loading ${CheLiveChart.symbol.value.name}, ${cheChartIntervals[CheLiveChart.interval.value] ?? CheLiveChart.interval.value} candles.';
    HapticFeedback.selectionClick();
    if (!mounted) return;
    _set(() => messages
      ..add({'role': 'user', 'text': message})
      ..add({'role': 'assistant', 'text': reply}));
    if (!command.readPrice) _openAssistantHub(tab: 1);
    await speakText(reply, record: false);
  }

  /// Opens the Meetings list, the last meeting, or the meeting matching a topic, and says what happened.
  Future<void> _navigateMeetings(String message, ({String kind, String topic}) nav) async {
    Future<void> say(String reply) async {
      if (mounted) {
        _set(() {
          controller.clear();
          messages
            ..add({'role': 'user', 'text': message})
            ..add({'role': 'assistant', 'text': reply});
        });
      }
      HapticFeedback.mediumImpact();
      await speakText(reply, record: false);
    }

    Future<void> open(String id) => cheOpenMeetingRoom(context, client: _agentRuntime, id: id, onSpeak: (t) => speakText(t, record: false), onBackToOffice: () => _goShellTab(2));

    if (nav.kind == 'list') {
      unawaited(say('Opening your meetings, sir: active, recent and completed.'));
      if (mounted) unawaited(Navigator.of(context).push(CheMeetingsPage.route(client: _agentRuntime, onSpeak: (t) => speakText(t, record: false), onBackToOffice: () => _goShellTab(2))));
      return;
    }
    List<CheMeetingSummary> all;
    try {
      all = await _agentRuntime.meetings();
    } catch (e) {
      await say('I could not load your meetings, sir: $e');
      return;
    }
    if (nav.kind == 'last') {
      final id = await cheLastMeetingId() ?? (all.isEmpty ? null : all.first.id);
      final m = all.where((x) => x.id == id).firstOrNull;
      if (id == null) {
        await say('You have no meetings yet, sir.');
        return;
      }
      unawaited(say(m == null ? 'Taking you back to your last meeting, sir.' : 'Taking you back to ${cheMeetingName(m)}, sir. It is ${cheMeetingStatusSpoken(m)}.'));
      if (mounted) unawaited(open(id));
      return;
    }
    final m = cheMatchMeeting(all, nav.topic);
    if (m == null) {
      await say(all.isEmpty ? 'You have no meetings yet, sir.' : 'I found no meeting about ${nav.topic}, sir. Say "show my meetings" to hear the list.');
      return;
    }
    unawaited(say('Opening ${cheMeetingName(m)}, sir. It is ${cheMeetingStatusSpoken(m)}.'));
    if (mounted) unawaited(open(m.id));
  }

  /// Connect GPU's real ports: CHE's browser session and her Worker. Speech only for required steps and results.
  void _configureGpuConnect() {
    CheGpuConnect.instance.configure(
      worker: CheGpuHttpWorker(baseUrl: cheAgentBaseUrl, headers: _authHeaders),
      browser: CheGpuSessionBrowser(front: _showGpuBrowser),
      speak: (text) => unawaited(speakText(text, record: false, show: true)),
    );
  }

  /// Brings the GPU Browser (and its retained notebook) to the front without stacking a second copy.
  Future<void> _showGpuBrowser() async {
    if (!mounted || CheGpuBrowser.openCount > 0) return;
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) =>
      CheGpuBrowser(baseUrl: cheAgentBaseUrl, headers: _authHeaders,
        onRead: (text) => speakText(text, record: false, readOnDemand: true)))));
    await Future<void>.delayed(const Duration(milliseconds: 600));
  }
}
