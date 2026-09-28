import 'dart:async';
import 'dart:convert';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

import 'che_voice_state.dart';

typedef CheRealtimeSnapshotCallback = void Function(CheVoiceSnapshot snapshot);
typedef CheRealtimeUserTranscriptCallback = void Function(String text, String? itemId);
typedef CheRealtimeAssistantTranscriptCallback = void Function(
  String text,
  bool isFinal,
  String? responseId,
);
typedef CheRealtimeToolHandler = Future<String> Function(
  String request,
  List<String> capabilityHints,
);
typedef CheRealtimeSleepCallback = Future<void> Function();

class CheRealtimeVoiceEngine {
  CheRealtimeVoiceEngine({
    required this.baseUrl,
    required this.deviceToken,
    required this.state,
    required this.onSnapshot,
    required this.onUserTranscript,
    required this.onAssistantTranscript,
    required this.onCapabilityRequest,
    required this.onStandDown,
  });

  final String baseUrl;
  final String deviceToken;
  final CheVoiceStateMachine state;
  final CheRealtimeSnapshotCallback onSnapshot;
  final CheRealtimeUserTranscriptCallback onUserTranscript;
  final CheRealtimeAssistantTranscriptCallback onAssistantTranscript;
  final CheRealtimeToolHandler onCapabilityRequest;
  final CheRealtimeSleepCallback onStandDown;

  RTCPeerConnection? _peer;
  RTCDataChannel? _events;
  MediaStream? _localStream;
  final RTCVideoRenderer _remoteRenderer = RTCVideoRenderer();

  bool _rendererReady = false;
  bool _disposed = false;
  bool _connected = false;
  bool _handlingTool = false;
  String? _activeResponseId;
  String _assistantTranscript = '';

  String? lastServerEvent;
  String? lastError;

  bool get connected => _connected;

  Future<void> initialize() async {
    if (_rendererReady) return;
    await WebRTC.initialize();
    await _remoteRenderer.initialize();
    _rendererReady = true;
  }

  Future<void> connect() async {
    if (_disposed) throw StateError('Realtime voice engine was disposed.');
    await initialize();
    await disconnect(keepRenderer: true);

    state.beginRealtimeConnect();
    _emitSnapshot();

    try {
      final ephemeralKey = await _fetchEphemeralKey();

      await Helper.ensureAudioSession();
      _localStream = await navigator.mediaDevices.getUserMedia({
        'audio': {
          'echoCancellation': true,
          'noiseSuppression': true,
          'autoGainControl': true,
          'channelCount': 1,
        },
        'video': false,
      });

      final pc = await createPeerConnection(
        {
          'sdpSemantics': 'unified-plan',
          'iceServers': <Map<String, dynamic>>[],
        },
        {
          'mandatory': <String, dynamic>{},
          'optional': <Map<String, dynamic>>[],
        },
      );
      _peer = pc;

      pc.onConnectionState = (value) {
        state.connectionChanged(value.name);
        if (value == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
          _connected = true;
          state.realtimeReady();
          _emitSnapshot();
        } else if (value == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
            value == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected ||
            value == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
          if (!_disposed && _connected) {
            _connected = false;
            state.disconnected('Realtime connection ended.');
            _emitSnapshot();
          }
        } else {
          _emitSnapshot();
        }
      };

      pc.onTrack = (event) {
        if (event.streams.isNotEmpty) {
          _remoteRenderer.srcObject = event.streams.first;
        }
        unawaited(Helper.setSpeakerphoneOnButPreferBluetooth());
      };

      for (final track in _localStream!.getAudioTracks()) {
        await pc.addTrack(track, _localStream!);
      }

      final channel = await pc.createDataChannel(
        'oai-events',
        RTCDataChannelInit()..ordered = true,
      );
      _events = channel;
      channel.onMessage = _handleMessage;
      channel.onDataChannelState = (channelState) {
        state.connectionChanged('data:${channelState.name}');
        if (channelState == RTCDataChannelState.RTCDataChannelOpen) {
          _connected = true;
          state.realtimeReady();
        }
        _emitSnapshot();
      };

      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      final response = await http
          .post(
            Uri.parse('https://api.openai.com/v1/realtime/calls'),
            headers: {
              'Authorization': 'Bearer $ephemeralKey',
              'Content-Type': 'application/sdp',
            },
            body: offer.sdp ?? '',
          )
          .timeout(const Duration(seconds: 20));

      if (response.statusCode != 200) {
        throw StateError('Realtime SDP failed (${response.statusCode}).');
      }

      await pc.setRemoteDescription(
        RTCSessionDescription(response.body, 'answer'),
      );

      await Helper.setSpeakerphoneOnButPreferBluetooth();
    } catch (error) {
      lastError = error.toString();
      state.reportError(lastError!);
      _emitSnapshot();
      await disconnect(keepRenderer: true);
      rethrow;
    }
  }

