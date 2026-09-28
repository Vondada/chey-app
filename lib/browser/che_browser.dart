// CHE's in-app browser: tabs, history, favorites, reader/research mode,
// summarize, ask CHE about the page, save to project, teach CHE, and file
// handoff. Keeps back / forward / refresh / external open / custom URL.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

typedef ChePageCallback = Future<void> Function(String title, String url, String pageText);

/// App-level hooks the browser uses to reach CHE. Set once by the app.
class CheBrowserActions {
  CheBrowserActions._();

  /// "Teach CHE this page" → learn into owner context.
  static ChePageCallback? learn;

  /// "Save to project" → create a CHE project from the page.
  static ChePageCallback? saveToProject;

  /// Sends a prompt about the page to CHE (page text goes as screen context).
  static Future<void> Function(String prompt, String title, String url, String pageText)? ask;
}

class CheBrowserEntry {
  const CheBrowserEntry({required this.url, required this.title, required this.at});
  final String url;
  final String title;
  final DateTime at;
  Map<String, dynamic> toJson() => {'url': url, 'title': title, 'at': at.toIso8601String()};
  static CheBrowserEntry? fromJson(Object? j) {
    if (j is! Map) return null;
    final url = '${j['url'] ?? ''}';
    if (url.isEmpty) return null;
    return CheBrowserEntry(url: url, title: '${j['title'] ?? url}', at: DateTime.tryParse('${j['at']}') ?? DateTime.now());
  }
}

/// History + favorites, stored on the phone.
class CheBrowserStore {
  CheBrowserStore._();
  static final instance = CheBrowserStore._();

  static const _historyKey = 'che_browser_history';
  static const _favoritesKey = 'che_browser_favorites';

  List<CheBrowserEntry> history = [];
  List<CheBrowserEntry> favorites = [];
  bool _loaded = false;

  Future<void> load() async {
    if (_loaded) return;
    final prefs = await SharedPreferences.getInstance();
    List<CheBrowserEntry> read(String key) {
      try {
        final raw = jsonDecode(prefs.getString(key) ?? '[]');
        return [for (final e in (raw as List)) ?CheBrowserEntry.fromJson(e)];
      } catch (_) {
        return [];
      }
    }

    history = read(_historyKey);
    favorites = read(_favoritesKey);
    _loaded = true;
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_historyKey, jsonEncode([for (final e in history) e.toJson()]));
    await prefs.setString(_favoritesKey, jsonEncode([for (final e in favorites) e.toJson()]));
  }

  Future<void> visit(String url, String title) async {
    await load();
    if (history.isNotEmpty && history.first.url == url) {
      history[0] = CheBrowserEntry(url: url, title: title, at: DateTime.now());
    } else {
      history.insert(0, CheBrowserEntry(url: url, title: title, at: DateTime.now()));
    }
    if (history.length > 300) history = history.sublist(0, 300);
    await _save();
  }

  bool isFavorite(String url) => favorites.any((e) => e.url == url);

  Future<void> toggleFavorite(String url, String title) async {
    await load();
    if (isFavorite(url)) {
      favorites.removeWhere((e) => e.url == url);
    } else {
      favorites.insert(0, CheBrowserEntry(url: url, title: title, at: DateTime.now()));
    }
    await _save();
  }

  Future<void> clearHistory() async {
    history = [];
    await _save();
  }
}

/// Turns address-bar input into a URL: a web address, or a search.
Uri cheAddressToUri(String input) {
  final raw = input.trim();
  final looksLikeUrl = raw.contains('://') || (RegExp(r'^[^\s]+\.[a-z]{2,}(/.*)?$', caseSensitive: false).hasMatch(raw));
  if (looksLikeUrl) {
    final withScheme = raw.contains('://') ? raw : 'https://$raw';
    final uri = Uri.tryParse(withScheme);
    if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) return uri;
  }
  return Uri.https('duckduckgo.com', '/', {'q': raw});
}

const _fileExtensions = ['.pdf', '.zip', '.dmg', '.pkg', '.ipa', '.apk', '.mp3', '.mp4', '.mov', '.csv', '.xlsx', '.docx', '.pptx'];

