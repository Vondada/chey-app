import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_local_brain.dart';
import '../che_ui/che_theme.dart';
import 'che_core_sphere.dart';
import 'che_platform_client.dart';
import 'che_platform_models.dart';

CheHttpPlatformGateway chePlatformGateway({
  required String Function() baseUrl,
  required Map<String, String> Function() headers,
}) {
  return CheHttpPlatformGateway(baseUrl: baseUrl, headers: headers);
}

class ChePriorityNotificationBanner extends StatefulWidget {
  const ChePriorityNotificationBanner({
    super.key,
    required this.gateway,
    this.onOpen,
  });

  final ChePlatformGateway gateway;
  final VoidCallback? onOpen;

  @override
  State<ChePriorityNotificationBanner> createState() => _ChePriorityNotificationBannerState();
}

class _ChePriorityNotificationBannerState extends State<ChePriorityNotificationBanner> {
  List<ChePlatformNotification> _banners = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final page = await widget.gateway.notifications(unreadOnly: true);
    if (!mounted || !page.isLive) return;
    setState(() => _banners = cheTopPriorityBanners(page.items));
  }

  @override
  Widget build(BuildContext context) {
    if (_banners.isEmpty) return const SizedBox.shrink();
    final top = _banners.first;
    final count = _banners.length;
    final label = count == 1
        ? 'Priority CHE notification. ${top.priority}. ${top.title}. ${top.body}'
        : '$count priority CHE notifications. Newest: ${top.title}. ${top.body}';
    return Semantics(
      liveRegion: true,
      container: true,
      label: label,
      button: widget.onOpen != null,
      child: Material(
        color: top.priority == 'urgent' ? const Color(0xFF3A1420) : const Color(0xFF2A2412),
        child: InkWell(
          onTap: widget.onOpen,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
            child: Row(
              children: [
                Icon(
                  top.priority == 'urgent' ? Icons.priority_high_rounded : Icons.notification_important_outlined,
                  color: top.priority == 'urgent' ? CheColors.danger : CheColors.warning,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        count == 1 ? top.title : '${top.title}  ·  $count priority',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: CheType.label,
                      ),
                      Text(top.body, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption),
                    ],
                  ),
                ),
                Semantics(
                  button: true,
                  label: 'Mark ${top.title} read',
                  child: IconButton(
                    tooltip: 'Mark read',
                    onPressed: () async {
                      final result = await widget.gateway.markNotificationRead(top.id);
                      if (!mounted || result != ChePlatformAvailability.live) return;
                      setState(() => _banners = _banners.where((item) => item.id != top.id).toList());
                    },
                    icon: const Icon(Icons.check_rounded, color: CheColors.text),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class CheNotificationsScreen extends StatefulWidget {
  const CheNotificationsScreen({super.key, required this.gateway, this.onReadAloud});

  final ChePlatformGateway gateway;
  final ValueChanged<String>? onReadAloud;

  @override
  State<CheNotificationsScreen> createState() => _CheNotificationsScreenState();
}

class _CheNotificationsScreenState extends State<CheNotificationsScreen> {
  ChePlatformPage<ChePlatformNotification>? _page;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final page = await widget.gateway.notifications();
    if (!mounted) return;
    setState(() {
      _page = page;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final page = _page;
    return _PlatformScaffold(
      title: 'CHE Notifications',
      child: _loading
          ? const _Loading(label: 'Loading CHE notifications')
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
                children: [
                  ChePriorityNotificationBanner(gateway: widget.gateway),
                  const SizedBox(height: 12),
                  if (page == null || !page.isLive)
                    _Unavailable(message: page?.message ?? 'Notifications are not available.')
                  else if (page.items.isEmpty)
                    const _Unavailable(message: 'No live notifications. This is an empty feed, not sample data.')
                  else
                    for (final item in page.items) _NotificationTile(item: item, onReadAloud: widget.onReadAloud),
                ],
              ),
            ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.item, this.onReadAloud});

  final ChePlatformNotification item;
  final ValueChanged<String>? onReadAloud;

  @override
  Widget build(BuildContext context) {
    final when = item.createdAt?.toLocal().toString() ?? 'time unavailable';
    return Semantics(
      container: true,
      label: '${item.priority} notification from ${item.source}. ${item.title}. ${item.body}. $when.${item.isRead ? ' Read.' : ' Unread.'}',
      child: Card(
        color: CheColors.surface,
        child: ListTile(
          title: Text(item.title, style: CheType.headline),
          subtitle: Text('${item.source} · ${item.priority} · $when\n${item.body}', style: CheType.bodyDim),
          isThreeLine: true,
          trailing: onReadAloud == null
              ? null
              : Semantics(
                  button: true,
                  label: 'Read ${item.title} aloud',
                  child: IconButton(
                    tooltip: 'Read aloud',
                    onPressed: () => onReadAloud!('${item.title}. ${item.body}'),
                    icon: const Icon(Icons.volume_up_rounded),
                  ),
                ),
        ),
      ),
    );
  }
}

class CheCoreRoomScreen extends StatefulWidget {
  const CheCoreRoomScreen({super.key, required this.gateway, this.onReadAloud});

  final ChePlatformGateway gateway;
  final ValueChanged<String>? onReadAloud;

  @override
  State<CheCoreRoomScreen> createState() => _CheCoreRoomScreenState();
}

class _CheCoreRoomScreenState extends State<CheCoreRoomScreen> {
  final _request = TextEditingController();
  final _title = TextEditingController();
  ChePlatformPage<CheCoreRule>? _rules;
  ChePlatformPage<CheCoreRequest>? _requests;
  bool _priority = false;
  bool _paid = false;
  bool _busy = false;
  String _status = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _request.dispose();
    _title.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final rules = await widget.gateway.coreRules();
    final requests = await widget.gateway.coreRequests();
    if (!mounted) return;
    setState(() {
      _rules = rules;
      _requests = requests;
    });
  }

  Future<void> _submit() async {
    setState(() => _busy = true);
    final page = await widget.gateway.submitCoreRequest(CheCoreRequestDraft(
      request: _request.text,
      title: _title.text,
      priorityRequested: _priority,
      paidPriorityAuthorized: _paid,
    ));
    if (!mounted) return;
    setState(() {
      _busy = false;
      _status = page.isLive ? 'Core request submitted.' : page.message;
      if (page.isLive) {
        _request.clear();
        _title.clear();
        _priority = false;
        _paid = false;
      }
    });
    if (page.isLive) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final liveRules = _rules?.isLive == true ? _rules!.items : const <CheCoreRule>[];
    final shownRules = liveRules.isEmpty ? chePlatformContractRules : liveRules;
    final rulesLive = liveRules.isNotEmpty;
    return _PlatformScaffold(
      title: 'CHE Core',
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          Center(child: CheCoreSphere(active: _busy)),
          const SizedBox(height: 8),
          Text('CHE Core', style: CheType.title, textAlign: TextAlign.center),
          Text(
            'Compact command space. Requests follow Core rules and do not bypass privacy.',
            style: CheType.bodyDim,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Semantics(
            header: true,
            child: Text(rulesLive ? 'Core rules, live' : 'Core rules, contract preview', style: CheType.headline),
          ),
          if (!rulesLive)
            const _Unavailable(message: 'Live /api/core/rules is not on this Worker yet. Showing the verified contract text only.'),
          for (final rule in shownRules)
            Semantics(
              container: true,
              label: 'Core rule ${rule.id}, version ${rule.version}. ${rule.text}',
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(rule.id, style: CheType.label),
                subtitle: Text(rule.text, style: CheType.body),
              ),
            ),
          const SizedBox(height: 8),
          Semantics(
            textField: true,
            label: 'Core request title',
            child: TextField(
              controller: _title,
              decoration: const InputDecoration(labelText: 'Title'),
            ),
          ),
          const SizedBox(height: 8),
          Semantics(
            textField: true,
            label: 'Core request',
            child: TextField(
              controller: _request,
              minLines: 3,
              maxLines: 6,
              decoration: const InputDecoration(labelText: 'Request'),
            ),
          ),
          Semantics(
            toggled: _priority,
            label: 'Request priority review',
            child: SwitchListTile(
              value: _priority,
              onChanged: (value) => setState(() => _priority = value),
              title: const Text('Request priority review'),
            ),
          ),
          Semantics(
            toggled: _paid,
            label: 'Authorize paid priority. Off unless you explicitly allow it.',
            child: SwitchListTile(
              value: _paid,
              onChanged: (value) => setState(() => _paid = value),
              title: const Text('Authorize paid priority'),
              subtitle: const Text('Stays off unless you turn it on. This does not charge anything by itself.'),
            ),
          ),
          Semantics(
            button: true,
            label: 'Submit Core request',
            child: FilledButton(
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? 'Submitting' : 'Submit Core request'),
            ),
          ),
          if (_status.isNotEmpty) ...[
            const SizedBox(height: 8),
            Semantics(liveRegion: true, label: _status, child: Text(_status, style: CheType.bodyDim)),
          ],
          const SizedBox(height: 16),
          Text('Core requests', style: CheType.headline),
          if (_requests == null || !_requests!.isLive)
            _Unavailable(message: _requests?.message ?? 'Core requests are not available on this Worker yet.')
          else if (_requests!.items.isEmpty)
            const _Unavailable(message: 'No live Core requests.')
          else
            for (final item in _requests!.items)
              Semantics(
                container: true,
                label: 'Core request ${item.title}. Status ${item.status}. ${item.request}',
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(item.title, style: CheType.label),
                  subtitle: Text('${item.status} · ${item.request}', style: CheType.bodyDim),
                  trailing: widget.onReadAloud == null
                      ? null
                      : IconButton(
                          tooltip: 'Read aloud',
                          onPressed: () => widget.onReadAloud!('${item.title}. ${item.status}. ${item.request}'),
                          icon: const Icon(Icons.volume_up_rounded),
                        ),
                ),
              ),
        ],
      ),
    );
  }
}

