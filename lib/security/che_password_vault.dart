// CHE's on-device password vault.
//
// The owner asked CHE to keep his passwords for him. They live only in the
// iPhone Keychain (flutter_secure_storage): never sent to the CHE Worker,
// never sent to any AI provider, never written to chat history, memory or
// logs. CHE fills them into web-app sign-in pages inside her own browser.

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class CheVaultEntry {
  const CheVaultEntry({required this.site, required this.password, this.username = ''});
  final String site; // normalized name, e.g. "gmail" or "netflix.com"
  final String username;
  final String password;

  Map<String, String> toJson() => {'site': site, 'username': username, 'password': password};

  static CheVaultEntry? fromJson(Object? j) {
    if (j is! Map) return null;
    final site = '${j['site'] ?? ''}';
    final password = '${j['password'] ?? ''}';
    if (site.isEmpty || password.isEmpty) return null;
    return CheVaultEntry(site: site, password: password, username: '${j['username'] ?? ''}');
  }
}

/// Parsed vault voice/typed command.
class CheVaultCommand {
  const CheVaultCommand(this.kind, {this.site = '', this.password = '', this.username = ''});
  final String kind; // save, read, delete, list, import
  final String site;
  final String password;
  final String username;

  /// Understands: "save my Gmail password hunter2 username me@x.com",
  /// "what's my Netflix password", "delete my Gmail password",
  /// "what passwords do you have". Uses the original text so the
  /// password keeps its capitalization.
  static CheVaultCommand? parse(String raw) {
    final text = raw.trim().replaceFirst(RegExp(r'^(?:chay|chey|che)[,\s]+', caseSensitive: false), '').replaceAll(RegExp(r'[?]+$'), '');
    final save = RegExp(
      r'^(?:save|store|remember|keep)\s+(?:my\s+)?(.+?)\s+password\s+(?:as\s+|is\s+|:\s*)?(\S+)(?:\s+(?:and\s+)?(?:my\s+)?(?:username|user name|email|login)\s+(?:is\s+|as\s+)?(\S+))?\.?$',
      caseSensitive: false,
    ).firstMatch(text);
    if (save != null) {
      return CheVaultCommand('save', site: normalizeSite(save.group(1)!), password: save.group(2)!, username: save.group(3) ?? '');
    }
    if (RegExp(r'^(?:what|which)\s+passwords\s+(?:do you have|are saved|did you save)|^(?:list|show)\s+(?:my\s+)?(?:saved\s+)?passwords$|^(?:my\s+)?passwords$', caseSensitive: false).hasMatch(text)) {
      return const CheVaultCommand('list');
    }
    final read = RegExp(
      r"^(?:what(?:'s|\s+is)|read|show|tell\s+me|give\s+me)\s+(?:me\s+)?(?:my\s+)?(.+?)\s+(?:password|login)$",
      caseSensitive: false,
    ).firstMatch(text);
    if (read != null) return CheVaultCommand('read', site: normalizeSite(read.group(1)!));
    if (RegExp(r'^(?:import|load|bring in|add)\s+(?:all\s+)?(?:my\s+)?(?:saved\s+|iphone\s+|apple\s+)?passwords', caseSensitive: false).hasMatch(text)) {
      return const CheVaultCommand('import');
    }
    final delete = RegExp(r'^(?:delete|remove|forget)\s+(?:my\s+)?(.+?)\s+password$', caseSensitive: false).firstMatch(text);
    if (delete != null) return CheVaultCommand('delete', site: normalizeSite(delete.group(1)!));
    return null;
  }

  static String normalizeSite(String value) =>
      value.toLowerCase().replaceAll(RegExp(r'^(?:the|my)\s+'), '').replaceFirst(RegExp(r'^(?:https?://)?(?:www\.)?'), '').trim();
}

class CheVault {
  CheVault._();
  static final CheVault instance = CheVault._();

  static const _key = 'che_password_vault_v1';
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  Future<List<CheVaultEntry>> _all() async {
    try {
      final raw = await _storage.read(key: _key);
      final decoded = jsonDecode(raw ?? '[]');
      return [for (final e in (decoded as List)) ?CheVaultEntry.fromJson(e)];
    } catch (_) {
      return [];
    }
  }

  Future<void> _write(List<CheVaultEntry> entries) =>
      _storage.write(key: _key, value: jsonEncode([for (final e in entries) e.toJson()]));

  Future<void> save(CheVaultEntry entry) async {
    final all = await _all();
    all.removeWhere((e) => e.site == entry.site);
    all.insert(0, entry);
    await _write(all);
  }

  Future<bool> delete(String site) async {
    final all = await _all();
    final before = all.length;
    all.removeWhere((e) => e.site == site);
    await _write(all);
    return all.length != before;
  }

