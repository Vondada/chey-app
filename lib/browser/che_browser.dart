// CHE's in-app browser: tabs, history, favorites, reader/research mode,
// summarize, ask CHE about the page, save to project, teach CHE, and file
// handoff. Keeps back / forward / refresh / external open / custom URL.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show Factory;
import 'package:flutter/gestures.dart' show EagerGestureRecognizer, OneSequenceGestureRecognizer;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../che_app_portal.dart' show cheAppForName;
import '../security/che_password_vault.dart';

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

  /// Voice control of the browser that is open right now. Returns what CHE
  /// should say, or null when the words aren't a browser command.
  static Future<String?> Function(String words)? voice;
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

  /// Live "now playing" page for Theater TV (best-effort URL/title mirror).
  final ValueNotifier<CheBrowserEntry?> nowPlaying = ValueNotifier<CheBrowserEntry?>(null);

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
    final entry = CheBrowserEntry(url: url, title: title, at: DateTime.now());
    nowPlaying.value = entry;
    if (history.isNotEmpty && history.first.url == url) {
      history[0] = entry;
    } else {
      history.insert(0, entry);
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
      // Owner signs in once (Face ID AutoFill or typing); CHE saves that login
      // to her on-device Keychain vault. Sessions persist in the web view's
      // own cookie store, so he stays logged in.
      ..addJavaScriptChannel('CheVaultCapture', onMessageReceived: (message) {
        unawaited(_saveCapturedLogin(message.message));
      })
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
          unawaited(controller.runJavaScript(_loginCaptureJs));
          unawaited(_autoFill(controller, u));
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

  // Watches sign-in forms on this page and hands the login to the vault
  // when the owner submits it. Nothing leaves the phone.
  static const _loginCaptureJs = r'''
(function () {
  if (window.__cheLoginCapture) return;
  window.__cheLoginCapture = true;
  function grab() {
    var pw = document.querySelector('input[type=password]');
    if (!pw || !pw.value) return;
    var user = document.querySelector('input[autocomplete=username],input[type=email],input[name*=user i],input[name*=email i],input[id*=user i],input[id*=email i]');
    try {
      CheVaultCapture.postMessage(JSON.stringify({ host: location.host, username: user ? user.value : '', password: pw.value }));
    } catch (e) {}
  }
  document.addEventListener('submit', grab, true);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button,input[type=submit],[role=button]') : null;
    if (b) setTimeout(grab, 0);
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter') setTimeout(grab, 0); }, true);
})();
''';

  // On a sign-in page for a site CHE already has, fill the login in
  // automatically (the owner or CHE still presses Sign in).
  static Future<void> _autoFill(WebViewController controller, String pageUrl) async {
    try {
      final host = Uri.tryParse(pageUrl)?.host ?? '';
      if (host.isEmpty) return;
      final entry = await CheVault.instance.find(host);
      if (entry == null) return;
      final u = jsonEncode(entry.username);
      final p = jsonEncode(entry.password);
      await controller.runJavaScript('''(function(u,p){
var pw=document.querySelector('input[type=password]');if(!pw||pw.value)return;
function set(e,v){var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
var user=document.querySelector('input[autocomplete=username],input[type=email],input[name*=user i],input[name*=email i],input[id*=user i],input[id*=email i]');
if(user&&u&&!user.value)set(user,u);set(pw,p);})($u,$p)''');
    } catch (_) {}
  }

  static Future<void> _saveCapturedLogin(String raw) async {
    try {
      final data = jsonDecode(raw);
      if (data is! Map) return;
      final host = '${data['host'] ?? ''}';
      final password = '${data['password'] ?? ''}';
      if (host.isEmpty || password.isEmpty) return;
      final site = CheVaultCommand.normalizeSite(host);
      final existing = await CheVault.instance.find(site);
      if (existing != null && existing.password == password && existing.site == site) return;
      await CheVault.instance.save(CheVaultEntry(site: site, password: password, username: '${data['username'] ?? ''}'));
    } catch (_) {
      // Never let a capture problem affect the page.
    }
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
    CheBrowserActions.voice = _voiceCommand;
    _addressFocus.addListener(() {
      if (!_addressFocus.hasFocus) _syncAddress();
    });
  }

  @override
  void dispose() {
    if (CheBrowserActions.voice == _voiceCommand) CheBrowserActions.voice = null;
    _address.dispose();
    _addressFocus.dispose();
    super.dispose();
  }

  // ─── Voice navigation (voice-first use) ─────────────────────────────────
  static const _ordinals = {
    'first': 1, 'one': 1, '1st': 1, 'second': 2, 'two': 2, '2nd': 2, 'third': 3, 'three': 3, '3rd': 3,
    'fourth': 4, 'four': 4, '4th': 4, 'fifth': 5, 'five': 5, '5th': 5, 'sixth': 6, 'six': 6, '6th': 6,
    'seventh': 7, 'seven': 7, '7th': 7, 'eighth': 8, 'eight': 8, '8th': 8,
  };

  Future<String> _js(String code) async {
    try {
      final raw = await _tab.controller.runJavaScriptReturningResult(code);
      var text = raw.toString();
      try {
        final decoded = jsonDecode(text);
        if (decoded is String) text = decoded;
      } catch (_) {}
      return text;
    } catch (_) {
      return '';
    }
  }

  static const _listJs = r'''(function(){
var els=[].slice.call(document.querySelectorAll('a,button,[role=button],[role=link],input[type=submit]'));
document.querySelectorAll('[data-che-n]').forEach(function(e){e.removeAttribute('data-che-n');});
var out=[],seen={};
for(var i=0;i<els.length&&out.length<8;i++){var e=els[i];var r=e.getBoundingClientRect();
if(r.width<20||r.height<12||r.bottom<0||r.top>innerHeight)continue;
var t=(e.getAttribute('aria-label')||e.innerText||e.title||'').replace(/\s+/g,' ').trim();
if(t.length<3||t.length>140||seen[t])continue;seen[t]=1;e.setAttribute('data-che-n',String(out.length+1));out.push(t);}
return JSON.stringify({title:document.title||'',items:out});})()''';

  Future<List<String>> _listItems() async {
    final raw = await _js(_listJs);
    try {
      final j = jsonDecode(raw);
      if (j is Map) return [for (final i in (j['items'] as List? ?? const [])) '$i'];
    } catch (_) {}
    return const [];
  }

  Future<String> _describe() async {
    final items = await _listItems();
    if (items.isEmpty) return 'This is $_title. I can\'t find anything to open on this part of the page. Say "scroll down" or "read the page".';
    final spoken = [for (var i = 0; i < items.length; i++) '${i + 1}: ${items[i]}'].join('. ');
    return 'On $_title I see: $spoken. Say "open" and a number, or "scroll down" for more.';
  }

  Future<String> _clickNumber(int n) async {
    var label = await _js('(function(){var e=document.querySelector(\'[data-che-n="$n"]\');if(!e)return "";var t=(e.getAttribute("aria-label")||e.innerText||"").replace(/\\s+/g," ").trim().slice(0,100);e.scrollIntoView({block:"center"});e.click();return t;})()');
    if (label.isEmpty) {
      final items = await _listItems();
      if (n > items.length) return 'There are only ${items.length} options on screen right now.';
      label = await _js('(function(){var e=document.querySelector(\'[data-che-n="$n"]\');if(!e)return "";var t=(e.getAttribute("aria-label")||e.innerText||"").replace(/\\s+/g," ").trim().slice(0,100);e.scrollIntoView({block:"center"});e.click();return t;})()');
    }
    return label.isEmpty ? 'I couldn\'t open number $n.' : 'Opening $label.';
  }

  // ── Typing into web apps (Gmail, WhatsApp Web, …) ───────────────────
  // Fills the field whose label, placeholder or aria-label matches `field`,
  // or the focused / first empty text field when no field is named.
  Future<String> _typeInto(String text, String? field) async {
    final t = jsonEncode(text);
    final f = jsonEncode((field ?? '').toLowerCase());
    final label = await _js('''(function(text,field){
var sel='input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true],[contenteditable=""],[role=textbox]';
var els=[].slice.call(document.querySelectorAll(sel)).filter(function(e){var r=e.getBoundingClientRect();return r.width>8&&r.height>8;});
function name(e){var id=e.id?document.querySelector('label[for="'+e.id+'"]'):null;return ((e.getAttribute('aria-label')||'')+' '+(e.placeholder||'')+' '+(e.name||'')+' '+(id?id.innerText:'')).toLowerCase().replace(/\\s+/g,' ').trim();}
var target=null;
if(field){target=els.filter(function(e){return name(e).indexOf(field)>=0;})[0]||null;}
if(!target&&document.activeElement&&els.indexOf(document.activeElement)>=0)target=document.activeElement;
if(!target)target=els.filter(function(e){return !(e.value||e.innerText||'').trim();})[0]||els[0]||null;
if(!target)return '';
target.scrollIntoView({block:'center'});target.focus();
if(target.isContentEditable||target.getAttribute('role')==='textbox'){document.execCommand('insertText',false,text);}
else{var proto=target.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(target,(target.value?target.value+' ':'')+text);}
target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));
return name(target)||'the text box';})($t,$f)''');
    return label.isEmpty
        ? 'I couldn\'t find a place to type on this page. Say "what\'s on screen" and I\'ll read the options.'
        : 'Typed it into ${label.length > 60 ? label.substring(0, 60) : label}.';
  }

  // What's typed on the page right now (for reading a draft back).
  Future<String> _draftText() => _js('''(function(){
var parts=[];[].slice.call(document.querySelectorAll('input:not([type=hidden]):not([type=password]),textarea,[contenteditable=true],[role=textbox]')).forEach(function(e){
var v=(e.value!==undefined&&e.tagName!=='DIV'?e.value:e.innerText)||'';v=v.replace(/\\s+/g,' ').trim();if(v)parts.push(v.slice(0,400));});
return parts.slice(0,4).join(' | ');})()''');

  // Owner rule (Sep 28, 2026): CHE has full permission to act, except when
  // something costs money — those presses need his spoken yes first.
  static final RegExp _consequential = RegExp(
    r'\b(pay|pay now|buy|buy now|purchase|order|place order|checkout|check out|subscribe|upgrade|rent|donate|tip|transfer|send money|add to cart|confirm (?:payment|purchase|order)|book)\b',
  );
  // Owner rule: deleting anything also always needs his yes first.
  static final RegExp _destructive = RegExp(
    r'\b(delete|remove|trash|discard|erase|clear all|empty trash|unsubscribe|deactivate|close account|archive all)\b',
  );

  // Fills the saved username/password for this site from CHE's on-device
  // vault. Values go straight into the page, never into chat or the server.
  Future<String> _signIn() async {
    final host = Uri.tryParse(_tab.url)?.host ?? '';
    final entry = await CheVault.instance.find(host.isEmpty ? _title : host) ?? await CheVault.instance.find(_title);
    if (entry == null) {
      return 'I don\'t have a saved password for this site. Say "save my ${host.replaceFirst('www.', '')} password" and the password.';
    }
    final u = jsonEncode(entry.username);
    final p = jsonEncode(entry.password);
    final filled = await _js('''(function(u,p){
function set(e,v){var proto=HTMLInputElement.prototype;var s=Object.getOwnPropertyDescriptor(proto,'value').set;e.focus();s.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
var pw=document.querySelector('input[type=password]');
var user=document.querySelector('input[autocomplete=username],input[type=email],input[name*=user i],input[name*=email i],input[id*=user i],input[id*=email i],input[type=text]');
var did=[];if(user&&u){set(user,u);did.push('user');}if(pw){set(pw,p);did.push('pass');}
return did.join(',');})($u,$p)''');
    if (filled.isEmpty) return 'I don\'t see a sign-in box on this page yet. Open the sign-in page and say "sign me in" again.';
    final both = filled.contains('pass');
    return both
        ? 'Filled in your ${entry.site} sign-in. Say "click sign in" or "next" to continue.'
        : 'Filled in your username. Say "next", then "sign me in" again for the password.';
  }
  String? _pendingPress;
  int? _pendingNumber;

  Future<String> _confirmPrompt(String label) async {
    final draft = (await _draftText()).trim();
    final host = Uri.tryParse(_tab.url)?.host ?? 'this page';
    if (_destructive.hasMatch(label.toLowerCase())) {
      return 'Double-checking before I delete anything: I\'m about to press "$label" on $host. Say "yes" to delete, or "cancel".';
    }
    return 'This costs money: I\'m about to press "$label" on $host${draft.isNotEmpty ? ' ($draft)' : ''}. '
        'Say "yes" to pay, or "cancel".';
  }

  Future<String> _clickText(String query) async {
    final q = jsonEncode(query.toLowerCase());
    final label = await _js('''(function(q){var els=[].slice.call(document.querySelectorAll('a,button,[role=button],[role=link]'));var best=null,bs=0;
els.forEach(function(e){var t=(e.getAttribute('aria-label')||e.innerText||e.title||'').replace(/\\s+/g,' ').trim().toLowerCase();if(!t)return;var s=0;
if(t===q)s=100;else if(t.indexOf(q)>=0)s=60-Math.min(40,t.length/10);else{var w=q.split(' ').filter(function(x){return x.length>2});var hit=w.filter(function(x){return t.indexOf(x)>=0}).length;if(w.length&&hit===w.length)s=40;}
var r=e.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight)s+=5;if(s>bs){bs=s;best=e;}});
if(!best)return '';var label=(best.getAttribute('aria-label')||best.innerText||'').replace(/\\s+/g,' ').trim().slice(0,100);best.scrollIntoView({block:'center'});best.click();return label;})($q)''');
    return label.isEmpty ? 'I couldn\'t find "$query" on this page. Say "what\'s on screen" and I\'ll read the options.' : 'Opening $label.';
  }

  Future<String?> _voiceCommand(String words) async {
    if (!mounted || _tabs.isEmpty) return null;
    final w = words.toLowerCase().replaceAll(RegExp(r'[.!?,]+$'), '').trim();
    if (w.isEmpty) return null;

    if (RegExp(r'^(scroll )?(down|next|more)( please)?$|^scroll down').hasMatch(w)) {
      await _js('window.scrollBy({top: innerHeight*0.8, behavior: "smooth"}); "ok"');
      return 'Scrolled down.';
    }
    if (RegExp(r'^(scroll )?up$|^scroll up').hasMatch(w)) {
      await _js('window.scrollBy({top: -innerHeight*0.8, behavior: "smooth"}); "ok"');
      return 'Scrolled up.';
    }
    if (RegExp(r'^(go )?back$').hasMatch(w)) {
      if (await _tab.controller.canGoBack()) {
        await _tab.controller.goBack();
        return 'Going back.';
      }
      return 'This is the first page.';
    }
    if (RegExp(r'^(go )?forward$').hasMatch(w)) {
      if (await _tab.controller.canGoForward()) await _tab.controller.goForward();
      return 'Going forward.';
    }
    if (RegExp(r'^(reload|refresh)( (the )?page)?$').hasMatch(w)) {
      await _tab.controller.reload();
      return 'Reloading.';
    }
    if (RegExp(r'^(pause|stop)( the)?( video| it)?$').hasMatch(w)) {
      await _js('(function(){var v=document.querySelector("video");if(v)v.pause();return v?"1":"";})()');
      return 'Paused.';
    }
    if (RegExp(r'^(play|resume)( the)?( video| it)?$').hasMatch(w)) {
      await _js('(function(){var v=document.querySelector("video");if(v)v.play();return v?"1":"";})()');
      return 'Playing.';
    }
    if (RegExp(r'^(close|exit|leave)( the)?( browser| app| this)?$').hasMatch(w)) {
      Navigator.of(context).maybePop();
      return 'Closed.';
    }
    if (RegExp(r"^(read|read me)( the| this)? (page|article|screen)$").hasMatch(w)) {
      final text = await _pageText();
      if (text.isEmpty) return 'There\'s no readable text on this page.';
      final clipped = text.length > 900 ? '${text.substring(0, 900)}…' : text;
      return clipped;
    }
    if (RegExp(r"^(what('?s| is) on (the |my )?screen|what do you see|describe (the |this )?(screen|page)|what are (my|the) options|read (the )?(options|links|results|videos|list))").hasMatch(w)) {
      return _describe();
    }
    final search = RegExp(r'^search(?: youtube)?(?: for)? (.+)$').firstMatch(w);
    if (search != null) {
      final q = Uri.encodeQueryComponent(search.group(1)!.trim());
      final host = Uri.tryParse(_tab.url)?.host ?? '';
      final url = host.contains('youtube') || w.startsWith('search youtube')
          ? 'https://m.youtube.com/results?search_query=$q'
          : 'https://www.google.com/search?q=$q';
      await _tab.controller.loadRequest(Uri.parse(url));
      return 'Searching for ${search.group(1)!.trim()}. Say "what\'s on screen" when you want the results.';
    }
    if (RegExp(r'^(sign|log) (me )?in$|^(fill|enter|put) (in )?my (password|login|sign ?in)$').hasMatch(w)) {
      return _signIn();
    }
    // Confirming or cancelling a pending money press.
    if (_pendingPress != null || _pendingNumber != null) {
      if (RegExp(r'^(yes|yeah|yep|confirm|do it|go ahead)\b').hasMatch(w)) {
        final text = _pendingPress;
        final number = _pendingNumber;
        _pendingPress = null;
        _pendingNumber = null;
        final done = number != null ? await _clickNumber(number) : await _clickText(text!);
        return done.startsWith('Opening ') ? 'Done. I pressed ${done.substring(8)}' : done;
      }
      if (RegExp(r'^(no|nope|cancel|stop|don.?t|never ?mind)\b').hasMatch(w)) {
        _pendingPress = null;
        _pendingNumber = null;
        return 'Cancelled. Nothing was paid for or deleted.';
      }
    }
    if (RegExp(r"^(read|read me|what did i|what's)( back)?( what)?( i| you)?( typed| wrote| the draft| my draft| draft)").hasMatch(w)) {
      final draft = (await _draftText()).trim();
      return draft.isEmpty ? 'Nothing is typed on this page yet.' : 'It says: $draft';
    }
    final fill = RegExp(r'^fill (?:in |out )?(?:the )?(.+?)(?: box| field)? with (.+)$').firstMatch(w);
    if (fill != null) {
      final original = words.trim();
      final at = original.toLowerCase().lastIndexOf(' with ');
      return _typeInto(at >= 0 ? original.substring(at + 6).trim() : fill.group(2)!, fill.group(1));
    }
    if (RegExp(r'^(?:type|write|enter|put)\s+.+$').hasMatch(w)) {
      // Keep the owner's own capitalization for what gets typed.
      final original = words.trim().replaceFirst(RegExp(r'^(?:type|write|enter|put)\s+', caseSensitive: false), '');
      var text = original;
      String? field;
      final seps = RegExp(r'\s+(?:in|into)\s+(?:the\s+)?').allMatches(original.toLowerCase()).toList();
      if (seps.isNotEmpty) {
        final candidate = original.substring(seps.last.end).trim().replaceFirst(RegExp(r'\s+(?:box|field)$', caseSensitive: false), '');
        final known = RegExp(r'^(?:to|subject|message|body|search|email|name|recipient|reply|comment|chat|text|title|caption|address|note|notes)\b', caseSensitive: false);
        if (candidate.split(' ').length <= 3 && known.hasMatch(candidate)) {
          field = candidate.toLowerCase();
          text = original.substring(0, seps.last.start).trim();
        }
      }
      return _typeInto(text, field);
    }

    final pick = RegExp(r'^(?:open|play|click|tap|select|choose|pick|watch|press|hit)(?: the)?(?: number)? (.+?)(?: one| video| result| link| option| button)?$').firstMatch(w);
    // Sending needs no confirmation (owner's standing permission).
    final bareSend = RegExp(r'^(send|post|submit|reply)( it| this| the message| the email)?$').firstMatch(w);
    if (bareSend != null) {
      final done = await _clickText(bareSend.group(1)!);
      return done.startsWith('Opening ') ? 'Sent. I pressed ${done.substring(8)}' : done;
    }
    if (pick != null) {
      final target = pick.group(1)!.trim();
      final n = int.tryParse(target) ?? _ordinals[target];
      if (n != null) {
        final items = await _listItems();
        if (n >= 1 && n <= items.length &&
            (_consequential.hasMatch(items[n - 1].toLowerCase()) || _destructive.hasMatch(items[n - 1].toLowerCase()))) {
          _pendingNumber = n;
          _pendingPress = null;
          return _confirmPrompt(items[n - 1]);
        }
        return _clickNumber(n);
      }
      if (_consequential.hasMatch(target) || _destructive.hasMatch(target)) {
        _pendingPress = target;
        _pendingNumber = null;
        return _confirmPrompt(target);
      }
      // "open YouTube" etc. is an app switch, not a click on this page.
      if (cheAppForName(target) != null && target.split(' ').length <= 2) return null;
      return _clickText(target);
    }
    return null;
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
            children: [
              for (final t in _tabs)
                WebViewWidget(
                  key: ObjectKey(t),
                  controller: t.controller,
                  // Hand every touch straight to the page so iOS tells scrolls
                  // and taps apart itself (prevents scrolling from "clicking").
                  gestureRecognizers: {
                    Factory<OneSequenceGestureRecognizer>(() => EagerGestureRecognizer()),
                  },
                ),
            ],
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
