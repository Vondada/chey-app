// CHE Privacy Center: the opt-in privacy inventory, kept on the owner's iPhone (owner, 2026-10-25; spec stage 5
// of docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md, built as documented in docs/CHE_PRIVACY_CENTER.md). Separate from
// GPU and compute features.
//
// Rules this file enforces in code:
// - Off until the owner says "turn on Privacy Center"; the consent is stored with its time and his exact words.
//   Everything that keeps data (the inventory, broker actions, the password check) refuses while it is off.
// - "Turn off Privacy Center" deletes its data only after the owner says yes.
// - The inventory lists only services the owner connected in CHE (names from the Worker's records) or added by
//   voice. Names only: no account, token, password or secret is read or kept.
// - The password breach check runs here, on the phone, on request: each password in the on-device vault is
//   hashed with SHA-1 and only the first five hex characters go to Have I Been Pwned's free range API
//   (k-anonymity). The password, the full hash and the suffix never leave the phone; the result keeps the site
//   name and a count only.
// - People-search removals open each site's official opt-out page for the owner to fill in. CHE never submits a
//   form and never says data was erased unless the owner says the site confirmed it.
// - Everything is stored in the iPhone Keychain (flutter_secure_storage), never sent to the Worker, a model,
//   chat history, memory or logs.
import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'che_password_vault.dart';

// ─── Sources ─────────────────────────────────────────────────────────────
/// An official page CHE can open for the owner. [verified] is false when the address came only from
/// third-party guides in the October 2026 research and was not confirmed on the site itself.
class ChePrivacyLink {
  const ChePrivacyLink({required this.id, required this.name, required this.url, required this.purpose, this.verified = true, this.note = ''});
  final String id, name, url, purpose, note;
  final bool verified;
  String get verification => verified ? 'official page' : 'address from third-party guides, not confirmed on the site';
}

/// Credit freeze, identity theft and SSN protection: official sites only. The owner enters his details there.
const cheOfficialPrivacyLinks = <ChePrivacyLink>[
  ChePrivacyLink(id: 'equifax', name: 'Equifax security freeze', url: 'https://www.equifax.com/personal/credit-report-services/', purpose: 'Freeze, lift or remove a freeze on your Equifax credit file. Free.'),
  ChePrivacyLink(id: 'experian', name: 'Experian credit freeze', url: 'https://www.experian.com/help/credit-freeze/', purpose: 'Freeze or unfreeze your Experian credit file. Free.'),
  ChePrivacyLink(id: 'transunion', name: 'TransUnion credit freeze', url: 'https://www.transunion.com/credit-freeze', purpose: 'Freeze or unfreeze your TransUnion credit file. Free.'),
  ChePrivacyLink(id: 'cfpb', name: 'CFPB: what a credit freeze is', url: 'https://www.consumerfinance.gov/ask-cfpb/what-is-a-credit-freeze-or-security-freeze-on-my-credit-report-en-1341/', purpose: 'The government explanation: freezes are free by federal law and must be placed at each bureau separately.'),
  ChePrivacyLink(id: 'identitytheft', name: 'IdentityTheft.gov', url: 'https://www.identitytheft.gov/', purpose: 'The FTC\'s site to report identity theft and get a recovery plan.'),
  ChePrivacyLink(id: 'annualcreditreport', name: 'AnnualCreditReport.com', url: 'https://www.annualcreditreport.com/', purpose: 'Free weekly credit reports from all three bureaus, the official site.'),
  ChePrivacyLink(id: 'ssa', name: 'my Social Security', url: 'https://www.ssa.gov/myaccount/', purpose: 'Your own Social Security account: check your earnings record for anything you do not recognize.'),
  ChePrivacyLink(id: 'irs_ippin', name: 'IRS Identity Protection PIN', url: 'https://www.irs.gov/identity-theft-fraud-scams/get-an-identity-protection-pin', purpose: 'A yearly PIN that stops anyone else filing a tax return with your SSN.'),
  ChePrivacyLink(id: 'hibp', name: 'Have I Been Pwned email search', url: 'https://haveibeenpwned.com/', purpose: 'Search your own email address yourself on their site, free. CHE cannot do it for you: their email API needs a paid key.'),
];

