// CHE platform models. Field names match the verified contract in
// feature/che-platform-core-multiuser server/cloudflare/che_platform.js.
// These models do not invent live tenant data.

class ChePlatformNotification {
  const ChePlatformNotification({
    required this.id,
    required this.tenantId,
    required this.source,
    required this.title,
    required this.body,
    required this.priority,
    required this.target,
    required this.createdAt,
    this.readAt,
  });

  final String id;
  final String tenantId;
  final String source;
  final String title;
  final String body;
  final String priority;
  final String target;
  final DateTime? createdAt;
  final DateTime? readAt;

  bool get isRead => readAt != null;
  bool get isTopPriority => priority == 'urgent' || priority == 'high';

  static ChePlatformNotification? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _text(raw['id']);
    final title = _text(raw['title']);
    final body = _text(raw['body']);
    if (id.isEmpty || title.isEmpty || body.isEmpty) return null;
    return ChePlatformNotification(
      id: id,
      tenantId: _text(raw['tenant_id']),
      source: _text(raw['source']).isEmpty ? 'CHE' : _text(raw['source']),
      title: title,
      body: body,
      priority: _priority(raw['priority']),
      target: _text(raw['target']),
      createdAt: _time(raw['created_at']),
      readAt: _time(raw['read_at']),
    );
  }
}

class CheCoreRule {
  const CheCoreRule({required this.id, required this.version, required this.text});

  final String id;
  final int version;
  final String text;

  static CheCoreRule? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _text(raw['id']);
    final text = _text(raw['text']);
    if (id.isEmpty || text.isEmpty) return null;
    return CheCoreRule(id: id, version: int.tryParse('${raw['version']}') ?? 1, text: text);
  }
}

class CheCoreRequest {
  const CheCoreRequest({
    required this.id,
    required this.tenantId,
    required this.title,
    required this.request,
    required this.kind,
    required this.priorityRequested,
    required this.paidPriorityAuthorized,
    required this.status,
    required this.ruleIds,
    required this.createdAt,
    this.decision,
  });

  final String id;
  final String tenantId;
  final String title;
  final String request;
  final String kind;
  final bool priorityRequested;
  final bool paidPriorityAuthorized;
  final String status;
  final String? decision;
  final List<String> ruleIds;
  final DateTime? createdAt;

  static CheCoreRequest? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final request = _text(raw['request']);
    if (request.isEmpty) return null;
    return CheCoreRequest(
      id: _text(raw['id']),
      tenantId: _text(raw['tenant_id']),
      title: _text(raw['title']).isEmpty ? request : _text(raw['title']),
      request: request,
      kind: _text(raw['kind']).isEmpty ? 'capability' : _text(raw['kind']),
      priorityRequested: raw['priority_requested'] == true,
      paidPriorityAuthorized: raw['paid_priority_authorized'] == true,
      status: _text(raw['status']).isEmpty ? 'submitted' : _text(raw['status']),
      decision: _text(raw['decision']).isEmpty ? null : _text(raw['decision']),
      ruleIds: [for (final id in (raw['rule_ids'] as List? ?? const [])) _text(id)].where((id) => id.isNotEmpty).toList(),
      createdAt: _time(raw['created_at']),
    );
  }
}

class ChePlatformDevice {
  const ChePlatformDevice({
    required this.name,
    required this.access,
    required this.tenantId,
    required this.createdAt,
    required this.lastSeenAt,
    this.revokedAt,
  });

  final String name;
  final String access;
  final String tenantId;
  final DateTime? createdAt;
  final DateTime? lastSeenAt;
  final DateTime? revokedAt;

  bool get revoked => revokedAt != null;

  static ChePlatformDevice? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final name = _text(raw['name']);
    if (name.isEmpty) return null;
    return ChePlatformDevice(
      name: name,
      access: _text(raw['access']).isEmpty ? 'full' : _text(raw['access']),
      tenantId: _text(raw['tenant_id']),
      createdAt: _time(raw['created_at']),
      lastSeenAt: _time(raw['last_seen_at']),
      revokedAt: _time(raw['revoked_at']),
    );
  }
}

