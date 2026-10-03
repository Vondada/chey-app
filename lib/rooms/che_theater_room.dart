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
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../agents/che_agent_runtime.dart';
import '../che_ui/che_agents.dart' show CheAgentStatus;
import '../agents/che_office_world.dart' show CheRoomVisitors;
import '../che_ui/che_theme.dart';
import '../browser/che_browser.dart';
import '../browser/che_embedded_app_shell.dart';
import '../widgets/che_native_scene_world.dart';

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
  const CheTheaterRoom({super.key, required this.runtime, required this.client, this.onOpenOffice, this.onAskAboutScene});

  final CheAgentRuntimeController runtime;
  final CheAgentRuntimeClient client;
  final VoidCallback? onOpenOffice;

  /// Sends a question to CHE, with a JPEG (base64) of the paused frame when
  /// the site allows reading the picture.
  final Future<void> Function(String prompt, String? jpegBase64)? onAskAboutScene;

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
  final List<Map<String, Object>> _captionBuffer = [];
  Timer? _captionFlush;
  String _pageTitle = '';
  int _captionCount = 0;
  final List<Map<String, Object>> _learningCaptions = [];
  bool _learningVideo = false;

  // Reads captions (text tracks, or on-screen subtitle text) with the video
  // time, every 1.5 seconds, and hands them to CHE's Theater notes.
  static const String _captionJs = r'''
(function () {
  if (window.__cheCaptions) return;
  window.__cheCaptions = true;
  var last = '';
  setInterval(function () {
    var v = document.querySelector('video');
    if (!v) return;
    var text = '';
    try {
      for (var i = 0; i < v.textTracks.length; i++) {
        var tr = v.textTracks[i];
        if (tr.kind !== 'subtitles' && tr.kind !== 'captions') continue;
        if (tr.mode === 'disabled') tr.mode = 'hidden';
        var cues = tr.activeCues || [];
        for (var j = 0; j < cues.length; j++) text += ' ' + (cues[j].text || '');
      }
    } catch (e) {}
    if (!text.trim()) {
      var box = document.querySelector('.player-timedtext, [class*="caption-window"], [class*="subtitle"], [class*="Subtitle"], [class*="captions-text"], [data-testid*="subtitle"]');
      if (box) text = box.innerText || '';
    }
    text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text === last) return;
    last = text;
    try { CheCaptions.postMessage(JSON.stringify({ t: Math.round(v.currentTime || 0), text: text })); } catch (e) {}
  }, 1500);
})();
''';

  static const String _frameJs = r'''
(function () {
  var v = document.querySelector('video');
  if (!v || !v.videoWidth) return 'novideo';
  try {
    var c = document.createElement('canvas');
    var scale = Math.min(1, 960 / v.videoWidth);
    c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    var data = c.toDataURL('image/jpeg', 0.8);
    if (!data || data.length < 2000) return 'blank';
    return data.split(',')[1];
  } catch (e) { return 'blocked'; }
})()
''';

  void _onCaption(String raw) {
    try {
      final j = jsonDecode(raw);
      if (j is! Map) return;
      final text = '${j['text'] ?? ''}'.trim();
      if (text.isEmpty) return;
      final line = {'t': (j['t'] as num?)?.round() ?? 0, 'text': text};
      _captionBuffer.add(line);
      _learningCaptions.add(line);
      if (_learningCaptions.length > 1600) _learningCaptions.removeRange(0, _learningCaptions.length - 1600);
      _captionCount += 1;
      _captionFlush ??= Timer(const Duration(seconds: 20), _flushCaptions);
    } catch (_) {}
  }

  Future<void> _flushCaptions() async {
    _captionFlush = null;
    if (_captionBuffer.isEmpty) return;
    final lines = List<Map<String, Object>>.from(_captionBuffer);
    _captionBuffer.clear();
    final host = Uri.tryParse(_address.text.contains('://') ? _address.text : 'https://${_address.text}')?.host ?? '';
    try {
      await widget.client.saveTheaterNotes(_pageTitle.isEmpty ? host : _pageTitle, host, lines);
    } catch (_) {
      _captionBuffer.insertAll(0, lines);
    }
  }

  // "Look at this scene": pause-frame to CHE when the site allows it.
  Future<void> _askAboutScene() async {
    final ask = widget.onAskAboutScene;
    final web = _web;
    if (ask == null || web == null) return;
    await _flushCaptions();
    String result;
    try {
      final raw = await web.runJavaScriptReturningResult(_frameJs);
      result = raw.toString().replaceAll('"', '');
    } catch (_) {
      result = 'blocked';
    }
    final hasImage = result.length > 100;
    if (!hasImage && mounted) {
      setState(() => _status = result == 'novideo'
          ? 'I don\'t see a video playing yet.'
          : 'This site blocks reading the picture, so I\'ll use the captions only.');
    }
    await ask(
      hasImage
          ? 'Look at this scene from what I\'m watching and tell me what\'s going on, using the Theater notes for context.'
          : 'Talk with me about the scene I\'m watching right now, using the Theater notes (captions only, no picture).',
      hasImage ? result : null,
    );
  }

  bool get _isYouTube {
    final host = Uri.tryParse(_address.text.contains('://') ? _address.text : 'https://${_address.text}')?.host.toLowerCase() ?? '';
    return host == 'youtu.be' || host.endsWith('youtube.com');
  }

  Future<void> _learnCurrentVideo({bool quiet = false}) async {
    if (!_isYouTube || _learningVideo) return;
    final url = _address.text.trim();
    if (url.isEmpty) return;
    setState(() {
      _learningVideo = true;
      if (!quiet) _status = 'Learning this YouTube video from captions and any readable frame…';
    });
    await _flushCaptions();
    String? frame;
    final web = _web;
    if (web != null) {
      try {
        final raw = await web.runJavaScriptReturningResult(_frameJs);
        final result = raw.toString().replaceAll('"', '');
        if (result.length > 1000) frame = result;
      } catch (_) {}
    }
    try {
      final result = await widget.client.learnYouTube(
        url: url,
        title: _pageTitle.isEmpty ? 'YouTube video' : _pageTitle,
        captions: List<Map<String, Object>>.from(_learningCaptions),
        frameBase64: frame,
      );
      if (!mounted) return;
      setState(() => _status = '${result['reply'] ?? 'I learned this YouTube video, sir.'}');
    } catch (error) {
      if (!mounted || quiet) return;
      setState(() => _status = 'I could not save this video to my learning library yet: $error');
    } finally {
      if (mounted) setState(() => _learningVideo = false);
    }
  }

  @override
  void dispose() {
    _captionFlush?.cancel();
    unawaited(_flushCaptions());
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
      ..addJavaScriptChannel('CheCaptions', onMessageReceived: (message) => _onCaption(message.message))
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
        onPageFinished: (_) async {
          final web = _web;
          if (web == null) return;
          unawaited(web.runJavaScript(CheTheaterGuard.popupShield));
          unawaited(web.runJavaScript(_captionJs));
          _pageTitle = ((await web.getTitle()) ?? '').trim();
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
      _learningCaptions.clear();
      _captionCount = 0;
      _pageTitle = '';
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

  Future<void> _openTheaterScreen() async {
    final typed = _address.text.trim();
    final now = CheBrowserStore.instance.nowPlaying.value;
    final existing = typed.isNotEmpty ? typed : (now?.url ?? '').trim();
    if (existing.isNotEmpty) {
      _address.text = existing;
      await _open(existing);
      return;
    }

    final input = TextEditingController();
    final raw = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: CheColors.surface,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            CheSpace.gutter,
            CheSpace.md,
            CheSpace.gutter,
            CheSpace.lg + MediaQuery.viewInsetsOf(sheetContext).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Theater TV', style: CheType.title),
              const SizedBox(height: CheSpace.xs),
              Text(
                'Play a video page inside CHE. This stays in the Theater instead of opening another app.',
                style: CheType.caption,
              ),
              const SizedBox(height: CheSpace.md),
              Semantics(
                textField: true,
                label: 'Video page address for the Theater TV',
                child: TextField(
                  controller: input,
                  autofocus: true,
                  keyboardType: TextInputType.url,
                  textInputAction: TextInputAction.go,
                  onSubmitted: (value) => Navigator.pop(sheetContext, value),
                  decoration: const InputDecoration(
                    labelText: 'Video page address',
                    hintText: 'https://…',
                  ),
                ),
              ),
              const SizedBox(height: CheSpace.md),
              FilledButton.icon(
                onPressed: () => Navigator.pop(sheetContext, input.text),
                icon: const Icon(Icons.live_tv_rounded),
                label: const Text('Play inside CHE'),
              ),
            ],
          ),
        ),
      ),
    );
    final value = raw?.trim() ?? '';
    if (value.isEmpty) return;
    _address.text = value;
    await _open(value);
  }

  Future<void> _stop() async {
    if (_isYouTube) await _learnCurrentVideo(quiet: true);
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
            if (web != null && widget.onAskAboutScene != null)
              Semantics(
                button: true,
                label: 'Ask CHE about this scene. She uses the captions she saved, and the picture when the site allows it.',
                excludeSemantics: true,
                onTap: _askAboutScene,
                child: FilledButton.icon(onPressed: _askAboutScene, icon: const Icon(Icons.forum_outlined, size: 18), label: const Text('Talk about this scene')),
              ),
            if (web != null && _isYouTube)
              Semantics(
                button: true,
                label: 'Learn this YouTube video. CHE saves its timed captions and only records visual details she could actually see.',
                excludeSemantics: true,
                onTap: _learningVideo ? null : _learnCurrentVideo,
                child: OutlinedButton.icon(
                  onPressed: _learningVideo ? null : _learnCurrentVideo,
                  icon: _learningVideo
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.school_outlined, size: 18),
                  label: Text(_learningVideo ? 'Learning…' : 'Learn video'),
                ),
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
              '$_status${_blockedCount > 0 ? '  ·  $_blockedCount blocked' : ''}${_captionCount > 0 ? '  ·  $_captionCount caption lines saved' : ''}',
              style: CheType.caption,
            ),
          ),
        ),
        const SizedBox(height: CheSpace.sm),
        Expanded(
          child: RepaintBoundary(
            child: web == null
                ? _Theater3DStage(runtime: widget.runtime, onScreenTap: _openTheaterScreen)
                : Container(
                    color: Colors.black,
                    child: WebViewWidget(
                      controller: web,
                      // In-tab player: do not claim the room sheet's dismiss drag.
                      gestureRecognizers: cheEmbeddedParentFriendlyGestures(),
                    ),
                  ),
          ),
        ),
        if (web != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.xs, CheSpace.gutter, 0),
            child: SizedBox(
              height: 160,
              child: _Theater3DStage(runtime: widget.runtime, compact: true, onScreenTap: _openTheaterScreen),
            ),
          ),
        CheRoomVisitors(runtime: widget.runtime, rooms: const {'theater'}, onOpenOffice: widget.onOpenOffice),
      ]),
    );
  }
}


