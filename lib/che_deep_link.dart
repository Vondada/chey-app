// CHE deep-link handoff for a companion world / 3D app.
//
// Listens for custom URL schemes (che:// or che-world://) so CHE can receive
// return control and context from a separate world app, and can launch the
// world app itself. Activity is published via a ValueNotifier so the rest of
// the UI (activity feed, banners, voice) can react without tight coupling.
//
// Native registration of the URL scheme still requires the one-time Info.plist
// change (already partially handled by tool/bootstrap.sh for the 'che' scheme).
// The companion world app must register its own scheme (e.g. che-world).

import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

/// Latest deep-link event CHE received or initiated.
/// Format: { 'direction': 'in'|'out', 'uri': '...', 'scene': '...', 'agent': '...' }
final ValueNotifier<Map<String, String>?> cheDeepLinkEvent =
    ValueNotifier<Map<String, String>?>(null);

class CheDeepLink {
  CheDeepLink._();
  static final CheDeepLink instance = CheDeepLink._();

  final AppLinks _appLinks = AppLinks();
  StreamSubscription<Uri>? _sub;
  bool _started = false;

  /// Call once from the home state after the widget is mounted.
  Future<void> start() async {
    if (_started) return;
    _started = true;

    // Cold start
    final initial = await _appLinks.getInitialLink();
    if (initial != null) _handle(initial, incoming: true);

    // Warm start / subsequent
    _sub = _appLinks.uriLinkStream.listen(
      (uri) => _handle(uri, incoming: true),
      onError: (e) => debugPrint('CHE deep link stream error: $e'),
    );
  }

  void dispose() {
    _sub?.cancel();
    _sub = null;
    _started = false;
  }

  void _handle(Uri uri, {required bool incoming}) {
    final scene = uri.queryParameters['scene'] ?? '';
    final agent = uri.queryParameters['agent'] ?? '';
    final event = <String, String>{
      'direction': incoming ? 'in' : 'out',
      'uri': uri.toString(),
      'scheme': uri.scheme,
      'host': uri.host,
      'path': uri.path,
      if (scene.isNotEmpty) 'scene': scene,
      if (agent.isNotEmpty) 'agent': agent,
    };
    cheDeepLinkEvent.value = event;
    debugPrint('CHE deep link: $event');
  }

  /// Launch the companion world app (or any registered scheme).
  /// Returns true if the OS accepted the launch.
  Future<bool> launchWorld({
    String scheme = 'che-world',
    String scene = 'office',
    String? agent,
  }) async {
    final qp = <String, String>{'scene': scene};
    if (agent != null && agent.isNotEmpty) qp['agent'] = agent;
    final uri = Uri(
      scheme: scheme,
      host: 'open',
      queryParameters: qp,
    );
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (ok) _handle(uri, incoming: false);
    return ok;
  }

  /// Convenience for returning control back to CHE from the world app.
  /// The world app should call this URL (or the equivalent) when finished.
  static Uri returnToChe({String? scene, String? agent}) {
    final qp = <String, String>{};
    if (scene != null) qp['scene'] = scene;
    if (agent != null) qp['agent'] = agent;
    return Uri(scheme: 'che', host: 'return', queryParameters: qp);
  }
}
