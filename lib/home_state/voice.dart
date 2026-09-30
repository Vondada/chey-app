part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (voice).
extension _CheHomeVoice on _CHEHomeState {
  Future<void> initializeVoice() async {
    try {
      final available = await speech.initialize(
        onStatus: (status) {
          if (!mounted) return;

          final listeningNow = speech.isListening;
          if (isListening != listeningNow) {
            _set(() {
              isListening = listeningNow;
            });
          }

          final recognitionStopped =
              status == 'done' || status == 'notListening';

          if (!kIsWeb &&
              recognitionStopped &&
              openConversation &&
              !cheSleeping &&
              !_isSending &&
              !_isSpeaking &&
              !_localVoice.isSpeaking &&
              !_autoSentCurrentTurn) {
            _restartListeningSoon();
          }
        },
        onError: (error) {
          if (!mounted) return;

          _set(() {
            isListening = false;
          });

          if (!kIsWeb &&
              openConversation &&
              !cheSleeping &&
              !_isSending &&
              !_isSpeaking &&
              !_localVoice.isSpeaking) {
            _restartListeningSoon(delay: const Duration(milliseconds: 800));
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
      if (!kIsWeb && available) {
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

  Future<bool> _tryNaturalVoice(String text) async {
    _naturalVoiceServerErrored = false;
    _voiceFailReason = '';

    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) {
      return false;
    }

    if (_localVoice.serverVoiceCoolingDown) {
      _naturalVoiceServerErrored = true;
      _voiceFailReason = 'server voice cooling down';
      debugPrint('CHE voice: skip server TTS (cooldown)');
      return false;
    }

    if (_deviceToken == null ||
        cheAgentBaseUrl.isEmpty ||
        integrations['natural_voice'] != true) {
      _naturalVoiceServerErrored = true;
      _voiceFailReason = 'server voice not connected';
      return false;
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
        return false;
      }

      if (response.statusCode == 429) {
        _localVoice.markServerVoiceCooldown();
        _naturalVoiceServerErrored = true;
        _voiceFailReason = 'server voice 429';
        debugPrint('CHE voice: server TTS 429 cooldown');
        return false;
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
        return false;
      }
      _voiceFailReason = '';

      final contentType =
          response.headers['content-type']?.toLowerCase() ?? '';
      if (!contentType.startsWith('audio/')) {
        _naturalVoiceServerErrored = true;
        return false;
      }

      final played = await CheNativeVoice.playAudio(response.bodyBytes);
      if (played) {
        final engine = (response.headers['x-che-voice'] ?? '').trim();
        if (mounted) {
          _set(() {
            _lastVoiceEngine = engine.isEmpty ? 'server-voice' : engine;
          });
        } else {
          _lastVoiceEngine = engine.isEmpty ? 'server-voice' : engine;
        }
        debugPrint('CHE voice: played $_lastVoiceEngine');
        return true;
      }
      // Bytes arrived but nothing audible — keep cascading to neural/native/TTS.
      _naturalVoiceServerErrored = true;
      _voiceFailReason = 'server voice playback failed';
      return false;
    } catch (e) {
      _naturalVoiceServerErrored = true;
      _voiceFailReason = e is TimeoutException ? 'server voice timed out' : 'server voice unreachable';
      debugPrint('CHE voice: $_voiceFailReason');
      return false;
    }
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
    // Mirror the persisted UI Controls toggle (defaults ON).
    voiceResponsesEnabled = CheUiPreferences.instance.voiceResponsesEnabled;
    if (_realtimeVoice?.connected == true) {
      // Realtime owns the speaker while it is mid-turn. Otherwise fall through
      // to local TTS so greetings / system prompts are not silently dropped when
      // Realtime is connected but idle — or when its audio path failed open.
      final phase = _voiceSnapshot.phase;
      final realtimeBusy = phase == CheVoicePhase.speaking ||
          phase == CheVoicePhase.thinking ||
          phase == CheVoicePhase.userSpeaking ||
          phase == CheVoicePhase.connecting;
      if (realtimeBusy) {
        return;
      }
    }
    // CHE refers to and pronounces herself as "CHE" in normal conversation.
    // "Chay" is reserved for the spoken wake word only, so no substitution
    // happens here.
    final spokenText = text;

    if (!voiceResponsesEnabled) {
      if (kIsWeb && openConversation) {
        Future.delayed(
          const Duration(milliseconds: 300),
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
      } else if (!kIsWeb && openConversation && !cheSleeping) {
        _restartListeningSoon();
      }
      return;
    }

    // Suppress near-duplicate server+native races of the same sentence.
    if (!_localVoice.acceptSpeak(text)) {
      debugPrint('CHE voice: skip duplicate speak');
      return;
    }
    final speechTurn = ++_speechTurn;
    final localGen = _localVoice.goSpeaking();
    debugPrint('CHE voice: speaking');

    try {
      if (speech.isListening) {
        await _localVoice.runMicOp(() async {
          await speech.stop();
        });
      }

      if (mounted) {
        _set(() {
          isListening = false;
        });
      }

      _isSpeaking = true;
      if (mounted) _set(() {});

      await _ensureAudibleOutput();

      if (!kIsWeb &&
          defaultTargetPlatform == TargetPlatform.iOS &&
          _nativeIosVoiceActive) {
        try {
          await CheNativeVoice.setAssistantSpeaking(true);
        } catch (_) {}
      }

      if (kIsWeb) {
        final played = await che_web_voice.speakText(spokenText);
        if (!played) {
          await flutterTts.stop();
          await flutterTts.speak(spokenText);
        }
      } else if (defaultTargetPlatform == TargetPlatform.iOS) {
        // Server voice first. The iPhone voice is only a fallback when the
        // server voice request fails, unless the owner explicitly forces
        // free native voice mode.
        var played = false;
        if (!freeNativeVoiceMode) {
          played = await _tryNaturalVoice(spokenText);
        } else {
          _naturalVoiceServerErrored = true;
        }

        // Always cascade when prior stage was silent — never leave the owner
        // with a typed reply and no audio.
        if (!played) {
          try {
            played = await CheNativeVoice.speakNeural(spokenText);
            if (played && mounted) {
              _set(() {
                _lastVoiceEngine = _voiceFailReason.isEmpty ? 'iphone-neural' : 'iphone-neural (server voice failed: $_voiceFailReason)';
              });
            }
          } on MissingPluginException {
            played = false;
          } catch (_) {
            played = false;
          }
        }

        if (!played) {
          try {
            played = await CheNativeVoice.speakText(spokenText);
            if (played && mounted) {
              _set(() {
                _lastVoiceEngine = _voiceFailReason.isEmpty ? 'iphone-voice' : 'iphone-voice (server voice failed: $_voiceFailReason)';
              });
            }
          } on MissingPluginException {
            played = false;
          } catch (_) {
            played = false;
          }
        }

        if (!played) {
          await flutterTts.stop();
          await flutterTts.setVolume(CheUiPreferences.instance.voiceVolume.clamp(0.0, 1.0));
          await flutterTts.speak(spokenText);
          if (mounted) {
            final prior = _naturalVoiceServerErrored && _voiceFailReason.isNotEmpty
                ? 'iphone-tts (server voice failed: $_voiceFailReason)'
                : 'iphone-tts';
            _set(() {
              _lastVoiceEngine = prior;
            });
          }
        }
      } else {
        await flutterTts.stop();
        await flutterTts.speak(spokenText);
      }
    } catch (_) {
      // Keep the typed response even if audio output fails. Native mode removes
      // Safari's autoplay restriction entirely.
    } finally {
      // Barge-in bumps generation / speechTurn so a cancelled speak cannot
      // restart the mic or clear the new listening turn.
      if (speechTurn == _speechTurn && localGen == _localVoice.speechGeneration) {
        if (!kIsWeb &&
            defaultTargetPlatform == TargetPlatform.iOS &&
            _nativeIosVoiceActive) {
          try {
            await CheNativeVoice.setAssistantSpeaking(false);
          } catch (_) {}
        }

        _isSpeaking = false;
        _localVoice.finishSpeakingToListening(continuous: openConversation && !cheSleeping);
        if (mounted) _set(() {});

        if (kIsWeb && openConversation) {
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
        } else if (!kIsWeb && openConversation && !cheSleeping) {
          // Continuous conversation: listen again without requiring wake.
          _restartListeningSoon();
        }
      }
    }
  }

  Future<void> _interruptSpeechAndListen({bool resumeListening = true}) async {
    if (_realtimeVoice?.connected == true) {
      await _realtimeVoice!.cancelActiveResponse('owner interruption');
      _applyVoiceSnapshot(_voiceMachine.snapshot);
      return;
    }
    ++_speechTurn;
    _localVoice.bargeIn();
    _listenRestartTimer?.cancel();
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
    try { await CheNativeVoice.stop(); } catch (_) {}
    _nativeIosVoiceActive = false;
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
    _nativeIosVoiceSub?.cancel();
    _nativeIosVoiceSub = CheNativeVoice.events.listen(
      _handleNativeIosVoiceEvent,
      onError: (_) {
        unawaited(_fallbackSpeech('Native voice event stream failed'));
      },
    );

    try {
      final started = await CheNativeVoice.start();

      if (!mounted) return;

      // The native iPhone bridge now owns hands-free speech recognition
      // when it starts successfully. It keeps listening during CHE speech
      // so the owner can interrupt naturally (barge-in).
      _set(() {
        _nativeIosVoiceActive = started;
        if (started) {
          openConversation = true;
          isListening = true;
        }
      });
      if (!started) await _fallbackSpeech('Native recognition did not start');
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
      _listenRestartTimer?.cancel();
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

