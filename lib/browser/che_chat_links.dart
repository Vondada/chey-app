// Finds the real web destinations in a CHE reply ("go to Supabase and create
// an account") and turns each into a short, safe action: "Open Supabase".
// Pure Dart: detection, labels, URL safety and the spoken link commands.
// The chat shows these as buttons that open inside CHE's own browser
// (CheEmbeddedAppScreen), so the owner never copies or pastes a URL.

/// One destination CHE gave the owner in a reply.
class CheChatLink {
  const CheChatLink({required this.url, required this.name, required this.host, this.externalReason});

  /// The exact, validated address that opens.
  final String url;

  /// Human name: "Supabase", "GitHub PR #161", "Supabase documentation".
  final String name;

  /// Host without "www.", shown and read under the action.
  final String host;

  /// Why this one opens outside CHE (App Store, Google sign-in, a file),
  /// or null when it opens inside CHE.
  final String? externalReason;

  /// The action's text: "Open Supabase".
  String get label => 'Open $name';

  bool get opensExternally => externalReason != null;
}

const int _maxUrlLength = 2048;
const int _maxLinks = 4;

/// Returns the address when it is a genuine http/https destination that is
/// safe to open, or null. Blocks other schemes (javascript:, data:, file:,
/// intent:), embedded credentials (https://bank.com@evil.example), control
/// characters, injection characters, local hosts and placeholders.
Uri? cheSafeLinkUri(String raw) {
  final url = raw.trim();
  if (url.isEmpty || url.length > _maxUrlLength) return null;
  if (RegExp(r'[\s\x00-\x1f\x7f<>"`\\{}|^]').hasMatch(url)) return null;
  if (RegExp(r'%(?:00|0a|0d)', caseSensitive: false).hasMatch(url)) return null;
  if (!RegExp(r'^https?://', caseSensitive: false).hasMatch(url)) return null;
  final uri = Uri.tryParse(url);
  if (uri == null) return null;
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'https' && scheme != 'http') return null;
  if (uri.userInfo.isNotEmpty) return null;
  final host = uri.host.toLowerCase();
  if (!RegExp(r'^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$').hasMatch(host)) return null;
  if (host == 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (RegExp(r'(?:^|\.)example\.(?:com|org|net)$').hasMatch(host)) return null;
  return uri;
}

String _trimTrailing(String url) {
  var out = url;
  while (out.isNotEmpty) {
    final last = out[out.length - 1];
    if ('.,;:!?\'"*_'.contains(last)) {
      out = out.substring(0, out.length - 1);
    } else if (last == ')' && '('.allMatches(out).length < ')'.allMatches(out).length) {
      out = out.substring(0, out.length - 1);
    } else if (last == ']' && '['.allMatches(out).length < ']'.allMatches(out).length) {
      out = out.substring(0, out.length - 1);
    } else {
      break;
    }
  }
  return out;
}

final RegExp _markdownLink = RegExp(r'\[([^\]\n]{1,80})\]\((https?://[^\s)]+)\)', caseSensitive: false);
final RegExp _bareLink = RegExp(r'https?://[^\s<>"`]+', caseSensitive: false);
final RegExp _codeFence = RegExp(r'```[\s\S]*?(?:```|$)');
final RegExp _imageFile = RegExp(r'\.(?:png|jpe?g|gif|webp|svg)$', caseSensitive: false);

