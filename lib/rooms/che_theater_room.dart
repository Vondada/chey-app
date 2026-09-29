// CHE Theater: watch web video inside CHE with a guarded, steady player,
// open the owner's iWebTV app on request, and let free Office agents come
// sit in the Theater while he watches.
//
// Safety: pop-ups (window.open, target=_blank), cross-site redirect
// hijacks, jumps into other apps/URL schemes and file downloads are blocked
// in code (CheTheaterGuard), not just by model instructions. The owner can
// allow a blocked site once. No website can be made risk-free; this closes
// the common ways junk gets in.
//
// iPhone does not let one app run inside another, so iWebTV itself opens as
// its own app — only after the owner explicitly confirms.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../agents/che_agent_runtime.dart';
import '../agents/che_office_world.dart' show CheRoomVisitors;
import '../che_ui/che_theme.dart';

enum CheTheaterVerdict { allow, blockPopup, blockRedirect, blockScheme, blockDownload }

/// Pure navigation policy for the Theater player (unit-tested).
class CheTheaterGuard {
  CheTheaterGuard();

  final Set<String> _allowedSites = {};

  static final RegExp _download = RegExp(
    r'\.(?:exe|msi|apk|ipa|dmg|pkg|mobileconfig|deb|rpm|bat|cmd|scr|jar|zip|rar|7z|iso|bin)(?:$|[?#])',
    caseSensitive: false,
  );

  /// Registrable-ish site of a host: the last two labels (last three for
  /// short country second-levels like co.uk).
  static String siteOf(String host) {
    final parts = host.toLowerCase().split('.').where((p) => p.isNotEmpty).toList();
    if (parts.length <= 2) return parts.join('.');
    final secondLevel = parts[parts.length - 2];
    final keep = (secondLevel.length <= 3 && parts.last.length == 2) ? 3 : 2;
    return parts.sublist(parts.length - keep).join('.');
  }

  /// The owner opened (or allowed) this site on purpose.
  void allowSite(String url) {
    final host = Uri.tryParse(url)?.host ?? '';
    if (host.isNotEmpty) _allowedSites.add(siteOf(host));
  }

  bool isAllowedSite(String host) => _allowedSites.contains(siteOf(host));

  CheTheaterVerdict check(String url, {required bool isMainFrame}) {
    final uri = Uri.tryParse(url);
    if (uri == null) return CheTheaterVerdict.blockScheme;
    if (uri.scheme == 'about' || uri.scheme == 'blob' || uri.scheme == 'data') {
      return isMainFrame && uri.scheme == 'data' ? CheTheaterVerdict.blockScheme : CheTheaterVerdict.allow;
    }
    if (uri.scheme != 'https' && uri.scheme != 'http') return CheTheaterVerdict.blockScheme;
    if (_download.hasMatch(uri.path)) return CheTheaterVerdict.blockDownload;
    // Embedded players (iframes) may load from other sites; only whole-page
    // jumps to a new site are treated as redirect hijacks.
    if (isMainFrame && _allowedSites.isNotEmpty && !isAllowedSite(uri.host)) {
      return CheTheaterVerdict.blockRedirect;
    }
    return CheTheaterVerdict.allow;
  }

  /// Injected into every page: neutralizes pop-ups and new-window links.
  static const String popupShield = r'''
(function () {
  if (window.__cheTheaterGuard) return;
  window.__cheTheaterGuard = true;
  var report = function (kind) { try { CheTheater.postMessage(kind); } catch (e) {} };
  window.open = function () { report('popup'); return null; };
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[target]') : null;
    if (a) { a.removeAttribute('target'); }
  }, true);
  var style = document.createElement('style');
  style.textContent = 'html,body{overscroll-behavior:none;}';
  (document.head || document.documentElement).appendChild(style);
})();
''';
}

class CheTheaterRoom extends StatefulWidget {
  const CheTheaterRoom({super.key, required this.runtime, required this.client, this.onOpenOffice});

  final CheAgentRuntimeController runtime;
  final CheAgentRuntimeClient client;
  final VoidCallback? onOpenOffice;