/// Major people-search sites and their opt-out procedures (research of October 25, 2026; see
/// docs/CHE_PRIVACY_CENTER.md for each source). Each one removes data only from that site.
const cheDataBrokers = <ChePrivacyLink>[
  ChePrivacyLink(id: 'ca_drop', name: 'California DROP (all registered brokers)', url: 'https://privacy.ca.gov/drop/', purpose: 'California residents: one free state request to every registered data broker.', note: 'California residents only; verified through the state identity gateway.'),
  ChePrivacyLink(id: 'spokeo', name: 'Spokeo', url: 'https://www.spokeo.com/optout', purpose: 'Paste your listing\'s address and confirm by email.'),
  ChePrivacyLink(id: 'peoplefinders', name: 'PeopleFinders', url: 'https://www.peoplefinders.com/remove-my-info', purpose: 'Online opt-out form; they do not take requests by email.'),
  ChePrivacyLink(id: 'whitepages', name: 'Whitepages', url: 'https://www.whitepages.com/suppression-requests', purpose: 'Paste your listing\'s address; they verify by phone call.', verified: false),
  ChePrivacyLink(id: 'beenverified', name: 'BeenVerified', url: 'https://www.beenverified.com/app/optout/search', purpose: 'Find your record and confirm by email.', verified: false),
  ChePrivacyLink(id: 'peopleconnect', name: 'Intelius, TruthFinder, Instant Checkmate, US Search', url: 'https://suppression.peopleconnect.us/', purpose: 'One PeopleConnect suppression center for these sites; email verification.', verified: false),
  ChePrivacyLink(id: 'truepeoplesearch', name: 'TruePeopleSearch', url: 'https://www.truepeoplesearch.com/removal', purpose: 'Two-step removal confirmed by email.', verified: false),
  ChePrivacyLink(id: 'fastpeoplesearch', name: 'FastPeopleSearch', url: 'https://www.fastpeoplesearch.com/removal', purpose: 'Removal page; guides disagree on its address.', verified: false, note: 'Some guides give /optout instead.'),
];

// ─── State ───────────────────────────────────────────────────────────────
const chePrivacyActions = {'monitor': 'Monitor', 'request_removal': 'Request removal', 'ignore': 'Ignore', 'resolved': 'Mark resolved'};

class ChePrivacyItemAction {
  const ChePrivacyItemAction(this.action, this.at);
  final String action, at;
  Map<String, String> toJson() => {'action': action, 'at': at};
  String get label => chePrivacyActions[action] ?? action;
}

class ChePrivacyService {
  const ChePrivacyService({required this.name, required this.source, this.addedAt = ''});
  final String name, source, addedAt;
  Map<String, String> toJson() => {'name': name, 'source': source, 'added_at': addedAt};
  static ChePrivacyService? fromJson(Object? j) {
    if (j is! Map) return null;
    final name = '${j['name'] ?? ''}'.trim();
    return name.isEmpty ? null : ChePrivacyService(name: name, source: '${j['source'] ?? ''}', addedAt: '${j['added_at'] ?? ''}');
  }
}

/// One site's breach-check result: the site name and how often its password appears. Never the password.
class ChePasswordFinding {
  const ChePasswordFinding({required this.site, required this.count, this.error = ''});
  final String site, error;
  final int count;
  bool get exposed => count > 0;
  Map<String, Object> toJson() => {'site': site, 'count': count, if (error.isNotEmpty) 'error': error};
  static ChePasswordFinding fromJson(Map j) => ChePasswordFinding(site: '${j['site'] ?? ''}', count: (j['count'] as num?)?.toInt() ?? 0, error: '${j['error'] ?? ''}');
}

