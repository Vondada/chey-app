// TradeSea inside CHE's web view (issue #342): the owner's chart and active account load in the
// native TradeSea app but not reliably here. Two differences from Safari are known in code:
//   - With no handler, iOS's web view answers every confirm() with "Cancel" and drops every
//     alert(), silently. CHE's browser now shows TradeSea's own questions to the owner.
//   - A window TradeSea opens (window.open, target=_blank) replaces the page in the same view and
//     the opener gets nothing back, so a sign-in or chart window that needs its own window fails.
// The rest is unproven, so the owner can ask for a check: it reads page structure and site names
// only (never his login, account numbers, addresses with their paths, or page text), and its
// findings are said as a numbered list. Not verified on an iPhone yet.

/// True only for TradeSea's own hosts (tradesea.ai and its subdomains).
bool cheIsTradeSeaHost(String url) {
  final host = Uri.tryParse(url)?.host.toLowerCase() ?? '';
  return host == 'tradesea.ai' || host.endsWith('.tradesea.ai');
}

/// The site a web address or host belongs to, and nothing else: no path, query, port, user or
/// subdomain, so a check can never carry an account number or a token.
String cheSafeSite(String value) {
  final raw = value.trim().toLowerCase();
  if (raw.isEmpty) return 'unknown';
  if (raw == 'inline' || raw == 'blank') return raw;
  final uri = Uri.tryParse(raw);
  var host = uri != null && uri.host.isNotEmpty ? uri.host : raw.split(RegExp(r'[/?#]')).first;
  host = host.split('@').last.split(':').first;
  if (!RegExp(r'^[a-z0-9.-]+$').hasMatch(host) || !host.contains('.')) return 'unknown';
  if (RegExp(r'^\d+(\.\d+){3}$').hasMatch(host)) return 'a numeric address';
  final parts = host.split('.').where((p) => p.isNotEmpty).toList();
  return parts.length <= 2 ? parts.join('.') : parts.sublist(parts.length - 2).join('.');
}

/// Installed only when the owner asks for a check: counts, in the page's own memory, the windows
/// TradeSea tries to open, its live-data connections and how they close, its pop-up questions and
/// failed loads, by site name. Every call still reaches TradeSea's original code unchanged.
const String cheTradeSeaWatchJs = r'''
(function () {
  if (window.__cheTsWatch) return 'already';
  var w = window.__cheTsWatch = { opens: {}, blockedOpens: 0, sockets: {}, socketErrors: {}, socketCloses: {}, confirms: 0, alerts: 0, failedLoads: {} };
  function site(u) { try { return new URL(String(u), location.href).hostname.toLowerCase(); } catch (e) { return 'unknown'; } }
  function bump(m, k) { m[k] = (m[k] || 0) + 1; }
  var open = window.open;
  window.open = function (u) {
    bump(w.opens, u ? site(u) : 'blank');
    var r = open.apply(window, arguments);
    if (!r) w.blockedOpens++;
    return r;
  };
  if (window.WebSocket && window.Proxy && window.Reflect) {
    window.WebSocket = new Proxy(window.WebSocket, { construct: function (T, args, next) {
      var s = Reflect.construct(T, args, next), h = site(args[0]);
      bump(w.sockets, h);
      s.addEventListener('error', function () { bump(w.socketErrors, h); });
      s.addEventListener('close', function (e) { bump(w.socketCloses, h + ' ' + e.code); });
      return s;
    } });
  }
  var c = window.confirm, a = window.alert;
  window.confirm = function () { w.confirms++; return c.apply(window, arguments); };
  window.alert = function () { w.alerts++; return a.apply(window, arguments); };
  window.addEventListener('error', function (e) {
    var t = e.target, u = t && (t.src || t.href);
    if (u && typeof u === 'string') bump(w.failedLoads, site(u));
  }, true);
  return 'watching';
})()
''';

/// The page's shape for the check: chart drawing surfaces (also inside TradeSea's own frames),
/// frames by site, failed loads by site, whether storage works, and the watch counters.
const String cheTradeSeaProbeJs = r'''
(function () {
  function site(u) { try { return new URL(String(u), location.href).hostname.toLowerCase(); } catch (e) { return ''; } }
  var docs = [document], frames = [];
  [].slice.call(document.querySelectorAll('iframe')).forEach(function (f) {
    frames.push(f.src ? site(f.src) : 'inline');
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
  });
  var count = 0, best = [0, 0];
  docs.forEach(function (d) {
    [].slice.call(d.querySelectorAll('canvas')).forEach(function (c) {
      count++;
      var r = c.getBoundingClientRect();
      if (r.width * r.height > best[0] * best[1]) best = [Math.round(r.width), Math.round(r.height)];
    });
  });
  var failed = {};
  try {
    performance.getEntriesByType('resource').forEach(function (e) {
      if (e.responseStatus >= 400) { var h = site(e.name); failed[h] = (failed[h] || 0) + 1; }
    });
  } catch (e) {}
  var local = false;
  try { localStorage.setItem('__che_check', '1'); localStorage.removeItem('__che_check'); local = true; } catch (e) {}
  return JSON.stringify({ canvases: count, largestCanvas: best, frames: frames, failedResources: failed, cookies: navigator.cookieEnabled, localStorage: local, watch: window.__cheTsWatch || null });
})()
''';