  Future<String> _fetchEphemeralKey() async {
    final root = baseUrl.replaceFirst(RegExp(r'/$'), '');
    final response = await http
        .post(
          Uri.parse('$root/api/live/token'),
          headers: {
            'Authorization': 'Bearer $deviceToken',
            'Content-Type': 'application/json',
          },
          body: '{}',
        )
        .timeout(const Duration(seconds: 15));

    final decoded = response.body.isEmpty
        ? <String, dynamic>{}
        : Map<String, dynamic>.from(jsonDecode(response.body) as Map);

    if (response.statusCode != 200) {
      throw StateError(
        decoded['detail']?.toString() ?? 'Realtime session token failed.',
      );
    }

    final value = decoded['value']?.toString() ??
        (decoded['client_secret'] is Map
            ? (decoded['client_secret'] as Map)['value']?.toString()
            : null);

    if (value == null || value.isEmpty) {
      throw StateError('Realtime session token was empty.');
    }
    return value;
  }

  void _handleMessage(RTCDataChannelMessage message) {
    if (message.isBinary || message.text.isEmpty) return;

    Map<String, dynamic> event;
    try {
      event = Map<String, dynamic>.from(jsonDecode(message.text) as Map);
    } catch (_) {
      return;
    }

    final type = event['type']?.toString() ?? '';
    lastServerEvent = type;

    switch (type) {
      case 'session.created':
      case 'session.updated':
        state.realtimeReady();
        _connected = true;
        _emitSnapshot();
        return;

      case 'input_audio_buffer.speech_started':
        final wasSpeaking = state.phase == CheVoicePhase.speaking;
        state.userSpeechStarted();
        if (wasSpeaking) {
          _send({
            'type': 'output_audio_buffer.clear',
            'event_id': _eventId('clear'),
          });
        }
        _emitSnapshot();
        return;

      case 'input_audio_buffer.speech_stopped':
        state.userSpeechStopped();
        _emitSnapshot();
        return;

      case 'conversation.item.input_audio_transcription.completed':
        final text = event['transcript']?.toString().trim() ?? '';
        final itemId = event['item_id']?.toString();
        if (!state.acceptFinalTranscript(text: text, itemId: itemId)) return;
        final normalized = _normalize(text);
        if (normalized == 'stand down' ||
            normalized == 'chay stand down' ||
            normalized == 'che stand down' ||
            normalized == 'chey stand down') {
          unawaited(_standDown());
          return;
        }
        onUserTranscript(text, itemId);
        _emitSnapshot();
        return;

      case 'response.created':
        final response = event['response'];
        if (response is Map) {
          _activeResponseId = response['id']?.toString();
          state.responseCreated(_activeResponseId);
        }
        _assistantTranscript = '';
        _emitSnapshot();
        return;

      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
        final responseId = event['response_id']?.toString() ?? _activeResponseId;
        if (!state.acceptResponseEvent(responseId)) return;
        final delta = event['delta']?.toString() ?? '';
        if (delta.isEmpty) return;
        _assistantTranscript += delta;
        state.assistantAudioStarted(responseId: responseId);
        onAssistantTranscript(_assistantTranscript, false, responseId);
        _emitSnapshot();
        return;

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done':
        final responseId = event['response_id']?.toString() ?? _activeResponseId;
        if (!state.acceptResponseEvent(responseId)) return;
        final transcript = event['transcript']?.toString() ??
            event['text']?.toString() ??
            _assistantTranscript;
        if (transcript.trim().isNotEmpty) {
          _assistantTranscript = transcript;
          onAssistantTranscript(_assistantTranscript, true, responseId);
        }
        return;

      case 'response.function_call_arguments.done':
        unawaited(_handleToolCall(event));
        return;

      case 'response.done':
        final response = event['response'];
        final responseId = response is Map
            ? response['id']?.toString()
            : _activeResponseId;
        if (state.acceptResponseEvent(responseId)) {
          state.assistantDone(responseId: responseId);
          if (_assistantTranscript.trim().isNotEmpty) {
            onAssistantTranscript(_assistantTranscript, true, responseId);
          }
        }
        _assistantTranscript = '';
        _activeResponseId = null;
        _emitSnapshot();
        return;

      case 'error':
        final error = event['error'];
        lastError = error is Map
            ? error['message']?.toString() ?? 'Realtime error.'
            : 'Realtime error.';
        state.reportError(lastError!);
        _emitSnapshot();
        return;
    }
  }