class _Theater3DStage extends StatelessWidget {
  const _Theater3DStage({
    required this.runtime,
    required this.onScreenTap,
    this.compact = false,
  });

  final CheAgentRuntimeController runtime;
  final Future<void> Function() onScreenTap;
  final bool compact;

  List<CheSceneEntity> _visitors() {
    final visitors = <CheSceneEntity>[
      for (final p in runtime.agents)
        if (p.room == 'theater' || p.agent.status == CheAgentStatus.idle)
          CheSceneEntity(
            id: p.agent.id,
            label: p.agent.name,
            description:
                p.room == 'theater' ? 'Watching in the Theater' : 'Available seat visitor',
            color: p.agent.color,
            state: p.room == 'theater' ? 'working' : 'idle',
          ),
    ];
    if (visitors.isEmpty) {
      visitors.add(
        const CheSceneEntity(
          id: 'che',
          label: 'CHE',
          description: 'Theater host',
          color: CheColors.accent,
        ),
      );
    }
    return visitors;
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CheBrowserEntry?>(
      valueListenable: CheBrowserStore.instance.nowPlaying,
      builder: (context, value, child) {
        return ValueListenableBuilder<CheSceneQuality>(
          valueListenable: CheSceneQualityStore.value,
          builder: (context, quality, _) => CheNativeSceneWorld(
            mode: CheSceneMode.theater,
            quality: quality,
            entities: _visitors(),
            height: compact ? 160 : 420,
            semanticsLabel: 'Immersive Theater with in-CHE TV',
            primarySurfaceLabel:
                'Theater TV. Activate to play a video page inside CHE.',
            onPrimarySurfaceTap: () => unawaited(onScreenTap()),
          ),
        );
      },
    );
  }
}