class ChePrivacyState {
  ChePrivacyState({this.consentAt = '', this.consentWords = '', List<ChePrivacyService>? added, Map<String, List<ChePrivacyItemAction>>? actions, this.passwordCheckAt = '', List<ChePasswordFinding>? passwordFindings})
      : added = added ?? [],
        actions = actions ?? {},
        passwordFindings = passwordFindings ?? [];
  String consentAt, consentWords, passwordCheckAt;
  final List<ChePrivacyService> added;
  final Map<String, List<ChePrivacyItemAction>> actions;
  final List<ChePasswordFinding> passwordFindings;

  bool get on => consentAt.isNotEmpty;
  ChePrivacyItemAction? latest(String id) => (actions[id] ?? const []).isEmpty ? null : actions[id]!.last;

  Map<String, Object> toJson() => {
        'consent': {'at': consentAt, 'words': consentWords},
        'added': [for (final s in added) s.toJson()],
        'actions': {for (final e in actions.entries) e.key: [for (final a in e.value) a.toJson()]},
        'password_check': {'at': passwordCheckAt, 'findings': [for (final f in passwordFindings) f.toJson()]},
      };

  static ChePrivacyState fromJson(Object? raw) {
    if (raw is! Map) return ChePrivacyState();
    final consent = raw['consent'] is Map ? raw['consent'] as Map : const {};
    final check = raw['password_check'] is Map ? raw['password_check'] as Map : const {};
    final acts = raw['actions'] is Map ? raw['actions'] as Map : const {};
    return ChePrivacyState(
      consentAt: '${consent['at'] ?? ''}',
      consentWords: '${consent['words'] ?? ''}',
      added: [for (final s in (raw['added'] as List? ?? const [])) ?ChePrivacyService.fromJson(s)],
      actions: {
        for (final e in acts.entries)
          '${e.key}': [for (final a in (e.value as List? ?? const [])) if (a is Map) ChePrivacyItemAction('${a['action']}', '${a['at']}')],
      },
      passwordCheckAt: '${check['at'] ?? ''}',
      passwordFindings: [for (final f in (check['findings'] as List? ?? const [])) if (f is Map) ChePasswordFinding.fromJson(f)],
    );
  }
}

/// Where the Privacy Center keeps its state. The app uses the Keychain; tests use [ChePrivacyMemoryStore].
abstract class ChePrivacyStore {
  Future<String?> read();
  Future<void> write(String value);
  Future<void> delete();
}

class ChePrivacyKeychainStore implements ChePrivacyStore {
  static const _key = 'che_privacy_center_v1';
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  @override
  Future<String?> read() => _storage.read(key: _key);
  @override
  Future<void> write(String value) => _storage.write(key: _key, value: value);
  @override
  Future<void> delete() => _storage.delete(key: _key);
}

class ChePrivacyMemoryStore implements ChePrivacyStore {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String v) async => value = v;
  @override
  Future<void> delete() async => value = null;
}

// ─── Have I Been Pwned: Pwned Passwords range API (free, k-anonymity) ────
/// Checks passwords on the phone. Only the first five hex characters of each SHA-1 go out; the match is made here.
class CheBreachChecker {
  CheBreachChecker({http.Client? client}) : _client = client ?? http.Client();
  final http.Client _client;
  static const endpoint = 'https://api.pwnedpasswords.com/range/';

  static String sha1Hex(String password) => sha1.convert(utf8.encode(password)).toString().toUpperCase();

  /// How often [password] appears in Have I Been Pwned's breach corpus (0 = not found).
  Future<int> count(String password) async {
    final hash = sha1Hex(password);
    final prefix = hash.substring(0, 5);
    final suffix = hash.substring(5);
    final r = await _client
        .get(Uri.parse('$endpoint$prefix'), headers: {'Add-Padding': 'true', 'User-Agent': 'CHE-iPhone-Privacy-Center'})
        .timeout(const Duration(seconds: 20));
    if (r.statusCode != 200) throw Exception('Have I Been Pwned answered ${r.statusCode}');
    for (final line in const LineSplitter().convert(r.body)) {
      final parts = line.trim().split(':');
      // Padding rows have a count of 0 and never match a real password.
      if (parts.length == 2 && parts[0].toUpperCase() == suffix) return int.tryParse(parts[1]) ?? 0;
    }
    return 0;
  }