int _count(Object? v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;

Map<String, int> _bySite(Object? v) {
  final out = <String, int>{};
  if (v is Map) {
    v.forEach((key, n) {
      final site = cheSafeSite('$key');
      out[site] = (out[site] ?? 0) + _count(n);
    });
  }
  return out;
}

String _list(Map<String, int> m) {
  final entries = m.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
  return entries.take(5).map((e) => '${e.key} (${e.value})').join(', ');
}

/// What a TradeSea check found, as plain sentences for the screen and for CHE's voice. [probe] is
/// [cheTradeSeaProbeJs]'s answer; [pageErrors] are the load failures CHE's web view saw, already
/// reduced to site names and codes.
List<String> cheTradeSeaFindings(Map<String, dynamic> probe, {List<String> pageErrors = const []}) {
  final out = <String>[];
  if (pageErrors.isNotEmpty) {
    out.add('CHE\'s web view reported ${pageErrors.length == 1 ? 'one page failure' : '${pageErrors.length} page failures'}: ${pageErrors.take(5).join('; ')}.');
  }
  final canvases = _count(probe['canvases']);
  final size = probe['largestCanvas'] is List && (probe['largestCanvas'] as List).length == 2
      ? (probe['largestCanvas'] as List).map(_count).toList()
      : const [0, 0];
  if (canvases == 0) {
    out.add('No chart drawing surface is on the page, so the chart has not started drawing.');
  } else if (size[0] * size[1] < 40000) {
    out.add('The chart surface is there but tiny, ${size[0]} by ${size[1]} points, so the chart area looks empty.');
  } else {
    out.add('A chart surface is drawn, ${size[0]} by ${size[1]} points.');
  }
  final frames = (probe['frames'] as List?)?.map((f) => cheSafeSite('$f')).toSet().toList() ?? const <String>[];
  if (frames.isNotEmpty) {
    out.add('The page has embedded frames from ${frames.join(', ')}. A frame from another site gets no shared sign-in storage in an iPhone web view.');
  }
  final failed = _bySite(probe['failedResources']);
  if (failed.isNotEmpty) out.add('Loads that failed: ${_list(failed)}.');
  if (probe['cookies'] == false || probe['localStorage'] == false) {
    out.add('This web view refused site storage (cookies ${probe['cookies'] == false ? 'off' : 'on'}, local storage ${probe['localStorage'] == false ? 'off' : 'on'}), so a sign-in may not stick.');
  }
  final watch = probe['watch'];
  if (watch is! Map) {
    out.add('I am now watching TradeSea\'s live connections and new windows. Open your account and the chart, then say "check TradeSea" again.');
    return out;
  }
  final opened = _bySite(watch['opens']);
  if (opened.isNotEmpty) {
    out.add('TradeSea tried to open new windows: ${_list(opened)}. CHE\'s web view opens those in the same page, so a sign-in or chart window that needs its own window cannot work here. Compare in the Safari view.');
  }
  final sockets = _bySite(watch['sockets']);
  final socketErrors = _bySite(watch['socketErrors']);
  final closes = <String, int>{};
  if (watch['socketCloses'] is Map) {
    (watch['socketCloses'] as Map).forEach((key, n) {
      final parts = '$key'.trim().split(' ');
      final code = parts.length > 1 ? int.tryParse(parts.last) : null;
      final label = '${cheSafeSite(parts.first)}${code == null ? '' : ' code $code'}';
      closes[label] = (closes[label] ?? 0) + _count(n);
    });
  }
  if (sockets.isEmpty) {
    out.add('No live-data connection opened since I started watching.');
  } else {
    out.add('Live-data connections opened: ${_list(sockets)}.${socketErrors.isEmpty ? '' : ' Failed: ${_list(socketErrors)}.'}${closes.isEmpty ? '' : ' Closed: ${_list(closes)}.'}');
  }
  final failedLoads = _bySite(watch['failedLoads']);
  if (failedLoads.isNotEmpty) out.add('Files that did not load since I started watching: ${_list(failedLoads)}.');
  final asked = _count(watch['confirms']) + _count(watch['alerts']);
  if (asked > 0) out.add('TradeSea showed $asked pop-up message${asked == 1 ? '' : 's'}; CHE shows them to you and reads them aloud.');
  return out;
}

/// The findings as CHE says them: numbered, with the two next steps the owner can say.
String cheTradeSeaSpoken(List<String> findings) {
  final numbered = [for (var i = 0; i < findings.length; i++) '${i + 1}, ${findings[i]}'].join(' ');
  return 'TradeSea check, sir: $numbered Say "retry TradeSea" to reload it, or "open TradeSea in Safari view" to compare. '
      'The check reads only page structure and site names, never your login, account numbers or page text.';
}

/// One load failure CHE's web view saw, reduced to its site and code.
String cheTradeSeaPageError({required String url, String? type, int? code, int? status}) {
  final site = cheSafeSite(url);
  if (type == 'webContentProcessTerminated') return 'iOS stopped the page\'s process on $site (often for memory), which leaves it blank until it reloads';
  if (status != null) return '$site answered HTTP $status';
  return '$site failed to load${type == null ? '' : ' ($type${code == null ? '' : ' $code'})'}';
}
