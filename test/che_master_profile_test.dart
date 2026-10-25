// "CHE, use my master profile": command routing, profile choice, vault gating,
// fill/submit separation, CAPTCHA hand-off and the privacy boundary, with a
// fake page that models the engine's API (the real engine is tested in
// headless Chromium by tools/che_form_fill_test.mjs).
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chey/browser/che_form_filler.dart';
import 'package:chey/browser/che_master_profile.dart';
import 'package:chey/browser/che_master_profile_screen.dart';
import 'package:chey/security/che_password_vault.dart';
import 'package:chey/security/che_session_store.dart' show CheMemoryKv;

class _Field {
  _Field(this.id, this.key, this.label, {this.control = 'text', this.required = false, this.hint = ''});
  final String id, key, label, control, hint;
  final bool required;
  String value = '';
  Map<String, Object?> toJson() => {
        'id': id, 'key': key, 'label': label, 'control': control, 'required': required, 'hint': hint,
        'filled': value.isNotEmpty, 'type': control, 'frame': 0,
        if (control == 'password') ...{'minlength': null, 'maxlength': null, 'passwordrules': '', 'pattern': ''},
      };
}

/// A fake form page speaking the engine's JSON API.
class _FakePage implements CheFormPage {
  _FakePage(this.pages, {this.host = 'shop.example.com', this.payment = false, this.captcha = '', this.business = 0, this.domains = const []});
  final List<List<_Field>> pages;
  final String host;
  final bool payment;
  String captcha; // '' = none
  bool captchaSolved = false;
  final int business;
  final List<String> domains;
  int page = 0;
  int submitted = 0;
  final Map<String, String> secrets = {};
  final List<String> evals = [];
  List<Map<String, Object?>> _lastResults = [];

  @override
  String get url => 'https://$host/form';

  List<_Field> get fields => pages[page];

  @override
  Future<String> eval(String js) async {
    evals.add(js);
    final m = RegExp(r'window\.CheFormFill\.(\w+)\((.*)\);\}\)\(\)$', dotAll: true).firstMatch(js)!;
    final args = jsonDecode('[${m[2]}]') as List;
    final out = switch (m[1]) {
      'scan' => {
          'site': host, 'title': 'Form', 'fields': [for (final f in fields) f.toJson()], 'crossOriginFrames': <String>[],
          'captcha': {'present': captcha.isNotEmpty, 'solved': captchaSolved, 'kind': captcha},
          'verification': null,
          'next': page < pages.length - 1 ? 'next' : null,
          'submit': page == pages.length - 1 ? (payment ? 'place order' : 'create account') : null,
          'payment': payment, 'businessSignals': business, 'personalSignals': 0, 'emailDomains': domains,
        },
      'start' => _start(jsonDecode(args[0] as String) as Map<String, dynamic>),
      'poll' => {'results': _lastResults, 'captcha': {'present': captcha.isNotEmpty, 'solved': captchaSolved, 'kind': captcha}},
      'setSecret' => _secret(args[0] as String, args[1] as String),
      'next' => _next(),
      'submit' => _submit(),
      'captchaState' => {'present': captcha.isNotEmpty, 'solved': captchaSolved, 'kind': captcha},
      'readBack' => {for (final id in jsonDecode(args[0] as String) as List) if (fields.any((f) => f.id == id && f.value.isNotEmpty)) id: fields.firstWhere((f) => f.id == id).value},
      _ => <String, Object?>{},
    };
    return jsonEncode(out);
  }

  Map<String, Object?> _start(Map<String, dynamic> plan) {
    _lastResults = [];
    (plan['values'] as Map).forEach((id, v) {
      final f = fields.firstWhere((x) => x.id == id);
      String status;
      if (f.key == 'cc' || f.key == 'one-time-code' || f.control == 'password') {
        status = 'refused';
      } else if (f.value.isNotEmpty) {
        status = 'kept';
      } else {
        f.value = '$v';
        status = 'filled';
      }
      _lastResults.add({'id': id, 'status': status});
    });
    return {'started': true};
  }

  Map<String, Object?> _secret(String id, String v) {
    secrets[id] = v;
    fields.firstWhere((f) => f.id == id).value = v;
    return {'ok': true};
  }

  Map<String, Object?> _next() {
    if (page >= pages.length - 1) return {'clicked': null};
    page += 1;
    return {'clicked': 'next'};
  }

  Map<String, Object?> _submit() {
    submitted += 1;
    return {'clicked': payment ? 'place order' : 'create account'};
  }
}

const _vaultPassword = 'Vault-Only_Secret-9xQ2!kLmZ7';

