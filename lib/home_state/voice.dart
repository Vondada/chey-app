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

  Future<bool> _playServerVoice(CheVoiceClip clip, [CheVoiceTurnOutcome? outcome]) async {
    // The clip's words, the owner's Voice Volume and Audio Output go with it.
    final played = await CheNativeVoice.playAudioBounded(clip.bytes, text: clip.text);
    final route = CheNativeVoice.lastPlayback['route']?.toString() ?? '';
    if (route.isNotEmpty) _audioRouteNow = route;
    final engine = clip.engine.isEmpty ? 'server-voice' : clip.engine;
    if (played) {
      _naturalVoiceServerErrored = false;
      outcome?.played(engine);
      if (_lastVoiceEngine != engine) {
        _lastVoiceEngine = engine;
        if (mounted) _set(() {});
      }
      return true;
    }
    _naturalVoiceServerErrored = true;
    final why = CheNativeVoice.lastPlaybackError;
    _voiceFailReason = 'the iPhone could not play the ${cheVoiceEngineLabel(engine)} clip${why.isEmpty ? '' : ' ($why)'}';
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
        // A build that routes CHE's voice itself (the loudspeaker unless the
        // owner connected headphones, Bluetooth, AirPlay or a car, or his
        // Audio Output choice) must not have the WebRTC helper reset that
        // route before every reply. Older builds keep the helper.
        final routed = await CheNativeVoice.setAudioOutput(CheUiPreferences.instance.audioOutput.name);
        if (routed == null) {
          await Helper.setSpeakerphoneOnButPreferBluetooth();
        } else {
          _audioRouteNow = routed['route']?.toString() ?? _audioRouteNow;
        }
      } catch (e) {
        // Allow a later speak to retry setup if the first attempt failed.
        _localVoice.audioSessionReady = false;
        debugPrint('CHE voice: audio session setup failed');
      }
    }
  }

  /// Speak on an explicit owner request. Read This bypasses the ordinary
  /// voice-replies toggle without enabling automatic screen narration.
  Future<void> speakText(String text, {bool record = true, bool readOnDemand = false}) async {
    if (text.trim().isEmpty) return;
    if (record && mounted && (messages.isEmpty || messages.last['text'] != text)) {
      _set(() => messages.add({'role': 'assistant', 'text': text}));
    }
    // Suppress near-duplicate server+native races of the same sentence.
    if (!_localVoice.acceptSpeak(text)) {
      debugPrint('CHE voice: skip duplicate speak');
      return;
    }
    final turn = _openSpeechTurn(readOnDemand: readOnDemand);
    if (turn == null) return;
    // CHE is written "CHE" and said "Chay" (owner, 2026-10-14). Only the words
    // handed to a voice change; the transcript above keeps "CHE".
    // Read This can include whole Brain memories or long articles. The Fish and
    // ElevenLabs routes reject a clip above 800 characters; split before
    // prefetch so every part can use them, in the correct order.
    // Markdown and technical formatting become natural speech first, so Read
    // This never reads symbols aloud; the transcript keeps the formatting.
    for (final chunk in cheReadAloudChunks(cheSpeakableText(text))) {
      turn.add(cheSpokenText(chunk));
    }
    turn.close();
    await turn.done;
  }

  /// Starts one spoken assistant turn. Chunks added to the returned pipeline
  /// are synthesized ahead of playback and played back to back; the mic is
  /// suppressed once at the start and resumed once at the end of the turn.
  /// [purpose] is 'story' for a story the owner asked for (Fish's expressive
  /// voice), otherwise 'conversation'.
  CheSpeechPipeline<CheVoiceClip>? _openSpeechTurn({bool readOnDemand = false, String purpose = 'conversation'}) {
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
    if (!voiceResponsesEnabled && !readOnDemand) {
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
    // CHE's voice on the iPhone is ElevenLabs, then Fish, and nothing else
    // (owner, 2026-10-14): no iPhone voice and no free server voice. A clip
    // neither could speak stays silent, with its words and the reason on screen.
    final premiumOnly = !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;
    final outcome = CheVoiceTurnOutcome();
    // One voice for the whole reply (owner, 2026-10-18): the first clip's
    // voice is locked for every later clip; a failure partway stops the voice
    // and says why instead of switching to another voice.
    final voice = CheVoiceTurn((text, {required turn, required index, lock = ''}) =>
        CheEdgeVoice.speak(text, purpose: purpose, premiumOnly: true, turn: turn, index: index, lock: lock));
    // Clips are prepared ahead of playback, so each silent clip keeps its own
    // reason instead of reading a shared one another clip may have changed.
    final silentReasons = <String, String>{};
    String? playFailure;
    late final CheSpeechPipeline<CheVoiceClip> turn;
    turn = CheSpeechPipeline<CheVoiceClip>(
      ready: _prepareSpeechOutput(),
      synthesize: (text) async {
        if (!premiumOnly) return null;
        final made = await voice.synthesize(text);
        final edge = made.result;
        final edgeClip = edge.clip;
        final engine = edgeClip?.engine ?? 'none';
        if (edge.maryStatus.isNotEmpty) _maryStatus = edge.maryStatus;
        if (edge.fishStatus.isNotEmpty) _fishStatus = edge.fishStatus;
        if (engine == 'fish-audio') _fishStatus = 'healthy';
        if (edgeClip != null && edgeClip.bytes.isNotEmpty) {
          // When Fish spoke, why ElevenLabs did not, for the diagnostics sheet.
          _voiceFailReason = cheMaryReason(edge.maryStatus, engine);
          return CheVoiceClip(edgeClip.bytes, edgeClip.engine, text: text, index: made.index, tag: edge.tag);
        }
        final why = cheSilentVoiceReason(edge);
        _voiceFailReason = why;
        silentReasons[text] = why;
        return null;
      },
      play: (clip) async {
        // A clip after the point where the locked voice failed stays unheard,
        // so the reply never skips ahead or resumes in pieces.
        if (voice.stoppedBefore(clip.index)) {
          playFailure = voice.interruption;
          return false;
        }
        final started = DateTime.now();
        final played = await _playServerVoice(clip, outcome);
        if (played) outcome.timedClip(DateTime.now().difference(started).inMilliseconds, cheAudioDurationMs(clip.bytes));
        playFailure = played ? null : _voiceFailReason;
        return played;
      },
      fallback: (text) {
        if (!premiumOnly) return _speakFallbackChunk(text);
        final why = silentReasons.remove(text) ?? playFailure ?? 'neither ElevenLabs nor Fish sent audio';
        playFailure = null;
        return _staySilent(text, why, outcome);
      },
      log: (m) => debugPrint('CHE voice timing: $m'),
      onComplete: (cancelled) async {
        if (cancelled) voice.cancel();
        outcome
          ..provider = voice.provider
          ..tags = Map.of(voice.tags)
          ..fallback = voice.fallback
          ..interrupted = voice.interrupted
          ..stopped = cancelled
          ..retries = voice.retries
          ..gapsMs = List.of(turn.gapsMs)
          ..synthMs = List.of(turn.synthMs)
          ..firstAudioMs = turn.firstPlaybackMs;
        if (premiumOnly && outcome.chunks > 0) {
          _lastSpokenReply = outcome.summary();
          unawaited(CheEdgeVoice.report(outcome.toReport()));
        }
        await _finishSpeechTurn(turn, speechTurn, localGen);
      },
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
      // Audio-session setup must not hold the turn: a stalled platform call
      // would otherwise keep every chunk waiting in silence.
      await _ensureAudibleOutput().timeout(const Duration(seconds: 3), onTimeout: () {});
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS && _nativeIosVoiceActive) {
        try {
          await CheNativeVoice.setAssistantSpeaking(true);
        } catch (_) {}
      }
    } catch (_) {}
  }

  /// A clip neither ElevenLabs nor Fish could speak (owner, 2026-10-14: never
  /// the iPhone voice). Its words go into a large banner with the reason, which
  /// VoiceOver reads, and the phone gives one strong haptic per reply.
  Future<bool> _staySilent(String text, String reason, CheVoiceTurnOutcome outcome) async {
    final first = outcome.silent == 0;
    _naturalVoiceServerErrored = true;
    outcome.stayedSilent(text, reason);
    _lastVoiceEngine = 'none';
    if (first) {
      unawaited(HapticFeedback.heavyImpact());
      unawaited(Future<void>.delayed(const Duration(milliseconds: 160), HapticFeedback.heavyImpact));
    }
    if (!mounted) return true;
    _set(() {});
    final unspoken = outcome.silentText.join(' ');
    final shown = unspoken.length > 600 ? '${unspoken.substring(0, 600)}…' : unspoken;
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(
      duration: const Duration(seconds: 12),
      content: Semantics(
        liveRegion: true,
        label: 'CHE stayed silent: ${outcome.reasons.join('; ')}. $shown',
        excludeSemantics: true,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('CHE stayed silent: ${outcome.reasons.join('; ')}',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text(shown, style: const TextStyle(fontSize: 22, height: 1.3)),
          ],
        ),
      ),
    ));
    return true;
  }

  /// The device voice for one chunk, used only off the iPhone (web, desktop).
  Future<bool> _speakFallbackChunk(String text) async {
    try {
      if (kIsWeb) {
        if (await che_web_voice.speakText(text)) return true;
        await flutterTts.stop();
        await flutterTts.speak(text);
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

    if (type == 'audio_route') {
      // Headphones or Bluetooth came or went: shown in Voice diagnostics.
      _audioRouteNow = event['route']?.toString() ?? _audioRouteNow;
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