  /// One finding per vault entry: site and count, or the error. Passwords are read here and dropped.
  Future<List<ChePasswordFinding>> checkAll(List<CheVaultEntry> entries) async {
    final out = <ChePasswordFinding>[];
    for (final e in entries) {
      try {
        out.add(ChePasswordFinding(site: e.site, count: await count(e.password)));
      } on TimeoutException {
        out.add(ChePasswordFinding(site: e.site, count: 0, error: 'no answer within 20 seconds'));
      } catch (error) {
        out.add(ChePasswordFinding(site: e.site, count: 0, error: '$error'.replaceFirst('Exception: ', '')));
      }
    }
    return out;
  }
}

// ─── Voice ───────────────────────────────────────────────────────────────
enum ChePrivacyOp { open, turnOn, turnOff, yes, no, passwords, brokers, credit, email, services, addService, action, openLink, read }

class ChePrivacyCommand {
  const ChePrivacyCommand(this.op, {this.number = 0, this.action = '', this.name = '', this.words = ''});
  final ChePrivacyOp op;
  final int number;
  final String action, name, words;
}

const _numberWords = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'for': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5};
int _num(String w) => int.tryParse(w) ?? _numberWords[w] ?? 0;
const _n = r'(\d{1,2}|one|two|three|four|for|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth)';
const _center = r"(?:the |my |che's )?privacy (?:center|centre)";

String _clean(String raw) => raw
    .trim()
    .toLowerCase()
    .replaceAll('’', "'")
    .replaceFirst(RegExp(r"^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chay|chey|shay)(?![a-z'])[\s,.:;!?-]*"), '')
    .replaceFirst(RegExp(r'^(?:please|can you|could you)\s+'), '')
    .replaceFirst(RegExp(r'^/privacy-center\b\s*'), '/pc ')
    .replaceAll(RegExp(r'[.!?]+$'), '')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