Future<CheMasterProfileStore> _store({bool office = true, bool personal = true}) async {
  final s = CheMasterProfileStore(kv: CheMemoryKv());
  if (personal) {
    await s.setField(CheProfileKind.personal, 'given-name', 'Jordan');
    await s.setField(CheProfileKind.personal, 'family-name', 'Rivera');
    await s.setField(CheProfileKind.personal, 'email', 'jordan.rivera@gmail.com');
    await s.setField(CheProfileKind.personal, 'tel', '602-555-0147');
    await s.setField(CheProfileKind.personal, 'postal-code', '85004', approved: false); // saved, NOT approved
  }
  if (office) {
    await s.setField(CheProfileKind.office, 'organization', 'CHE Office LLC');
    await s.setField(CheProfileKind.office, 'x-ein', '12-3456789');
    await s.setField(CheProfileKind.office, 'email', 'office@cheoffice.example');
  }
  return s;
}

CheFormFiller _filler(_FakePage page, CheMasterProfileStore store, {bool unlock = true, List<CheVaultEntry>? vault, List<String>? unlockReasons}) {
  final saved = vault ?? <CheVaultEntry>[];
  return CheFormFiller(
    page: page,
    engineSource: () async => '/* engine */',
    store: store,
    findLogin: (host) async => saved.where((e) => host.contains(e.site) || e.site.contains(host)).firstOrNull,
    saveLogin: (e) async => saved.add(e),
    unlockVault: (reason) async {
      unlockReasons?.add(reason);
      return unlock;
    },
    wait: (_) async {},
  );
}

List<_Field> _personalForm() => [
      _Field('f0-1', 'given-name', 'First name', required: true),
      _Field('f0-2', 'family-name', 'Last name'),
      _Field('f0-3', 'email', 'Email'),
      _Field('f0-4', 'postal-code', 'ZIP code'),
      _Field('f0-5', 'custom', 'How did you hear about us?'),
    ];

