part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (voice).
extension _CheHomeVoice on _CHEHomeState {
  Future<void> initializeVoice() async {
    try {
      final available = await speech.initialize(
        onStatus: (status) {
          if (!mounted) return;

          debugPrint('CHE mic STT_STATUS: $status');
          _setListening(speech.isListening, 'stt status $status');

          final recognitionStopped =
              status == 'done' || status == 'notListening';

          if (!kIsWeb &&
              !_nativeIosVoiceStarting &&
              !_nativeIosVoiceActive &&
              recognitionStopped &&
              openConversation &&
              !cheSleeping &&
              !_isSending &&
              !_isSpeaking &&
              !_localVoice.isSpeaking &&
              !_autoSentCurrentTurn) {
            _restartListeningSoon(reason: 'stt $status');
          }
        },
        onError: (error) {
          if (!mounted) return;
          debugPrint('CHE mic STT_STATUS: error ${error.errorMsg}');
          _setListening(false, 'stt error ${error.errorMsg}');

          if (!kIsWeb &&
              !_nativeIosVoiceStarting &&
              !_nativeIosVoiceActive &&
              openConversation &&
              !cheSleeping &&
              !_isSending &&
              !_isSpeaking &&
              !_localVoice.isSpeaking) {
            _restartListeningSoon(
              delay: const Duration(milliseconds: 800),
              reason: 'stt error ${error.errorMsg}',
            );
          }
        },
      );

      // This is still device/browser TTS. The Agent prompt is written to make
      // the WORDING and rhythm natural. A true neural voice can replace this
      // TTS layer later without changing the agent/memory/security design.
      await flutterTts.setLanguage(cheLanguageByCode(_replyLanguage).ttsLocale);
      await flutterTts.setSpeechRate(0.44);
      await flutterTts.setPitch(0.95);
      await flutterTts.setVolume(1.0);

      // Native iPhone build: prefer a smoother modern English voice when
      // the device has one installed. This is ignored safely on web/Android.
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
        try {
          final dynamic voices = await flutterTts.getVoices;
          if (voices is List) {
            // Smoothest free iPhone voice first: Premium, then Enhanced
            // (both free downloads in iOS Settings), then the named voices.
            final preferredNames = <String>[
              'Ava',
              'Zoe',
              'Evan',
              'Nathan',
              'Samantha',
              'Nicky',
              'Serena',
            ];
            int qualityRank(Map<dynamic, dynamic> v) {
              final q = (v['quality'] ?? '').toString().toLowerCase();
              final n = (v['name'] ?? '').toString().toLowerCase();
              if (q.contains('premium') || n.contains('premium')) return 3;
              if (q.contains('enhanced') || n.contains('enhanced')) return 2;
              return 1;
            }
            int nameRank(Map<dynamic, dynamic> v) {
              final n = (v['name'] ?? '').toString().toLowerCase();
              final i = preferredNames.indexWhere((w) => n.contains(w.toLowerCase()));
              return i < 0 ? preferredNames.length : i;
            }

            final english = voices
                .whereType<Map<dynamic, dynamic>>()
                .where((v) => (v['locale'] ?? '').toString().toLowerCase().startsWith('en'))
                .toList()
              ..sort((a, b) {
                final byQuality = qualityRank(b).compareTo(qualityRank(a));
                if (byQuality != 0) return byQuality;
                final aUs = (a['locale'] ?? '').toString().toLowerCase().contains('us') ? 0 : 1;
                final bUs = (b['locale'] ?? '').toString().toLowerCase().contains('us') ? 0 : 1;
                if (aUs != bUs) return aUs.compareTo(bUs);
                return nameRank(a).compareTo(nameRank(b));
              });

            final Map<dynamic, dynamic>? selected = english.isEmpty ? null : english.first;

            if (selected != null) {
              await flutterTts.setVoice({
                'name': selected['name'].toString(),
                'locale': selected['locale'].toString(),
              });
            }
          }
        } catch (_) {}
      }

      try {
        await flutterTts.awaitSpeakCompletion(true);
      } catch (_) {}

      flutterTts.setStartHandler(() {
        _isSpeaking = true;
        if (mounted) _set(() {});
      });

      // Native restart is owned by speakText finally so TTS completion cannot
      // race a second mic start/stop against the same turn.
      flutterTts.setCompletionHandler(() {
        // A pipeline turn ends in _finishSpeechTurn, not per chunk.
        if (_activeSpeech != null) return;
        _isSpeaking = false;
        if (mounted) _set(() {});

        if (kIsWeb && openConversation && !_isSending) {
          Future.delayed(
            const Duration(milliseconds: 450),
            () {
              if (mounted &&
                  openConversation &&
                  !_isSending &&
                  !_isSpeaking &&
                  !isListening) {
                _captureWebSpeech();
              }
            },
          );
        }
      });

      flutterTts.setCancelHandler(() {
        _isSpeaking = false;
        if (mounted) _set(() {});
      });

      flutterTts.setErrorHandler((message) {
        _isSpeaking = false;
        if (mounted) _set(() {});
        debugPrint('CHE voice: tts error');
      });

      if (!mounted) return;
      _set(() {
        speechAvailable = available;
      });

      // Native builds can keep an open foreground conversation more reliably.
      // iPhone Safari/web still requires browser-controlled microphone sessions.
      if (!kIsWeb &&
          available &&
          defaultTargetPlatform != TargetPlatform.iOS) {
        openConversation = true;
        _restartListeningSoon(delay: const Duration(milliseconds: 700));
      }
    } catch (_) {
      if (!mounted) return;
      _set(() {
        speechAvailable = false;
      });
    }
  }

  /// Server TTS only: returns the clip, or null so the caller falls back to
  /// the iPhone voice. Safe to call ahead of playback (prefetch).
  Future<CheVoiceClip?> _synthesizeServerVoice(String text) async {
    if (freeNativeVoiceMode) {
      _naturalVoiceServerErrored = true;
      return null;
    }
    _naturalVoiceServerErrored = false;
    _voiceFailReason = '';

    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) {
      return null;
    }

    if (_localVoice.serverVoiceCoolingDown) {
      _naturalVoiceServerErrored = true;
      _voiceFailReason = 'server voice cooling down';
      debugPrint('CHE voice: skip server TTS (cooldown)');
      return null;
    }

    if (_deviceToken == null ||
        cheAgentBaseUrl.isEmpty ||
        integrations['natural_voice'] != true) {
      _naturalVoiceServerErrored = true;
      _voiceFailReason = 'server voice not connected';
      return null;
    }

    try {
      // Fail fast so iPhone TTS can speak — never leave the owner silent.
      final response = await http
          .post(
            Uri.parse('$cheAgentBaseUrl/api/voice/synthesize'),
            headers: _authHeaders,
            body: jsonEncode({'text': text}),
          )
          .timeout(const Duration(seconds: 5));

      if (response.statusCode == 401) {
        _naturalVoiceServerErrored = true;
        await _clearSecuritySession();
        return null;
      }

      if (response.statusCode == 429) {
        _localVoice.markServerVoiceCooldown();
        _naturalVoiceServerErrored = true;
        _voiceFailReason = 'server voice 429';
        debugPrint('CHE voice: server TTS 429 cooldown');
        return null;
      }

      if (response.statusCode != 200 || response.bodyBytes.isEmpty) {
        _naturalVoiceServerErrored = true;
        try {
          final decoded = jsonDecode(response.body);
          _voiceFailReason = decoded is Map ? '${decoded['detail'] ?? ''}' : '';
        } catch (_) {
          _voiceFailReason = 'server voice ${response.statusCode}';
        }
        final detail = _voiceFailReason.toLowerCase();
        if (response.statusCode == 503 ||
            detail.contains('quota') ||
            detail.contains('429') ||
            detail.contains('cooling')) {
          _localVoice.markServerVoiceCooldown();
        }
        debugPrint('CHE voice: server TTS fail ${_voiceFailReason.isEmpty ? response.statusCode : _voiceFailReason}');
        return null;
      }
      _voiceFailReason = '';

      final contentType =
          response.headers['content-type']?.toLowerCase() ?? '';
      if (!contentType.startsWith('audio/')) {
        _naturalVoiceServerErrored = true;
        return null;
      }

      return CheVoiceClip(response.bodyBytes, (response.headers['x-che-voice'] ?? '').trim());
    } catch (e) {
      _naturalVoiceServerErrored = true;
      _voiceFailReason = e is TimeoutException ? 'server voice timed out' : 'server voice unreachable';
      debugPrint('CHE voice: $_voiceFailReason');
      return null;
    }
  }


  Future<bool> _playServerVoice(CheVoiceClip clip) async {
    final played = await CheNativeVoice.playAudio(clip.bytes);
    if (played) {
      final engine = clip.engine.isEmpty ? 'server-voice' : clip.engine;
      if (_lastVoiceEngine != engine) {
        _lastVoiceEngine = engine;
        if (mounted) _set(() {});
      }
      return true;
    }
    _naturalVoiceServerErrored = true;
    _voiceFailReason = 'server voice playback failed';
    return false;
  }

  /// Routes playback to the loudspeaker (or BT if preferred) so replies are audible.
  ///
  /// iOS playAndRecord is configured once. Re-applying the session on every
  /// speak tears down recognition and causes mic on/off thrashing.
  Future<void> _ensureAudibleOutput() async {
    final vol = CheUiPreferences.instance.voiceVolume.clamp(0.0, 1.0);
    try {
      await flutterTts.setVolume(vol);
    } catch (_) {}
    if (kIsWeb) return;
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      try {
        if (_localVoice.claimAudioSessionSetup()) {
          await Helper.ensureAudioSession();
          await Helper.setAppleAudioConfiguration(
            AppleAudioConfiguration(
              appleAudioCategory: AppleAudioCategory.playAndRecord,
              appleAudioCategoryOptions: const {
                AppleAudioCategoryOption.allowBluetooth,
                AppleAudioCategoryOption.allowBluetoothA2DP,
                AppleAudioCategoryOption.allowAirPlay,
                AppleAudioCategoryOption.defaultToSpeaker,
              },
              appleAudioMode: AppleAudioMode.voiceChat,
            ),
          );
          debugPrint('CHE voice: audio session playAndRecord ready');
        }
        await Helper.setSpeakerphoneOnButPreferBluetooth();
      } catch (e) {
        // Allow a later speak to retry setup if the first attempt failed.
        _localVoice.audioSessionReady = false;
        debugPrint('CHE voice: audio session setup failed');
      }
    }
  }

  /// Speaks [text]. With [record] false (the home greeting) nothing is added
  /// to the conversation, so the voice-first home stays on screen.
  Future<void> speakText(String text, {bool record = true}) async {
    if (text.trim().isEmpty) return;
    if (record && mounted && (messages.isEmpty || messages.last['text'] != text)) {
      _set(() => messages.add({'role': 'assistant', 'text': text}));
    }
    // Suppress near-duplicate server+native races of the same sentence.
    if (!_localVoice.acceptSpeak(text)) {
      debugPrint('CHE voice: skip duplicate speak');
      return;
    }
    final turn = _openSpeechTurn();
    if (turn == null) return;
    // CHE refers to and pronounces herself as "CHE"; "Chay" is only the wake
    // word, so no substitution happens here.
    turn.add(text);
    turn.close();
    await turn.done;
  }

  /// Starts one spoken assistant turn. Chunks added to the returned pipeline
  /// are synthesized ahead of playback and played back to back; the mic is
  /// suppressed once at the start and resumed once at the end of the turn.
  CheSpeechPipeline<CheVoiceClip>? _openSpeechTurn() {
    // Mirror the persisted UI Controls toggle (defaults ON).
    voiceResponsesEnabled = CheUiPreferences.instance.voiceResponsesEnabled;
    if (_realtimeVoice?.connected == true) {
      // Realtime owns the speaker while it is mid-turn. Otherwise fall through
      // to local TTS so greetings / system prompts are not silently dropped.
      final phase = _voiceSnapshot.phase;
      if (phase == CheVoicePhase.speaking ||
          phase == CheVoicePhase.thinking ||
          phase == CheVoicePhase.userSpeaking ||
          phase == CheVoicePhase.connecting) {
        return null;
      }
    }
    if (!voiceResponsesEnabled) {
      if (kIsWeb && openConversation) {
        Future.delayed(const Duration(milliseconds: 300), () {
          if (mounted && openConversation && !_isSending && !_isSpeaking && !isListening) {
            _captureWebSpeech();
          }
        });
      } else if (!kIsWeb && openConversation && !cheSleeping) {
        _restartListeningSoon(reason: 'voice replies off');
      }
      return null;
    }

    _activeSpeech?.cancel();
    final speechTurn = ++_speechTurn;
    final localGen = _localVoice.goSpeaking();
    _mic.invalidate('TTS_START');
    _isSpeaking = true;
    debugPrint('CHE voice: TTS_START turn $speechTurn');
    late final CheSpeechPipeline<CheVoiceClip> turn;
    turn = CheSpeechPipeline<CheVoiceClip>(
      ready: _prepareSpeechOutput(),
      synthesize: (text) async {
        if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return null;
        final server = await _synthesizeServerVoice(text);
        if (server != null) return server;
        // Fluent reading: prepare the on-device neural voice here (ahead of
        // playback) instead of in the fallback, which only runs after the
        // previous chunk finished and left a pause between paragraphs.
        try {
          final local = await CheNativeVoice.synthesizeNeural(text);
          if (local != null) return CheVoiceClip(local, 'iphone-neural');
        } catch (_) {}
        return null;
      },
      play: _playServerVoice,
      fallback: _speakFallbackChunk,
      log: (m) => debugPrint('CHE voice timing: $m'),
      onComplete: (cancelled) => _finishSpeechTurn(turn, speechTurn, localGen),
    );
    _activeSpeech = turn;
    if (mounted) _set(() => isListening = false);
    return turn;
  }

  /// Once per turn: stop the Flutter recognizer, route audio, and tell the
  /// native recognizer CHE is talking (it stays open for barge-in).
  Future<void> _prepareSpeechOutput() async {
    try {
      if (speech.isListening) {
        await _localVoice.runMicOp(() async {
          debugPrint('CHE mic MIC_STOP_REQUEST: TTS start');
          await speech.stop();
          debugPrint('CHE mic MIC_STOPPED: TTS start');
        });
      }
      await _ensureAudibleOutput();
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS && _nativeIosVoiceActive) {
        try {
          await CheNativeVoice.setAssistantSpeaking(true);
        } catch (_) {}
      }
    } catch (_) {}
  }

  /// iPhone/device voice for one chunk, used only when server TTS failed.
  Future<bool> _speakFallbackChunk(String text) async {
    try {
      if (kIsWeb) {
        if (await che_web_voice.speakText(text)) return true;
        await flutterTts.stop();
        await flutterTts.speak(text);
        return true;
      }
      if (defaultTargetPlatform == TargetPlatform.iOS) {
        for (final (engine, speak) in [
          ('iphone-neural', CheNativeVoice.speakNeural),
          ('iphone-voice', CheNativeVoice.speakText),
        ]) {
          try {
            if (await speak(text)) {
              if (_lastVoiceEngine != engine) {
                _lastVoiceEngine = engine;
                if (mounted) _set(() {});
              }
              return true;
            }
          } on MissingPluginException {
            // Fall through to the next engine.
          } catch (_) {}
        }
        await flutterTts.stop();
        await flutterTts.setVolume(CheUiPreferences.instance.voiceVolume.clamp(0.0, 1.0));
        await flutterTts.speak(text);
        _lastVoiceEngine = 'iphone-tts';
        return true;
      }
      await flutterTts.stop();
      await flutterTts.speak(text);
      return true;
    } catch (_) {
      // Keep the typed response even if audio output fails.
      return false;
    }
  }

  /// Runs once when a whole spoken turn ends. Barge-in bumps the generation /
  /// speechTurn, so a cancelled turn cannot restart the mic.
  Future<void> _finishSpeechTurn(
    CheSpeechPipeline<CheVoiceClip> turn,
    int speechTurn,
    int localGen,
  ) async {
    if (identical(_activeSpeech, turn)) _activeSpeech = null;
    if (speechTurn != _speechTurn || localGen != _localVoice.speechGeneration) return;
    debugPrint('CHE voice: TTS_END turn $speechTurn');
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS && _nativeIosVoiceActive) {
      try {
        await CheNativeVoice.setAssistantSpeaking(false);
      } catch (_) {}
    }
    _isSpeaking = false;
    _localVoice.finishSpeakingToListening(continuous: openConversation && !cheSleeping);
    if (mounted) _set(() {});
    if (kIsWeb && openConversation) {
      Future.delayed(const Duration(milliseconds: 450), () {
        if (mounted && openConversation && !_isSending && !_isSpeaking && !isListening) {
          _captureWebSpeech();
        }
      });
    } else if (!kIsWeb && openConversation && !cheSleeping) {
      // Continuous conversation: listen again once, after the whole reply.
      _restartListeningSoon(reason: 'TTS_END');
    }
  }

  Future<void> _interruptSpeechAndListen({bool resumeListening = true}) async {
    if (_realtimeVoice?.connected == true) {
      await _realtimeVoice!.cancelActiveResponse('owner interruption');
      _applyVoiceSnapshot(_voiceMachine.snapshot);
      return;
    }
    ++_speechTurn;
    _activeSpeech?.cancel();
    _activeSpeech = null;
    _localVoice.bargeIn();
    _mic.cancelRestart('voice state change');
    debugPrint('CHE voice: barge-in stop TTS');
    if (kIsWeb) {
      try { che_web_voice.stopSpeech(); } catch (_) {}
    } else if (defaultTargetPlatform == TargetPlatform.iOS) {
      try { await CheNativeVoice.stopAudio(); } catch (_) {}
    }
    await flutterTts.stop();
    if (!mounted) return;
    _set(() {
      _isSpeaking = false;
      if (resumeListening) {
        openConversation = true;
        cheSleeping = false;
        isListening = true;
      }
    });
    if (!resumeListening) return;
    if (kIsWeb) {
      _rearmWebMicSoon(delay: const Duration(milliseconds: 150));
    } else if (_nativeIosVoiceActive) {
      // Native recognizer stays open during CHE speech for barge-in; just
      // clear the speaking flag — do not stop/start the mic session.
      try {
        await CheNativeVoice.setAssistantSpeaking(false);
      } catch (_) {}
    } else {
      await _startListening();
    }
  }

  Future<void> _fallbackSpeech(String reason) async {
    if (_usingSpeechFallback) return;
    _usingSpeechFallback = true;
    debugPrint('CHE speech error: native: $reason');
    await _localVoice.runMicOp(() async {
      try {
        await CheNativeVoice.stop();
      } catch (_) {}
    });
    _nativeIosVoiceActive = false;
    _nativeIosVoiceStarting = false;
    if (!speechAvailable) await initializeVoice();
    if (!mounted) return;
    if (speechAvailable) {
      _set(() { openConversation = true; cheSleeping = false; });
      await _startListening();
    } else {
      debugPrint('CHE speech error: speech_to_text unavailable');
      await speakText('Both speech recognizers are unavailable. You can still type every request.');
    }
  }

  Future<void> _initNativeIosVoice() async {
    if (_nativeIosVoiceStarting) return;
    _nativeIosVoiceStarting = true;
    _mic.cancelRestart('voice state change');
    _nativeIosVoiceSub?.cancel();
    _nativeIosVoiceSub = CheNativeVoice.events.listen(
      _handleNativeIosVoiceEvent,
      onError: (_) {
        unawaited(_fallbackSpeech('Native voice event stream failed'));
      },
    );

    try {
      // Security/session state is loaded before this runs. Release any Flutter
      // recognizer once, then let the shared wake-stack selector choose exactly
      // one iPhone microphone owner (Porcupine, native, or speech fallback).
      await _localVoice.runMicOp(() async {
        if (speech.isListening) {
          await speech.cancel();
        }
      });
      await _restartWakeListener();

      if (!mounted) return;
    } on MissingPluginException {
      await _fallbackSpeech('Native voice bridge unavailable');
    } catch (e) {
      await _fallbackSpeech(e.toString());

      if (mounted) {
        _set(() {});
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Native iPhone voice could not start: '
              '${e.toString().replaceFirst("PlatformException", "")}',
            ),
          ),
        );
      }
    } finally {
      _nativeIosVoiceStarting = false;
    }
  }

  Future<void> _handleNativeIosVoiceEvent(
    Map<String, dynamic> event,
  ) async {
    final type = event['type']?.toString() ?? '';

    if (type == 'state') {
      if (_realtimeConnecting || _realtimeVoice?.connected == true) return;
      final running = event['running'] == true;

      if (mounted) {
        _set(() {
          _nativeIosVoiceActive = running;
          openConversation = running;
          isListening = running && !_isSpeaking;
        });
      }
      return;
    }

    if (type == 'sleep') {
      if (mounted) {
        _set(() {
          cheSleeping = true;
          isListening = false;
        });
      }
      await _closeMicUnlessHandsFree();

      await _controlAutonomy('stand by');
      return;
    }

    if (type == 'wake_signal') {
      if (cheSleeping) HapticFeedback.lightImpact();
      return;
    }

    if (type == 'wake') {
      await _beginRealtimeConversation(fromWake: true);
      return;
    }

    if (type == 'barge_in') {
      // Native layer already stopped CHE audio. Invalidate in-flight speak so
      // finally cannot restart TTS or mute the new listen turn.
      ++_speechTurn;
      _localVoice.bargeIn();
      _mic.cancelRestart('voice state change');
      await flutterTts.stop();
      debugPrint('CHE voice: native barge-in');

      if (!mounted) return;
      _set(() {
        _isSpeaking = false;
        openConversation = true;
        cheSleeping = false;
        isListening = true;
      });
      return;
    }

    if (type == 'utterance') {
      var words = event['text']?.toString().trim() ?? '';
      if (words.isEmpty) return;

      // Race-safe fallback: if the final transcript arrives before the
      // barge-in event, stop any remaining audio before handling the command.
      if (_isSpeaking) {
        await _interruptSpeechAndListen(resumeListening: false);
      }

      if (_isSending) return;

      if (wakePhraseMode && cheSleeping) {
        final afterWake = cheWakeRemainder(words);
        if (afterWake == null) return;

        // Live (OpenAI Realtime) voice only when the server says it is set up.
        if (integrations['openai_live_voice'] == true) {
          await _beginRealtimeConversation(fromWake: true);
          if (_realtimeVoice?.connected == true) {
            if (afterWake.isNotEmpty) {
              if (mounted) {
                _set(() {
                  messages.add({'role': 'user', 'text': afterWake});
                });
                _scrollToBottom();
              }
              await _realtimeVoice!.sendText(afterWake);
            }
            return;
          }
        }

        // Standard wake: CHE is awake, answers out loud, and handles any
        // command said in the same breath ("Chay, what's the weather?").
        HapticFeedback.mediumImpact();
        if (!mounted) return;
        _set(() {
          cheSleeping = false;
          openConversation = true;
        });
        if (afterWake.isEmpty) {
          await speakText('Yeah, sir?');
        } else {
          _set(() {
            controller.text = afterWake;
            isListening = false;
          });
          await sendMessage(fromVoice: true);
        }
        return;
      }

      if (_isSleepPhrase(words)) {
        if (!mounted) return;
        _set(() {
          cheSleeping = true;
          isListening = false;
        });

        try {
          await CheNativeVoice.sleep();
        } catch (_) {}
        await _closeMicUnlessHandsFree();

        await _controlAutonomy('stand by');
        return;
      }

      // If the owner still says the wake name while already awake, strip it.
      words = cheWakeRemainder(words) ?? words;

      if (words.isEmpty) {
        await speakText('Yeah, sir?');
        return;
      }

      if (!mounted) return;

      _set(() {
        controller.text = words;
        controller.selection = TextSelection.collapsed(
          offset: controller.text.length,
        );
        isListening = false;
      });
      _localVoice.goThinking();
      debugPrint('CHE voice: thinking (utterance)');

      await sendMessage(fromVoice: true);
      return;
    }

    if (type == 'error' && mounted) {
      final message =
          event['message']?.toString() ?? 'Unknown native voice error.';

      await _fallbackSpeech(message);
    }
  }
}

