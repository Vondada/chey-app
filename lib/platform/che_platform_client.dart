// Boundary for ChatGPT's platform lane. Endpoints below were verified in
// feature/che-platform-core-multiuser server/cloudflare/worker.js. They are
// not on main yet, so a missing route stays unavailable instead of becoming
// fake production data.

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'che_platform_models.dart';

abstract class ChePlatformGateway {
  Future<ChePlatformPage<ChePlatformNotification>> notifications({bool unreadOnly = false});
  Future<ChePlatformPage<CheCoreRule>> coreRules();
  Future<ChePlatformPage<CheCoreRequest>> coreRequests();
  Future<ChePlatformPage<ChePlatformDevice>> devices();
  Future<ChePlatformTenant?> tenant();
  Future<ChePlatformAvailability> markNotificationRead(String id);
  Future<ChePlatformPage<CheCoreRequest>> submitCoreRequest(CheCoreRequestDraft draft);
  Future<CheEnrollmentResult> createEnrollment({String access = 'private', int ttlMinutes = 10});
}

class CheCoreRequestDraft {
  const CheCoreRequestDraft({
    required this.request,
    this.title = '',
    this.kind = 'capability',
    this.priorityRequested = false,
    this.paidPriorityAuthorized = false,
  });

  final String request;
  final String title;
  final String kind;
  final bool priorityRequested;
  final bool paidPriorityAuthorized;

  Map<String, Object> toJson() => {
        'request': request.trim(),
        'title': title.trim(),
        'kind': kind.trim().isEmpty ? 'capability' : kind.trim(),
        'priority': priorityRequested,
        'paid_priority_authorized': paidPriorityAuthorized,
      };
}

class CheEnrollmentResult {
  const CheEnrollmentResult({required this.availability, this.token = '', this.message = ''});

  final ChePlatformAvailability availability;
  final String token;
  final String message;
}

