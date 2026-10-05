part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (streaming).
extension _CheHomeStreaming on _CHEHomeState {
  Future<String?> _tryLocalOfflineResponse(
    String userMessage,
    List<Map<String, String>> history, {
    required void Function(String text) onPartial,
  }) async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return null;

    // Saved library passages first: the owner asked CHE to remember these.
    final library = await _offlineLibrary.search(userMessage);
    final local = await CheLocalAI.respond(
      userMessage,
      history: history,
      memoryContext: [...library, ..._brainContextFor(userMessage)],
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
        memory: [...library, ..._brainContextFor(userMessage)].take(8).toList(),
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
    await _cognitionReady;

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
    final hasConversationContext = history.any(
      (item) => (item['content'] ?? item['text'] ?? '').trim().isNotEmpty,
    );
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
    final codeRequest = !terminalChatOnly &&
        (fixThis || cheIsSelfUpdateRequest(trimmedRequest));

    final projectMatch = RegExp(
      r'\b(?:build|create|develop|write|start|make)\s+'
      r'(?:me\s+)?(?:(?:a|an|my)\s+)?'
      r'(website|site|app|book|story|screenplay|movie script|script|prototype|invention)\b',
      caseSensitive: false,
    ).firstMatch(trimmedRequest);

    if (!codeRequest && projectMatch != null) {
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

      final projectTitle = project is Map
          ? project['title']?.toString() ?? title
          : title;
      final reply =
          'I created “$projectTitle” in Creator Studio, sir. Open Create whenever you want to keep developing it.';
      onPartial(reply);
      return reply;
    }

    if (codeRequest) {
      final response = await http.post(
        Uri.parse('$cheAgentBaseUrl/api/change/request'),
        headers: _authHeaders,
        body: jsonEncode(fixThis
            ? {'request': _fixThisRequest(trimmedRequest), 'fix_this': true}
            : {'request': userMessage.trim()}),
      );
      if (response.statusCode == 401) {
        await _clearSecuritySession();
        throw const _CHEAgentException('Pair this device again, sir.');
      }
      final result = jsonDecode(response.body) as Map<String, dynamic>;
      if (response.statusCode != 200) {
        throw _CHEAgentException(
          result['detail']?.toString() ?? 'The code proposal could not start.',
        );
      }
      final reply = result['message']?.toString() ?? 'Proposal started.';
      onPartial(reply);
      return reply;
    }

    // Offline knowledge first: answer from what CHE already learned (or let
    // the on-phone brain combine saved notes) before spending cloud credits.
    if (_pendingAttachment == null &&
        !hasConversationContext &&
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

    request.headers.addAll(_authHeaders);
    final explainLevel = _deeperOnce ? 'deeper' : _explainLevel;
    _deeperOnce = false;
    request.body = jsonEncode({
      'message': userMessage,
      'history': history,
      'request_id': _requestGate.current.requestId,

      // Future-ready fields for a tool-capable CHE Agent gateway.
      'owner_mode': strictOwnerMode,
      'wake_phrase': 'Chay',
      'requested_capabilities': turnCapabilities,
      'screen_context': _pendingScreenContext,
      'attachment': _pendingAttachment,
      'client_identity_profile': _cheIdentityProfile,
      'client_personality_profile': learnedPersonality,
      'client_memories': savedMemories,
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
      await _clearSecuritySession();
      throw const _CHEAgentException(
        'Your CHE security session expired. Pair this device again.',
      );
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

    await for (final line in response.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())) {
      if (_stopRequested) break;
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;

      final data = jsonDecode(trimmed);
      final type = data['type']?.toString();

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

      if (type == 'tool_result') {
        final toolText = data['text']?.toString() ?? '';
        if (toolText.isNotEmpty) {
          if (complete.isNotEmpty) complete.write('\n');
          complete.write(toolText);
          onPartial(complete.toString());
        }
      }

      if (type == 'done') {
        final mediaUrl = data['media_url']?.toString().trim() ?? '';
        final mediaType = data['media_type']?.toString().trim() ?? '';
        if (mediaUrl.startsWith('https://')) {
          _streamMediaUrl = mediaUrl;
          _streamMediaType = mediaType;
        }
      }
    }

    _pendingScreenContext = null;
    final hadAttachment = _pendingAttachment != null;
    _pendingAttachment = null;
    if (mounted) _set(() {});
    final finalText = complete.toString().trim();
    if (!hadAttachment && _streamMediaUrl == null) {
      unawaited(_knowledge.remember(trimmedRequest, finalText));
    }
    return finalText;
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
