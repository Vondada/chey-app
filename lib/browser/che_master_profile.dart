// CHE master profile: the owner's approved Personal and CHE Office (business)
// profiles, stored only on this iPhone in the Keychain (via CheSecureKv).
//
// Privacy boundary (owner rule, AGENTS.md): profile values, remembered form
// answers and passwords never go to the CHE Worker, any AI provider, chat
// history, memory or logs. Field matching is deterministic and runs on the
// phone (assets/browser/che_form_fill.js). Spoken/recorded replies name
// fields, never values; the owner's own screen may show masked values.

import 'dart:convert';

import '../security/che_redact.dart';
import '../security/che_session_store.dart' show CheSecureKv, CheKeychainKv;

/// Which profile a value belongs to.
enum CheProfileKind { personal, office }

extension CheProfileKindName on CheProfileKind {
  String get spoken => this == CheProfileKind.personal ? 'Personal' : 'CHE Office';
}

/// The profile fields CHE understands, keyed by the engine's canonical keys
/// (WHATWG autocomplete field names plus x-ein).
const Map<String, String> cheProfileFieldLabels = {
  'given-name': 'First name',
  'additional-name': 'Middle name',
  'family-name': 'Last name',
  'email': 'Email',
  'tel': 'Phone',
  'organization': 'Company name',
  'organization-title': 'Job title',
  'street-address': 'Street address',
  'address-line2': 'Apartment or suite',
  'address-level2': 'City',
  'address-level1': 'State',
  'postal-code': 'ZIP code',
  'country': 'Country',
  'bday': 'Date of birth',
  'sex': 'Gender',
  'url': 'Website',
  'x-ein': 'EIN (tax ID)',
};

/// Fields that only make sense on the business profile.
const Set<String> cheOfficeOnlyFields = {'organization', 'x-ein', 'organization-title'};

/// Identity fields a business form may take from the Personal profile when
/// CHE Office has none (the owner is the business's contact person).
const Set<String> chePersonFallbackFields = {'given-name', 'additional-name', 'family-name', 'bday'};

/// Spoken names → canonical key, for "set my business phone to ...".
const Map<String, String> _spokenField = {
  'first name': 'given-name', 'given name': 'given-name',
  'middle name': 'additional-name', 'middle initial': 'additional-name',
  'last name': 'family-name', 'surname': 'family-name', 'family name': 'family-name',
  'email': 'email', 'email address': 'email', 'e-mail': 'email',
  'phone': 'tel', 'phone number': 'tel', 'cell': 'tel', 'cell phone': 'tel', 'mobile': 'tel', 'mobile number': 'tel', 'number': 'tel',
  'company': 'organization', 'company name': 'organization', 'business name': 'organization', 'name of the business': 'organization', 'legal name': 'organization',
  'job title': 'organization-title', 'title': 'organization-title', 'position': 'organization-title',
  'address': 'street-address', 'street address': 'street-address', 'street': 'street-address', 'mailing address': 'street-address',
  'apartment': 'address-line2', 'apt': 'address-line2', 'suite': 'address-line2', 'unit': 'address-line2', 'address line 2': 'address-line2',
  'city': 'address-level2', 'town': 'address-level2',
  'state': 'address-level1', 'province': 'address-level1',
  'zip': 'postal-code', 'zip code': 'postal-code', 'postal code': 'postal-code', 'postcode': 'postal-code',
  'country': 'country',
  'birthday': 'bday', 'date of birth': 'bday', 'birth date': 'bday', 'dob': 'bday',
  'gender': 'sex', 'sex': 'sex',
  'website': 'url', 'web site': 'url', 'site': 'url', 'url': 'url',
  'ein': 'x-ein', 'e i n': 'x-ein', 'tax id': 'x-ein', 'tax i d': 'x-ein', 'employer identification number': 'x-ein', 'federal tax id': 'x-ein',
};

/// One approved value.
class CheProfileValue {
  const CheProfileValue(this.value, {this.approved = false, this.at});
  final String value;
  final bool approved;
  final DateTime? at;
  Map<String, Object?> toJson() => {'v': value, 'ok': approved, 'at': at?.toIso8601String()};
  static CheProfileValue? fromJson(Object? j) {
    if (j is! Map || '${j['v'] ?? ''}'.isEmpty) return null;
    return CheProfileValue('${j['v']}', approved: j['ok'] == true, at: DateTime.tryParse('${j['at']}'));
  }
}