class ChePlatformDevicesScreen extends StatefulWidget {
  const ChePlatformDevicesScreen({super.key, required this.gateway});

  final ChePlatformGateway gateway;

  @override
  State<ChePlatformDevicesScreen> createState() => _ChePlatformDevicesScreenState();
}

class _ChePlatformDevicesScreenState extends State<ChePlatformDevicesScreen> {
  ChePlatformPage<ChePlatformDevice>? _devices;
  ChePlatformTenant? _tenant;
  String _status = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final devices = await widget.gateway.devices();
    final tenant = await widget.gateway.tenant();
    if (!mounted) return;
    setState(() {
      _devices = devices;
      _tenant = tenant;
    });
  }

  Future<void> _enroll(String access) async {
    setState(() => _busy = true);
    final result = await widget.gateway.createEnrollment(access: access);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _status = result.availability == ChePlatformAvailability.live
          ? 'Enrollment token created. It is single-use and was not stored in this screen.'
          : result.message;
    });
    if (result.token.isNotEmpty) {
      await Clipboard.setData(ClipboardData(text: result.token));
      if (mounted) {
        setState(() => _status = 'Enrollment token copied. Share it only with the device you are pairing.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final owner = _tenant?.isOwner == true;
    return _PlatformScaffold(
      title: 'Devices & share',
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          Text(_tenant == null ? 'Tenant unavailable' : '${_tenant!.name} · ${_tenant!.role}', style: CheType.bodyDim),
          const SizedBox(height: 8),
          if (_devices == null || !_devices!.isLive)
            _Unavailable(message: _devices?.message ?? 'Device list is not on this Worker yet.')
          else if (_devices!.items.isEmpty)
            const _Unavailable(message: 'No live devices returned for this tenant.')
          else
            for (final device in _devices!.items)
              Semantics(
                container: true,
                label:
                    '${device.name}. Access ${device.access}. ${device.revoked ? 'Revoked.' : 'Active.'} Last seen ${device.lastSeenAt?.toLocal() ?? 'unknown'}.',
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(device.name, style: CheType.headline),
                  subtitle: Text(
                    '${device.access} · ${device.revoked ? 'revoked' : 'active'}',
                    style: CheType.bodyDim,
                  ),
                ),
              ),
          const SizedBox(height: 12),
          Text('Share access', style: CheType.headline),
          const Text(
            'Enrollment tokens are created only by the owner endpoint. This screen does not invent a paired device.',
            style: CheType.bodyDim,
          ),
          const SizedBox(height: 8),
          Semantics(
            button: true,
            label: 'Create private enrollment token',
            child: FilledButton(
              onPressed: _busy || !owner ? null : () => _enroll('private'),
              child: const Text('Create private enrollment'),
            ),
          ),
          const SizedBox(height: 8),
          Semantics(
            button: true,
            label: 'Create full access enrollment token',
            child: OutlinedButton(
              onPressed: _busy || !owner ? null : () => _enroll('full'),
              child: const Text('Create full-access enrollment'),
            ),
          ),
          if (!owner)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: _Unavailable(message: 'Enrollment stays disabled until the live platform view says this tenant is owner.'),
            ),
          if (_status.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Semantics(liveRegion: true, label: _status, child: Text(_status, style: CheType.bodyDim)),
            ),
        ],
      ),
    );
  }
}