/// Parses the owner's Privacy Center words. [inRoom] (the room is on screen, or CHE asked a yes/no question)
/// enables the numbered actions, yes and no, and "add X". The same phrases as the Worker's privacyIntent.
ChePrivacyCommand? cheParsePrivacyVoice(String raw, {bool inRoom = false, bool awaitingYes = false}) {
  var t = _clean(raw);
  if (t.isEmpty || t.length > 200) return null;
  if (t.startsWith('/pc')) {
    final rest = t.substring(3).trim();
    t = rest.isEmpty ? 'open privacy center' : (RegExp(r'^(?:turn|switch) (?:on|off)$|^enable$|^disable$').hasMatch(rest) ? '$rest privacy center' : rest);
  }
  if (RegExp('^(?:turn on|switch on|enable|start|activate) $_center\$').hasMatch(t)) return ChePrivacyCommand(ChePrivacyOp.turnOn, words: raw.trim());
  if (RegExp('^(?:turn off|switch off|disable|stop|deactivate) $_center\$').hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.turnOff);
  if (RegExp('^(?:open|show(?: me)?|go to|take me to|bring up) $_center(?: (?:page|screen|room))?\$|^$_center\$').hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.open);
  if (RegExp(r'^(?:check|scan) (?:my |all my |the )?(?:saved |vault )?passwords? (?:for (?:breaches|leaks)|against (?:breaches|have i been pwned))$|^(?:have|were|are) (?:any of )?my passwords? (?:been )?(?:leaked|breached|pwned|exposed)$').hasMatch(t)) {
    return const ChePrivacyCommand(ChePrivacyOp.passwords);
  }
  if (RegExp(r'^(?:show|list|read|check)(?: me)? (?:the )?(?:data brokers?|people[- ]search sites?)$|^remove me from (?:data brokers?|people[- ]search sites?)$').hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.brokers);
  if (RegExp(r'^(?:freeze my credit|(?:how do i |help me )?(?:freeze|lock) my credit|credit (?:freeze|monitoring))$').hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.credit);
  if (RegExp(r'^(?:has|was|is) my email (?:been )?(?:in a |part of a )?(?:breach|breached|leaked|pwned)$').hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.email);
  if (awaitingYes) {
    if (RegExp(r'^(?:yes|yeah|yep|confirm|do it|delete it|yes delete(?: it)?)$').hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.yes);
    if (RegExp(r"^(?:no|nope|cancel|keep it|don't|do not)$").hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.no);
  }
  if (!inRoom) return null;
  if (RegExp(r'^(?:read (?:this|it|aloud|the privacy center)|read it aloud)$').hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.read);
  if (RegExp(r'^(?:list|show|read)(?: me)? (?:my )?(?:services|accounts|inventory)$').hasMatch(t)) return const ChePrivacyCommand(ChePrivacyOp.services);
  final add = RegExp(r'^(?:add|track|list) (.{2,60}?) (?:to|in|on) (?:my |the )?(?:privacy (?:list|inventory|center)|inventory)$').firstMatch(t);
  if (add != null) return ChePrivacyCommand(ChePrivacyOp.addService, name: _titleCase(add.group(1)!));
  final act = RegExp('^(monitor|ignore|request removal(?: for)?|remove|resolve) (?:number |item )?$_n\$').firstMatch(t);
  if (act != null) {
    final verb = act.group(1)!;
    final action = verb == 'monitor'
        ? 'monitor'
        : verb == 'ignore'
            ? 'ignore'
            : verb == 'resolve'
                ? 'resolved'
                : 'request_removal';
    return ChePrivacyCommand(ChePrivacyOp.action, number: _num(act.group(2)!), action: action);
  }
  final markResolved = RegExp('^mark (?:number |item )?$_n (?:as )?resolved\$').firstMatch(t);
  if (markResolved != null) return ChePrivacyCommand(ChePrivacyOp.action, number: _num(markResolved.group(1)!), action: 'resolved');
  final open = RegExp('^open (?:number |link )?$_n\$').firstMatch(t);
  if (open != null) return ChePrivacyCommand(ChePrivacyOp.openLink, number: _num(open.group(1)!));
  return null;
}

String _titleCase(String s) => s.split(' ').map((w) => w.isEmpty ? w : '${w[0].toUpperCase()}${w.substring(1)}').join(' ');

// ─── The controller: one per app, shared by the room and chat ───────────
/// Runs every Privacy Center action and returns the words CHE says about its real result.
class ChePrivacyCenter {
  ChePrivacyCenter({
    ChePrivacyStore? store,
    CheBreachChecker? checker,
    Future<List<CheVaultEntry>> Function()? vaultEntries,
    Future<List<ChePrivacyService>> Function()? connectedServices,
    Future<bool> Function(Uri)? openLink,
    DateTime Function()? now,
  })  : _store = store ?? ChePrivacyKeychainStore(),
        _checker = checker ?? CheBreachChecker(),
        _vaultEntries = vaultEntries ?? _defaultVaultEntries,
        _connected = connectedServices ?? (() async => const <ChePrivacyService>[]),
        _openLink = openLink ?? ((_) async => false),
        _now = now ?? DateTime.now;

  final ChePrivacyStore _store;
  final CheBreachChecker _checker;
  final Future<List<CheVaultEntry>> Function() _vaultEntries;
  final Future<List<ChePrivacyService>> Function() _connected;
  final Future<bool> Function(Uri) _openLink;
  final DateTime Function() _now;

  ChePrivacyState state = ChePrivacyState();
  List<ChePrivacyService> connected = const [];
  bool loaded = false;
  bool awaitingTurnOff = false;
  bool checking = false;

  /// Which numbered list "number 3" refers to: the one CHE read or showed last.
  String lastList = 'brokers';