/// The two profiles, as stored.
class CheProfiles {
  CheProfiles({Map<String, CheProfileValue>? personal, Map<String, CheProfileValue>? office})
      : personal = personal ?? {},
        office = office ?? {};
  final Map<String, CheProfileValue> personal;
  final Map<String, CheProfileValue> office;

  Map<String, CheProfileValue> of(CheProfileKind k) => k == CheProfileKind.personal ? personal : office;

  /// Only APPROVED values are ever used to fill a form.
  String? approved(CheProfileKind k, String key) {
    final v = of(k)[key];
    return v != null && v.approved && v.value.trim().isNotEmpty ? v.value.trim() : null;
  }

  int approvedCount(CheProfileKind k) => of(k).values.where((v) => v.approved).length;

  String emailDomain(CheProfileKind k) {
    final e = approved(k, 'email') ?? '';
    final at = e.indexOf('@');
    return at > 0 ? e.substring(at + 1).toLowerCase() : '';
  }
}

/// On-device store: profiles, remembered answers per site/form, and the
/// profile chosen per site. Everything lives in the Keychain.
class CheMasterProfileStore {
  CheMasterProfileStore({CheSecureKv? kv}) : _kv = kv ?? const CheKeychainKv();
  static CheMasterProfileStore instance = CheMasterProfileStore();

  static const profilesKey = 'che_master_profiles_v1';
  static const answersKey = 'che_form_answers_v1';
  static const choiceKey = 'che_profile_site_choice_v1';

  final CheSecureKv _kv;

  Future<Map<String, dynamic>> _readMap(String key) async {
    try {
      final raw = await _kv.read(key);
      final d = jsonDecode(raw ?? '{}');
      return d is Map<String, dynamic> ? d : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  Future<CheProfiles> load() async {
    final m = await _readMap(profilesKey);
    Map<String, CheProfileValue> side(Object? j) => {
          if (j is Map)
            for (final e in j.entries)
              '${e.key}': ?CheProfileValue.fromJson(e.value),
        };
    return CheProfiles(personal: side(m['personal']), office: side(m['office']));
  }

  Future<void> _save(CheProfiles p) => _kv.write(
        profilesKey,
        jsonEncode({
          'personal': {for (final e in p.personal.entries) e.key: e.value.toJson()},
          'office': {for (final e in p.office.entries) e.key: e.value.toJson()},
        }),
      );

  /// Sets (and approves, when [approved]) one field.
  Future<void> setField(CheProfileKind kind, String key, String value, {bool approved = true}) async {
    final p = await load();
    p.of(kind)[key] = CheProfileValue(value.trim(), approved: approved, at: DateTime.now());
    await _save(p);
  }

  Future<void> approve(CheProfileKind kind, String key, bool approved) async {
    final p = await load();
    final v = p.of(kind)[key];
    if (v == null) return;
    p.of(kind)[key] = CheProfileValue(v.value, approved: approved, at: DateTime.now());
    await _save(p);
  }

  Future<bool> clearField(CheProfileKind kind, String key) async {
    final p = await load();
    final had = p.of(kind).remove(key) != null;
    await _save(p);
    return had;
  }

  // Remembered answers: host → form label (normalized) → value.
  static String labelKey(String label) => label.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), ' ').trim();

  Future<Map<String, String>> answersFor(String host) async {
    final m = await _readMap(answersKey);
    final site = m[host];
    return site is Map ? {for (final e in site.entries) '${e.key}': '${e.value}'} : <String, String>{};
  }

  Future<void> rememberAnswers(String host, Map<String, String> byLabel) async {
    if (host.isEmpty || byLabel.isEmpty) return;
    final m = await _readMap(answersKey);
    final site = Map<String, dynamic>.from(m[host] is Map ? m[host] as Map : const {});
    for (final e in byLabel.entries) {
      if (e.value.trim().isEmpty) continue;
      site[labelKey(e.key)] = e.value.trim();
    }
    m[host] = site;
    await _kv.write(answersKey, jsonEncode(m));
  }

  Future<CheProfileKind?> choiceFor(String host) async {
    final m = await _readMap(choiceKey);
    return switch (m[host]) { 'personal' => CheProfileKind.personal, 'office' => CheProfileKind.office, _ => null };
  }

  Future<void> rememberChoice(String host, CheProfileKind kind) async {
    if (host.isEmpty) return;
    final m = await _readMap(choiceKey);
    m[host] = kind.name;
    await _kv.write(choiceKey, jsonEncode(m));
  }
}

