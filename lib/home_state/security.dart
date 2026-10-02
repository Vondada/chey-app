part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (security).
extension _CheHomeSecurity on _CHEHomeState {
  Map<String, String> get _authHeaders => {
        'Content-Type': 'application/json',
        if (_deviceToken != null) 'Authorization': 'Bearer $_deviceToken',
      };

  Future<void> _loadSecuritySession() async {
    final prefs = await SharedPreferences.getInstance();
    _restoreLocalSnapshotCache(prefs);
    _agentBaseUrl = prefs.getString('che_agent_base_url') ?? _defaultAgentBaseUrl;
    _replyLanguage = prefs.getString('che_reply_language') ?? 'en';
    _translateTarget = prefs.getString('che_translate_target') ?? 'es';
    final savedHomeBaseUrl = (prefs.getString(_homeBaseUrlKey) ?? '').trim();
    _homeBaseUrl = savedHomeBaseUrl.endsWith('/')
        ? savedHomeBaseUrl.substring(0, savedHomeBaseUrl.length - 1)
        : savedHomeBaseUrl;
    _deviceToken = prefs.getString('che_agent_device_token');

    if (_deviceToken != null && _deviceToken!.isNotEmpty) {
      await _loadAgentState(silent: true);
      unawaited(
        Future.delayed(
          const Duration(seconds: 3),
          _checkProactiveSuggestion,
        ),
      );

      if (kIsWeb) {
        openConversation = true;
        _rearmWebMicSoon(
          delay: const Duration(milliseconds: 900),
        );
      }
    }

    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      unawaited(_initNativeIosVoice());
    }