void main() {
  group('command routing', () {
    test('use / fill phrases become a fill command; submit is never part of it', () {
      expect(CheProfileCommand.parse('CHE, use my master profile')?.kind, 'use');
      expect(CheProfileCommand.parse('Chay use my master profile.')?.kind, 'use');
      final biz = CheProfileCommand.parse('fill this with my business profile')!;
      expect((biz.kind, biz.profile), ('use', CheProfileKind.office));
      expect(CheProfileCommand.parse('fill this form with my CHE Office profile')!.profile, CheProfileKind.office);
      final all = CheProfileCommand.parse('fill everything with my personal profile')!;
      expect((all.profile, all.value), (CheProfileKind.personal, 'all'));
      expect(CheProfileCommand.parse('/master-profile business everything')!.value, 'all');
      expect(CheProfileCommand.parse('submit it'), isNull);
      expect(CheProfileCommand.parse('what is the weather'), isNull);
      expect(CheProfileCommand.parse('my name is Jordan'), isNull, reason: 'conversation is not a profile edit');
    });

    test('voice entry: "set my business phone to ..." and friends', () {
      final phone = CheProfileCommand.parse('set my business phone to 602 555 0199')!;
      expect((phone.kind, phone.profile, phone.field, phone.value), ('set', CheProfileKind.office, 'tel', '602 555 0199'));
      final ein = CheProfileCommand.parse('change my EIN to 12 345 6789')!;
      expect((ein.profile, ein.field), (CheProfileKind.office, 'x-ein'), reason: 'EIN is a business field');
      expect(cheNormalizeProfileValue('x-ein', ein.value), '12-3456789');
      final email = CheProfileCommand.parse('update my personal email to Jane at Example dot com')!;
      expect(cheNormalizeProfileValue('email', email.value), 'jane@example.com');
      expect(cheNormalizeProfileValue('bday', 'May 14th, 1990'), '1990-05-14');
      expect(cheNormalizeProfileValue('bday', 'sometime in spring'), isNull, reason: 'never guessed');
      expect(CheProfileCommand.parse('set my favourite colour to blue'), isNull, reason: 'unknown field is not captured');
      expect(cheIsProfileTurn('set my business phone to 602 555 0199'), isTrue);
      expect(cheIsProfileTurn('use my master profile'), isFalse);
    });
  });

  group('filling', () {
    test('fills approved values only, reports missing answers by number, and never submits', () async {
      final page = _FakePage([_personalForm()]);
      final f = _filler(page, await _store(office: false));
      final reply = (await f.handle('CHE, use my master profile'))!;
      expect(page.fields[0].value, 'Jordan');
      expect(page.fields[2].value, 'jordan.rivera@gmail.com');
      expect(page.fields[3].value, '', reason: 'ZIP saved but not approved → not used');
      expect(page.fields[4].value, '', reason: 'no remembered answer → left empty');
      expect(reply, contains('filled and checked 3 fields: First name, Last name, Email'));
      expect(reply, contains('Left empty because I have no approved answer: 1. ZIP code. 2. How did you hear about us?'));
      expect(reply, contains('Nothing was submitted'));
      expect(page.submitted, 0);
      // The spoken reply carries no profile value.
      for (final v in ['Jordan', 'Rivera', 'jordan.rivera', '602']) {
        expect(reply.contains(v), isFalse, reason: v);
      }
      // "submit it" is a separate command and presses submit.
      final sent = (await f.handle('submit it'))!;
      expect(page.submitted, 1);
      expect(sent, startsWith('Submitted: I pressed "create account"'));
    });

    test('a payment form needs the money yes before submit; cancel sends nothing', () async {
      final page = _FakePage([_personalForm()], payment: true);
      final f = _filler(page, await _store());
      await f.handle('use my personal profile');
      expect(await f.handle('submit it'), contains('This costs money'));
      expect(page.submitted, 0);
      expect(await f.handle('cancel'), contains('Nothing was submitted or paid for'));
      expect(page.submitted, 0);
      await f.handle('submit it');
      expect(await f.handle('yes'), contains('Submitted'));
      expect(page.submitted, 1);
    });

    test('business fields choose CHE Office without asking; personal name falls back for the contact', () async {
      final page = _FakePage([
        [_Field('f0-1', 'organization', 'Legal business name'), _Field('f0-2', 'x-ein', 'EIN'), _Field('f0-3', 'given-name', 'Contact first name'), _Field('f0-4', 'email', 'Business email', hint: 'work')],
      ], business: 5);
      final f = _filler(page, await _store());
      final reply = (await f.handle('use my master profile'))!;
      expect(reply, contains('with your CHE Office profile'));
      expect(page.fields.map((x) => x.value), ['CHE Office LLC', '12-3456789', 'Jordan', 'office@cheoffice.example']);
    });

    test('the signed-in account\'s email domain chooses the profile', () async {
      final page = _FakePage([_personalForm()], domains: ['cheoffice.example']);
      final f = _filler(page, await _store());
      expect(await f.handle('use my master profile'), contains('CHE Office profile'));
    });

    test('ambiguous: one numbered spoken question, then the spoken choice fills and is remembered for the site', () async {
      final page = _FakePage([_personalForm()], business: 1);
      final store = await _store();
      final f = _filler(page, store);
      expect(await f.handle('use my master profile'), 'Which profile should I use on shop.example.com? 1. Personal. 2. CHE Office. Say the number.');
      expect(page.fields[0].value, '', reason: 'nothing filled before he answers');
      expect(await f.handle('number one'), contains('with your Personal profile'));
      expect(page.fields[0].value, 'Jordan');
      expect(await store.choiceFor('shop.example.com'), CheProfileKind.personal);
    });

    test('remembered answers: "remember my answers" stores the extra question on the phone and reuses it next time', () async {
      final store = await _store();
      final page = _FakePage([_personalForm()]);
      final f = _filler(page, store);
      await f.handle('use my personal profile');
      page.fields[4].value = 'A friend'; // he answered it himself
      expect(await f.handle('remember my answers'), contains('Remembered your 1 answer for shop.example.com'));
      final again = _FakePage([_personalForm()]);
      await _filler(again, store).handle('use my personal profile');
      expect(again.fields[4].value, 'A friend');
    });
  });

  group('passwords and the vault', () {
    List<_Field> login() => [_Field('f0-1', 'username', 'Username'), _Field('f0-2', 'current-password', 'Password', control: 'password')];

    test('vault auth is required before a password is filled', () async {
      final page = _FakePage([login()], host: 'bank.example.com');
      final vault = [const CheVaultEntry(site: 'bank.example.com', password: _vaultPassword, username: 'jrivera')];
      final reasons = <String>[];
      final reply = (await _filler(page, await _store(), unlock: false, vault: vault, unlockReasons: reasons).handle('use my master profile'))!;
      expect(reasons.single, contains('Face ID'));
      expect(page.secrets, isEmpty, reason: 'locked vault → no password in the page');
      expect(reply, contains('Password: not filled, Face ID not completed'));
    });

    test('after vault auth the password goes only into setSecret; never into a reply, details or any other script', () async {
      final page = _FakePage([login()], host: 'bank.example.com');
      final vault = [const CheVaultEntry(site: 'bank.example.com', password: _vaultPassword, username: 'jrivera')];
      final f = _filler(page, await _store(), vault: vault);
      final reply = (await f.handle('use my master profile'))!;
      expect(page.secrets.values.single, _vaultPassword);
      expect(page.fields[0].value, 'jrivera', reason: 'username from the vault login');
      expect(reply, contains('Password: filled from vault'));
      expect(reply.contains(_vaultPassword), isFalse);
      expect(f.details().contains(_vaultPassword), isFalse);
      final carrying = page.evals.where((js) => js.contains(_vaultPassword)).toList();
      expect(carrying.length, 1);
      expect(carrying.single, contains('CheFormFill.setSecret('));
    });

    test('sign-up: a strong password is generated, saved to the vault BEFORE any submit, and filled; it is never spoken', () async {
      final page = _FakePage([
        [_Field('f0-1', 'email', 'Email'), _Field('f0-2', 'new-password', 'Create password', control: 'password'), _Field('f0-3', 'new-password', 'Confirm password', control: 'password')],
      ], host: 'newsite.example.com');
      final vault = <CheVaultEntry>[];
      final reply = (await _filler(page, await _store(), vault: vault).handle('use my personal profile'))!;
      expect(vault.single.site, 'newsite.example.com');
      expect(vault.single.username, 'jordan.rivera@gmail.com');
      expect(vault.single.password.length, greaterThanOrEqualTo(20));
      expect(page.secrets.values.toSet(), {vault.single.password}, reason: 'both boxes get the saved password');
      expect(page.submitted, 0);
      expect(reply.contains(vault.single.password), isFalse);
      expect(reply, contains('generated and saved to your vault'));
    });
  });

  group('CAPTCHA and multi-page', () {
    test('CAPTCHA pauses with a hand-off; continue while unsolved waits; after he solves it CHE resumes and goes on with "fill everything"', () async {
      final page = _FakePage([
        _personalForm().sublist(0, 2),
        [_Field('f0-9', 'tel', 'Phone')],
      ], captcha: 'reCAPTCHA');
      final f = _filler(page, await _store());
      final first = (await f.handle('fill everything with my personal profile'))!;
      expect(first, contains('There\'s a reCAPTCHA check on this page. Please complete it yourself; I never solve or skip those.'));
      expect(first, contains('Say "continue"'));
      expect(page.page, 0, reason: 'never moved past the CAPTCHA');
      expect(page.fields[0].value, 'Jordan', reason: 'answers stay filled');
      expect(await f.handle('continue'), contains('still looks unfinished'));
      page.captchaSolved = true; // the owner did it
      page.fields[1].value = ''; // and the site cleared a field meanwhile
      final resumed = (await f.handle('continue'))!;
      expect(page.pages[0][1].value, 'Rivera', reason: 'lost value restored from the on-device snapshot');
      expect(page.page, 1, reason: 'went on to the next page because he said fill everything');
      expect(page.pages[1][0].value, '602-555-0147');
      expect(resumed, contains('Nothing was submitted'));
      expect(page.submitted, 0);
    });

    test('without "everything", CHE stops at the page break and asks', () async {
      final page = _FakePage([_personalForm().sublist(0, 1), [_Field('f0-9', 'tel', 'Phone')]]);
      final f = _filler(page, await _store());
      expect(await f.handle('use my personal profile'), contains('This form has another page. Say "next page"'));
      expect(page.page, 0);
      expect(await f.handle('next page'), contains('Pressed "next"'));
      expect(page.page, 1);
      expect(page.fields[0].value, '602-555-0147');
    });
  });

  test('nothing is sent over the network: no HTTP client is created while filling', () async {
    final created = <String>[];
    await HttpOverrides.runZoned(() async {
      final page = _FakePage([_personalForm()], payment: true);
      final f = _filler(page, await _store());
      await f.handle('use my master profile');
      await f.handle('remember my answers');
      await f.handle('submit it');
      await f.handle('yes');
    }, createHttpClient: (context) {
      created.add('client');
      throw StateError('no network allowed in the master profile path');
    });
    expect(created, isEmpty);
  });

  testWidgets('profile editor: VoiceOver labels, approve switch, and only approved values are stored as approved', (tester) async {
    final handle = tester.ensureSemantics();
    final store = CheMasterProfileStore(kv: CheMemoryKv());
    await tester.pumpWidget(MaterialApp(home: CheMasterProfileScreen(store: store)));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp(r'^Personal First name')), findsOneWidget);
    expect(find.bySemanticsLabel('Approve First name for CHE to use'), findsOneWidget);
    expect(find.bySemanticsLabel('Choose profile'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('profile-personal-given-name')), 'Jordan');
    await tester.tap(find.byKey(const ValueKey('approve-personal-given-name')));
    await tester.pumpAndSettle();
    expect((await store.load()).approved(CheProfileKind.personal, 'given-name'), 'Jordan');
    expect(find.text('First name approved for your Personal profile.'), findsOneWidget);
    expect(find.bySemanticsLabel('Approved: First name. Double tap to stop CHE using it.'), findsOneWidget);
    // CHE Office shows the business-only fields.
    await tester.tap(find.text('CHE Office'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const ValueKey('profile-office-x-ein')), 200, scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first);
    expect(find.bySemanticsLabel(RegExp(r'^CHE Office EIN \(tax ID\)')), findsOneWidget);
    handle.dispose();
  });
}