/// The destinations in [text], in order, deduplicated, at most four.
/// Code blocks, images and anything in [skip] (already shown as a preview)
/// are left out so ordinary conversation is not cluttered.
List<CheChatLink> cheChatLinks(String text, {Iterable<String?> skip = const [], String? ownBase}) {
  final source = text.replaceAll(_codeFence, ' ');
  final skipped = {for (final s in skip) if (s != null && s.isNotEmpty) _key(s)};
  final found = <({int at, String url, String? title})>[];
  final covered = <(int, int)>[];
  for (final m in _markdownLink.allMatches(source)) {
    found.add((at: m.start, url: _trimTrailing(m.group(2)!), title: m.group(1)!.trim()));
    covered.add((m.start, m.end));
  }
  for (final m in _bareLink.allMatches(source)) {
    if (covered.any((c) => m.start >= c.$1 && m.start < c.$2)) continue;
    found.add((at: m.start, url: _trimTrailing(m.group(0)!), title: null));
  }
  found.sort((a, b) => a.at.compareTo(b.at));

  final seen = <String>{};
  final links = <CheChatLink>[];
  for (final f in found) {
    final uri = cheSafeLinkUri(f.url);
    if (uri == null) continue;
    final key = _key(uri.toString());
    if (skipped.contains(key) || !seen.add(key)) continue;
    if (_imageFile.hasMatch(uri.path)) continue;
    links.add(CheChatLink(
      url: uri.toString(),
      name: _nameFor(uri, f.title, ownBase),
      host: _bareHost(uri.host),
      externalReason: cheLinkExternalReason(uri),
    ));
    if (links.length == _maxLinks) break;
  }
  return _distinctNames(links);
}

String _key(String url) => url.trim().replaceAll(RegExp(r'/+$'), '').toLowerCase();

String _bareHost(String host) => host.toLowerCase().replaceFirst(RegExp(r'^www\.'), '');

// Two actions never share a name: "Open GitHub" twice becomes 1 and 2.
List<CheChatLink> _distinctNames(List<CheChatLink> links) {
  final counts = <String, int>{};
  for (final l in links) {
    counts[l.name] = (counts[l.name] ?? 0) + 1;
  }
  final used = <String, int>{};
  return [
    for (final l in links)
      if ((counts[l.name] ?? 0) < 2)
        l
      else
        CheChatLink(
          url: l.url,
          name: '${l.name} ${used[l.name] = (used[l.name] ?? 0) + 1}',
          host: l.host,
          externalReason: l.externalReason,
        ),
  ];
}

const Map<String, String> _brands = {
  'supabase.com': 'Supabase',
  'supabase.co': 'Supabase',
  'github.com': 'GitHub',
  'cloudflare.com': 'Cloudflare',
  'groq.com': 'Groq',
  'aistudio.google.com': 'Google AI Studio',
  'cerebras.ai': 'Cerebras',
  'mistral.ai': 'Mistral',
  'openrouter.ai': 'OpenRouter',
  'sambanova.ai': 'SambaNova',
  'huggingface.co': 'Hugging Face',
  'openai.com': 'OpenAI',
  'x.ai': 'xAI',
  'shorebird.dev': 'Shorebird',
  'vercel.com': 'Vercel',
  'stripe.com': 'Stripe',
  'twilio.com': 'Twilio',
  'elevenlabs.io': 'ElevenLabs',
  'picovoice.ai': 'Picovoice',
  'apple.com': 'Apple',
  'google.com': 'Google',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'wikipedia.org': 'Wikipedia',
  'flutter.dev': 'Flutter',
  'pub.dev': 'pub.dev',
  'npmjs.com': 'npm',
  'stackoverflow.com': 'Stack Overflow',
};

String _brand(String host) {
  final h = _bareHost(host);
  for (final e in _brands.entries) {
    if (h == e.key || h.endsWith('.${e.key}')) return e.value;
  }
  final parts = h.split('.');
  // co.uk / com.au style endings take one more label.
  final i = parts.length >= 3 && parts[parts.length - 2].length <= 3 && parts.last.length == 2 ? parts.length - 3 : parts.length - 2;
  final word = parts[i < 0 ? 0 : i];
  return word.isEmpty ? h : '${word[0].toUpperCase()}${word.substring(1)}';
}

String _nameFor(Uri uri, String? title, String? ownBase) {
  final derived = _derivedName(uri, ownBase);
  // Link text is only trusted when it names the real destination, so
  // "[Supabase](https://evil.site)" is announced as "Evil", never "Supabase".
  final cleanTitle = title?.replaceFirst(RegExp(r'^open\s+', caseSensitive: false), '').trim() ?? '';
  if (cleanTitle.isEmpty || cleanTitle.contains('://')) return derived;
  String squash(String v) => v.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '');
  final site = squash(_brand(uri.host));
  final hostWord = squash(_bareHost(uri.host).split('.').first);
  final said = squash(cleanTitle);
  final matches = (site.length >= 2 && said.contains(site)) || (hostWord.length >= 3 && said.contains(hostWord));
  return matches ? cleanTitle : derived;
}