/// A parsed profile voice/typed command. Handled entirely on the phone.
class CheProfileCommand {
  const CheProfileCommand(this.kind, {this.profile, this.field = '', this.value = ''});
  final String kind; // set, clear, show, open, use
  final CheProfileKind? profile;
  final String field; // canonical key
  final String value;

  static final _lead = RegExp(r'^(?:hey\s+)?(?:chay|chey|che)[,\s]+', caseSensitive: false);

  static CheProfileKind? _which(String? word) {
    if (word == null) return null;
    final w = word.toLowerCase();
    if (RegExp(r'business|office|work|company').hasMatch(w)) return CheProfileKind.office;
    if (RegExp(r'personal|home|own').hasMatch(w)) return CheProfileKind.personal;
    return null;
  }

  /// Understands:
  ///  "set my business phone to 602 555 0199", "update my personal email to ...",
  ///  "change my CHE Office EIN to 12-3456789", "clear my business website",
  ///  "what's in my business profile", "open my master profile",
  ///  "use my master profile", "fill this with my business profile",
  ///  "fill everything with my personal profile", "/master-profile".
  static CheProfileCommand? parse(String raw) {
    var text = raw.trim().replaceFirst(_lead, '').replaceAll(RegExp(r'[.!?]+$'), '').trim();
    final lower = text.toLowerCase();
    if (lower.isEmpty) return null;
    const qual = r'(business|che office|office|work|company|personal|home)';

    // Use / fill.
    final slash = RegExp(r'^/master-profile\b\s*(.*)$', caseSensitive: false).firstMatch(text);
    if (slash != null) {
      final rest = slash.group(1)!.toLowerCase();
      return CheProfileCommand('use', profile: _which(rest), value: RegExp(r'everything|all|whole|entire').hasMatch(rest) ? 'all' : '');
    }
    final use = RegExp(
      '^(?:please\\s+)?(?:use|apply)\\s+(?:my\\s+)?(?:$qual\\s+)?(?:master\\s+)?profile(?:\\s+(?:to fill|on|for)\\s+(?:this|the)(?:\\s+(?:form|page))?)?(?:\\s+(?:for|on)\\s+everything)?\$',
    ).firstMatch(lower);
    final fill = RegExp(
      '^(?:please\\s+)?fill\\s+(?:in\\s+|out\\s+)?(?:this|the|everything|it|all|the whole|this whole|the entire)?(?:\\s+(?:form|page|thing))?(?:\\s+(?:in|out))?\\s+(?:with|from|using)\\s+my\\s+(?:$qual\\s+)?(?:master\\s+)?(?:profile|details|info|information)\$',
    ).firstMatch(lower);
    if (use != null || fill != null) {
      final q = (use ?? fill)!.group(1);
      final all = RegExp(r'\b(everything|all|whole|entire)\b').hasMatch(lower);
      return CheProfileCommand('use', profile: _which(q), value: all ? 'all' : '');
    }
    if (RegExp(r'^(?:open|show|edit)\s+(?:my\s+)?(?:master\s+)?profiles?(?:\s+editor)?$').hasMatch(lower) ||
        RegExp(r'^(?:open|show|edit)\s+my\s+master\s+profile').hasMatch(lower)) {
      return const CheProfileCommand('open');
    }
    final show = RegExp("^(?:what(?:'s| is) in|read|read me|show me)\\s+my\\s+$qual?\\s*(?:master\\s+)?profile\$").firstMatch(lower);
    if (show != null) return CheProfileCommand('show', profile: _which(show.group(1)) ?? CheProfileKind.personal);

    // Set: verb + "my" + optional qualifier + field + to/as/is + value (keep the owner's capitalization).
    final set = RegExp(
      '^(?:set|save|update|change|make|put)\\s+my\\s+(?:$qual\\s+)?(?:profile\\s+)?(.+?)\\s+(?:to|as|is|=)\\s+(.+)\$',
      caseSensitive: false,
    ).firstMatch(text);
    if (set != null) {
      final key = _spokenField[set.group(2)!.toLowerCase().trim()];
      if (key == null) return null;
      var profile = _which(set.group(1));
      profile ??= cheOfficeOnlyFields.contains(key) ? CheProfileKind.office : CheProfileKind.personal;
      return CheProfileCommand('set', profile: profile, field: key, value: set.group(3)!.trim());
    }
    final clear = RegExp('^(?:clear|delete|remove|forget)\\s+my\\s+(?:$qual\\s+)?(?:profile\\s+)?(.+?)\$').firstMatch(lower);
    if (clear != null) {
      final key = _spokenField[clear.group(2)!.trim()];
      if (key == null) return null;
      var profile = _which(clear.group(1));
      profile ??= cheOfficeOnlyFields.contains(key) ? CheProfileKind.office : CheProfileKind.personal;
      return CheProfileCommand('clear', profile: profile, field: key);
    }
    return null;
  }
}