  /// Bumped after every change so the room repaints.
  final changes = StreamController<void>.broadcast();

  static Future<List<CheVaultEntry>> _defaultVaultEntries() async {
    final out = <CheVaultEntry>[];
    for (final site in await CheVault.instance.sites()) {
      final e = await CheVault.instance.find(site);
      if (e != null) out.add(e);
    }
    return out;
  }

  String _stamp() => _now().toUtc().toIso8601String();

  Future<void> load() async {
    try {
      state = ChePrivacyState.fromJson(jsonDecode(await _store.read() ?? '{}'));
    } catch (_) {
      state = ChePrivacyState();
    }
    loaded = true;
    if (state.on) await refreshConnected();
    changes.add(null);
  }

  Future<void> refreshConnected() async {
    try {
      connected = await _connected();
    } catch (_) {
      connected = const [];
    }
    changes.add(null);
  }

  Future<void> _save() async {
    await _store.write(jsonEncode(state.toJson()));
    changes.add(null);
  }

  Future<void> _ensureLoaded() async {
    if (!loaded) await load();
  }

  /// Every service in the inventory: connected in CHE first, then the ones the owner added by voice.
  List<ChePrivacyService> get inventory {
    final seen = <String>{};
    return [
      for (final s in [...connected, ...state.added])
        if (seen.add(s.name.toLowerCase())) s,
    ];
  }

  static const _offReply = 'The Privacy Center is off, so I keep nothing for it. Say "turn on Privacy Center" to start it; the official credit freeze links work while it is off.';

  Future<String> turnOn(String words) async {
    await _ensureLoaded();
    if (state.on) return 'The Privacy Center is already on, since ${state.consentAt}. Nothing changed.';
    state.consentAt = _stamp();
    state.consentWords = words.trim().isEmpty ? 'turn on Privacy Center' : words.trim();
    await _save();
    await refreshConnected();
    return 'The Privacy Center is on. I recorded your consent at ${state.consentAt} with your words "${state.consentWords}". '
        'I list ${inventory.length} service${inventory.length == 1 ? '' : 's'} you connected in CHE, by name only. Everything stays on this iPhone.';
  }

  Future<String> requestTurnOff() async {
    await _ensureLoaded();
    if (!state.on) return 'The Privacy Center is already off. Nothing changed.';
    awaitingTurnOff = true;
    final acted = state.actions.values.fold<int>(0, (n, list) => n + list.length);
    changes.add(null);
    return 'Turning off deletes the Privacy Center\'s data on this iPhone: your consent record, ${state.added.length} service${state.added.length == 1 ? '' : 's'} you added, '
        '$acted recorded action${acted == 1 ? '' : 's'} and the last password check. Your vault passwords are not touched. Say yes to delete it, or no to keep it.';
  }

  Future<String> confirmTurnOff(bool yes) async {
    if (!awaitingTurnOff) return 'There is nothing waiting for your yes. Nothing changed.';
    awaitingTurnOff = false;
    if (!yes) {
      changes.add(null);
      return 'Kept. The Privacy Center stays on and nothing was deleted.';
    }
    await _store.delete();
    final left = await _store.read();
    state = ChePrivacyState();
    connected = const [];
    changes.add(null);
    return left == null
        ? 'The Privacy Center is off and its data on this iPhone is deleted. I checked: nothing is left.'
        : 'I tried to delete the Privacy Center data, but some is still stored. Please try again.';
  }

  Future<String> addService(String name) async {
    await _ensureLoaded();
    if (!state.on) return _offReply;
    final clean = name.trim();
    if (clean.isEmpty) return 'Say the service\'s name, for example "add Chase to my privacy list". Nothing changed.';
    if (inventory.any((s) => s.name.toLowerCase() == clean.toLowerCase())) return '$clean is already on your privacy list. Nothing changed.';
    state.added.add(ChePrivacyService(name: clean, source: 'Added by you', addedAt: _stamp()));
    await _save();
    lastList = 'services';
    return 'Added $clean to your privacy list, by name only. It is number ${inventory.length}.';
  }

