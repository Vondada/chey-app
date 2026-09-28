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
              !_isSending &&
              !_isSpeaking &&
              !_autoSentCurrentTurn) {
            _restartListeningSoon();
          }
        },
        onError: (error) {
          if (!mounted) return;

          _set(() {
            isListening = false;
          });

          if (!kIsWeb && openConversation && !_isSending && !_isSpeaking) {
            _restartListeningSoon(delay: const Duration(milliseconds: 800));
          }
        },
      );

      // This is still device/browser TTS. The Agent prompt is written to make
      // the WORDING and rhythm natural. A true neural voice can replace this
      // TTS layer later without changing the agent/memory/security design.
      await flutterTts.setLanguage('en-US');
      await flutterTts.setSpeechRate(0.44);
      await flutterTts.setPitch(0.95);
      await flutterTts.setVolume(1.0);

      // Native iPhone build: prefer a smoother modern English voice when
      // the device has one installed. This is ignored safely on web/Android.
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
        try {
          final dynamic voices = await flutterTts.getVoices;
          if (voices is List) {
            final preferredNames = <String>[
              'Samantha',
              'Ava',
              'Nicky',
              'Zoe',
              'Serena',
            ];

            Map<dynamic, dynamic>? selected;

            for (final wanted in preferredNames) {
              for (final dynamic candidate in voices) {
                if (candidate is Map) {
                  final name =
                      (candidate['name'] ?? '').toString().toLowerCase();
                  final locale =
                      (candidate['locale'] ?? '').toString().toLowerCase();

                  if (name.contains(wanted.toLowerCase()) &&
                      locale.startsWith('en')) {
                    selected = candidate;
                    break;
                  }
                }
              }
              if (selected != null) break;
            }

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
        } else if (!kIsWeb && openConversation) {
          _restartListeningSoon();
        }
      });

      flutterTts.setCancelHandler(() {
        _isSpeaking = false;
        if (mounted) _set(() {});
      });

      flutterTts.setErrorHandler((message) {
        _isSpeaking = false;
        if (mounted) _set(() {});

        if (!kIsWeb && openConversation) {
          _restartListeningSoon();
        }
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
    if (freeNativeVoiceMode ||
        kIsWeb ||
        defaultTargetPlatform != TargetPlatform.iOS ||
        _deviceToken == null ||
        cheAgentBaseUrl.isEmpty ||
        integrations['natural_voice'] != true) {
      return false;
    }

    try {
      final response = await http
          .post(
            Uri.parse('$cheAgentBaseUrl/api/voice/synthesize'),
            headers: _authHeaders,
            body: jsonEncode({'text': text}),
          )
          .timeout(const Duration(seconds: 25));

      if (response.statusCode == 401) {
        await _clearSecuritySession();
        return false;
      }

      if (response.statusCode != 200 || response.bodyBytes.isEmpty) {
        return false;
      }

      final contentType =
          response.headers['content-type']?.toLowerCase() ?? '';
      if (!contentType.startsWith('audio/')) return false;

      return await CheNativeVoice.playAudio(response.bodyBytes);
    } catch (_) {
      return false;
    }
  }

  Future<void> speakText(String text) async {
    if (text.trim().isEmpty) return;
    if (_realtimeVoice?.connected == true) {
      // Realtime owns both microphone and speaker during a live session.
      return;
    }
    final speechTurn = ++_speechTurn;

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
      } else if (!kIsWeb && openConversation) {
        _restartListeningSoon();
      }
      return;
    }

    try {
      if (speech.isListening) {
        await speech.stop();
      }

      if (mounted) {
        _set(() {
          isListening = false;
        });
      }

      _isSpeaking = true;
      if (mounted) _set(() {});

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
        // Smooth voice order: CHE's local Chaze neural voice when its voice
        // pack is ready (free, unmetered), then the smooth cloud voices
        // (ElevenLabs / OpenAI / Cloudflare / Gemini), and only then the
        // basic iPhone voice. The basic voice never pre-empts a smooth one.
        var played = false;
        try {
          played = await CheNativeVoice.speakNeural(spokenText);
        } on MissingPluginException {
          played = false;
        } catch (_) {
          played = false;
        }

        if (!played) {
          played = await _tryNaturalVoice(spokenText);
        }

        if (!played) {
          try {
            played = await CheNativeVoice.speakText(spokenText);
          } on MissingPluginException {
            played = false;
          } catch (_) {
            played = false;
          }
        }

        if (!played) {
          await flutterTts.stop();
          await flutterTts.speak(spokenText);
        }
      } else {
        await flutterTts.stop();
        await flutterTts.speak(spokenText);
      }
    } catch (_) {
      // Keep the typed response even if audio output fails. Native mode removes
      // Safari's autoplay restriction entirely.
    } finally {
      if (speechTurn == _speechTurn) {
        if (!kIsWeb &&
            defaultTargetPlatform == TargetPlatform.iOS &&
            _nativeIosVoiceActive) {
          try {
            await CheNativeVoice.setAssistantSpeaking(false);
          } catch (_) {}
        }

        _isSpeaking = false;
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
        } else if (!kIsWeb && openConversation) {
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
    _listenRestartTimer?.cancel();
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
      }
    });
    if (!resumeListening) return;
    if (kIsWeb) {
      _rearmWebMicSoon(delay: const Duration(milliseconds: 150));
    } else if (_nativeIosVoiceActive) {
      await CheNativeVoice.start();
    } else {
      await _startListening();
    }
  }

  Future<void> _initNativeIosVoice() async {
    _nativeIosVoiceSub?.cancel();
    _nativeIosVoiceSub = CheNativeVoice.events.listen(
      _handleNativeIosVoiceEvent,
      onError: (_) {
        _nativeIosVoiceActive = false;
        if (mounted) _set(() {});
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
    } on MissingPluginException {
      // The native voice channel is optional until its Runner code is added.
      // The microphone button uses speech_to_text in the meantime.
      _nativeIosVoiceActive = false;
    } catch (e) {
      _nativeIosVoiceActive = false;

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

      await speakText('Standing by, sir.');
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
      // The native iPhone layer has already stopped CHE's audio. Advance the
      // speech generation immediately so the cancelled response cannot resume.
      ++_speechTurn;
      _listenRestartTimer?.cancel();
      await flutterTts.stop();

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
        final wakeMatch = RegExp(
          r'^(?:hey\s+)?(?:chay|chey|shay|chai|chee|chi|che|she|c\.?\s*h\.?\s*e\.?)[\s,.:;!?-]*',
          caseSensitive: false,
        ).firstMatch(words);

        if (wakeMatch == null) return;

        final afterWake = words.substring(wakeMatch.end).trim();
        await _beginRealtimeConversation(fromWake: true);

        if (afterWake.isNotEmpty && _realtimeVoice?.connected == true) {
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

      if (_isSleepPhrase(words)) {
        if (!mounted) return;
        _set(() {
          cheSleeping = true;
          isListening = false;
        });

        try {
          await CheNativeVoice.sleep();
        } catch (_) {}

        await speakText('Standing by, sir.');
        return;
      }

      // If the owner still says the wake name while already awake, strip it.
      words = words
          .replaceFirst(
            RegExp(
              r'^(?:hey\s+)?(?:chay|chey|shay|chai|chee|chi|che|she|c\.?\s*h\.?\s*e\.?)[\s,.:;!?-]*',
              caseSensitive: false,
            ),
            '',
          )
          .trim();

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

      await sendMessage(fromVoice: true);
      return;
    }

    if (type == 'error' && mounted) {
      final message =
          event['message']?.toString() ?? 'Unknown native voice error.';

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(message)),
      );
    }
  }
}