/// True for a turn that carries or asks about profile values; live voice
/// drops such a turn from the Realtime session (see security.dart).
bool cheIsProfileTurn(String text) {
  final c = CheProfileCommand.parse(text);
  return c != null && (c.kind == 'set' || c.kind == 'show');
}

/// Normalizes an owner-supplied value for a field, or returns null with
/// [error] filled when it cannot be understood (CHE never guesses).
String? cheNormalizeProfileValue(String key, String value, {List<String>? error}) {
  final v = value.trim();
  if (v.isEmpty) return null;
  switch (key) {
    case 'bday':
      final iso = cheParseDate(v);
      if (iso == null) error?.add('I couldn\'t understand that date. Say it like "May 14 1990" or "1990-05-14".');
      return iso;
    case 'email':
      final e = v.replaceAll(RegExp(r'\s+at\s+', caseSensitive: false), '@').replaceAll(RegExp(r'\s+dot\s+', caseSensitive: false), '.').replaceAll(' ', '');
      if (!RegExp(r'^[^@\s]+@[^@\s]+\.[a-z]{2,}$', caseSensitive: false).hasMatch(e)) {
        error?.add('That doesn\'t sound like a full email address. Say it like "name at example dot com".');
        return null;
      }
      return e.toLowerCase();
    case 'tel':
      final digits = v.replaceAll(RegExp(r'[^\d+]'), '');
      if (digits.replaceAll('+', '').length < 7) {
        error?.add('That phone number is too short. Say all the digits.');
        return null;
      }
      return v;
    case 'x-ein':
      final d = v.replaceAll(RegExp(r'\D'), '');
      if (d.length != 9) {
        error?.add('An EIN has 9 digits. Say all nine.');
        return null;
      }
      return '${d.substring(0, 2)}-${d.substring(2)}';
    default:
      return v;
  }
}

const _monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/// "1990-05-14", "05/14/1990" (US order), "May 14 1990", "14 May 1990" → "1990-05-14".
String? cheParseDate(String raw) {
  final s = raw.trim().toLowerCase().replaceAll(',', ' ').replaceAllMapped(RegExp(r'(\d)(st|nd|rd|th)\b'), (m) => m[1]!).replaceAll(RegExp(r'\s+'), ' ').trim();
  String? iso(int y, int m, int d) {
    if (y < 1900 || y > DateTime.now().year || m < 1 || m > 12 || d < 1 || d > 31) return null;
    final dt = DateTime(y, m, d);
    if (dt.month != m) return null;
    return '${y.toString().padLeft(4, '0')}-${m.toString().padLeft(2, '0')}-${d.toString().padLeft(2, '0')}';
  }

  var m = RegExp(r'^(\d{4})-(\d{1,2})-(\d{1,2})$').firstMatch(s);
  if (m != null) return iso(int.parse(m[1]!), int.parse(m[2]!), int.parse(m[3]!));
  m = RegExp(r'^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$').firstMatch(s);
  if (m != null) return iso(int.parse(m[3]!), int.parse(m[1]!), int.parse(m[2]!));
  int? month(String w) {
    final i = _monthNames.indexWhere((n) => n == w || (w.length >= 3 && n.startsWith(w)));
    return i < 0 ? null : i + 1;
  }

  m = RegExp(r'^([a-z]+) (\d{1,2}) (\d{4})$').firstMatch(s);
  if (m != null && month(m[1]!) != null) return iso(int.parse(m[3]!), month(m[1]!)!, int.parse(m[2]!));
  m = RegExp(r'^(\d{1,2}) ([a-z]+) (\d{4})$').firstMatch(s);
  if (m != null && month(m[2]!) != null) return iso(int.parse(m[3]!), month(m[2]!)!, int.parse(m[1]!));
  return null;
}

/// The owner's on-screen view of a profile: labels with masked values.
String cheProfileMaskedSummary(CheProfiles p, CheProfileKind kind) {
  final rows = <String>[];
  for (final e in cheProfileFieldLabels.entries) {
    final v = p.of(kind)[e.key];
    if (v == null) continue;
    rows.add('${e.value}: ${cheMaskValue(v.value, kind: e.key)}${v.approved ? '' : ' (not approved yet)'}');
  }
  return rows.isEmpty ? 'Your ${kind.spoken} profile is empty.' : rows.join('\n');
}