class CheTwoBrainsView extends StatefulWidget {
  const CheTwoBrainsView({super.key, required this.live, required this.offline});

  final Widget live;
  final Widget offline;

  @override
  State<CheTwoBrainsView> createState() => _CheTwoBrainsViewState();
}

class _CheTwoBrainsViewState extends State<CheTwoBrainsView> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final selected = cheBrainPresentations[_index];
    // One compact row: the brain's name plus the Live/Offline switch. The
    // visualization below gets the rest of the screen.
    final media = MediaQuery.of(context);
    return Column(
      children: [
        MediaQuery(
          data: media.copyWith(textScaler: media.textScaler.clamp(minScaleFactor: 1.0, maxScaleFactor: 1.2)),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 12, 2),
            child: Row(
              children: [
                Expanded(
                  child: Semantics(
                    header: true,
                    label: '${selected.title}. ${selected.detail}',
                    excludeSemantics: true,
                    child: Text(
                      selected.title,
                      maxLines: 1,
                      softWrap: false,
                      overflow: TextOverflow.ellipsis,
                      style: CheType.label.copyWith(color: CheColors.text, fontSize: 15),
                    ),
                  ),
                ),
                for (var i = 0; i < cheBrainPresentations.length; i++)
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: Semantics(
                      button: true,
                      selected: i == _index,
                      label: cheBrainPresentations[i].title,
                      excludeSemantics: true,
                      child: InkWell(
                        onTap: () {
                          HapticFeedback.selectionClick();
                          setState(() => _index = i);
                        },
                        borderRadius: BorderRadius.circular(999),
                        child: Ink(
                          height: 32,
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          decoration: BoxDecoration(
                            color: i == _index ? CheColors.accent.withValues(alpha: 0.22) : CheColors.surface,
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(color: i == _index ? CheColors.accent : CheColors.stroke),
                          ),
                          child: Center(
                            child: Text(
                              i == 0 ? 'Live' : 'Offline',
                              style: CheType.caption.copyWith(
                                color: i == _index ? CheColors.accent : CheColors.textDim,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        Expanded(child: _index == 0 ? widget.live : widget.offline),
      ],
    );
  }
}

class CheOfflineBrainPanel extends StatefulWidget {
  const CheOfflineBrainPanel({super.key, this.health});

  final CheLocalBrainHealth? health;

  @override
  State<CheOfflineBrainPanel> createState() => _CheOfflineBrainPanelState();
}

class _CheOfflineBrainPanelState extends State<CheOfflineBrainPanel> {
  CheLocalBrainHealth? _health;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (widget.health != null) {
      setState(() {
        _health = widget.health;
        _loading = false;
      });
      return;
    }
    try {
      final health = await CheLocalBrain().health();
      if (!mounted) return;
      setState(() {
        _health = health;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _health = CheLocalBrainHealth(
          installed: false,
          loaded: false,
          available: false,
          status: 'unavailable',
          detail: '$error',
        );
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final model = cheDefaultLocalBrainModel;
    final health = _health;
    final label = _loading
        ? 'Checking CHE Brain Offline.'
        : 'CHE Brain — Offline. ${model.modelId}. Status ${health?.status ?? 'unknown'}. ${health?.detail ?? ''}';
    return Semantics(
      container: true,
      label: label,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('CHE Brain — Offline', style: CheType.title),
          const SizedBox(height: 6),
          Text(cheBrainPresentations[1].detail, style: CheType.bodyDim),
          const SizedBox(height: 12),
          Text('Pinned model ${model.modelId}', style: CheType.headline),
          Text('${model.parameterCount} · ${model.quantization} · ${model.license}', style: CheType.bodyDim),
          const SizedBox(height: 12),
          if (_loading)
            const _Loading(label: 'Checking offline brain')
          else
            Text(
              'Status: ${health?.status ?? 'unknown'}. Installed: ${health?.installed == true}. Loaded: ${health?.loaded == true}.',
              style: CheType.body,
            ),
          if ((health?.detail ?? '').isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(health!.detail, style: CheType.bodyDim),
            ),
        ],
      ),
    );
  }
}

class _PlatformScaffold extends StatelessWidget {
  const _PlatformScaffold({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: CheTheme.dark(),
      child: Scaffold(
        backgroundColor: CheColors.bg,
        appBar: AppBar(title: Text(title)),
        body: child,
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      child: const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
    );
  }
}

class _Unavailable extends StatelessWidget {
  const _Unavailable({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: message,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(message, style: CheType.bodyDim),
      ),
    );
  }
}