  /// MONITOR / REQUEST REMOVAL / IGNORE / MARK RESOLVED for a broker or a service, stored with its time.
  Future<String> act(String id, String name, String action, {ChePrivacyLink? link}) async {
    await _ensureLoaded();
    if (!state.on) return _offReply;
    if (!chePrivacyActions.containsKey(action)) return 'I do not know that action. Nothing changed.';
    final stamp = _stamp();
    (state.actions[id] ??= []).add(ChePrivacyItemAction(action, stamp));
    await _save();
    if (action == 'request_removal') {
      if (link == null) {
        return 'Recorded: you want $name to remove your data, at $stamp. CHE has no official removal page for it, so contact $name directly. I will not call it removed until you tell me $name confirmed.';
      }
      final opened = await _openLink(Uri.parse(link.url));
      return opened
          ? 'I opened ${link.name}\'s opt-out page${link.verified ? '' : ', an address from third-party guides that I could not confirm on the site'}. You fill it in there; I did not submit anything. '
              'Recorded at $stamp. I will not call it removed until you tell me ${link.name} confirmed.'
          : 'Recorded your removal request at $stamp, but the page did not open. The address is ${link.url}. Nothing was submitted.';
    }
    if (action == 'resolved') return 'Marked $name resolved at $stamp, on your word.';
    return '${chePrivacyActions[action]}: $name, recorded at $stamp.';
  }

  /// The free k-anonymity check of every password in the on-device vault, run here on the phone.
  Future<String> checkPasswords() async {
    await _ensureLoaded();
    if (!state.on) return _offReply;
    if (checking) return 'The password check is already running.';
    checking = true;
    changes.add(null);
    try {
      final entries = await _vaultEntries();
      if (entries.isEmpty) return 'Your on-device vault has no passwords, so there was nothing to check.';
      final findings = await _checker.checkAll(entries);
      state
        ..passwordCheckAt = _stamp()
        ..passwordFindings.clear()
        ..passwordFindings.addAll(findings);
      await _save();
      return cheSpeakPasswordFindings(findings);
    } finally {
      checking = false;
      changes.add(null);
    }
  }

  Future<String> openLink(ChePrivacyLink link) async {
    final opened = await _openLink(Uri.parse(link.url));
    return opened
        ? 'I opened ${link.name}. You enter your details there yourself; CHE sees nothing you type on that page.'
        : 'The page did not open. The address is ${link.url}.';
  }

  String speakBrokers() {
    lastList = 'brokers';
    final rows = [
      for (final (i, b) in cheDataBrokers.indexed)
        '${i + 1}. ${b.name}${b.verified ? '' : ', address unconfirmed'}${state.latest(b.id) == null ? '' : ', ${state.latest(b.id)!.label.toLowerCase()} since ${state.latest(b.id)!.at}'}',
    ];
    return 'People-search sites with official opt-out pages: ${rows.join('; ')}. Say "request removal for number 2" to open that site\'s page, or monitor, ignore or mark resolved.';
  }

  String speakLinks() {
    lastList = 'links';
    final links = cheOfficialPrivacyLinks;
    return 'Official links: ${[for (final (i, l) in links.indexed) '${i + 1}. ${l.name}'].join('; ')}. Say "open number 1" and I open it; you enter your details on that site.';
  }

  String speakServices() {
    lastList = 'services';
    final items = inventory;
    if (items.isEmpty) return 'No services are on your privacy list yet. Say "add Chase to my privacy list" to add one by name.';
    return 'Your privacy list: ${[for (final (i, s) in items.indexed) '${i + 1}. ${s.name}, ${s.source.toLowerCase()}${state.latest('service:${s.name.toLowerCase()}') == null ? '' : ', ${state.latest('service:${s.name.toLowerCase()}')!.label.toLowerCase()}'}'].join('; ')}.';
  }