  Future<void> _handleToolCall(Map<String, dynamic> event) async {
    if (_handlingTool) return;
    final name = event['name']?.toString() ?? '';
    final callId = event['call_id']?.toString() ?? '';
    if (name != 'che_capability_router' || callId.isEmpty) return;

    Map<String, dynamic> args = <String, dynamic>{};
    try {
      args = Map<String, dynamic>.from(
        jsonDecode(event['arguments']?.toString() ?? '{}') as Map,
      );
    } catch (_) {}

    final request = args['request']?.toString().trim() ?? '';
    final hints = args['capabilities'] is List
        ? (args['capabilities'] as List)
            .map((item) => item.toString())
            .where((item) => item.isNotEmpty)
            .toList()
        : <String>[];

    if (request.isEmpty) return;

    _handlingTool = true;
    state.userSpeechStopped();
    _emitSnapshot();

    try {
      final output = await onCapabilityRequest(request, hints);
      _send({
        'type': 'conversation.item.create',
        'event_id': _eventId('tool'),
        'item': {
          'type': 'function_call_output',
          'call_id': callId,
          'output': output,
        },
      });
      _send({
        'type': 'response.create',
        'event_id': _eventId('continue'),
        'response': {
          'instructions':
              'Use the CHE tool result. Give the owner one unified direct answer. '
              'Never claim an action succeeded unless the tool output confirms it.',
        },
      });
    } catch (error) {
      _send({
        'type': 'conversation.item.create',
        'event_id': _eventId('tool_error'),
        'item': {
          'type': 'function_call_output',
          'call_id': callId,
          'output': jsonEncode({
            'ok': false,
            'error': error.toString(),
          }),
        },
      });
      _send({'type': 'response.create'});
    } finally {
      _handlingTool = false;
    }
  }

  Future<void> sendText(String text) async {
    final clean = text.trim();
    if (!_connected || clean.isEmpty) return;

    _send({
      'type': 'conversation.item.create',
      'event_id': _eventId('text'),
      'item': {
        'type': 'message',
        'role': 'user',
        'content': [
          {'type': 'input_text', 'text': clean},
        ],
      },
    });
    state.userSpeechStopped();
    _emitSnapshot();
    _send({
      'type': 'response.create',
      'event_id': _eventId('respond'),
    });
  }

  Future<void> cancelActiveResponse([String reason = 'owner interruption']) async {
    final id = _activeResponseId;
    state.interrupted(reason);
    _emitSnapshot();

    _send({
      'type': 'response.cancel',
      if (id != null && id.isNotEmpty) 'response_id': id,
      'event_id': _eventId('cancel'),
    });
    _send({
      'type': 'output_audio_buffer.clear',
      'event_id': _eventId('clear'),
    });
    _assistantTranscript = '';
    _activeResponseId = null;
  }

  Future<void> _standDown() async {
    await cancelActiveResponse('stand down');
    await onStandDown();
  }

  Future<void> disconnect({bool keepRenderer = false}) async {
    _connected = false;

    final events = _events;
    _events = null;
    if (events != null) {
      try {
        await events.close();
      } catch (_) {}
    }

    final peer = _peer;
    _peer = null;
    if (peer != null) {
      try {
        await peer.close();
      } catch (_) {}
      try {
        await peer.dispose();
      } catch (_) {}
    }

    final stream = _localStream;
    _localStream = null;
    if (stream != null) {
      for (final track in stream.getTracks()) {
        try {
          await track.stop();
        } catch (_) {}
      }
      try {
        await stream.dispose();
      } catch (_) {}
    }

    _remoteRenderer.srcObject = null;
    if (!keepRenderer && _rendererReady) {
      await _remoteRenderer.dispose();
      _rendererReady = false;
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    await disconnect();
  }

  void _send(Map<String, dynamic> event) {
    final channel = _events;
    if (channel == null ||
        channel.state != RTCDataChannelState.RTCDataChannelOpen) {
      return;
    }
    unawaited(channel.send(RTCDataChannelMessage(jsonEncode(event))));
  }

  void _emitSnapshot() => onSnapshot(state.snapshot);

  String _normalize(String value) => value
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9 ]+'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();

  String _eventId(String prefix) =>
      'che_${prefix}_${DateTime.now().microsecondsSinceEpoch}';
}