class ChePlatformTenant {
  const ChePlatformTenant({required this.id, required this.name, required this.role});

  final String id;
  final String name;
  final String role;

  bool get isOwner => role == 'owner';

  static ChePlatformTenant? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _text(raw['id']);
    if (id.isEmpty) return null;
    return ChePlatformTenant(
      id: id,
      name: _text(raw['name']).isEmpty ? 'CHE' : _text(raw['name']),
      role: _text(raw['role']).isEmpty ? 'personal' : _text(raw['role']),
    );
  }
}

/// Contract rules verified from che_platform.js on
/// feature/che-platform-core-multiuser. These are the interface boundary,
/// not a live Core fetch.
const chePlatformContractRules = <CheCoreRule>[
  CheCoreRule(
    id: 'CORE-PRIVACY-1',
    version: 1,
    text: 'Personal memories stay inside their tenant and never become shared Core knowledge.',
  ),
  CheCoreRule(
    id: 'CORE-SECRETS-1',
    version: 1,
    text: 'Secrets and credentials are never copied into shared learning, prompts, logs, or invitations.',
  ),
  CheCoreRule(
    id: 'CORE-SKILLS-1',
    version: 1,
    text: 'Verified sanitized skills may be shared through Core; personal memories may not.',
  ),
  CheCoreRule(
    id: 'CORE-SAFETY-1',
    version: 1,
    text: 'Core requests cannot bypass privacy, consent, security, provider, or platform rules.',
  ),
];

enum ChePlatformAvailability { live, notPaired, unavailable, unauthorized, error }

class ChePlatformPage<T> {
  const ChePlatformPage({
    required this.availability,
    required this.items,
    this.message = '',
  });

  final ChePlatformAvailability availability;
  final List<T> items;
  final String message;

  bool get isLive => availability == ChePlatformAvailability.live;
}

class CheBrainPresentation {
  const CheBrainPresentation({required this.id, required this.title, required this.detail});

  final String id;
  final String title;
  final String detail;
}

/// Exactly two CHE brains. Do not add a third presentation brain.
const cheBrainPresentations = <CheBrainPresentation>[
  CheBrainPresentation(
    id: 'live',
    title: 'CHE Brain — Live',
    detail: 'Paired cloud brain: constellation, soul, facts, and conversation log.',
  ),
  CheBrainPresentation(
    id: 'offline',
    title: 'CHE Brain — Offline',
    detail: 'On-device Local Brain. Status comes from the phone, not from invented cloud data.',
  ),
];

List<ChePlatformNotification> cheSortNotificationsNewestFirst(Iterable<ChePlatformNotification> items) {
  final copy = items.toList();
  copy.sort((a, b) => _millis(b.createdAt).compareTo(_millis(a.createdAt)));
  return copy;
}

List<CheCoreRequest> cheSortCoreRequestsNewestFirst(Iterable<CheCoreRequest> items) {
  final copy = items.toList();
  copy.sort((a, b) => _millis(b.createdAt).compareTo(_millis(a.createdAt)));
  return copy;
}

List<ChePlatformNotification> cheTopPriorityBanners(Iterable<ChePlatformNotification> items) {
  return cheSortNotificationsNewestFirst(items).where((item) => item.isTopPriority && !item.isRead).toList();
}

String _text(Object? value) => value == null ? '' : '$value'.trim();

String _priority(Object? value) {
  final raw = _text(value);
  return const {'low', 'normal', 'high', 'urgent'}.contains(raw) ? raw : 'normal';
}

DateTime? _time(Object? value) {
  final raw = _text(value);
  if (raw.isEmpty) return null;
  return DateTime.tryParse(raw);
}

int _millis(DateTime? value) => value?.millisecondsSinceEpoch ?? 0;