class CheHttpPlatformGateway implements ChePlatformGateway {
  CheHttpPlatformGateway({
    required this.baseUrl,
    required this.headers,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client _client;

  @override
  Future<ChePlatformPage<ChePlatformNotification>> notifications({bool unreadOnly = false}) async {
    final path = unreadOnly ? '/api/notifications?unread=1' : '/api/notifications';
    final response = await _get(path);
    if (response.availability != ChePlatformAvailability.live) {
      return ChePlatformPage(availability: response.availability, items: const [], message: response.message);
    }
    final raw = response.json?['notifications'];
    final items = cheSortNotificationsNewestFirst([
      for (final item in (raw is List ? raw : const [])) ?ChePlatformNotification.fromJson(item),
    ]);
    return ChePlatformPage(availability: ChePlatformAvailability.live, items: items);
  }

  @override
  Future<ChePlatformPage<CheCoreRule>> coreRules() async {
    final response = await _get('/api/core/rules');
    if (response.availability != ChePlatformAvailability.live) {
      return ChePlatformPage(availability: response.availability, items: const [], message: response.message);
    }
    final raw = response.json?['rules'];
    return ChePlatformPage(
      availability: ChePlatformAvailability.live,
      items: [
        for (final item in (raw is List ? raw : const [])) ?CheCoreRule.fromJson(item),
      ],
    );
  }

  @override
  Future<ChePlatformPage<CheCoreRequest>> coreRequests() async {
    final response = await _get('/api/core/requests');
    if (response.availability != ChePlatformAvailability.live) {
      return ChePlatformPage(availability: response.availability, items: const [], message: response.message);
    }
    final raw = response.json?['requests'];
    return ChePlatformPage(
      availability: ChePlatformAvailability.live,
      items: cheSortCoreRequestsNewestFirst([
        for (final item in (raw is List ? raw : const [])) ?CheCoreRequest.fromJson(item),
      ]),
    );
  }

  @override
  Future<ChePlatformPage<ChePlatformDevice>> devices() async {
    final response = await _get('/api/platform');
    if (response.availability != ChePlatformAvailability.live) {
      return ChePlatformPage(availability: response.availability, items: const [], message: response.message);
    }
    final raw = response.json?['devices'];
    return ChePlatformPage(
      availability: ChePlatformAvailability.live,
      items: [
        for (final item in (raw is List ? raw : const [])) ?ChePlatformDevice.fromJson(item),
      ],
    );
  }

  @override
  Future<ChePlatformTenant?> tenant() async {
    final response = await _get('/api/platform');
    if (response.availability != ChePlatformAvailability.live) return null;
    return ChePlatformTenant.fromJson(response.json?['tenant']);
  }

  @override
  Future<ChePlatformAvailability> markNotificationRead(String id) async {
    final response = await _send('POST', '/api/notifications/${Uri.encodeComponent(id)}/read');
    return response.availability;
  }

  @override
  Future<ChePlatformPage<CheCoreRequest>> submitCoreRequest(CheCoreRequestDraft draft) async {
    if (draft.request.trim().isEmpty) {
      return const ChePlatformPage(
        availability: ChePlatformAvailability.error,
        items: [],
        message: 'Describe the Core request.',
      );
    }
    final response = await _send('POST', '/api/core/requests', draft.toJson());
    if (response.availability != ChePlatformAvailability.live) {
      return ChePlatformPage(availability: response.availability, items: const [], message: response.message);
    }
    final parsed = CheCoreRequest.fromJson(response.json?['request']);
    return ChePlatformPage(
      availability: ChePlatformAvailability.live,
      items: [?parsed],
    );
  }

  @override
  Future<CheEnrollmentResult> createEnrollment({String access = 'private', int ttlMinutes = 10}) async {
    final response = await _send('POST', '/api/platform/enrollments', {
      'access': access == 'full' ? 'full' : 'private',
      'ttl_minutes': ttlMinutes,
    });
    if (response.availability != ChePlatformAvailability.live) {
      return CheEnrollmentResult(availability: response.availability, message: response.message);
    }
    final enrollment = response.json?['enrollment'];
    final token = enrollment is Map ? _text(enrollment['token']) : '';
    if (token.isEmpty) {
      return const CheEnrollmentResult(
        availability: ChePlatformAvailability.error,
        message: 'Enrollment response did not include a token.',
      );
    }
    return CheEnrollmentResult(availability: ChePlatformAvailability.live, token: token);
  }

  Future<_RawResponse> _get(String path) => _send('GET', path);

  Future<_RawResponse> _send(String method, String path, [Map<String, Object>? body]) async {
    final root = baseUrl().trim();
    final auth = headers();
    if (root.isEmpty || !(auth['Authorization'] ?? '').startsWith('Bearer ')) {
      return const _RawResponse(ChePlatformAvailability.notPaired, 'Pair this phone to CHE before platform data can load.');
    }
    try {
      final uri = Uri.parse('$root$path');
      final requestHeaders = {...auth, 'Accept': 'application/json'};
      final http.Response response;
      if (method == 'POST') {
        response = await _client
            .post(uri, headers: {...requestHeaders, 'Content-Type': 'application/json'}, body: jsonEncode(body ?? const {}))
            .timeout(const Duration(seconds: 20));
      } else {
        response = await _client.get(uri, headers: requestHeaders).timeout(const Duration(seconds: 20));
      }
      return _classify(response);
    } catch (error) {
      return _RawResponse(ChePlatformAvailability.error, '$error');
    }
  }
}

class _RawResponse {
  const _RawResponse(this.availability, this.message, [this.json]);

  final ChePlatformAvailability availability;
  final String message;
  final Map<String, dynamic>? json;
}

_RawResponse _classify(http.Response response) {
  Map<String, dynamic>? json;
  try {
    final decoded = jsonDecode(response.body);
    if (decoded is Map<String, dynamic>) json = decoded;
    if (decoded is Map) json ??= Map<String, dynamic>.from(decoded);
  } catch (_) {
    json = null;
  }
  final detail = json == null ? '' : _text(json['detail']);
  if (response.statusCode == 401) {
    return _RawResponse(ChePlatformAvailability.unauthorized, detail.isEmpty ? 'Pair your phone to CHE.' : detail);
  }
  if (response.statusCode == 404 || response.statusCode == 501) {
    return _RawResponse(
      ChePlatformAvailability.unavailable,
      'This platform endpoint is not on the connected Worker yet.',
    );
  }
  if (response.statusCode >= 400) {
    return _RawResponse(
      ChePlatformAvailability.error,
      detail.isEmpty ? 'CHE platform error ${response.statusCode}.' : detail,
    );
  }
  return _RawResponse(ChePlatformAvailability.live, '', json);
}

String _text(Object? value) => value == null ? '' : '$value'.trim();
