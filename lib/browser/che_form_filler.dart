// "CHE, use my master profile": fills the form on the page that is open in
// CHE's browser from the owner's approved profiles, remembered answers and
// the on-device password vault.
//
// Runs entirely on the iPhone. The page engine (assets/browser/che_form_fill.js)
// returns labels and statuses only; values flow one way, from this file into
// the page. Spoken replies name fields, never values. Filling and submitting
// are separate commands; a payment form also needs the money confirmation.

import 'dart:async';
import 'dart:convert';

import '../security/che_password_generator.dart';
import '../security/che_password_vault.dart';
import 'che_master_profile.dart';

/// The page CHE is filling (the real WebView in the app, a fake in tests).
abstract class CheFormPage {
  String get url;

  /// Runs JavaScript in the page and returns its string result.
  Future<String> eval(String js);
}

/// App-level hook: the browser that is open sets this, Chat calls it first
/// (before anything can reach the Worker) and speaks the reply unrecorded.
class CheFormFillVoice {
  CheFormFillVoice._();
  static Future<String?> Function(String words)? handler;
}

enum _Pending { none, profileChoice, captcha, verification, nextPage, submitConfirm }

class _FieldOutcome {
  _FieldOutcome(this.label, this.key, this.status, {this.value = '', this.required = false});
  final String label;
  final String key;
  String status; // filled, kept, no_answer, unsupported, refused, no_option, failed, password_vault, password_generated, password_missing, too_long
  final String value; // for the owner's masked on-screen detail only
  final bool required;
}

class CheFormFiller {
  CheFormFiller({
    required this.page,
    required this.engineSource,
    CheMasterProfileStore? store,
    Future<CheVaultEntry?> Function(String host)? findLogin,
    Future<void> Function(CheVaultEntry entry)? saveLogin,
    Future<bool> Function(String reason)? unlockVault,
    Future<void> Function(Duration)? wait,
  })  : store = store ?? CheMasterProfileStore.instance,
        _findLogin = findLogin ?? CheVault.instance.find,
        _saveLogin = saveLogin ?? CheVault.instance.save,
        _unlock = unlockVault,
        _wait = wait ?? ((d) => Future<void>.delayed(d));

  final CheFormPage page;
  final Future<String> Function() engineSource;
  final CheMasterProfileStore store;
  final Future<CheVaultEntry?> Function(String host) _findLogin;
  final Future<void> Function(CheVaultEntry entry) _saveLogin;
  final Future<bool> Function(String reason)? _unlock;
  final Future<void> Function(Duration) _wait;

  // Session (memory only; ends when the browser closes).
  String _host = '';
  CheProfileKind? _profile;
  bool _all = false;
  _Pending _pending = _Pending.none;
  Map<String, dynamic> _scan = const {};
  final Map<String, String> _plan = {}; // fieldId → value (snapshot used to restore after a hand-off)
  final List<_FieldOutcome> _outcomes = [];
  int _pages = 0;
  String _submitLabel = '';

  bool get active => _host.isNotEmpty && _host == _currentHost;
  String get _currentHost => Uri.tryParse(page.url)?.host ?? '';

  /// For tests and the details screen: the last report lines, value-free.
  List<String> get lastStatuses => [for (final o in _outcomes) '${o.label}: ${o.status}'];