    if (mounted) _set(() {});
  }

  Future<void> _clearSecuritySession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('che_agent_device_token');

    _deviceToken = null;
    savedMemories = [];
    learnedPersonality = [];

    if (mounted) _set(() {});
  }

  Future<void> _checkProactiveSuggestion() async {
    if (!proactiveMode ||
        _deviceToken == null ||
        _deviceToken!.isEmpty ||
        _isSending ||
        _isSpeaking ||
        _realtimeVoice?.connected == true) {
      return;
    }

    try {
      final response = await http.post(
        Uri.parse('$cheAgentBaseUrl/api/proactive/check'),
        headers: _authHeaders,
        body: jsonEncode({
          'client_time': {
            'local_iso': DateTime.now().toIso8601String(),
            'timezone_name': DateTime.now().timeZoneName,
            'utc_offset_minutes': DateTime.now().timeZoneOffset.inMinutes,
          },
        }),
      );

      if (response.statusCode == 401) {
        await _clearSecuritySession();
        return;
      }
      if (response.statusCode != 200) return;

      final data = jsonDecode(response.body) as Map<String, dynamic>;
      final suggestion = data['suggestion']?.toString().trim() ?? '';
      if (suggestion.isEmpty) return;

      final alreadyShown = messages.any(
        (item) =>
            item['role'] == 'assistant' &&
            item['text']?.trim() == suggestion,
      );
      if (alreadyShown || !mounted) return;

      _set(() {
        suggestions = [suggestion, ...suggestions.where((s) => s != suggestion)]
            .take(30)
            .toList();
        messages.add({
          'role': 'assistant',
          'text': suggestion,
        });
      });

      _scrollToBottom();
      if (voiceResponsesEnabled && openConversation) {
        await speakText(suggestion);
      }
    } catch (_) {}
  }

  Future<bool> _showAgentServerDialog() async {
    if (kIsWeb) return true;
    final urlController = TextEditingController(text: cheAgentBaseUrl);
    final homeBaseController = TextEditingController(text: _homeBaseUrl);
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        String? errorText;
        return StatefulBuilder(
          builder: (dialogContext, setDialogState) => AlertDialog(
            title: const Text('CHE server address'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('Paste the HTTPS address of your CHE Agent server.'),
                const SizedBox(height: 12),
                TextField(
                  controller: urlController,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Server URL',
                    hintText: 'https://your-che-server.example',
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: homeBaseController,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  onSubmitted: (value) async {
                    final homeBase = value.trim().replaceFirst(RegExp(r'/$'), '');
                    final prefs = await SharedPreferences.getInstance();
                    await prefs.setString(_homeBaseUrlKey, homeBase);
                    _homeBaseUrl = homeBase;
                    if (mounted) _set(() {});
                  },
                  decoration: const InputDecoration(
                    labelText: 'Home base URL',
                    hintText: 'http://192.168.x.x:8787',
                  ),
                ),
                if (errorText != null) Text(errorText!,
                    style: const TextStyle(color: Colors.redAccent)),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('CANCEL'),
              ),
              FilledButton(
                onPressed: () async {
                  final raw = urlController.text.trim();
                  final uri = Uri.tryParse(raw);
                  final local = uri != null &&
                      (uri.host == 'localhost' ||
                          uri.host == '127.0.0.1' ||
                          uri.host == '10.0.2.2');
                  if (uri == null || uri.host.isEmpty ||
                      (uri.scheme != 'https' && !(local && uri.scheme == 'http')) ||
                      uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment ||
                      (uri.path.isNotEmpty && uri.path != '/')) {
                    setDialogState(() => errorText =
                        'Use an HTTPS server address without a path or login.');
                    return;
                  }
                  final address = raw.replaceFirst(RegExp(r'/$'), '');
                  final homeBase = homeBaseController.text.trim().replaceFirst(RegExp(r'/$'), '');
                  final prefs = await SharedPreferences.getInstance();
                  if (address != cheAgentBaseUrl) {
                    await prefs.remove('che_agent_device_token');
                    _deviceToken = null;
                    savedMemories = [];
                    learnedPersonality = [];
                  }
                  await prefs.setString('che_agent_base_url', address);
                  await prefs.setString(_homeBaseUrlKey, homeBase);
                  _agentBaseUrl = address;
                  _homeBaseUrl = homeBase;
                  if (mounted) _set(() {});
                  if (dialogContext.mounted) Navigator.pop(dialogContext, true);
                },
                child: const Text('SAVE'),
              ),
            ],
          ),
        );
      },
    );
    urlController.dispose();
    homeBaseController.dispose();
    return saved == true;
  }

  Future<bool> _ensurePaired() async {
    if (cheAgentBaseUrl.isEmpty) {
      if (!await _showAgentServerDialog()) return false;
    }
    if (_deviceToken != null && _deviceToken!.isNotEmpty) {
      return true;
    }

    return _showPairingDialog();
  }

  Future<bool> _showPairingDialog() async {
    if (cheAgentBaseUrl.isEmpty && !await _showAgentServerDialog()) {
      return false;
    }
    final pairController = TextEditingController();
    final deviceController = TextEditingController(
      text: kIsWeb
          ? 'CHE Web'
          : defaultTargetPlatform == TargetPlatform.iOS
              ? 'CHE iPhone'
              : 'CHE Android',
    );

    if (!mounted) {
      pairController.dispose();
      deviceController.dispose();
      return false;
    }

    final result = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) {
        bool pairing = false;
        String? errorText;

        return StatefulBuilder(
          builder: (context, setDialogState) {
            Future<void> pair() async {
              final code = pairController.text.trim();
              final deviceName = deviceController.text.trim();

              if (code.isEmpty) {
                setDialogState(() {
                  errorText = 'Enter the pairing code shown on your Windows PC.';
                });
                return;
              }

              setDialogState(() {
                pairing = true;
                errorText = null;
              });

              try {
                final response = await http.post(
                  Uri.parse('$cheAgentBaseUrl/api/pair'),
                  headers: const {'Content-Type': 'application/json'},
                  body: jsonEncode({
                    'code': code,
                    'device_name':
                        deviceName.isEmpty ? 'CHE device' : deviceName,
                  }),
                );

                if (response.statusCode != 200) {
                  final data = jsonDecode(response.body);
                  throw Exception(
                    data['detail']?.toString() ?? 'Pairing failed.',
                  );
                }

                final data = jsonDecode(response.body);
                final token = data['device_token']?.toString();

                if (token == null || token.isEmpty) {
                  throw Exception('The agent did not return a device token.');
                }

                final prefs = await SharedPreferences.getInstance();
                await prefs.setString('che_agent_device_token', token);
                _deviceToken = token;

                if (!context.mounted) return;
                Navigator.of(context).pop(true);
              } catch (e) {
                setDialogState(() {
                  pairing = false;
                  errorText = e.toString().replaceFirst('Exception: ', '');
                });
              }
            }

            return AlertDialog(
              backgroundColor: const Color(0xFF162532),
              title: const Text('PAIR WITH C.H.E. AGENT'),
              content: SizedBox(
                width: 420,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      'Enter the one-time pairing code from your CHE Agent '
                      'server. This pairs your phone once; it is separate '
                      'from SideStore’s weekly app refresh.',
                      style: TextStyle(color: Colors.white70),
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: pairController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Pairing code',
                        hintText: '123456',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: deviceController,
                      decoration: const InputDecoration(
                        labelText: 'Device name',
                      ),
                    ),
                    if (errorText != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        errorText!,
                        style: const TextStyle(color: Colors.redAccent),
                      ),
                    ],
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: pairing
                      ? null
                      : () => Navigator.of(context).pop(false),
                  child: const Text('CANCEL'),
                ),
                FilledButton(
                  onPressed: pairing ? null : pair,
                  child: Text(pairing ? 'PAIRING...' : 'PAIR'),
                ),
              ],
            );
          },
        );
      },
    );

    pairController.dispose();
    deviceController.dispose();

    if (result == true) {
      await _loadAgentState();

      if (kIsWeb) {
        openConversation = true;
        _rearmWebMicSoon(
          delay: const Duration(milliseconds: 650),
        );
      }

      return true;
    }

    return false;
  }

  Future<void> _loadAgentState({bool silent = false}) async {
    if (_deviceToken == null || _deviceToken!.isEmpty) return;
    if (_loadingAgentState) return;

    _loadingAgentState = true;

    try {
      final response = await http.get(
        Uri.parse('$cheAgentBaseUrl/api/state'),
        headers: _authHeaders,
      );

      if (response.statusCode == 401) {
        await _clearSecuritySession();
        return;
      }

      if (response.statusCode != 200) return;

      // Keep the phone's copy of CHE's library current for offline recall.
      unawaited(_offlineLibrary.sync(cheAgentBaseUrl, _authHeaders));
      unawaited(_refreshMailboxBadge());

      final data = jsonDecode(response.body);

      final memoryData = (data['memories'] as List?) ?? const [];
      final memoryRecordData = (data['memory_records'] as List?) ?? const [];
      final personalityData = (data['personality'] as List?) ?? const [];
      final knowledgeData = (data['learned_knowledge'] as List?) ?? const [];
      final suggestionData = (data['suggestions'] as List?) ?? const [];
      final projectData = (data['projects'] as List?) ?? const [];
      final memoryNoteData = (data['memory_notes'] as List?) ?? const [];
      final brainGraphData = (data['brain_graph'] is Map)
          ? Map<String, dynamic>.from(data['brain_graph'] as Map)
          : <String, dynamic>{};
      final brainNodeData = (brainGraphData['nodes'] as List?) ?? const [];
      final brainLinkData = (brainGraphData['links'] as List?) ?? const [];
      final officeGoalData = (data['office_goals'] as List?) ?? const [];
      final scoutData = (data['opportunity_scouts'] as List?) ?? const [];
      final pipelineData = (data['pipeline'] is Map) ? Map<String, dynamic>.from(data['pipeline'] as Map) : <String, dynamic>{};
      final dealData = (pipelineData['deals'] as List?) ?? const [];
      final vaultData = (data['vault_items'] as List?) ?? const [];
      final teamData = (data['team'] as List?) ?? const [];
      final teamTaskData = (data['team_tasks'] as List?) ?? const [];
      final jobData = (data['jobs'] as List?) ?? const [];
      final ownerContextData = (data['owner_context'] as List?) ?? const [];
      final personalSourceData = (data['personal_sources'] as Map?) ?? const {};
      final integrationData = (data['integrations'] as Map?) ?? const {};

      savedMemories = memoryData.map((e) => e.toString()).toList();
      memoryRecords = memoryRecordData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      // Prefer brain_graph.nodes (cluster/locale metadata) when present.
      final noteSource = brainNodeData.isNotEmpty ? brainNodeData : memoryNoteData;
      memoryNotes = noteSource
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      brainLinks = brainLinkData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      learnedPersonality = personalityData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      learnedKnowledge = knowledgeData.map((e) => e.toString()).toList();
      suggestions = suggestionData.map((e) => e.toString()).toList();
      projects = projectData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      officeGoals = officeGoalData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      opportunityScouts = scoutData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      pipelineDeals = dealData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      vaultItems = vaultData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      team = teamData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      teamTasks = teamTaskData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      backgroundJobs = jobData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      _autonomy = data['autonomy'] != false;
      final oldApprovalIds = _actionApprovals.map((a) => a['id']).toSet();
      _actionApprovals = ((data['action_approvals'] as List?) ?? []).whereType<Map>().map((a) => Map<String, dynamic>.from(a)).where((a) => a['status'] == 'pending').toList();
      final newApprovals = _actionApprovals.where((a) => !oldApprovalIds.contains(a['id'])).toList();
      if (newApprovals.isNotEmpty) {
        unawaited(_statusHaptic(2));
        for (final approval in newApprovals) {
          unawaited(CheNotifications.show(
            id: 'approval-${approval['id']}',
            title: 'CHE needs your approval',
            body: '${approval['query'] ?? 'A CHE action is waiting for your decision.'}',
          ));
        }
        final options = [for (var i = 0; i < _actionApprovals.length; i++) '${i + 1}. ${_actionApprovals[i]['query']}'].join(' ');
        if (!_isSpeaking && !_isSending) unawaited(speakText('Approval needed. $options Say or type approve action and its number, or reject action and its number.'));
      }
      unawaited(_notifyFinishedJobs());
      ownerContext = ownerContextData
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      personalSources = personalSourceData.map(
        (key, value) => MapEntry(key.toString(), value.toString()),
      );
      integrations = {
        'storage_vault': integrationData['storage_vault'] == true,
        'object_storage': integrationData['object_storage'] == true,
        'work_engine': integrationData['work_engine'] == true,
        'office': integrationData['office'] == true,
        'owner_context': integrationData['owner_context'] == true,
        'personal_source_learning': integrationData['personal_source_learning'] == true,
        'action_engine': integrationData['action_engine'] == true,
        'background_jobs': integrationData['background_jobs'] == true,
        'agent_identity': integrationData['agent_identity'] == true,
        'service_accounts': integrationData['service_accounts'] == true,
        'natural_voice': integrationData['natural_voice'] == true,
        'openai_live_voice': integrationData['openai_live_voice'] == true,
        'quantum_compute': integrationData['quantum_compute'] == true,        'web_research': integrationData['web_research'] == true,
        'public_records': integrationData['public_records'] == true,
        'music': integrationData['music'] == true,
        'windows': integrationData['windows'] == true,
        'car': integrationData['car'] == true,
        'smart_home': integrationData['smart_home'] == true,
        'rendering': integrationData['rendering'] == true,
        'image_generation': integrationData['image_generation'] == true,
        'video_generation': integrationData['video_generation'] == true,
        'model_panel': integrationData['model_panel'] == true,
        'screen_capture': integrationData['screen_capture'] == true,
        'face_verify': integrationData['face_verify'] == true,
        'data_recognition': integrationData['data_recognition'] == true,
        'multimodal': integrationData['multimodal'] == true,
        'market_data': integrationData['market_data'] == true,
        'backtesting': integrationData['backtesting'] == true,
        'broker': integrationData['broker'] == true,
        'prop_firm': integrationData['prop_firm'] == true,
        'business': integrationData['business'] == true,
        'advertising': integrationData['advertising'] == true,
        'payments': integrationData['payments'] == true,
        'leads': integrationData['leads'] == true,
      };

      final localSnapshot = <String, dynamic>{
        'team': team,
        'team_tasks': teamTasks,
        'projects': projects,
        'vault_items': vaultItems,
        'jobs': backgroundJobs,
        'meetings': const [],
      };
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('che.local.snapshot', jsonEncode(localSnapshot));
      _cachedSnapshot = localSnapshot;

      if (_homeBaseUrl.isNotEmpty) {
        unawaited(
          _postSnapshotToHomeBase({
            'team': team,
            'team_tasks': teamTasks,
            'projects': projects,
            'vault_items': vaultItems,
            'jobs': backgroundJobs,
          }),
        );
      }

      if (mounted) _set(() {});
    } catch (_) {
      if (!silent && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Could not refresh C.H.E. Agent state.'),
          ),
        );
      }
    } finally {
      _loadingAgentState = false;
    }
  }

  Future<void> _postSnapshotToHomeBase(Map<String, dynamic> snapshot) async {
    if (_homeBaseUrl.isEmpty) return;
    try {
      await http
          .post(
            Uri.parse('$_homeBaseUrl/api/snapshot'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode(snapshot),
          )
          .timeout(const Duration(seconds: 12));
    } catch (_) {}
  }

  Future<void> _openSecurityManager() async {
    await _loadAgentState(silent: true);

    if (!mounted) return;

    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF162532),
      isScrollControlled: true,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return SizedBox(
              height: MediaQuery.of(context).size.height * 0.78,
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  children: [
                    const Row(
                      children: [
                        Icon(Icons.shield, color: Color(0xFF34E0B8)),
                        SizedBox(width: 10),
                        Text(
                          'C.H.E. SECURITY + SELF PROFILE',
                          style: TextStyle(
                            color: Color(0xFF34E0B8),
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Text(
                      _deviceToken == null
                          ? 'This device is not paired.'
                          : 'This device is paired with your private CHE Agent.',
                      style: const TextStyle(color: Colors.white70),
                    ),
                    const SizedBox(height: 12),

                    SwitchListTile(
                      value: strictOwnerMode,
                      activeThumbColor: const Color(0xFF34E0B8),
                      title: const Text('Strict owner mode'),
                      subtitle: const Text(
                        'Require an authorized paired device for private C.H.E. Agent requests.',
                      ),
                      onChanged: (value) {
                        _set(() {
                          strictOwnerMode = value;
                        });
                        setModalState(() {});
                      },
                    ),

                    SwitchListTile(
                      value: proactiveMode,
                      activeThumbColor: const Color(0xFF34E0B8),
                      title: const Text('Proactive CHE'),
                      subtitle: const Text(
                        'Surface useful follow-ups and next steps while the app is active.',
                      ),
                      onChanged: (value) {
                        _set(() {
                          proactiveMode = value;
                        });
                        setModalState(() {});
                      },
                    ),

                    SwitchListTile(
                      value: wakePhraseMode,
                      activeThumbColor: const Color(0xFF34E0B8),
                      title: const Text('Wake phrase: “Chay”'),
                      subtitle: Text(
                        kIsWeb
                            ? 'Hands-free while this CHE page stays open. Say “stand down” to sleep and “Chay” to wake.'
                            : 'Say “Chay” once to wake CHE — then just talk, no wake word needed. Say “stand down” to put her back to sleep.',
                      ),
                      onChanged: (value) {
                        _set(() {
                          wakePhraseMode = value;
                        });
                        setModalState(() {});
                      },
                    ),

                    const SizedBox(height: 8),
                    const Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        'LEARNED PERSONALITY',
                        style: TextStyle(
                          color: Color(0xFF34E0B8),
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),

                    Expanded(
                      child: ListView(
                        children: [
                          const Text(
                            'WHAT C.H.E. HAS LEARNED ABOUT YOUR STYLE',
                            style: TextStyle(
                              color: Color(0xFF34E0B8),
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 8),
                          if (learnedPersonality.isEmpty)
                            const Text(
                              'Nothing stable learned yet. C.H.E. will build '
                              'this gradually from patterns you explicitly show.',
                              style: TextStyle(color: Colors.white54),
                            )
                          else
                            ...learnedPersonality.map((trait) {
                              final statement =
                                  trait['statement']?.toString() ?? '';
                              final confidence =
                                  (trait['confidence'] as num?)?.toDouble();

                              return Card(
                                color: const Color(0xFF243747),
                                child: ListTile(
                                  leading: const Icon(
                                    Icons.psychology_alt,
                                    color: Color(0xFF34E0B8),
                                  ),
                                  title: Text(statement),
                                  subtitle: confidence == null
                                      ? null
                                      : Text(
                                          'Confidence ${(confidence * 100).round()}%',
                                          style: const TextStyle(
                                            color: Colors.white54,
                                          ),
                                        ),
                                ),
                              );
                            }),
                        ],
                      ),
                    ),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () async {
                              if (_deviceToken == null) {
                                Navigator.pop(context);
                                await _showPairingDialog();
                              } else {
                                await _loadAgentState();
                                setModalState(() {});
                              }
                            },
                            child: Text(
                              _deviceToken == null
                                  ? 'PAIR THIS DEVICE'
                                  : 'REFRESH',
                            ),
                          ),
                        ),
                        if (_deviceToken != null) ...[
                          const SizedBox(width: 10),
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () async {
                                try {
                                  await http.post(
                                    Uri.parse(
                                      '$cheAgentBaseUrl/api/security/revoke_self',
                                    ),
                                    headers: _authHeaders,
                                  );
                                } catch (_) {}

                                await _clearSecuritySession();
                                if (!context.mounted) return;
                                Navigator.pop(context);
                              },
                              child: const Text('UNPAIR DEVICE'),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  Future<void> _openAccountBridge() async {
    if (!mounted) return;
    await CheAccountBridge.open(context);
  }

  void _applyVoiceSnapshot(CheVoiceSnapshot snapshot) {
    _voiceSnapshot = snapshot;
    if (!mounted) return;
    if (snapshot.phase == CheVoicePhase.disconnected &&
        _realtimeVoice != null &&
        !_realtimeConnecting) {
      unawaited(_fallbackAfterRealtimeLoss(snapshot.lastError));
    }
    _set(() {
      _isSpeaking = snapshot.phase == CheVoicePhase.speaking;
      _isSending = snapshot.phase == CheVoicePhase.thinking ||
          snapshot.phase == CheVoicePhase.connecting;
      isListening = snapshot.microphoneActive &&
          (snapshot.phase == CheVoicePhase.listening ||
              snapshot.phase == CheVoicePhase.userSpeaking ||
              snapshot.phase == CheVoicePhase.wakeListening);
      openConversation = snapshot.engine == CheVoiceEngine.realtime ||
          snapshot.engine == CheVoiceEngine.nativeFallback ||
          snapshot.phase == CheVoicePhase.wakeListening;
    });
  }

  Future<void> _fallbackAfterRealtimeLoss(String? reason) async {
    if (_realtimeConnecting || _realtimeVoice == null) return;
    final engine = _realtimeVoice;
    _realtimeVoice = null;
    try {
      await engine?.dispose();
    } catch (_) {}

    _voiceMachine.fallback(reason ?? 'Realtime connection ended.');
    _applyVoiceSnapshot(_voiceMachine.snapshot);

    try {
      final started = await _localVoice.runMicOp(() => CheNativeVoice.start());
      _nativeIosVoiceActive = started;
      if (!started) {
        _voiceMachine.disconnected(reason ?? 'Voice engines unavailable.');
        _applyVoiceSnapshot(_voiceMachine.snapshot);
      }
    } catch (error) {
      _voiceMachine.disconnected(error.toString());
      _applyVoiceSnapshot(_voiceMachine.snapshot);
    }
  }

  Future<void> _stopPorcupineWake({bool disposeEngine = false}) async {
    final wake = _porcupineWake;
    if (wake == null) {
      return;
    }
    await wake.stop(disposeManager: disposeEngine);
    if (disposeEngine) _porcupineWake = null;
  }

  Future<void> _handlePorcupineWake() async {
    if (!mounted ||
        !cheSleeping ||
        _realtimeConnecting ||
        _realtimeVoice?.connected == true) {
      return;
    }

    await _stopPorcupineWake();
    HapticFeedback.mediumImpact();
    if (mounted) {
      _set(() {
        cheSleeping = false;
        openConversation = true;
        isListening = false;
      });
    }
    await _beginRealtimeConversation(fromWake: true);
  }

  Future<bool> _startPorcupineWake() async {
    if (kIsWeb ||
        defaultTargetPlatform != TargetPlatform.iOS ||
        !cheSleeping ||
        _realtimeVoice?.connected == true ||
        _realtimeConnecting ||
        _deviceToken == null ||
        _deviceToken!.isEmpty ||
        cheAgentBaseUrl.isEmpty) {
      return false;
    }

    final current = _porcupineWake;
    if (current != null) {
      await current.dispose();
    }

    final wake = CheWakeWordEngine(
      baseUrl: cheAgentBaseUrl,
      deviceToken: _deviceToken!,
      onWake: _handlePorcupineWake,
    );
    _porcupineWake = wake;

    final started = await wake.start();
    if (started) {
      await _localVoice.runMicOp(() async {
        try {
          await CheNativeVoice.stop();
        } catch (_) {}
      });
      _nativeIosVoiceActive = false;
      _voiceMachine.startWakeListening();
      _applyVoiceSnapshot(_voiceMachine.snapshot);
    }
    return started;
  }

  Future<void> _restartWakeListener() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return;
    if (_realtimeVoice?.connected == true || _realtimeConnecting) return;

    // Production wake stack:
    // 1) Apple Vocal Shortcuts/App Intent gets CHE foregrounded at iPhone level.
    // 2) Porcupine listens locally while CHE is active/asleep.
    // 3) OpenAI Realtime/WebRTC exclusively owns the mic after wake.
    if (await _startPorcupineWake()) return;

    try {
      final started = await _localVoice.runMicOp(() => CheNativeVoice.start());
      _nativeIosVoiceActive = started;
      if (started) {
        _voiceMachine.startWakeListening();
        _applyVoiceSnapshot(_voiceMachine.snapshot);
      } else {
        await _fallbackSpeech('Native recognition did not start');
      }
    } catch (error) {
      _voiceMachine.disconnected(error.toString());
      _applyVoiceSnapshot(_voiceMachine.snapshot);
    }
  }

  Future<void> _beginRealtimeConversation({bool fromWake = false}) async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return;
    if (_realtimeConnecting || _realtimeVoice?.connected == true) return;
    if (!await _ensurePaired() || _deviceToken == null || cheAgentBaseUrl.isEmpty) {
      return;
    }

    if (DateTime.now().isBefore(_realtimeSkipUntil)) {
      // Straight to the free native listener, no failed live-voice attempt.
      HapticFeedback.mediumImpact();
      _listenRestartTimer?.cancel();
      try {
        await _stopPorcupineWake();
        await _localVoice.runMicOp(() async {
          await speech.cancel();
          if (!_nativeIosVoiceActive) {
            _nativeIosVoiceActive = await CheNativeVoice.start();
          } else {
            await CheNativeVoice.wake();
          }
        });
      } catch (_) {}
      if (mounted) {
        _set(() {
          cheSleeping = false;
          openConversation = _nativeIosVoiceActive;
          isListening = _nativeIosVoiceActive;
        });
      }
      return;
    }

    _realtimeConnecting = true;
    if (fromWake) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.lightImpact();
    }
    if (mounted) {
      _set(() {
        cheSleeping = false;
        openConversation = true;
      });
    }

    try {
      _listenRestartTimer?.cancel();

      // Realtime is the only microphone owner once CHE wakes.
      await _stopPorcupineWake();
      await _localVoice.runMicOp(() async {
        await speech.cancel();
        try {
          await CheNativeVoice.stop();
        } catch (_) {}
      });
      await flutterTts.stop();
      try {
        await CheNativeVoice.stopAudio();
      } catch (_) {}
      _nativeIosVoiceActive = false;

      final old = _realtimeVoice;
      _realtimeVoice = null;
      if (old != null) await old.dispose();

      final engine = CheRealtimeVoiceEngine(
        baseUrl: cheAgentBaseUrl,
        deviceToken: _deviceToken!,
        state: _voiceMachine,
        onSnapshot: _applyVoiceSnapshot,
        onUserTranscript: _onRealtimeUserTranscript,
        onAssistantTranscript: _onRealtimeAssistantTranscript,
        onCapabilityRequest: _runRealtimeCapabilityTool,
        onStandDown: _returnToWakeStandby,
      );
      _realtimeVoice = engine;
      await engine.connect();

      if (mounted) {
        _set(() {
          cheSleeping = false;
          openConversation = true;
        });
      }
    } catch (error) {
      final engine = _realtimeVoice;
      _realtimeVoice = null;
      if (engine != null) {
        try {
          await engine.dispose();
        } catch (_) {}
      }

      _voiceMachine.fallback(error.toString());
      _applyVoiceSnapshot(_voiceMachine.snapshot);
      _realtimeSkipUntil = DateTime.now().add(const Duration(hours: 6));

      // Native recognition/TTS is a real fallback, never a second simultaneous
      // mic owner.
      try {
        final started = await _localVoice.runMicOp(() => CheNativeVoice.start());
        _nativeIosVoiceActive = started;
        if (mounted) {
          _set(() {
            cheSleeping = false;
            openConversation = started;
            isListening = started;
          });
        }
      } catch (_) {
        _voiceMachine.disconnected(error.toString());
        _applyVoiceSnapshot(_voiceMachine.snapshot);
      }
    } finally {
      _realtimeConnecting = false;
    }
  }

  Future<void> _returnToWakeStandby({bool restartWakeListener = true}) async {
    final engine = _realtimeVoice;
    _realtimeVoice = null;
    if (engine != null) {
      try {
        await engine.dispose();
      } catch (_) {}
    }

    _realtimeAssistantIndex = null;
    _realtimePendingMediaUrl = null;
    _realtimePendingMediaType = null;
    _voiceMachine.sleep();

    if (mounted) {
      _set(() {
        cheSleeping = true;
        openConversation = true;
        isListening = false;
        _isSpeaking = false;
        _isSending = false;
      });
    }

    if (restartWakeListener) {
      await _restartWakeListener();
    }
  }

  void _onRealtimeUserTranscript(String text, String? itemId) {
    final clean = text.trim();
    if (clean.isEmpty || !mounted) return;

    _set(() {
      final assistantIndex = _realtimeAssistantIndex;
      if (assistantIndex != null &&
          assistantIndex >= 0 &&
          assistantIndex < messages.length) {
        messages.insert(assistantIndex, {'role': 'user', 'text': clean});
        _realtimeAssistantIndex = assistantIndex + 1;
      } else {
        messages.add({'role': 'user', 'text': clean});
      }
    });
    _scrollToBottom();

    unawaited(_controlAutonomy(clean));
    unawaited(_observeRealtimeTurn(clean, itemId));
  }

  Future<void> _observeRealtimeTurn(String message, String? itemId) async {
    if (_deviceToken == null || cheAgentBaseUrl.isEmpty) return;
    try {
      await http
          .post(
            Uri.parse('$cheAgentBaseUrl/api/realtime/observe'),
            headers: _authHeaders,
            body: jsonEncode({
              'message': message,
              'item_id': itemId,
            }),
          )
          .timeout(const Duration(seconds: 8));
    } catch (_) {}
  }

  void _onRealtimeAssistantTranscript(
    String text,
    bool isFinal,
    String? responseId,
  ) {
    final clean = text.trim();
    if (!mounted || clean.isEmpty) return;

    _set(() {
      var index = _realtimeAssistantIndex;
      if (index == null || index >= messages.length) {
        index = messages.length;
        messages.add({'role': 'assistant', 'text': clean});
        _realtimeAssistantIndex = index;
      } else {
        messages[index]['text'] = clean;
      }

      if (isFinal && index < messages.length && _realtimePendingMediaUrl != null) {
        messages[index]['media_url'] = _realtimePendingMediaUrl!;
        messages[index]['media_type'] = _realtimePendingMediaType ?? 'image';
        _realtimePendingMediaUrl = null;
        _realtimePendingMediaType = null;
      }

      if (isFinal) {
        _realtimeAssistantIndex = null;
        var youSaid = '';
        for (var i = index - 1; i >= 0; i--) {
          if (messages[i]['role'] == 'user') {
            youSaid = messages[i]['text'] ?? '';
            break;
          }
          if (messages[i]['role'] == 'assistant') break;
        }
        _brainLog.logVoiceTurn(youSaid.isEmpty ? '(spoken)' : youSaid, clean);
      }
    });
    _scrollToBottom();
  }

  Future<String> _runRealtimeCapabilityTool(
    String request,
    List<String> capabilityHints,
  ) async {
    final clean = request.trim();
    if (clean.isEmpty) {
      return jsonEncode({'ok': false, 'error': 'Empty CHE tool request.'});
    }

    final rememberMatch = RegExp(
      r'^(?:(?:chay|chey|shay|che)[, ]+)?remember(?: that)?\s+',
      caseSensitive: false,
    ).firstMatch(clean);
    if (rememberMatch != null) {
      final memory = clean.substring(rememberMatch.end).trim();
      if (memory.isNotEmpty) {
        await saveMemory(memory);
        return jsonEncode({
          'ok': true,
          'confirmed': true,
          'result': 'Saved to CHE memory.',
        });
      }
    }

    final history = _recentHistoryExcluding(clean);

    _streamMediaUrl = null;
    _streamMediaType = null;

    try {
      final result = await _streamCheResponse(
        clean,
        history,
        onPartial: (_) {},
      );

      _realtimePendingMediaUrl = _streamMediaUrl;
      _realtimePendingMediaType = _streamMediaType;

      return jsonEncode({
        'ok': true,
        'confirmed': true,
        'result': result,
        'media_url': _streamMediaUrl,
        'media_type': _streamMediaType,
        'requested_capabilities': {
          ..._requestedCapabilities(clean),
          ...capabilityHints,
        }.toList(),
      });
    } catch (error) {
      return jsonEncode({
        'ok': false,
        'confirmed': false,
        'error': error.toString(),
        'requested_capabilities': {
          ..._requestedCapabilities(clean),
          ...capabilityHints,
        }.toList(),
      });
    }
  }

  void _openVoiceDiagnostics() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => CheVoiceDiagnosticsSheet(
        snapshot: _voiceSnapshot,
        serverOnline: _deviceToken != null,
        lastServerEvent: _realtimeVoice?.lastServerEvent,
        playbackEngine: _lastVoiceEngine,
        fallbackReason: _voiceFailReason.isEmpty ? null : _voiceFailReason,
      ),
    );
  }

  Future<void> _openPluginManager() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: CheColors.panel,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.extension_rounded),
              title: const Text('Skill plugins'),
              subtitle: const Text('Install, build with CHE, roll back, Safe mode'),
              onTap: () => Navigator.pop(sheetContext, 'skills'),
            ),
            ListTile(
              leading: const Icon(Icons.dns_outlined),
              title: const Text('Server connectors'),
              subtitle: const Text('Read-only services configured on your CHE server'),
              onTap: () => Navigator.pop(sheetContext, 'server'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'skills') {
      await _openSkillPlugins();
      return;
    }
    if (!await _ensurePaired() || !mounted || _deviceToken == null) return;
    await ChePluginManager.open(context, cheAgentBaseUrl, _deviceToken!);
  }
}