  /// The whole screen as speech, for Read Aloud.
  String speakAll() {
    if (!state.on) return 'Privacy Center. It is off: nothing is kept. Say "turn on Privacy Center" to start it. ${speakLinks()}';
    final check = state.passwordCheckAt.isEmpty ? 'No password check yet.' : 'Last password check ${state.passwordCheckAt}: ${cheSpeakPasswordFindings(state.passwordFindings)}';
    return 'Privacy Center, on since ${state.consentAt}. ${speakServices()} $check ${speakBrokers()} ${speakLinks()}';
  }

  /// Runs one parsed voice command and returns what CHE says.
  Future<String> handle(ChePrivacyCommand c) async {
    await _ensureLoaded();
    switch (c.op) {
      case ChePrivacyOp.open:
        return state.on ? 'Privacy Center, on since ${state.consentAt}. ${inventory.length} services listed. Say "read this" to hear it all.' : _offReply;
      case ChePrivacyOp.turnOn:
        return turnOn(c.words);
      case ChePrivacyOp.turnOff:
        return requestTurnOff();
      case ChePrivacyOp.yes:
        return confirmTurnOff(true);
      case ChePrivacyOp.no:
        return confirmTurnOff(false);
      case ChePrivacyOp.passwords:
        return checkPasswords();
      case ChePrivacyOp.brokers:
        return state.on ? speakBrokers() : _offReply;
      case ChePrivacyOp.credit:
        return 'A credit freeze is free and must be placed at each bureau. ${speakLinks()}';
      case ChePrivacyOp.email:
        return 'Checking an email automatically needs Have I Been Pwned\'s paid API key, so CHE does not do it. You can search your email yourself on haveibeenpwned.com for free: say "open number ${cheOfficialPrivacyLinks.indexWhere((l) => l.id == 'hibp') + 1}" after I read the links. ${speakLinks()}';
      case ChePrivacyOp.services:
        return state.on ? speakServices() : _offReply;
      case ChePrivacyOp.addService:
        return addService(c.name);
      case ChePrivacyOp.read:
        return speakAll();
      case ChePrivacyOp.openLink:
        final list = lastList == 'brokers' ? cheDataBrokers : cheOfficialPrivacyLinks;
        if (lastList == 'services' || c.number < 1 || c.number > list.length) return 'There is no number ${c.number} in that list. Nothing was opened.';
        return openLink(list[c.number - 1]);
      case ChePrivacyOp.action:
        if (!state.on) return _offReply;
        if (lastList == 'services') {
          final items = inventory;
          if (c.number < 1 || c.number > items.length) return 'There is no service number ${c.number}. Nothing changed.';
          final s = items[c.number - 1];
          return act('service:${s.name.toLowerCase()}', s.name, c.action);
        }
        if (c.number < 1 || c.number > cheDataBrokers.length) return 'There is no site number ${c.number}. Nothing changed.';
        final b = cheDataBrokers[c.number - 1];
        return act(b.id, b.name, c.action, link: b);
    }
  }
}

/// What CHE says about a password check: site names and counts only.
String cheSpeakPasswordFindings(List<ChePasswordFinding> findings) {
  if (findings.isEmpty) return 'No passwords were checked.';
  final exposed = findings.where((f) => f.exposed).toList();
  final failed = findings.where((f) => f.error.isNotEmpty).toList();
  final clean = findings.length - exposed.length - failed.length;
  final parts = <String>[
    'I checked ${findings.length} password${findings.length == 1 ? '' : 's'} on this iPhone; only the first five characters of each fingerprint went to Have I Been Pwned.',
    if (exposed.isNotEmpty) 'Found in breaches: ${[for (final f in exposed) '${f.site}, seen ${f.count} times'].join('; ')}. Change those passwords.',
    if (clean > 0) '$clean not found in any known breach.',
    if (failed.isNotEmpty) 'Could not check ${[for (final f in failed) f.site].join(', ')}: ${failed.first.error}.',
  ];
  return parts.join(' ');
}