  @override
  State<CheTheaterRoom> createState() => _CheTheaterRoomState();
}

class _CheTheaterRoomState extends State<CheTheaterRoom> {
  final CheTheaterGuard _guard = CheTheaterGuard();
  final TextEditingController _address = TextEditingController();
  WebViewController? _web;
  String _status = 'Say or type a video page address, or open iWebTV.';
  String? _blockedUrl;
  int _blockedCount = 0;
  bool _watching = false;

  @override
  void dispose() {
    if (_watching) unawaited(_setWatching(false));
    _address.dispose();
    super.dispose();
  }

  Future<void> _setWatching(bool on) async {
    _watching = on;
    try {
      await widget.client.setTheaterWatching(on);
      await widget.runtime.refresh();
    } catch (_) {
      // Seats are a nicety; the player works without the server.
    }
  }

  void _notice(String text, {String? blockedUrl}) {
    if (!mounted) return;
    HapticFeedback.heavyImpact();
    setState(() {
      _status = text;
      _blockedUrl = blockedUrl;
      _blockedCount += 1;
    });
  }

  WebViewController _buildController() {
    return WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.black)
      ..addJavaScriptChannel('CheTheater', onMessageReceived: (message) {
        if (message.message == 'popup') _notice('Blocked a pop-up.');
      })
      ..setNavigationDelegate(NavigationDelegate(
        onNavigationRequest: (request) {
          final verdict = _guard.check(request.url, isMainFrame: request.isMainFrame);
          switch (verdict) {
            case CheTheaterVerdict.allow:
              return NavigationDecision.navigate;
            case CheTheaterVerdict.blockPopup:
              _notice('Blocked a pop-up.');
            case CheTheaterVerdict.blockRedirect:
              _notice('Blocked a jump to ${Uri.tryParse(request.url)?.host ?? 'another site'}.', blockedUrl: request.url);
            case CheTheaterVerdict.blockScheme:
              _notice('Blocked the page from opening another app.');
            case CheTheaterVerdict.blockDownload:
              _notice('Blocked a file download.');
          }
          return NavigationDecision.prevent;
        },
        onPageFinished: (_) {
          unawaited(_web?.runJavaScript(CheTheaterGuard.popupShield));
        },
        onWebResourceError: (error) {
          if (mounted && error.isForMainFrame == true) {
            setState(() => _status = 'That page did not load: ${error.description}');
          }
        },
      ));
  }

  Future<void> _open(String raw) async {
    var text = raw.trim();
    if (text.isEmpty) return;
    if (!text.contains('://')) text = 'https://$text';
    final uri = Uri.tryParse(text);
    if (uri == null || (uri.scheme != 'https' && uri.scheme != 'http') || uri.host.isEmpty) {
      setState(() => _status = 'That doesn\'t look like a web address.');
      return;
    }
    if (_guard.check(uri.toString(), isMainFrame: false) == CheTheaterVerdict.blockDownload) {
      setState(() => _status = 'That link is a file download, so the Theater won\'t open it.');
      return;
    }
    _guard.allowSite(uri.toString());
    final web = _web ?? _buildController();
    setState(() {
      _web = web;
      _status = 'Playing ${uri.host}. Pop-ups, app jumps and downloads are blocked.';
      _blockedUrl = null;
    });
    HapticFeedback.mediumImpact();
    await web.loadRequest(uri);
    if (!_watching) await _setWatching(true);
  }

  Future<void> _allowBlockedOnce() async {
    final url = _blockedUrl;
    if (url == null) return;
    _guard.allowSite(url);
    setState(() => _blockedUrl = null);
    await _web?.loadRequest(Uri.parse(url));
  }

  Future<void> _stop() async {
    await _web?.loadHtmlString('<html><body style="background:#000"></body></html>');
    setState(() {
      _web = null;
      _status = 'Theater closed.';
    });
    await _setWatching(false);
  }

  // Opening another app requires the owner's explicit permission every time.
  Future<void> _openIWebTv() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: CheColors.surfaceHi,
        title: const Text('Open iWebTV?'),
        content: const Text('CHE will leave and open the iWebTV app. iPhone doesn\'t allow it to run inside CHE.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('No')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Yes, open iWebTV')),
        ],
      ),
    );
    if (ok != true) {
      if (mounted) setState(() => _status = 'OK, I left iWebTV closed.');
      return;
    }
    var opened = false;
    try {
      opened = await launchUrl(Uri.parse('iwebtv://'), mode: LaunchMode.externalApplication);
    } catch (_) {
      opened = false;
    }
    if (!opened) {
      try {
        opened = await launchUrl(
          Uri.parse('itms-apps://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search?media=software&term=iWebTV'),
          mode: LaunchMode.externalApplication,
        );
      } catch (_) {
        opened = false;
      }
      if (mounted) {
        setState(() => _status = opened
            ? 'iWebTV didn\'t answer its app link, so I opened it in the App Store.'
            : 'I couldn\'t open iWebTV on this iPhone.');
      }
      return;
    }
    if (!_watching) await _setWatching(true);
    if (mounted) setState(() => _status = 'Opened iWebTV. The team is in the Theater seats.');
  }

  @override
  Widget build(BuildContext context) {
    final web = _web;
    return Theme(
      data: CheTheme.dark(),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, 0),
          child: Row(children: [
            Expanded(
              child: Semantics(
                textField: true,
                label: 'Video page address',
                child: TextField(
                  controller: _address,
                  keyboardType: TextInputType.url,
                  textInputAction: TextInputAction.go,
                  onSubmitted: _open,
                  style: CheType.body,
                  decoration: const InputDecoration(hintText: 'Video page address', isDense: true),
                ),
              ),
            ),
            const SizedBox(width: CheSpace.sm),
            Semantics(
              button: true,
              label: 'Play this address in the Theater',
              excludeSemantics: true,
              onTap: () => _open(_address.text),
              child: IconButton.filled(onPressed: () => _open(_address.text), icon: const Icon(Icons.play_arrow_rounded)),
            ),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter, vertical: CheSpace.xs),
          child: Wrap(spacing: CheSpace.sm, runSpacing: CheSpace.xs, children: [
            Semantics(
              button: true,
              label: 'Open the iWebTV app. CHE asks you to confirm first.',
              excludeSemantics: true,
              onTap: _openIWebTv,
              child: OutlinedButton.icon(onPressed: _openIWebTv, icon: const Icon(Icons.cast_rounded, size: 18), label: const Text('Open iWebTV')),
            ),
            if (web != null)
              Semantics(
                button: true,
                label: 'Close the Theater player',
                excludeSemantics: true,
                onTap: _stop,
                child: TextButton.icon(onPressed: _stop, icon: const Icon(Icons.stop_rounded, size: 18), label: const Text('Close')),
              ),
            if (_blockedUrl != null)
              Semantics(
                button: true,
                label: 'Allow the blocked site once',
                excludeSemantics: true,
                onTap: _allowBlockedOnce,
                child: TextButton(onPressed: _allowBlockedOnce, child: const Text('Allow that site once')),
              ),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
          child: Semantics(
            liveRegion: true,
            child: Text(
              '$_status${_blockedCount > 0 ? '  ·  $_blockedCount blocked' : ''}',
              style: CheType.caption,
            ),
          ),
        ),
        const SizedBox(height: CheSpace.sm),
        Expanded(
          child: RepaintBoundary(
            child: Container(
              color: Colors.black,
              child: web == null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(CheSpace.xl),
                        child: Text(
                          'The Theater is ready. Free Office agents will take their seats while you watch.',
                          textAlign: TextAlign.center,
                          style: CheType.bodyDim,
                        ),
                      ),
                    )
                  : WebViewWidget(controller: web),
            ),
          ),
        ),
        CheRoomVisitors(runtime: widget.runtime, rooms: const {'theater'}, onOpenOffice: widget.onOpenOffice),
      ]),
    );
  }
}