String _derivedName(Uri uri, String? ownBase) {
  final path = uri.path.toLowerCase();
  final own = ownBase == null ? null : Uri.tryParse(ownBase);
  if (own != null && own.host.isNotEmpty && own.host.toLowerCase() == uri.host.toLowerCase()) {
    if (path.startsWith('/site/')) return 'the website CHE built';
    if (path == '/app' || path.startsWith('/app/')) return 'CHE web app';
    return 'CHE';
  }
  final host = _bareHost(uri.host);
  final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (host == 'github.com' && segments.length >= 2) {
    final repo = segments[1];
    if (segments.length >= 4 && segments[2] == 'pull') return 'GitHub PR #${segments[3]}';
    if (segments.length >= 4 && segments[2] == 'issues') return 'GitHub issue #${segments[3]}';
    if (segments.length >= 3 && segments[2] == 'actions') return 'GitHub Actions for $repo';
    if (segments.length >= 5 && (segments[2] == 'blob' || segments[2] == 'tree')) return '${segments.last} on GitHub';
    return '$repo on GitHub';
  }
  final brand = _brand(uri.host);
  final where = '$host$path';
  if (RegExp(r'(?:^|[./-])(?:docs?|documentation|guides?|reference|api-reference)(?:[./-]|$)').hasMatch(where)) {
    return '$brand documentation';
  }
  if (RegExp(r'(?:sign-?up|register|join|create-account|new-account)').hasMatch(path)) return '$brand sign-up';
  if (RegExp(r'(?:^|/)(?:login|log-in|sign-?in)(?:/|$)').hasMatch(path)) return '$brand sign-in';
  if (RegExp(r'(?:^|[./])(?:dashboard|console)(?:[./]|$)').hasMatch(where)) return '$brand dashboard';
  if (RegExp(r'(?:^|/)(?:keys|api-keys|tokens|settings/tokens)(?:/|$)').hasMatch(path)) return '$brand keys page';
  return brand;
}

const List<String> _fileTypes = ['.pdf', '.zip', '.dmg', '.pkg', '.ipa', '.apk', '.mp3', '.mov', '.csv', '.xlsx', '.docx', '.pptx'];

/// Why a destination must open outside CHE, or null when it can open inside.
/// Only where the in-app browser cannot work safely: App Store and TestFlight
/// pages belong to their own apps, Google refuses sign-in inside embedded
/// browsers, and files go to the phone's viewer.
String? cheLinkExternalReason(Uri uri) {
  final host = _bareHost(uri.host);
  if (host == 'apps.apple.com' || host == 'itunes.apple.com' || host == 'testflight.apple.com') {
    return 'it opens in the App Store app';
  }
  if (host == 'accounts.google.com') return 'Google does not allow sign-in inside other apps';
  if (_fileTypes.any(uri.path.toLowerCase().endsWith)) return 'it is a file for your phone to open';
  return null;
}

/// What a spoken or typed link command asks for.
enum CheLinkVoiceAction { open, openExternally, readAddress, copyAddress, chooseFromList }

class CheLinkVoiceCommand {
  const CheLinkVoiceCommand(this.action, this.links);
  final CheLinkVoiceAction action;

  /// The chosen link, or every candidate for [CheLinkVoiceAction.chooseFromList].
  final List<CheChatLink> links;

  CheChatLink get link => links.first;

  static const _ordinals = {
    'one': 1, 'first': 1, '1st': 1, 'two': 2, 'second': 2, '2nd': 2,
    'three': 3, 'third': 3, '3rd': 3, 'four': 4, 'fourth': 4, '4th': 4,
  };

