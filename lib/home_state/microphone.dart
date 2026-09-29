part of '../main.dart';

// Split out of main.dart: _CHEHomeState members (microphone).
extension _CheHomeMicrophone on _CHEHomeState {
  Future<void> toggleListening() async {
    HapticFeedback.lightImpact();

    if (_realtimeVoice?.connected == true) {
      if (_isSpeaking) {
        await _realtimeVoice!.cancelActiveResponse('mic button');
        _applyVoiceSnapshot(_voiceMachine.snapshot);
      } else {
        await _returnToWakeStandby();
      }
      return;
    }

    if (!kIsWeb &&
        defaultTargetPlatform == TargetPlatform.iOS &&
        cheSleeping) {
      await _beginRealtimeConversation(fromWake: true);
      return;
    }

    if (_isSpeaking) {
      await _interruptSpeechAndListen();
      return;
    }
    if (!kIsWeb &&
        defaultTargetPlatform == TargetPlatform.iOS &&
        _nativeIosVoiceActive) {
      // When CHE is in wake-word standby, tapping the mic means "wake now"
      // rather than "turn the microphone off."
      if (openConversation && cheSleeping) {
        try {
          await CheNativeVoice.wake();
        } catch (_) {}

        if (mounted) {
          _set(() {
            cheSleeping = false;
            isListening = true;
          });
        }
        return;
      }

      if (openConversation) {
        await CheNativeVoice.stop();

        if (mounted) {
          _set(() {
            openConversation = false;
            isListening = false;
          });
        }
      } else {
        final started = await CheNativeVoice.start();

        if (mounted) {
          _set(() {
            _nativeIosVoiceActive = started;
            openConversation = started;
            cheSleeping = !started ? cheSleeping : false;
            isListening = started;
          });
        }
      }
      return;
    }

    // iPhone/Safari: record real microphone audio and let the private Windows
    // Agent transcribe it locally instead of using Web Speech recognition.
    if (kIsWeb) {
      try {
        che_web_voice.primeSpeech();
      } catch (_) {}

      if (isListening || openConversation) {
        openConversation = false;
        if (mounted) {
          _set(() {
            isListening = false;
          });
        }
        return;
      }

      await _captureWebSpeech();
      return;
    }

    if (!speechAvailable) {
      if (!mounted) return;

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Microphone speech recognition is not available yet.',
          ),
        ),
      );
      return;
    }

    if (openConversation || speech.isListening) {
      openConversation = false;
      _listenRestartTimer?.cancel();
      _autoSentCurrentTurn = false;

      if (speech.isListening) {
        await speech.stop();
      }

      if (!mounted) return;
      _set(() {
        isListening = false;
      });
      return;
    }

    openConversation = true;
    // An explicit tap on the mic is already the "wake me up" action.
    cheSleeping = false;
    if (mounted) _set(() {});
    await _startListening();
  }

  bool _isWakePhrase(String raw) => cheIsWake(raw);

  bool _isSleepPhrase(String raw) {
    final text = raw.trim().toLowerCase();

    return text == 'stand down' ||
        text == 'chay stand down' ||
        text == 'chey stand down' ||
        text == 'shay stand down' ||
        text == 'che stand down' ||
        text == 'c h e stand down' ||
        text == 'go to sleep' ||
        text == 'chay go to sleep' ||
        text == 'chey go to sleep' ||
        text == 'che go to sleep';
  }

  void _rearmWebMicSoon({
    Duration delay = const Duration(milliseconds: 350),
  }) {
    if (!kIsWeb || !openConversation) return;

    Future.delayed(delay, () {
      if (!mounted ||
          !openConversation ||
          _isSending ||
          _isSpeaking ||
          isListening) {
        return;
      }

      _captureWebSpeech();
    });
  }

  Future<void> _captureWebSpeech() async {
    if (_isSending || _isSpeaking || isListening) return;
    if (!await _ensurePaired()) return;

    openConversation = true;

    if (mounted) {
      _set(() {
        isListening = true;
      });
    }

    try {
      await flutterTts.stop();

      final token = _deviceToken ?? '';
      if (token.isEmpty) {
        throw Exception('This device is not paired.');
      }

      final rawSpeech = (await che_web_voice.captureSpeech(
        cheAgentBaseUrl,
        token,
      )).trim();

      if (!mounted) return;

      _set(() {
        isListening = false;
      });

      // Silence: quietly keep the foreground voice loop alive.
      if (rawSpeech.isEmpty) {
        _rearmWebMicSoon();
        return;
      }

      // SLEEPING MODE:
      // Ignore everything except the wake phrase. No message is sent to the AI.
      if (cheSleeping) {
        final afterWake = cheWakeRemainder(rawSpeech);
        if (afterWake != null) {
          _set(() {
            cheSleeping = false;
          });

          if (afterWake.isEmpty) {
            await speakText('Yeah, sir?');
          } else {
            _set(() => controller.text = afterWake);
            await sendMessage(fromVoice: true);
          }
        } else {
          _rearmWebMicSoon();
        }
        return;
      }

      // One phrase puts CHE into standby while she continues listening only
      // for her name.
      if (_isSleepPhrase(rawSpeech)) {
        _set(() {
          cheSleeping = true;
          controller.clear();
        });

        await speakText('Standing by, sir.');
        return;
      }

      var spokenWords = cheWakeRemainder(rawSpeech) ?? rawSpeech.trim();

      // If the only thing said was "CHE" while already awake, acknowledge it
      // and continue listening for the actual command.
      if (spokenWords.isEmpty && _isWakePhrase(rawSpeech)) {
        await speakText('Yeah, sir?');
        return;
      }

      if (!mounted) return;

      _set(() {
        controller.text = spokenWords;
        controller.selection = TextSelection.collapsed(
          offset: controller.text.length,
        );
      });

      if (spokenWords.isEmpty) {
        _rearmWebMicSoon();
        return;
      }

      await sendMessage(fromVoice: true);
    } catch (e) {
      if (!mounted) return;

      _set(() {
        isListening = false;
      });

      // Keep the conversation armed after a temporary capture failure.
      if (openConversation) {
        _rearmWebMicSoon(
          delay: const Duration(milliseconds: 900),
        );
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'C.H.E. microphone issue: '
            '${e.toString().replaceFirst("Exception: ", "")}',
          ),
        ),
      );
    }
  }

  Future<void> _startListening() async {
    // Native iPhone voice already owns the microphone and keeps it open for
    // interruption detection. Never start the Flutter recognizer on top of it.
    if (_nativeIosVoiceActive) {
      if (mounted && !_isSpeaking && isListening != true) {
        _set(() => isListening = true);
      }
      return;
    }

    if (!speechAvailable ||
        !openConversation ||
        _isSending ||
        _isSpeaking ||
        speech.isListening) {
      return;
    }

    _autoSentCurrentTurn = false;

    try {
      await speech.listen(
        onResult: (result) async {
          if (!mounted) return;

          final rawWords = result.recognizedWords.trim();
          if (rawWords.isEmpty) return;

          // ----------------------------------------------------------------
          // WAKE-ONLY MODE ("Chay" has not been said yet, or "stand down"
          // was said previously). CHE listens for nothing except her wake
          // word here — no command text is shown or sent while sleeping.
          // ----------------------------------------------------------------
          if (wakePhraseMode && cheSleeping) {
            if (!result.finalResult) return;

            final afterWake = cheWakeRemainder(rawWords);
            if (afterWake != null) {
              _autoSentCurrentTurn = true;
              cheSleeping = false;

              if (speech.isListening) {
                await speech.stop();
              }
              if (!mounted) return;
              _set(() {
                isListening = false;
              });

              if (afterWake.isEmpty) {
                await speakText('Yeah, sir?');
              } else {
                _set(() => controller.text = afterWake);
                await sendMessage(fromVoice: true);
              }
              return;
            }

            // Not the wake word: stay asleep and keep listening quietly.
            if (!kIsWeb && openConversation) {
              _restartListeningSoon(delay: const Duration(milliseconds: 250));
            }
            return;
          }

          // ----------------------------------------------------------------
          // OPEN CONVERSATION MODE. CHE is already awake, so every sentence
          // is treated as a command — no wake word required per turn.
          // ----------------------------------------------------------------
          var spokenWords = rawWords;

          // If the owner still says "Chay" out of habit before a command,
          // strip it rather than requiring or rejecting it.
          spokenWords = cheWakeRemainder(spokenWords) ?? spokenWords;

          if (spokenWords.isEmpty) {
            // They only said the wake word again while already awake —            // acknowledge it without ending the conversation.
            if (result.finalResult && !_autoSentCurrentTurn && !_isSending) {
              _autoSentCurrentTurn = true;
              if (speech.isListening) await speech.stop();
              if (!mounted) return;
              _set(() => isListening = false);
              await speakText('Yeah, sir?');
            }
            return;
          }

          if (result.finalResult && _isSleepPhrase(spokenWords)) {
            _autoSentCurrentTurn = true;
            cheSleeping = true;
            controller.clear();

            if (speech.isListening) await speech.stop();
            if (!mounted) return;
            _set(() => isListening = false);

            await speakText('Standing by, sir.');
            return;
          }

          _set(() {
            controller.text = spokenWords;
            controller.selection = TextSelection.collapsed(
              offset: controller.text.length,
            );
          });

          if (result.finalResult && !_autoSentCurrentTurn && !_isSending) {
            _autoSentCurrentTurn = true;

            // iPhone Safari speech recognition is intermittent. We end the
            // web turn cleanly instead of forcing an on/off restart loop.
            if (kIsWeb) {
              openConversation = false;
            }

            if (speech.isListening) {
              await speech.stop();
            }

            if (!mounted) return;
            _set(() {
              isListening = false;
            });

            await sendMessage(fromVoice: true);
          }
        },
        listenOptions: stt.SpeechListenOptions(
          partialResults: true,
          cancelOnError: true,
          autoPunctuation: true,
          listenMode: stt.ListenMode.dictation,
          pauseFor: const Duration(milliseconds: 1400),
          listenFor: const Duration(seconds: 30),
        ),
      );

      if (!mounted) return;
      _set(() {
        isListening = speech.isListening;
      });
    } catch (_) {
      if (!mounted) return;

      _set(() {
        isListening = false;
      });

      if (!kIsWeb && openConversation && !_isSending && !_isSpeaking) {
        _restartListeningSoon(delay: const Duration(milliseconds: 800));
      }
    }
  }

  void _restartListeningSoon({
    Duration delay = const Duration(milliseconds: 450),
  }) {
    if (kIsWeb) return;

    // Native iPhone recognition is continuous and already listening while CHE
    // talks. Starting speech_to_text here would fight for the same microphone.
    if (_nativeIosVoiceActive) {
      if (mounted && !_isSpeaking && isListening != true) {
        _set(() => isListening = true);
      }
      return;
    }

    _listenRestartTimer?.cancel();

    _listenRestartTimer = Timer(delay, () {
      if (!mounted ||
          !openConversation ||
          _isSending ||
          _isSpeaking ||
          speech.isListening) {
        return;
      }

      _startListening();
    });
  }
}