class _BrowserTab {
  _BrowserTab(this.url, {required this.onChanged}) {
    controller = WebViewController()
      ..setBackgroundColor(const Color(0xFF060B11))
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (value) {
          progress = value;
          onChanged();
        },
        onPageStarted: (u) {
          url = u;
          onChanged();
        },
        onPageFinished: (u) async {
          url = u;
          title = (await controller.getTitle())?.trim() ?? title;
          if (title.isEmpty) title = Uri.tryParse(u)?.host ?? u;
          unawaited(CheBrowserStore.instance.visit(u, title));
          onChanged();
        },
        onNavigationRequest: (request) {
          final uri = Uri.tryParse(request.url);
          if (uri == null) return NavigationDecision.prevent;
          final path = uri.path.toLowerCase();
          // File handoff: downloads go to iOS (Files / share sheet / viewer).
          if (_fileExtensions.any(path.endsWith)) {
            launchUrl(uri, mode: LaunchMode.externalApplication);
            return NavigationDecision.prevent;
          }
          if (uri.scheme == 'http' || uri.scheme == 'https' || uri.scheme == 'about') return NavigationDecision.navigate;
          launchUrl(uri, mode: LaunchMode.externalApplication);
          return NavigationDecision.prevent;
        },
      ))
      ..loadRequest(Uri.parse(url));
  }

  final VoidCallback onChanged;
  late final WebViewController controller;
  String url;
  String title = '';
  int progress = 0;
}

class CheBrowserScreen extends StatefulWidget {
  const CheBrowserScreen({super.key, required this.initialUrl, this.title});
  final String initialUrl;
  final String? title;
  @override
  State<CheBrowserScreen> createState() => _CheBrowserScreenState();
}

class _CheBrowserScreenState extends State<CheBrowserScreen> {
  final List<_BrowserTab> _tabs = [];
  int _active = 0;
  final _address = TextEditingController();
  final _addressFocus = FocusNode();

  _BrowserTab get _tab => _tabs[_active];

  @override
  void initState() {
    super.initState();
    unawaited(CheBrowserStore.instance.load());
    _openTab(widget.initialUrl);
    _addressFocus.addListener(() {
      if (!_addressFocus.hasFocus) _syncAddress();
    });
  }

  @override
  void dispose() {
    _address.dispose();
    _addressFocus.dispose();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    if (!_addressFocus.hasFocus) _syncAddress();
    setState(() {});
  }

  void _syncAddress() => _address.text = _tabs.isEmpty ? '' : _tab.url;

  void _openTab(String url) {
    _tabs.add(_BrowserTab(url, onChanged: _changed));
    _active = _tabs.length - 1;
    _syncAddress();
    setState(() {});
  }

  void _closeTab(int i) {
    if (_tabs.length == 1) {
      Navigator.of(context).maybePop();
      return;
    }
    _tabs.removeAt(i);
    // Keep the same page active when an earlier tab closes.
    if (i < _active) _active--;
    if (_active >= _tabs.length) _active = _tabs.length - 1;
    _syncAddress();
    setState(() {});
  }

  void _go(String input) {
    if (input.trim().isEmpty) return;
    _addressFocus.unfocus();
    unawaited(_tab.controller.loadRequest(cheAddressToUri(input)));
  }

  Future<String> _pageText() async {
    try {
      final raw = await _tab.controller.runJavaScriptReturningResult(
        '(function(){var a=document.querySelector("article")||document.querySelector("main")||document.body;return a?a.innerText:"";})()',
      );
      var text = raw.toString();
      try {
        final decoded = jsonDecode(text);
        if (decoded is String) text = decoded;
      } catch (_) {}
      return text.trim();
    } catch (_) {
      return '';
    }
  }

