part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (streaming).
extension _CheHomeStreaming on _CHEHomeState {
  /// A setting CHE changed at the owner's request: applied on this iPhone now, reported back so the improvement is
  /// Verified only when the app really uses it, and shown as a banner with a haptic (the reply itself is spoken).
  Future<void> _applyOwnerUiConfig(Map<String, dynamic> uiConfig) async {
    final status = await CheOwnerConfigSync.applyReply(
      uiConfig,
      CheOwnerImprovementsClient(baseUrl: cheAgentBaseUrl, headers: () => _authHeaders),
    );
    if (!mounted || uiConfig['task_id'] == null) return;
    final ok = status == 'verified';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Semantics(
        liveRegion: true,
        child: Text(
          ok
              ? 'Applied on this iPhone and verified (${uiConfig['task_id']}).'
              : status == 'failed'
                  ? 'This iPhone could not apply it, so CHE put it back.'
                  : 'Applied on this iPhone; CHE could not record the confirmation yet.',
          style: const TextStyle(fontSize: 17),
        ),
      ),
    ));
    unawaited(_statusHaptic(ok ? 3 : 4));
  }

  /// Plays the held free sample. If it cannot play, CHE says so on screen and aloud.
  Future<void> _playPendingVoicePreview({String? requestedVoiceId}) async {
    final voiceId = requestedVoiceId ?? _pendingVoicePreviewId;
    if (requestedVoiceId == null) _pendingVoicePreviewId = null;
    if (voiceId == null) return;
    final played = await CheVoiceStudioPreview.play(voiceId: voiceId);
    if (played || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('The free sample could not play on this iPhone.')));
    unawaited(speakText('The free sample could not play on this iPhone, sir.', record: false));
  }

  Future<String?> _tryLocalOfflineResponse(
    String userMessage,
    List<Map<String, String>> history, {
    required void Function(String text) onPartial,
  }) async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return null;
    // Live repository/status claims require receipts from the connected
    // Worker/GitHub path. Never let an offline model invent files, workflows,
    // SHAs, jobs, or deployment state when that evidence is unavailable.
    if (isInstalledSkillRequest(userMessage) || cheIsAppStatusRequest(userMessage) ||
        cheTurnRequiresVerifiedRemoteEvidence(userMessage, history)) {
      return null;
    }

    // News needs articles CHE opens on her server; the offline model would
    // only guess at headlines, so she says she cannot check.
    if (cheNeedsLiveSources(userMessage)) {
      onPartial(cheOfflineNewsReply);
      return cheOfflineNewsReply;
    }

    // Saved library passages first: the owner asked CHE to remember these.
    final library = await _offlineLibrary.search(userMessage);
    // Then CHE's own Brain on the phone: memories, conversations and lessons, with their labels.
    final brainRecall = await _brainReplicaContext(userMessage);
    final local = await CheLocalAI.respond(
      userMessage,
      history: history,
      memoryContext: [...library, ...brainRecall, ..._brainContextFor(userMessage)],
    );
    if ((local == null || local.trim().isEmpty)) {
      final brain = CheLocalBrain();
      final packet = CheBootstrapPacket(
        request: userMessage,
        capabilities: const ['chat', 'memory', 'local_inference', 'office'],
        cloudHealth: 'down',
        localBrainHealth: 'active',
        currentProvider: 'local_brain',
        currentModel: cheDefaultLocalBrainModel.modelId,
        memory: [...library, ...brainRecall, ..._brainContextFor(userMessage)].take(8).toList(),
      );
      final generated = await brain.generate(
        prompt: userMessage,
        bootstrap: packet,
        history: history,
        memory: packet.memory,
      );
      final cleanBrain = generated?.trim() ?? '';
      if (cleanBrain.isEmpty) return null;
      onPartial(cleanBrain);
      return cleanBrain;
    }
    final clean = local.trim();
    if (clean.isEmpty) return null;
    onPartial(clean);
    return clean;
  }

  Future<String> _streamCheResponse(
    String userMessage,
    List<Map<String, String>> history, {
    required void Function(String text) onPartial,
  }) async {
    debugPrint('TRACE skill: enter _streamCheResponse');
    // The brain restore is local and normally instant. The owner's first reply is never held past 800 ms for it:
    // a slow restore just means that turn starts without the restored context, as a failed restore already does.
    await _cognitionReady.timeout(const Duration(milliseconds: 800), onTimeout: () {});
    debugPrint('TRACE skill: cognition ready');
    if (!await _ensurePaired()) {
      final local = await _tryLocalOfflineResponse(
        userMessage,
        history,
        onPartial: onPartial,
      );
      if (local != null) return local;
      throw const _CHEAgentException('This device is not paired.');
    }

    final trimmedRequest = userMessage.trim();
    final installedSkillRequest = isInstalledSkillRequest(trimmedRequest);
    final hasConversationContext = history.any(
      (item) => (item['content'] ?? item['text'] ?? '').trim().isNotEmpty,
    );
    final requiresVerifiedRemoteEvidence =
        cheIsAppStatusRequest(trimmedRequest) || cheTurnRequiresVerifiedRemoteEvidence(trimmedRequest, history);
    final turnCapabilities = _homeMode == 0
        ? _requestedCapabilitiesForTurn(trimmedRequest, history)
        : const <String>[];

    // Updating CHE itself is different from creating a separate owner project.
    // CHE self-code changes stay reviewable through the GitHub proposal workflow.
    // "Fix this": CHE works out what "this" is (the screen, the last thing
    // that went wrong) and has her crew rewrite or improve her own code.
    final fixThis = RegExp(
      r'^(?:(?:chay|chey|shay|che)[, ]+)?(?:please\s+)?(?:fix|repair)\s+(?:this|that|it)\b',
      caseSensitive: false,
    ).hasMatch(trimmedRequest);
    final terminalChatOnly = cheIsTerminalChatOnlyRequest(trimmedRequest);
    final codeRequest = !installedSkillRequest && !terminalChatOnly &&
        (fixThis || cheIsSelfUpdateRequest(trimmedRequest));

    final projectMatch = RegExp(
      r'\b(?:build|create|develop|write|start|make)\s+'
      r'(?:me\s+)?(?:(?:a|an|my)\s+)?'
      r'(website|site|app|book|story|screenplay|movie script|script|prototype|invention)\b',
      caseSensitive: false,
    ).firstMatch(trimmedRequest);

    // Private voice: coding jobs and new projects are worked by outside AI
    // services, so CHE says so instead of sending the words.
    if (ChePrivateVoice.isOn && (codeRequest || (!installedSkillRequest && !terminalChatOnly && projectMatch != null))) {
      const reply = 'Private voice is on, so I did not start that: coding jobs and new projects are worked on by outside AI services, and that would send your words to them. Nothing was sent. Say "turn off private voice" if you want me to go ahead.';
      onPartial(reply);
      return reply;
    }

    if (!installedSkillRequest && !terminalChatOnly && !codeRequest && projectMatch != null) {
      var projectType = projectMatch.group(1)!.toLowerCase();
      if (projectType == 'site') projectType = 'website';
      if (projectType == 'story') projectType = 'book';
      if (projectType == 'movie script' || projectType == 'script') {
        projectType = 'screenplay';
      }
      if (projectType == 'prototype') projectType = 'invention';

      var title = trimmedRequest.replaceFirst(
        RegExp(
          r'^(?:(?:chay|chey|shay|che)[, ]+)?',
          caseSensitive: false,
        ),
        '',
      );
      if (title.length > 100) title = title.substring(0, 100);

      final result = await _postAgentJson('/api/project/create', {
        'title': title,
        'type': projectType,
        'brief': trimmedRequest,
      });
      final project = result?['project'];
      await _loadAgentState(silent: true);

      // Only a project the Worker actually returned may be announced.
      final chatReply = result?['reply']?.toString() ?? '';
      if (project is! Map) {
        final reply = chatReply.isNotEmpty
            ? chatReply
            : 'I did not create a project for that, sir. Nothing was saved.';
        onPartial(reply);
        return reply;
      }
      final projectTitle = project['title']?.toString() ?? title;
      final reply =
          'I created “$projectTitle” in Creator Studio, sir. Open Create whenever you want to keep developing it.';
      onPartial(reply);
      return reply;
    }

    if (codeRequest) {
      final response = await http.post(
        Uri.parse('$cheAgentBaseUrl/api/change/request'),
        headers: {
          ..._authHeaders,
          // Announce background-job support so the Worker may answer with 202
          // and a real durable job id instead of 200 for legacy app builds.
          'x-che-background-jobs': '1',
        },
        body: jsonEncode(fixThis
            ? {'request': _fixThisRequest(trimmedRequest), 'fix_this': true}
            : {'request': userMessage.trim()}),
      );
      if (response.statusCode == 401) {
        if (await _onUnauthorized(response)) throw const _CHEAgentException('Pair this device again, sir.');
        throw const _CHEAgentException('That needs Face ID first. You are still signed in.');
      }
      Map<String, dynamic> result = const {};
      try {
        final decoded = jsonDecode(response.body);
        if (decoded is Map<String, dynamic>) result = decoded;
      } catch (_) {}
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw _CHEAgentException(
          result['detail']?.toString() ?? 'The coding job was not accepted. Nothing started.',
        );
      }
      final jobId = result['background_job_id']?.toString().trim() ?? '';
      if (jobId.isNotEmpty) {
        cheWatchedJobId.value = jobId;
        unawaited(_statusHaptic(3));
      }
      final reply = result['message']?.toString() ??
          (jobId.isEmpty
              ? 'The coding request finished without a job receipt.'
              : 'Coding job ${jobId.substring(0, jobId.length < 8 ? jobId.length : 8)} was accepted.');
      onPartial(reply);
      return reply;
    }

    // Offline knowledge first: answer from what CHE already learned (or let
    // the on-phone brain combine saved notes) before spending cloud credits.
    if (_pendingAttachment == null &&
        !installedSkillRequest &&
        !hasConversationContext &&
        !requiresVerifiedRemoteEvidence &&
        CheKnowledgeCache.cacheable(trimmedRequest)) {
      final saved = await _knowledge.answer(
        trimmedRequest,
        hasConversationContext: hasConversationContext,
      );
      if (saved != null) {
        onPartial(saved);
        return saved;
      }
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
        final notes = await _knowledge.related(trimmedRequest);
        if (notes.length >= 2 && await _knowledge.notesCover(trimmedRequest)) {
          final combined = await CheLocalAI.respond(
            'Answer the question using ONLY the saved notes. If the notes do not fully answer it, reply exactly UNKNOWN.\n\nQuestion: $trimmedRequest',
            history: const [],
            memoryContext: notes,
          ).catchError((_) => null);
          final clean = combined?.trim() ?? '';
          if (clean.length > 12 && !clean.toUpperCase().contains('UNKNOWN')) {
            onPartial(clean);
            return clean;
          }
        }
      }
    }

    final request = http.Request(
      'POST',
      Uri.parse('$cheAgentBaseUrl/api/chat'),
    );
    debugPrint('TRACE skill: request built');

    request.headers.addAll(_authHeaders);
    // A command approved on the Command Center page counts for this one turn,
    // and only for the exact text that was approved.
    final commandConfirmed = _pendingCommandConfirmedFor != null && _pendingCommandConfirmedFor == userMessage.trim();
    _pendingCommandConfirmedFor = null;
    if (mounted) _set(() => _commandSuggestions = const []);
    final explainLevel = _deeperOnce ? 'deeper' : _explainLevel;
    _deeperOnce = false;
    // The Worker enforces the app ask-first gate against these grants, so
    // every turn carries what the owner has already said yes to.
    final appGrants = await CheAppPermissions.granted();
    final installedBuild = cheIsAppStatusRequest(userMessage)
        ? await CheInstalledBuild.read().timeout(const Duration(seconds: 2), onTimeout: () => null)
        : null;
    final installedPatch = installedBuild == null
        ? null
        : await CheInstalledBuild.readPatch().timeout(const Duration(seconds: 2), onTimeout: () => null);
    request.body = jsonEncode({
      'message': userMessage,
      if (installedBuild != null) 'client_app': installedBuild.chatMetadata(patch: installedPatch),
      'history': history,
      'last_media_id': _lastMediaId(),
      'request_id': _requestGate.current.requestId,

      // Future-ready fields for a tool-capable CHE Agent gateway.
      'owner_mode': strictOwnerMode,
      'wake_phrase': 'Chay',
      'requested_capabilities': turnCapabilities,
      'screen_context': _pendingScreenContext,
      // The page in front of the owner, so "this page is too cramped" knows which page (Owner Improvements).
      if (CheScreenAwareness.current?.page case final String page) 'active_screen': page,
      // The image or video project open in Visual Studio, so "make this brighter" edits that project.
      ...CheVisualSession.chatFields(),
      'attachment': _pendingAttachment,
      'app_grants': appGrants.toList(),
      'command_confirmed': commandConfirmed,
      'dismissed_suggestions': _commandStore.dismissed.toList(),
      'client_identity_profile': _cheIdentityProfile,
      'client_personality_profile': learnedPersonality,
      // CHE's soul, for the browsing loop: each step is planned as her. The Worker reads it only in a loop request.
      'soul': _brain.soul,
      // A memory that holds a secret shape is never sent, even one a replica brought in from before the gate.
      'client_memories': savedMemories.where((m) => !cheBrainTextIsSensitive(m)).toList(),
      'brain_context': _brainContextFor(userMessage),
      'plugin_instructions': _pluginInstructionsFor(userMessage),
      'plugin_tools': _skillPlugins.tools(),
      'client_time': {
        'local_iso': DateTime.now().toIso8601String(),
        'timezone_name': DateTime.now().timeZoneName,
        'utc_offset_minutes': DateTime.now().timeZoneOffset.inMinutes,
      },
      'agent_mode': _homeMode == 0 ? 'full' : 'chat',
      'proactive_mode': true,
      'explain_level': explainLevel,
      'reply_language': _replyLanguage,
      'plugin_recommendations': true,
      // Private voice: the Worker answers with Cloudflare Workers AI only and
      // refuses tools that would send these words to anyone else.
      ...ChePrivateVoice.chatFields(),
      'client': {
        'platform': kIsWeb ? 'web' : 'flutter',
        'open_conversation': openConversation,
        'wake_phrase_mode': wakePhraseMode,
        'voice_enabled': voiceResponsesEnabled,
      },
    });

    http.StreamedResponse response;
    try {
      // The Worker answers once CHE has finished thinking (agents, plugins,
      // research), which can take well over 8s. Only a dead connection
      // falls back to the on-device model.
      response = await request.send().timeout(const Duration(seconds: 75));
    } catch (error) {
      final local = await _tryLocalOfflineResponse(
        trimmedRequest,
        history,
        onPartial: onPartial,
      );
      if (local != null) return local;
      final detail = error.toString().trim();
      throw _CHEAgentException(
        CheOwnerError.fromRaw(detail.isEmpty ? 'gateway unreachable' : detail).message,
      );
    }

    if (response.statusCode == 401) {
      final body = await response.stream.bytesToString();
      if (await _onUnauthorized(http.Response(body, 401))) {
        throw const _CHEAgentException('This phone was signed out of CHE. Pair this device again.');
      }
      throw const _CHEAgentException('That needs Face ID first. You are still signed in.');
    }

    if (response.statusCode != 200) {
      final body = await response.stream.bytesToString();
      final lower = body.toLowerCase();
      final cloudFailure = response.statusCode == 429 ||
          response.statusCode >= 500 ||
          lower.contains('quota') ||
          lower.contains('neurons') ||
          lower.contains('daily limit') ||
          lower.contains('allowance') ||
          lower.contains('engines failed') ||
          lower.contains('temporarily unavailable');

      if (cloudFailure) {
        final local = await _tryLocalOfflineResponse(
          trimmedRequest,
          history,
          onPartial: onPartial,
        );
        if (local != null) return local;
      }

      throw _CHEAgentException(
        CheOwnerError.fromRaw(
          'CHE Agent error ${response.statusCode}: $body',
          status: response.statusCode,
        ).message,
      );
    }

    final complete = StringBuffer();
    _streamMediaUrl = null;
    _streamMediaType = null;
    _streamUnderstoodAs = null;
    _streamResponseDetails = null;
    _streamRecordIds = const [];

    await for (final line in response.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())) {
      if (_stopRequested) break;
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;

      final data = jsonDecode(trimmed);
      final type = data['type']?.toString();

      // Owner-approval holds are ordinary JSON from the Worker, not NDJSON
      // "delta" events. Always show and speak the actual question instead
      // of silently discarding it and reporting an empty response.
      if (type == null && data['held_for_owner'] == true) {
        _streamUnderstoodAs = cheUnderstoodAs(data);
        final question = data['message']?.toString() ?? data['reply']?.toString() ?? '';
        if (question.isNotEmpty) {
          complete.write(question);
          onPartial(complete.toString());
        }
        continue;
      }

      if (type == 'error') {
        final message = data['message']?.toString() ?? 'Unknown CHE Agent error.';
        final lower = message.toLowerCase();
        if (lower.contains('quota') ||
            lower.contains('daily limit') ||
            lower.contains('allowance') ||
            lower.contains('engines failed') ||
            lower.contains('temporarily unavailable')) {
          final local = await _tryLocalOfflineResponse(
            trimmedRequest,
            history,
            onPartial: onPartial,
          );
          if (local != null) return local;
        }
        throw _CHEAgentException(CheOwnerError.fromRaw(message).message);
      }

      if (type == 'step') {
        final text = data['text']?.toString() ?? '';
        if (text.isNotEmpty && mounted) {
          _set(() {
            _liveSteps.add(CheLiveStep(
              text: text,
              agentId: data['agent_id']?.toString(),
              agentName: data['agent']?.toString(),
            ));
          });
          _scrollToBottom();
        }
        continue;
      }

      if (type == 'delta') {
        final delta = data['delta']?.toString() ?? '';
        if (delta.isEmpty) continue;

        complete.write(delta);
        onPartial(complete.toString());
      }

      // Suggestion cards of real commands, sent after the answer. Shown under
      // the reply; nothing runs from them.
      if (type == 'command_suggestions') {
        final cards = cheSuggestionsFrom(data);
        if (mounted && cards.isNotEmpty) _set(() => _commandSuggestions = cards);
        continue;
      }

      if (type == 'tool_result') {
        final toolText = data['text']?.toString() ?? '';
        if (toolText.isNotEmpty) {
          if (complete.isNotEmpty) complete.write('\n');
          complete.write(toolText);
          onPartial(complete.toString());
        }
      }

      if (type == 'done') {
        _streamUnderstoodAs = cheUnderstoodAs(data);
        _streamResponseDetails = cheResponseDetails(data);
        _streamRecordIds = cheRecordIdsOf(data['record_ids']);
        // "Open the workflows page": only the Workflow Engine's own reply opens it.
        if (data['open_screen'] == 'app_details' && data['source'] == 'che_runtime_status' && mounted) unawaited(_openAppVersionDetails());
        if (data['open_screen'] == 'workflows' && data['source'] == 'che_workflow_engine' && mounted) unawaited(_openWorkflows());
        if (data['open_screen'] == 'security' && data['source'] == 'che_security' && mounted) unawaited(_openSecurity(section: data['security_section']?.toString()));
        if (data['open_screen'] == 'film_studio' && data['source'] == 'che_film_studio' && mounted) unawaited(_openFilmStudio());
        if (data['open_screen'] == 'recording_studio' && data['source'] == 'che_recording_studio' && mounted) unawaited(_openRecordingStudio());
        // "Open your cloud computer": only the Cloud Computer Manager's own reply opens the room.
        if (data['open_screen'] == 'cloud_computer' && data['source'] == 'che_cloud_computer' && mounted) unawaited(_openCloudComputer());
        // "/privacy-center": only the Worker's Privacy Center route opens the room; its data stays on this iPhone.
        if (data['open_screen'] == 'privacy_center' && data['source'] == 'che_privacy_center' && mounted) {
          unawaited(_openPrivacyCenter(action: data['privacy_action']?.toString() ?? ''));
        }
        // "How many characters live in CHE World?": the Worker's population answer also shows the three counts on screen.
        if (data['open_screen'] == 'world_population' && data['source'] == 'che_world_population' && mounted) unawaited(_openWorldPopulation());
        // "Connect GPU" matched by the Worker (/cloud-gpu connect): the owner's own command, so the flow may open Colab.
        if (data['open_screen'] == 'gpu_connect' && data['source'] == 'che_cloud_computer' && mounted) {
          _configureGpuConnect();
          CheGpuConnect.instance.start('/cloud-gpu connect');
          unawaited(_showGpuBrowser());
        }
        // "Open Truth and Verification": only the Worker's own truth handler opens the Brain Room section.
        if (data['open_screen'] == 'brain_truth' && data['source'] == 'che_brain_truth' && mounted) unawaited(_openBrainTruth());
        // Owner Improvements: a setting CHE changed applies here at once, and the app reports what it now uses.
        if (data['source'] == 'che_owner_improvement') {
          if (data['open_screen'] == 'owner_improvements' && mounted) unawaited(_openOwnerImprovements());
          final uiConfig = data['ui_config'];
          if (uiConfig is Map) unawaited(_applyOwnerUiConfig(Map<String, dynamic>.from(uiConfig)));
        }
        // Only the trusted deterministic trading handlers can request this room.
        if (data['open_screen'] == 'trading_room' &&
            const {'che_trading_live', 'che_trading_ledgers', 'che_trading_desk'}.contains(data['source']) &&
            mounted) {
          // The section the reply names ("Show strategy progress" → STRATEGIES), for an open room too.
          final chart = data['chart'];
          if (chart is Map && chart['section'] != null) CheTradingRoom.requestedSection.value = cheTradingSectionNamed('${chart['section']}');
          if (!_assistantHubOpen) _openAssistantHub(tab: 1);
        }
        // "Preview number three": the reply names a free sample from the provider's own
        // library. It is held here and played by send.dart once CHE has finished saying
        // the reply, so the two never talk over each other.
        final voicePreview = data['voice_preview'];
        if (voicePreview is Map && voicePreview['voice_id'] is String) {
          _pendingVoicePreviewId = voicePreview['voice_id'] as String;
        }
        if (data['source'] == 'che_installed_skills' && mounted) {
          final ok = data['ok'] == true;
          // The delta pipeline speaks the result. This receipt adds visible
          // and screen-reader status without starting another spoken turn.
          ScaffoldMessenger.of(context).showSnackBar(cheInstalledSkillReceiptBar(ok));
          unawaited(_statusHaptic(ok ? 3 : 4));
        }
        // "Start a meeting with the team about X": the Worker convened a real War Room
        // meeting; the Meeting Room shows it as it happens (Spatial World MVP 1).
        final meetingId = data['meeting_id']?.toString().trim() ?? '';
        if (data['source'] == 'che_meeting_room' && meetingId.isNotEmpty && mounted) {
          unawaited(cheOpenMeetingRoom(
            context,
            client: _agentRuntime,
            id: meetingId,
            onSpeak: (text) => speakText(text, record: false),
            onBackToOffice: () => _goShellTab(2),
          ));
        }
        // "Show me my Alpaca trades": the Alpaca PAPER dashboard opens beside the spoken summary (owner, 2026-10-20).
        if (data['open_view'] == 'trading_controls' && mounted) {
          unawaited(Navigator.of(context).push(CheStrategyControlsPage.route(baseUrl: () => cheAgentBaseUrl, headers: () => _authHeaders, onAsk: _runHubPrompt)));
        }
        // "Open Alpaca chart", "CHE, show EMA trades", "Draw a line at 21,450": the Trading Room on
        // the section, account, symbol and strategy the Worker named (Build 1).
        // "What setups are ready?": the setups live on this iPhone, so the answer is read from the
        // Signal Mode desk here and added to the Worker's reply (an explicit question, so it is spoken).
        final setupsAsk = data['chart'] is Map ? data['chart'] as Map : const {};
        if (data['open_view'] == 'trading_chart' && setupsAsk['section'] == 'setups' && setupsAsk['answer'] == 'ready') {
          if (complete.isNotEmpty) complete.write(' ');
          complete.write((CheSetupDesk.instance..attach()).spokenSummary());
          onPartial(complete.toString());
        }
        if (data['open_view'] == 'trading_chart' && mounted) {
          // "Set CHE paper balance to 500": the CHE PAPER ACCOUNT opens the change for the owner to confirm.
          final paperBalance = data['paper_balance'];
          if (data['source'] == 'che_trading_chart' && paperBalance is num && paperBalance > 0) ChePaperAccountPanel.requestedBalance.value = paperBalance.toDouble();
          unawaited(Navigator.of(context).push(CheTradingRoomPage.route(
            baseUrl: () => cheAgentBaseUrl,
            headers: () => _authHeaders,
            onAsk: _runHubPrompt,
            onRead: (words) { speakText(words, record: false, readOnDemand: true); },
            chart: data['chart'] is Map<String, dynamic> ? data['chart'] as Map<String, dynamic> : null,
          )));
        }
        // "Replay my last trade", "replay trade T0…": the trade on its own stored bars (owner mission, Priority 5).
        final replayId = data['trade_id']?.toString().trim() ?? '';
        if (data['open_view'] == 'trade_replay' && replayId.isNotEmpty && mounted) {
          unawaited(Navigator.of(context).push(CheTradeReplayPage.route(
            tradeId: replayId,
            baseUrl: () => cheAgentBaseUrl,
            headers: () => _authHeaders,
            onRead: (words) { speakText(words, record: false, readOnDemand: true); },
          )));
        }
        // "Open my trading calendar", "show the office calendar for September", "what did we do yesterday" (che_calendars.js).
        final calendarAsk = data['calendar'] is Map ? Map<String, dynamic>.from(data['calendar'] as Map) : const <String, dynamic>{};
        if (data['open_view'] == 'trading_calendar' && mounted) {
          unawaited(Navigator.of(context).push(CheTradingCalendarPage.route(
            baseUrl: () => cheAgentBaseUrl,
            headers: () => _authHeaders,
            onRead: (words) { speakText(words, record: false, readOnDemand: true); },
            month: '${calendarAsk['month'] ?? ''}',
            source: '${calendarAsk['source'] ?? 'paper'}',
            day: '${calendarAsk['day'] ?? ''}',
            basis: '${calendarAsk['basis'] ?? 'owner'}',
          )));
        }
        if (data['open_view'] == 'office_calendar' && mounted) {
          unawaited(Navigator.of(context).push(CheOfficeCalendarPage.route(
            baseUrl: () => cheAgentBaseUrl,
            headers: () => _authHeaders,
            onRead: (words) { speakText(words, record: false, readOnDemand: true); },
            month: '${calendarAsk['month'] ?? ''}',
            day: '${calendarAsk['day'] ?? ''}',
          )));
        }
        // "Have Orion research BTC and ETH…", "how is crypto paper trading going": the Trading Room on its CRYPTO market.
        if (data['open_view'] == 'trading_crypto' && mounted) {
          unawaited(Navigator.of(context).push(CheTradingRoomPage.route(
            baseUrl: () => cheAgentBaseUrl,
            headers: () => _authHeaders,
            onAsk: _runHubPrompt,
            onRead: (words) { speakText(words, record: false, readOnDemand: true); },
            chart: const {'section': 'crypto'},
          )));
        }
        if (data['open_view'] == 'alpaca_paper' && mounted) {
          unawaited(Navigator.of(context).push(CheAlpacaPaperPage.route(baseUrl: () => cheAgentBaseUrl, headers: () => _authHeaders, onAsk: _runHubPrompt)));
        }
        // "CHE, connect Hugging Face": only the Worker's onboarding reply opens the onboarding screen. The owner's
        // own words named the service, so that is recorded as his permission for it before anything is opened.
        final onboarding = data['onboarding'];
        if (data['open_screen'] == 'service_onboarding' && data['source'] == 'che_onboarding' && onboarding is Map && mounted) {
          final provider = '${onboarding['provider'] ?? ''}';
          unawaited(CheAppPermissions.grant(provider == 'huggingface' ? 'hugging face' : provider).then((_) {
            if (!mounted) return;
            unawaited(Navigator.of(context).push(CheServiceOnboardingScreen.route(
              baseUrl: cheAgentBaseUrl,
              headers: () => _authHeaders,
              onboarding: Map<String, dynamic>.from(onboarding),
              onSpeak: (text) => speakText(text, record: false),
            )));
          }));
        }
        // "Design a wearable robotics prototype…": the Worker made a plan; the Plan Room shows it.
        final planId = data['plan_id']?.toString().trim() ?? '';
        if (data['source'] == 'che_project_plan' && planId.isNotEmpty && data['follow_up'] == null && mounted) {
          unawaited(Navigator.of(context).push(ChePlanRoom.route(
            load: _agentRuntime.planScene,
            planId: planId,
            onSpeak: (text) => speakText(text, record: false),
          )));
        }
        // "Find the closest realistic solution": the Worker ran the lab; the Simulation Lab shows the run.
        final simId = data['sim_id']?.toString().trim() ?? '';
        if (data['source'] == 'che_sim_lab' && simId.isNotEmpty && mounted) {
          unawaited(Navigator.of(context).push(CheSimLabPage.route(
            load: _agentRuntime.simScene,
            simId: simId,
            onSpeak: (text) => speakText(text, record: false),
          )));
        }
        final mediaUrl = data['media_url']?.toString().trim() ?? '';
        final mediaType = data['media_type']?.toString().trim() ?? '';
        if (mediaUrl.startsWith('https://')) {
          _streamMediaUrl = mediaUrl;
          _streamMediaType = mediaType;
        }
        // "Open it in 3D", "rotate it", "change the color": the Worker built or found the invention's saved 3D model.
        final inventionId = data['invention_id']?.toString().trim() ?? '';
        if (data['open_invention_3d'] == true && inventionId.isNotEmpty && mounted) {
          final move = data['viewport'];
          unawaited(Navigator.of(context).push(CheInventionViewer.route(
            baseUrl: cheAgentBaseUrl,
            headers: _authHeaders,
            inventionId: inventionId,
            title: 'Invention $inventionId',
            version: data['model_version'] is int ? data['model_version'] as int : null,
            initialCommand: move is Map ? Map<String, Object>.from(move) : null,
            onSpeak: (text) => speakText(text, record: false),
          )));
        }
        // "Open this same picture in my Creation Room": the Worker named the saved file; the Creation Room shows it.
        final openId = data['media_id']?.toString().trim() ?? '';
        if (data['open_creation'] == true && openId.isNotEmpty && mounted) {
          unawaited(Navigator.of(context).push(MaterialPageRoute<void>(
            builder: (_) => CheCreationViewer(
              item: {'id': openId, 'kind': mediaType == 'video' ? 'video' : 'image', 'title': 'Creation'},
              baseUrl: cheAgentBaseUrl,
              headers: _authHeaders,
            ),
          )));
        }
        // "Open number two": the owner asked for this link by voice in this
        // turn; open it and report the actual outcome aloud.
        final openUrl = data['open_url']?.toString().trim() ?? '';
        final openUri = Uri.tryParse(openUrl);
        if (openUrl.startsWith('https://') && openUri != null) {
          var opened = false;
          try {
            opened = await launchUrl(openUri, mode: LaunchMode.externalApplication);
          } catch (_) {}
          if (complete.isNotEmpty) complete.write('\n');
          complete.write(opened ? 'Opened it, sir.' : 'I could not open that link on this iPhone, sir.');
          onPartial(complete.toString());
        }
      }
    }

    _pendingScreenContext = null;
    final hadAttachment = _pendingAttachment != null;
    _pendingAttachment = null;
    if (mounted) _set(() {});
    final finalText = complete.toString().trim();
    if (!installedSkillRequest && !hadAttachment && _streamMediaUrl == null) {
      unawaited(_knowledge.remember(trimmedRequest, finalText));
    }
    return finalText;
  }

  /// The saved picture or video the chat showed last, so "open this same picture" needs no ID from the owner.
  String _lastMediaId() {
    for (final item in messages.reversed) {
      final match = RegExp(r'/api/media/([0-9a-fA-F-]{36})/').firstMatch(item['media_url'] ?? '');
      if (match != null) return match.group(1)!;
    }
    return '';
  }

  /// Turns "fix this" into a full brief for the coding crew.
  String _fixThisRequest(String spoken) {
    final recent = messages.length > 6 ? messages.sublist(messages.length - 6) : List.of(messages);
    final convo = recent
        .where((m) => (m['text'] ?? '').trim().isNotEmpty)
        .map((m) {
          final t = (m['text'] ?? '').trim();
          return '${m['role'] == 'user' ? 'Owner' : 'CHE'}: ${t.length > 400 ? '${t.substring(0, 400)}…' : t}';
        })
        .join('\n');
    final screen = _pendingScreenContext;
    final brief = StringBuffer()
      ..writeln('The owner said "$spoken". Work out what "this" is: the last thing that failed or looked wrong in the conversation below, or the screen he is on. Then fix it in CHE\'s own code.')
      ..writeln('How: find the real cause, then rewrite or improve that code so it works better than before. If stronger approaches exist in the reference projects provided, learn their technique and write CHE\'s own version: no copy-paste, respect licenses, credit sources in the PR. Keep the change small and tested.')
      ..writeln('Owner is on shell tab $_shellTab.');
    if (screen != null && screen.isNotEmpty) {
      brief.writeln('Screen: ${screen.length > 600 ? screen.substring(0, 600) : screen}');
    }
    brief
      ..writeln('Recent conversation:')
      ..writeln(convo);
    final text = brief.toString();
    return text.length > 3900 ? text.substring(0, 3900) : text;
  }
}