  /// Imports a password CSV (Apple Passwords / Safari export format:
  /// Title,URL,Username,Password,… — also Chrome's name,url,username,password).
  /// Returns how many logins were saved.
  Future<int> importCsv(String csv) async {
    final rows = parseCsv(csv);
    if (rows.length < 2) return 0;
    final header = [for (final h in rows.first) h.trim().toLowerCase()];
    int col(List<String> names) => header.indexWhere(names.contains);
    final title = col(['title', 'name']);
    final url = col(['url', 'website', 'login_uri']);
    final user = col(['username', 'login', 'email', 'login_username']);
    final pass = col(['password', 'login_password']);
    if (pass < 0 || (url < 0 && title < 0)) return 0;
    final all = await _all();
    var count = 0;
    for (final row in rows.skip(1)) {
      String at(int i) => i >= 0 && i < row.length ? row[i].trim() : '';
      final password = at(pass);
      if (password.isEmpty) continue;
      final host = Uri.tryParse(at(url))?.host ?? '';
      final site = CheVaultCommand.normalizeSite(host.isNotEmpty ? host : at(title));
      if (site.isEmpty) continue;
      all.removeWhere((e) => e.site == site);
      all.add(CheVaultEntry(site: site, password: password, username: at(user)));
      count += 1;
    }
    await _write(all);
    return count;
  }

  /// Minimal RFC 4180 CSV parser (quoted fields, "" escapes, CRLF).
  static List<List<String>> parseCsv(String input) {
    final rows = <List<String>>[];
    var row = <String>[];
    final field = StringBuffer();
    var quoted = false;
    for (var i = 0; i < input.length; i++) {
      final c = input[i];
      if (quoted) {
        if (c == '"') {
          if (i + 1 < input.length && input[i + 1] == '"') {
            field.write('"');
            i++;
          } else {
            quoted = false;
          }
        } else {
          field.write(c);
        }
      } else if (c == '"') {
        quoted = true;
      } else if (c == ',') {
        row.add(field.toString());
        field.clear();
      } else if (c == '\n' || c == '\r') {
        if (c == '\r' && i + 1 < input.length && input[i + 1] == '\n') i++;
        row.add(field.toString());
        field.clear();
        if (row.any((f) => f.isNotEmpty)) rows.add(row);
        row = <String>[];
      } else {
        field.write(c);
      }
    }
    row.add(field.toString());
    if (row.any((f) => f.isNotEmpty)) rows.add(row);
    return rows;
  }

  Future<List<String>> sites() async => [for (final e in await _all()) e.site];

  /// Finds an entry by spoken name ("gmail") or by page host
  /// ("accounts.google.com" matches a "google" or "gmail" entry).
  Future<CheVaultEntry?> find(String nameOrHost) async {
    final all = await _all();
    final q = CheVaultCommand.normalizeSite(nameOrHost);
    for (final e in all) {
      if (e.site == q) return e;
    }
    for (final e in all) {
      if (siteMatches(q, e.site)) return e;
    }
    // Common sign-in hosts for spoken names.
    const aliases = {
      'gmail': ['google.com'],
      'google': ['google.com'],
      'youtube': ['google.com', 'youtube.com'],
      'outlook': ['live.com', 'microsoft.com', 'microsoftonline.com'],
      'hotmail': ['live.com', 'microsoft.com'],
      'instagram': ['instagram.com'],
      'facebook': ['facebook.com'],
      'messenger': ['facebook.com', 'messenger.com'],
      'x': ['x.com', 'twitter.com'],
      'twitter': ['x.com', 'twitter.com'],
    };
    for (final e in all) {
      final hosts = aliases[e.site] ?? const <String>[];
      if (hosts.any((h) => q == h || q.endsWith('.$h'))) return e;
    }
    return null;
  }

  static const _genericLabels = {
    'www', 'com', 'net', 'org', 'io', 'co', 'app', 'uk', 'us', 'login', 'signin', 'accounts', 'account', 'auth', 'my', 'm', 'mobile',
  };

  static Set<String> _labels(String value) => value
      .toLowerCase()
      .split(RegExp(r'[.\s/:_-]+'))
      .where((l) => l.isNotEmpty && !_genericLabels.contains(l))
      .toSet();

  /// Whole-label match between a spoken name or page host and a saved site:
  /// "accounts.google.com" matches "google", "netflix" matches "netflix.com",
  /// but "x" never matches "netflix.com" (no substring matching).
  static bool siteMatches(String query, String site) {
    final q = _labels(query);
    final e = _labels(site);
    if (q.isEmpty || e.isEmpty) return false;
    return e.every(q.contains) || q.every(e.contains);
  }
}