  static final RegExp _generic = RegExp(r'^(?:it|that|this|the|that one|this one|(?:the|that|this) (?:link|page|site|website|address|url|one))$');
  static final RegExp _external = RegExp(
      r'\s+(?:in|with|on|using)\s+(?:safari|chrome|the browser|my browser|the real browser|another app|outside(?: of)? che)$|\s+(?:externally|outside(?: of)? che)$');

  /// Parses commands about the links CHE just gave, such as "open Supabase",
  /// "open it", "open link 2", "open the second link in Safari", "what's the
  /// link", "copy the link". Returns null when the words are not about one of
  /// [links], so other commands ("open YouTube") keep working.
  static CheLinkVoiceCommand? parse(String words, List<CheChatLink> links) {
    if (links.isEmpty) return null;
    var t = words.toLowerCase().trim().replaceAll(RegExp(r'[.!?]+$'), '').trim();
    t = t.replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chey|chay|shay)[,:]?\s+'), '').replaceFirst(RegExp(r'^(?:please|can you|could you)\s+'), '').trim();
    if (t.length > 90) return null;

    final read = RegExp(r"^(?:what(?:'s| is) (?:the|that) (?:link|url|address)|(?:read|say|tell|show|give)(?: me)? (?:the|that) (?:raw )?(?:link|url|address))(?: (?:for|of|to) (.+))?$").firstMatch(t);
    if (read != null) return _pick(CheLinkVoiceAction.readAddress, read.group(1), links, generic: true);
    final copy = RegExp(r'^copy (?:the|that) (?:link|url|address)(?: (?:for|of|to) (.+))?$').firstMatch(t);
    if (copy != null) return _pick(CheLinkVoiceAction.copyAddress, copy.group(1), links, generic: true);

    final open = RegExp(r'^(?:open|open up|go to|visit|take me to|pull up|launch|show me)\s+(.+)$').firstMatch(t);
    if (open == null) return null;
    var target = open.group(1)!.trim();
    var action = CheLinkVoiceAction.open;
    final ext = _external.firstMatch(target);
    if (ext != null) {
      action = CheLinkVoiceAction.openExternally;
      target = target.substring(0, ext.start).trim();
    }
    return _pick(action, target, links, generic: false);
  }

  static CheLinkVoiceCommand? _pick(CheLinkVoiceAction action, String? rawTarget, List<CheChatLink> links, {required bool generic}) {
    final target = (rawTarget ?? '').trim().replaceFirst(RegExp(r'^the\s+(?=\w+\s+(?:link|page|site|website)$)'), '');
    if (target.isEmpty || _generic.hasMatch(target)) {
      if (links.length == 1) return CheLinkVoiceCommand(action, [links.first]);
      return generic || target.isNotEmpty ? CheLinkVoiceCommand(CheLinkVoiceAction.chooseFromList, links) : null;
    }
    final number = RegExp(r'^(?:link|number|option)\s+(\w+)$|^(?:the\s+)?(\w+)\s+(?:link|one)$').firstMatch(target);
    if (number != null) {
      final w = number.group(1) ?? number.group(2)!;
      final n = int.tryParse(w) ?? _ordinals[w];
      if (n != null) return n >= 1 && n <= links.length ? CheLinkVoiceCommand(action, [links[n - 1]]) : null;
    }
    final want = target.replaceFirst(RegExp(r'\s+(?:link|page|site|website)$'), '').replaceAll(RegExp(r'[^a-z0-9#]+'), '');
    if (want.length < 3) return null;
    for (final l in links) {
      final name = l.name.toLowerCase().replaceAll(RegExp(r'[^a-z0-9#]+'), '');
      final host = l.host.replaceAll(RegExp(r'[^a-z0-9]+'), '');
      if (name == want || name.startsWith(want) || host.startsWith(want) || (want.length >= 5 && name.contains(want))) {
        return CheLinkVoiceCommand(action, [l]);
      }
    }
    return null;
  }

  /// The numbered list CHE reads aloud when "open the link" could mean more
  /// than one.
  static String listAloud(List<CheChatLink> links) => [
        'I gave you ${links.length} links:',
        for (var i = 0; i < links.length; i++) '${i + 1}. ${links[i].label}',
        'Say "open link" and the number.',
      ].join('\n');
}