  String get _title => _tab.title.isEmpty ? (Uri.tryParse(_tab.url)?.host ?? 'Page') : _tab.title;

  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  Future<void> _reader() async {
    final text = await _pageText();
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => _ReaderScreen(title: _title, url: _tab.url, text: text),
    ));
  }

  Future<void> _ask(String prompt) async {
    final ask = CheBrowserActions.ask;
    if (ask == null) {
      _snack('Open this page from CHE to ask about it.');
      return;
    }
    final text = await _pageText();
    await ask(prompt, _title, _tab.url, text);
  }

  Future<void> _askCustom() async {
    final ctrl = TextEditingController();
    final q = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Ask CHE about this page'),
        content: TextField(controller: ctrl, autofocus: true, maxLines: 3, decoration: const InputDecoration(hintText: 'What do you want to know?')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, ctrl.text), child: const Text('Ask')),
        ],
      ),
    );
    if (q == null || q.trim().isEmpty) return;
    await _ask(q.trim());
  }

  Future<void> _runPageAction(ChePageCallback? action, String done) async {
    if (action == null) {
      _snack('Not available here.');
      return;
    }
    final text = await _pageText();
    await action(_title, _tab.url, text);
    if (mounted) _snack(done);
  }

  Future<void> _showList(String title, List<CheBrowserEntry> Function() entries, {VoidCallback? onClear}) async {
    await CheBrowserStore.instance.load();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, setLocal) {
          final list = entries();
          return SizedBox(
            height: MediaQuery.sizeOf(context).height * 0.7,
            child: Column(children: [
              ListTile(
                title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
                trailing: onClear == null
                    ? null
                    : TextButton(
                        onPressed: () {
                          onClear();
                          setLocal(() {});
                        },
                        child: const Text('Clear'),
                      ),
              ),
              Expanded(
                child: list.isEmpty
                    ? const Center(child: Text('Nothing here yet.'))
                    : ListView.builder(
                        itemCount: list.length,
                        itemBuilder: (_, i) => ListTile(
                          title: Text(list[i].title, maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text(list[i].url, maxLines: 1, overflow: TextOverflow.ellipsis),
                          onTap: () {
                            Navigator.pop(sheet);
                            _go(list[i].url);
                          },
                        ),
                      ),
              ),
            ]),
          );
        },
      ),
    );
  }

  Future<void> _showTabs() async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, setLocal) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (var i = 0; i < _tabs.length; i++)
              ListTile(
                selected: i == _active,
                leading: const Icon(Icons.tab_rounded),
                title: Text(_tabs[i].title.isEmpty ? _tabs[i].url : _tabs[i].title, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(_tabs[i].url, maxLines: 1, overflow: TextOverflow.ellipsis),
                onTap: () {
                  Navigator.pop(sheet);
                  setState(() => _active = i);
                  _syncAddress();
                },
                trailing: IconButton(
                  tooltip: 'Close tab',
                  icon: const Icon(Icons.close_rounded),
                  onPressed: () {
                    Navigator.pop(sheet);
                    _closeTab(i);
                  },
                ),
              ),
            ListTile(
              leading: const Icon(Icons.add_rounded),
              title: const Text('New tab'),
              onTap: () {
                Navigator.pop(sheet);
                _openTab('https://duckduckgo.com');
              },
            ),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final store = CheBrowserStore.instance;
    final fav = store.isFavorite(_tab.url);
    return Scaffold(
      backgroundColor: const Color(0xFF060B11),
      appBar: AppBar(
        titleSpacing: 0,
        title: TextField(
          controller: _address,
          focusNode: _addressFocus,
          keyboardType: TextInputType.url,
          textInputAction: TextInputAction.go,
          onSubmitted: _go,
          style: const TextStyle(fontSize: 14),
          decoration: InputDecoration(
            isDense: true,
            hintText: 'Search or enter address',
            prefixIcon: Icon(_tab.url.startsWith('https://') ? Icons.lock_rounded : Icons.public_rounded, size: 16),
            filled: true,
            fillColor: Colors.white.withValues(alpha: 0.06),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
          ),
        ),
        actions: [
          IconButton(
            tooltip: fav ? 'Remove favorite' : 'Add favorite',
            icon: Icon(fav ? Icons.star_rounded : Icons.star_border_rounded),
            onPressed: () async {
              await store.toggleFavorite(_tab.url, _title);
              if (mounted) setState(() {});
            },
          ),
          PopupMenuButton<String>(
            tooltip: 'Page actions',
            onSelected: (v) async {
              switch (v) {
                case 'reader':
                  await _reader();
                case 'summarize':
                  await _ask('Summarize this page for me: key points, what matters, and anything that looks wrong or unsupported.');
                case 'ask':
                  await _askCustom();
                case 'teach':
                  await _runPageAction(CheBrowserActions.learn, 'CHE learned this page.');
                case 'project':
                  await _runPageAction(CheBrowserActions.saveToProject, 'Saved to a CHE project.');
                case 'history':
                  await _showList('History', () => store.history, onClear: () => unawaited(store.clearHistory()));
                case 'favorites':
                  await _showList('Favorites', () => store.favorites);
                case 'copy':
                  await Clipboard.setData(ClipboardData(text: _tab.url));
                  if (mounted) _snack('Link copied.');
                case 'external':
                  await launchUrl(Uri.parse(_tab.url), mode: LaunchMode.externalApplication);
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'reader', child: ListTile(leading: Icon(Icons.chrome_reader_mode_outlined), title: Text('Reader mode'))),
              PopupMenuItem(value: 'summarize', child: ListTile(leading: Icon(Icons.summarize_outlined), title: Text('Summarize'))),
              PopupMenuItem(value: 'ask', child: ListTile(leading: Icon(Icons.question_answer_outlined), title: Text('Ask CHE about this page'))),
              PopupMenuItem(value: 'teach', child: ListTile(leading: Icon(Icons.psychology_alt_outlined), title: Text('Teach CHE this page'))),
              PopupMenuItem(value: 'project', child: ListTile(leading: Icon(Icons.folder_special_outlined), title: Text('Save to project'))),
              PopupMenuItem(value: 'history', child: ListTile(leading: Icon(Icons.history_rounded), title: Text('History'))),
              PopupMenuItem(value: 'favorites', child: ListTile(leading: Icon(Icons.star_outline_rounded), title: Text('Favorites'))),
              PopupMenuItem(value: 'copy', child: ListTile(leading: Icon(Icons.link_rounded), title: Text('Copy link'))),
              PopupMenuItem(value: 'external', child: ListTile(leading: Icon(Icons.open_in_new_rounded), title: Text('Open in official app / Safari'))),
            ],
          ),
        ],
      ),
      body: Column(children: [
        if (_tab.progress < 100) LinearProgressIndicator(value: _tab.progress / 100.0, minHeight: 2),
        Expanded(
          child: IndexedStack(
            index: _active,
            children: [for (final t in _tabs) WebViewWidget(key: ObjectKey(t), controller: t.controller)],
          ),
        ),
      ]),
      bottomNavigationBar: SafeArea(
        child: SizedBox(
          height: 48,
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
            IconButton(
              tooltip: 'Back',
              icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18),
              onPressed: () async {
                if (await _tab.controller.canGoBack()) await _tab.controller.goBack();
              },
            ),
            IconButton(
              tooltip: 'Forward',
              icon: const Icon(Icons.arrow_forward_ios_rounded, size: 18),
              onPressed: () async {
                if (await _tab.controller.canGoForward()) await _tab.controller.goForward();
              },
            ),
            IconButton(tooltip: 'Reload', icon: const Icon(Icons.refresh_rounded), onPressed: () => _tab.controller.reload()),
            IconButton(tooltip: 'Ask CHE', icon: const Icon(Icons.auto_awesome_rounded), onPressed: _askCustom),
            IconButton(
              tooltip: 'Tabs',
              onPressed: _showTabs,
              icon: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(border: Border.all(color: Colors.white70), borderRadius: BorderRadius.circular(5)),
                child: Text('${_tabs.length}', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

class _ReaderScreen extends StatelessWidget {
  const _ReaderScreen({required this.title, required this.url, required this.text});
  final String title;
  final String url;
  final String text;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(tooltip: 'Copy text', onPressed: () => Clipboard.setData(ClipboardData(text: text)), icon: const Icon(Icons.copy_all_rounded)),
          if (CheBrowserActions.ask != null)
            IconButton(
              tooltip: 'Summarize with CHE',
              icon: const Icon(Icons.summarize_outlined),
              onPressed: () => CheBrowserActions.ask!('Summarize this page for me: key points and what matters.', title, url, text),
            ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 40),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, height: 1.25)),
            const SizedBox(height: 6),
            Text(url, style: const TextStyle(color: Colors.white54, fontSize: 12)),
            const SizedBox(height: 18),
            SelectableText(
              text.isEmpty ? 'This page has no readable text.' : text,
              style: const TextStyle(fontSize: 17, height: 1.6),
            ),
          ]),
        ),
      ),
    );
  }
}