  // ── Engine calls ──────────────────────────────────────────────────────
  Future<Map<String, dynamic>> _call(String fn, [List<Object?> args = const []]) async {
    final src = await engineSource();
    final a = args.map(jsonEncode).join(',');
    final raw = await page.eval('(function(){$src\n;return window.CheFormFill.$fn($a);})()');
    try {
      final d = jsonDecode(raw);
      return d is Map<String, dynamic> ? d : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  List<Map<String, dynamic>> get _fields => [for (final f in (_scan['fields'] as List? ?? const [])) if (f is Map<String, dynamic>) f];

  // ── Voice / typed entry point ─────────────────────────────────────────
  Future<String?> handle(String words) async {
    final w = words.toLowerCase().replaceAll(RegExp(r'[.!?,]+$'), '').replaceFirst(RegExp(r'^(?:hey\s+)?(?:chay|chey|che)[,\s]+'), '').trim();
    if (w.isEmpty) return null;

    if (_pending == _Pending.profileChoice) {
      final pick = _parseChoice(w);
      if (pick != null) {
        _profile = pick;
        _pending = _Pending.none;
        await store.rememberChoice(_host, pick);
        return _fillPages();
      }
      if (RegExp(r'^(cancel|stop|never ?mind|no)$').hasMatch(w)) {
        _reset();
        return 'Cancelled. I didn\'t fill anything.';
      }
    }
    if (_pending == _Pending.submitConfirm && active) {
      if (RegExp(r'^(yes|yeah|yep|confirm|do it|go ahead|pay)\b').hasMatch(w)) {
        _pending = _Pending.none;
        return _pressSubmit();
      }
      if (RegExp(r'^(no|nope|cancel|stop|don.?t|never ?mind)\b').hasMatch(w)) {
        _pending = _Pending.none;
        return 'Cancelled. Nothing was submitted or paid for. Your answers are still filled in.';
      }
    }

    final cmd = CheProfileCommand.parse(words);
    if (cmd != null && cmd.kind == 'use') return useMasterProfile(profileHint: cmd.profile, fillEverything: cmd.value == 'all');

    if (!active) return null;
    if (RegExp(r"^(continue|resume|keep going|carry on|go on|i'?m done|done|i did it|finished|it'?s done|i solved it|i finished it|try again)$").hasMatch(w)) {
      return _resume();
    }
    if (RegExp(r'^(?:go to (?:the )?)?next page$|^next step$|^continue to (?:the )?next page$').hasMatch(w)) {
      return _nextPage(explicit: true);
    }
    if (RegExp(r'^(submit|send|finish)( it| this| the form| the application| my application)?$').hasMatch(w)) {
      return _submit();
    }
    if (RegExp(r'^remember (my|these|those|the) answers( for this (form|site|page))?$').hasMatch(w)) {
      return _rememberAnswers();
    }
    if (RegExp(r'^(read|show)( me)? the fill details$|^what did you fill( in)?$').hasMatch(w)) {
      return details();
    }
    if (RegExp(r'^(generate|make|create) (a |me a )?(strong )?password$').hasMatch(w)) {
      return _generatePasswords(announce: true);
    }
    return null;
  }

  CheProfileKind? _parseChoice(String w) {
    if (RegExp(r'^(?:number )?(?:1|one|first)\b|^personal\b|^(?:my )?personal( profile)?$').hasMatch(w)) return CheProfileKind.personal;
    if (RegExp(r'^(?:number )?(?:2|two|second)\b|business|office|work|company').hasMatch(w)) return CheProfileKind.office;
    return null;
  }

  void _reset() {
    _host = '';
    _profile = null;
    _pending = _Pending.none;
    _plan.clear();
    _outcomes.clear();
    _pages = 0;
  }

  // ── Fill ──────────────────────────────────────────────────────────────
  /// "Use my master profile": fill only. Never submits.
  Future<String> useMasterProfile({CheProfileKind? profileHint, bool fillEverything = false}) async {
    _reset();
    _host = _currentHost;
    _all = fillEverything;
    if (_host.isEmpty) {
      _host = '';
      return 'Open the form\'s page in CHE\'s browser first, then say "use my master profile".';
    }
    _scan = await _call('scan');
    if (_fields.isEmpty) {
      final captcha = _scan['captcha'] as Map? ?? const {};
      if (captcha['present'] == true) {
        _pending = _Pending.captcha;
        return 'This page shows a ${captcha['kind']} check before the form. Please complete it yourself; I never solve or skip those. Say "continue" when it\'s done.';
      }
      _host = '';
      return 'I don\'t see a form to fill on this page. Say "what\'s on screen" to hear the options.';
    }
    final profiles = await store.load();
    final choice = profileHint ?? await _chooseProfile(profiles);
    if (choice == null) {
      _pending = _Pending.profileChoice;
      return 'Which profile should I use on $_host? 1. Personal. 2. CHE Office. Say the number.';
    }
    _profile = choice;
    if (profileHint != null) await store.rememberChoice(_host, choice);
    return _fillPages();
  }

  static const _genericMail = {'gmail.com', 'icloud.com', 'me.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'proton.me', 'protonmail.com'};

  Future<CheProfileKind?> _chooseProfile(CheProfiles p) async {
    final personal = p.approvedCount(CheProfileKind.personal) > 0;
    final office = p.approvedCount(CheProfileKind.office) > 0;
    if (!personal && !office) return CheProfileKind.personal; // nothing approved: the report says so
    // A sign-in page (only username/password/extra questions) needs no profile, so no question.
    final needsProfile = _fields.any((f) {
      final k = '${f['key']}';
      return cheProfileFieldLabels.containsKey(k) || k == 'name' || k.startsWith('bday-');
    });
    if (!needsProfile) return CheProfileKind.personal;
    // 1. The signed-in account's email domain (domains only, read on the page).
    final domains = {for (final d in (_scan['emailDomains'] as List? ?? const [])) '$d'.toLowerCase()};
    final pd = p.emailDomain(CheProfileKind.personal), od = p.emailDomain(CheProfileKind.office);
    if (od.isNotEmpty && od != pd && domains.contains(od)) return CheProfileKind.office;
    if (pd.isNotEmpty && pd != od && domains.contains(pd) && !_genericMail.contains(od)) return CheProfileKind.personal;
    // 2. Business fields on the form (company, EIN, business email/phone).
    final business = (_scan['businessSignals'] as num?)?.toInt() ?? 0;
    final personalSignals = (_scan['personalSignals'] as num?)?.toInt() ?? 0;
    if (business >= 2 && office) return CheProfileKind.office;
    // 3. What he chose on this site before.
    final remembered = await store.choiceFor(_host);
    if (remembered != null) return remembered;
    // 4. Clearly personal form, or only one profile has answers.
    if (business == 0 && personal && (personalSignals > 0 || !office)) return CheProfileKind.personal;
    if (business == 0 && !personal && office) return CheProfileKind.office;
    if (business > 0 && !office) return CheProfileKind.personal;
    return null; // genuinely ambiguous: ask one numbered question
  }

  Future<String> _fillPages() async {
    final parts = <String>[];
    while (true) {
      await _fillCurrentPage();
      _pages += 1;
      final stop = _handoff();
      if (stop != null) {
        parts.add(_pageReport());
        parts.add(stop);
        break;
      }
      final next = _scan['next'] as String?;
      final requiredEmpty = _outcomes.any((o) => o.required && (o.status == 'no_answer' || o.status == 'no_option'));
      if (next != null && _all && !requiredEmpty && _pages < 8) {
        parts.add(_pageReport(short: true));
        final moved = await _goNext();
        if (!moved) {
          parts.add('I pressed "$next" but the page didn\'t change, so I stopped here.');
          break;
        }
        continue;
      }
      parts.add(_pageReport());
      if (next != null) {
        _pending = _Pending.nextPage;
        parts.add(requiredEmpty && _all
            ? 'A required question has no approved answer, so I didn\'t go on to the next page. Answer it, then say "next page".'
            : 'This form has another page. Say "next page" and I\'ll go on and keep filling.');
      }
      break;
    }
    parts.add(_closing());
    return parts.where((s) => s.isNotEmpty).join(' ');
  }

  Future<void> _fillCurrentPage() async {
    _scan = await _call('scan');
    final profiles = await store.load();
    final remembered = await store.answersFor(_host);
    final kind = _profile ?? CheProfileKind.personal;
    _outcomes.clear();
    _passwordNote = '';
    final values = <String, String>{};
    final passwordFields = <Map<String, dynamic>>[];
    for (final f in _fields) {
      final id = '${f['id']}', key = '${f['key']}', label = '${f['label']}', control = '${f['control']}';
      final required = f['required'] == true;
      if (control == 'password') {
        passwordFields.add(f);
        continue;
      }
      if (key == 'cc') {
        _outcomes.add(_FieldOutcome(label, key, 'refused', required: required));
        continue;
      }
      if (key == 'one-time-code' || key == 'x-ssn') {
        _outcomes.add(_FieldOutcome(label, key, 'refused', required: required));
        continue;
      }
      if (control == 'file') {
        _outcomes.add(_FieldOutcome(label, key, 'unsupported', required: required));
        continue;
      }
      if (f['filled'] == true && !_plan.containsKey(id)) {
        _outcomes.add(_FieldOutcome(label, key, 'kept', required: required));
        continue;
      }
      final value = _plan[id] ?? _valueFor(profiles, kind, f, remembered);
      if (value == null) {
        _outcomes.add(_FieldOutcome(label, key, 'no_answer', required: required));
        continue;
      }
      values[id] = value;
      _plan[id] = value;
      _outcomes.add(_FieldOutcome(label, key, 'pending', value: value, required: required));
    }
    if (values.isNotEmpty) {
      await _call('start', [jsonEncode({'values': values})]);
      Map<String, dynamic> report = const {};
      for (var i = 0; i < 60; i++) {
        report = await _call('poll');
        if (report['pending'] != true) break;
        await _wait(const Duration(milliseconds: 80));
      }
      final byId = {for (final r in (report['results'] as List? ?? const [])) if (r is Map) '${r['id']}': '${r['status']}'};
      final ids = values.keys.toList();
      var i = 0;
      for (final o in _outcomes) {
        if (o.status != 'pending') continue;
        o.status = byId[ids[i]] ?? 'failed';
        i++;
      }
    }
    if (passwordFields.isNotEmpty) await _fillPasswords(passwordFields);
  }

  String? _valueFor(CheProfiles p, CheProfileKind kind, Map<String, dynamic> f, Map<String, String> remembered) {
    final key = '${f['key']}';
    String? get(String k) {
      // A "work" email/phone on a personal form comes from CHE Office.
      // Never a personal value in a business box.
      if (f['hint'] == 'work' && (k == 'email' || k == 'tel')) return p.approved(CheProfileKind.office, k);
      final v = p.approved(kind, k);
      if (v != null) return v;
      if (kind == CheProfileKind.office && chePersonFallbackFields.contains(k)) return p.approved(CheProfileKind.personal, k);
      return null;
    }

    switch (key) {
      case 'name':
        final g = get('given-name'), fam = get('family-name');
        return g != null && fam != null ? '$g $fam' : null;
      case 'bday-day':
      case 'bday-month':
      case 'bday-year':
        final b = get('bday');
        if (b == null) return null;
        final parts = b.split('-');
        if (parts.length != 3) return null;
        return key == 'bday-year' ? parts[0] : key == 'bday-month' ? '${int.parse(parts[1])}' : '${int.parse(parts[2])}';
      case 'username':
        return null; // from the vault login, filled with the password
      case 'custom':
      case 'x-date':
      case 'honorific-prefix':
        return remembered[CheMasterProfileStore.labelKey('${f['label']}')];
    }
    if (cheProfileFieldLabels.containsKey(key)) return get(key);
    return remembered[CheMasterProfileStore.labelKey('${f['label']}')];
  }

  Future<bool> _unlockVault(String reason) async {
    final unlock = _unlock;
    if (unlock != null) return unlock(reason);
    return false;
  }

  Future<void> _fillPasswords(List<Map<String, dynamic>> fields) async {
    final current = fields.where((f) => f['key'] == 'current-password').toList();
    final fresh = fields.where((f) => f['key'] == 'new-password').toList();
    if (current.isNotEmpty) {
      final entry = await _findLogin(_host);
      if (entry == null) {
        for (final f in current) {
          _outcomes.add(_FieldOutcome('${f['label']}', 'current-password', 'password_missing'));
        }
      } else if (!await _unlockVault('Use Face ID to fill your saved $_host password')) {
        for (final f in current) {
          _outcomes.add(_FieldOutcome('${f['label']}', 'current-password', 'password_locked'));
        }
      } else {
        for (final f in current) {
          final r = await _call('setSecret', ['${f['id']}', entry.password]);
          _outcomes.add(_FieldOutcome('${f['label']}', 'current-password', r['ok'] == true ? 'password_vault' : 'failed'));
        }
        await _fillUsername(entry.username);
      }
    }
    if (fresh.isNotEmpty) {
      final note = await _generatePasswords();
      if (note.isNotEmpty) {
        _passwordNote = note;
        _outcomes.removeWhere((o) => o.key == 'new-password');
        for (final f in fresh) {
          _outcomes.add(_FieldOutcome('${f['label']}', 'new-password', 'password_left'));
        }
      }
    }
  }

  String _passwordNote = '';
  String _generatedHost = '';

  Future<void> _fillUsername(String username) async {
    if (username.isEmpty) return;
    final users = _fields.where((f) => f['key'] == 'username' && f['filled'] != true).toList();
    if (users.isEmpty) return;
    await _call('start', [jsonEncode({'values': {for (final f in users) '${f['id']}': username}})]);
    await _wait(const Duration(milliseconds: 40));
    final report = await _call('poll');
    final byId = {for (final r in (report['results'] as List? ?? const [])) if (r is Map) '${r['id']}': '${r['status']}'};
    for (final f in users) {
      _outcomes.removeWhere((o) => o.key == 'username' && o.label == '${f['label']}');
      _outcomes.add(_FieldOutcome('${f['label']}', 'username', byId['${f['id']}'] ?? 'failed', value: username));
    }
  }

  /// New-password fields: generate a strong unique password on the phone,
  /// save it to the vault FIRST, then fill it. Returns '' on success.
  Future<String> _generatePasswords({bool announce = false}) async {
    final fields = _fields.where((f) => f['key'] == 'new-password').toList();
    if (fields.isEmpty) return announce ? 'I don\'t see a new-password box on this page.' : '';
    final existing = await _findLogin(_host);
    if (existing != null && _generatedHost == _host) {
      // Already generated in this session (e.g. resuming after a CAPTCHA): refill the same one from the vault.
      if (!await _unlockVault('Use Face ID to fill your new $_host password')) return 'Face ID was cancelled, so I didn\'t fill the password.';
      var n = 0;
      for (final f in fields) {
        if ((await _call('setSecret', ['${f['id']}', existing.password]))['ok'] == true) n += 1;
      }
      _outcomes.removeWhere((o) => o.key == 'new-password');
      for (final f in fields) {
        _outcomes.add(_FieldOutcome('${f['label']}', 'new-password', n > 0 ? 'password_generated' : 'failed'));
      }
      return '';
    }
    if (existing != null && existing.site == CheVaultCommand.normalizeSite(_host)) {
      const msg = 'You already have a saved password for this site, so I didn\'t make a new one. Fill that box yourself, or remove the old one from the vault first.';
      return msg;
    }
    if (!await _unlockVault('Use Face ID to save a new password for $_host in your CHE vault')) {
      return 'Face ID was cancelled, so I didn\'t create or fill a password.';
    }
    final first = fields.first;
    String password;
    try {
      password = chePasswordGenerate(
        rules: ChePasswordRules.fromAttributes(
          minlength: (first['minlength'] as num?)?.toInt(),
          maxlength: (first['maxlength'] as num?)?.toInt(),
          passwordrules: '${first['passwordrules'] ?? ''}',
          pattern: '${first['pattern'] ?? ''}',
        ),
      );
    } on StateError {
      return 'This site\'s password rules are ones I can\'t meet safely, so I left the password boxes for you.';
    }
    final username = _plan.entries
        .where((e) => _fields.any((f) => f['id'] == e.key && (f['key'] == 'username' || f['key'] == 'email')))
        .map((e) => e.value)
        .firstOrNull ?? '';
    await _saveLogin(CheVaultEntry(site: CheVaultCommand.normalizeSite(_host), password: password, username: username));
    _generatedHost = _host;
    var filled = 0;
    for (final f in fields) {
      final r = await _call('setSecret', ['${f['id']}', password]);
      if (r['ok'] == true) filled += 1;
    }
    password = ''; // drop the reference; the vault holds it now
    _outcomes.removeWhere((o) => o.key == 'new-password');
    for (final f in fields) {
      _outcomes.add(_FieldOutcome('${f['label']}', 'new-password', filled > 0 ? 'password_generated' : 'failed'));
    }
    return announce
        ? (filled > 0 ? 'Made a strong new password, saved it to your vault on this iPhone, and filled it into $filled password ${filled == 1 ? 'box' : 'boxes'}. Nothing was submitted.' : 'I saved a new password to your vault but couldn\'t fill the box.')
        : '';
  }

  String? _handoff() {
    final captcha = _scan['captcha'] as Map? ?? const {};
    if (captcha['present'] == true && captcha['solved'] != true) {
      _pending = _Pending.captcha;
      return 'There\'s a ${captcha['kind']} check on this page. Please complete it yourself; I never solve or skip those. '
          'Your answers stay filled in and I won\'t reload the page. Say "continue" when it\'s done.';
    }
    final v = _scan['verification'] as Map?;
    if (v != null) {
      _pending = _Pending.verification;
      final how = switch ('${v['kind']}') {
        'code' => 'Read me the code and say "type" and the code, or enter it yourself',
        'email_link' => 'Open the link in your email',
        'id_upload' => 'Upload the document yourself; I can\'t attach files',
        'payment_confirmation' => 'Approve it in your bank or card app',
        _ => 'Complete it yourself',
      };
      return 'This step needs ${v['text']}, which only you can provide. $how, then say "continue".';
    }
    return null;
  }

  Future<bool> _goNext() async {
    final before = {for (final f in _fields) '${f['id']}'};
    final beforeUrl = page.url;
    final r = await _call('next');
    if (r['clicked'] == null) return false;
    for (var i = 0; i < 30; i++) {
      await _wait(const Duration(milliseconds: 100));
      final s = await _call('scan');
      final now = {for (final f in (s['fields'] as List? ?? const [])) if (f is Map) '${f['id']}'};
      if (page.url != beforeUrl || now.difference(before).isNotEmpty || (now.isNotEmpty && now.intersection(before).isEmpty)) {
        _scan = s;
        return true;
      }
    }
    return false;
  }

  Future<String> _nextPage({bool explicit = false}) async {
    _scan = await _call('scan');
    if (_scan['next'] == null) {
      return _scan['submit'] != null
          ? 'This is the last page: the only button left is "${_scan['submit']}", which submits. Say "submit it" when you want it sent.'
          : 'I don\'t see a next-page button here.';
    }
    final label = _scan['next'];
    if (!await _goNext()) return 'I pressed "$label" but the page didn\'t change. The site may be waiting for a required answer.';
    _pending = _Pending.none;
    return 'Pressed "$label". ${await _fillPages()}';
  }

  Future<String> _resume() async {
    if (_currentHost != _host) return 'The form\'s page is no longer open, so there is nothing to continue.';
    final wasCaptcha = _pending == _Pending.captcha;
    final c = await _call('captchaState');
    if (wasCaptcha && c['present'] == true && c['solved'] != true) {
      return 'The ${c['kind']} check still looks unfinished. Complete it, then say "continue". Your answers are still filled in.';
    }
    _pending = _Pending.none;
    // Restore anything the page lost while he was busy, then carry on.
    final out = await _fillPages();
    return 'Thanks. $out';
  }

  Future<String> _submit() async {
    _scan = await _call('scan');
    final captcha = _scan['captcha'] as Map? ?? const {};
    if (captcha['present'] == true && captcha['solved'] != true) {
      return 'There\'s still a ${captcha['kind']} check to complete before this can be sent. Complete it yourself, then say "submit it" again.';
    }
    final label = _scan['submit'] as String?;
    if (label == null) {
      return _scan['next'] != null ? 'This page only has "${_scan['next']}", which goes to the next page. Say "next page".' : 'I don\'t see a submit button on this page.';
    }
    _submitLabel = label;
    if (_scan['payment'] == true) {
      _pending = _Pending.submitConfirm;
      return 'This costs money: I\'m about to press "$label" on $_host. Say "yes" to pay, or "cancel".';
    }
    return _pressSubmit();
  }

  Future<String> _pressSubmit() async {
    final r = await _call('submit');
    final clicked = r['clicked'];
    if (clicked == null) return 'I couldn\'t find the "$_submitLabel" button anymore. Nothing was sent.';
    await _wait(const Duration(milliseconds: 600));
    _scan = await _call('scan');
    final after = _handoff();
    return 'Submitted: I pressed "$clicked" on $_host.${after != null ? ' $after' : ' Say "what\'s on screen" to hear what the site says.'}';
  }

  Future<String> _rememberAnswers() async {
    _scan = await _call('scan');
    final custom = _fields.where((f) => const {'custom', 'x-date', 'honorific-prefix'}.contains(f['key'])).toList();
    if (custom.isEmpty) return 'There are no extra questions on this page to remember; your profile already covers the rest.';
    final values = await _call('readBack', [jsonEncode([for (final f in custom) '${f['id']}'])]);
    final byLabel = <String, String>{
      for (final f in custom)
        if ((values['${f['id']}'] ?? '').toString().trim().isNotEmpty) '${f['label']}': '${values['${f['id']}']}',
    };
    if (byLabel.isEmpty) return 'Those questions are still empty, so there\'s nothing to remember yet.';
    await store.rememberAnswers(_host, byLabel);
    return 'Remembered your ${byLabel.length} ${byLabel.length == 1 ? 'answer' : 'answers'} for $_host on this iPhone: ${byLabel.keys.join(', ')}. I\'ll reuse them next time.';
  }

  /// The owner's on-screen detail: labels, statuses and MASKED values only.
  String details() {
    if (_outcomes.isEmpty) return 'I haven\'t filled anything on this page yet.';
    return [
      for (final o in _outcomes) '${o.label}: ${_statusWords(o)}${o.value.isNotEmpty && o.status == 'filled' ? ' (${_mask(o)})' : ''}',
    ].join('\n');
  }

  String _mask(_FieldOutcome o) {
    final v = o.value;
    if (v.length <= 2) return '••';
    if (o.key == 'email' && v.contains('@')) return '${v[0]}•••${v.substring(v.indexOf('@'))}';
    final digits = v.replaceAll(RegExp(r'\D'), '');
    if (const {'tel', 'x-ein', 'bday', 'bday-day', 'bday-month', 'bday-year', 'postal-code'}.contains(o.key)) {
      return digits.length >= 4 ? '•••• ${digits.substring(digits.length - 2)}' : '••••';
    }
    return '${v[0]}•••';
  }

  static String _statusWords(_FieldOutcome o) => switch (o.status) {
        'filled' => 'filled and checked',
        'kept' => 'already had an answer, left as it was',
        'no_answer' => 'left empty, no approved answer',
        'no_option' => 'none of the choices matched your answer',
        'unsupported' => 'not supported',
        'refused' => 'left for you',
        'password_vault' => 'filled from vault',
        'password_generated' => 'generated and saved to your vault',
        'password_missing' => 'no saved password for this site',
        'password_locked' => 'not filled, Face ID not completed',
        'too_long' => 'your answer is longer than the box allows',
        _ => 'couldn\'t confirm it was filled',
      };

  String _pageReport({bool short = false}) {
    final filled = _outcomes.where((o) => o.status == 'filled').map((o) => o.label).toList();
    final kept = _outcomes.where((o) => o.status == 'kept').length;
    final pw = _outcomes.where((o) => o.status.startsWith('password_') || (o.key.endsWith('password') && o.status == 'failed')).toList();
    final empty = _outcomes.where((o) => o.status == 'no_answer').toList();
    final noOption = _outcomes.where((o) => o.status == 'no_option' || o.status == 'too_long').map((o) => o.label).toList();
    final failed = _outcomes.where((o) => o.status == 'failed' && !o.key.endsWith('password')).map((o) => o.label).toList();
    final unsupported = _outcomes.where((o) => o.status == 'unsupported').map((o) => '${o.label} (file upload)').toList();
    final leftForYou = _outcomes.where((o) => o.status == 'refused').map((o) => o.key == 'cc' ? '${o.label} (card details: I never fill those)' : o.key == 'one-time-code' ? '${o.label} (verification code)' : o.label).toList();
    final frames = [for (final h in (_scan['crossOriginFrames'] as List? ?? const [])) '$h'];
    final profile = _profile?.spoken ?? 'Personal';
    final b = StringBuffer();
    b.write(_pages <= 1 ? 'On $_host, with your $profile profile: ' : 'Page $_pages: ');
    b.write(filled.isEmpty ? 'I had no approved answers for these fields. ' : 'filled and checked ${filled.length} ${filled.length == 1 ? 'field' : 'fields'}: ${filled.join(', ')}. ');
    if (short) return b.toString().trim();
    if (kept > 0) b.write('$kept already had answers, so I left them. ');
    for (final o in pw) {
      if (o.status == 'password_left') continue;
      b.write('${o.label}: ${_statusWords(o)}. ');
    }
    if (_passwordNote.isNotEmpty) b.write('$_passwordNote ');
    if (failed.isNotEmpty) b.write('I couldn\'t confirm: ${failed.join(', ')}. ');
    if (noOption.isNotEmpty) b.write('Your answer didn\'t match the choices for: ${noOption.join(', ')}. ');
    if (empty.isNotEmpty) {
      b.write('Left empty because I have no approved answer: ');
      b.write([for (var i = 0; i < empty.length; i++) '${i + 1}. ${empty[i].label}${empty[i].required ? ' (required)' : ''}'].join('. '));
      b.write('. To answer one, say "fill the" and the box name, "with", and your answer. ');
    }
    if (leftForYou.isNotEmpty) b.write('Left for you: ${leftForYou.join(', ')}. ');
    if (unsupported.isNotEmpty || frames.isNotEmpty) {
      b.write('Not supported: ${[...unsupported, for (final h in frames) 'a secure box from $h that I can\'t reach'].join(', ')}. ');
    }
    return b.toString().trim();
  }

  String _closing() {
    if (_pending == _Pending.captcha || _pending == _Pending.verification) return 'Nothing was submitted.';
    final money = _scan['payment'] == true;
    final submit = _scan['submit'];
    if (submit == null) return 'Nothing was submitted.';
    return 'Nothing was submitted. Say "submit it" when you want it sent${money ? '; it costs money, so I\'ll ask you first' : ''}.';
  }
}
