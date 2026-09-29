import 'package:flutter_test/flutter_test.dart';
import 'package:chey/che_app_portal.dart';
import 'package:chey/rooms/che_theater_room.dart';
import 'package:chey/security/che_password_vault.dart';

void main() {
  group('Theater guard', () {
    test('blocks app jumps, downloads and cross-site redirects', () {
      final guard = CheTheaterGuard()..allowSite('https://www.example.com/watch');
      expect(guard.check('https://www.example.com/next', isMainFrame: true), CheTheaterVerdict.allow);
      expect(guard.check('https://cdn.example.com/player', isMainFrame: true), CheTheaterVerdict.allow);
      expect(guard.check('https://ads.badsite.io/win', isMainFrame: true), CheTheaterVerdict.blockRedirect);
      expect(guard.check('https://player.other.net/embed', isMainFrame: false), CheTheaterVerdict.allow);
      expect(guard.check('itms-services://?action=download', isMainFrame: true), CheTheaterVerdict.blockScheme);
      expect(guard.check('https://www.example.com/setup.apk', isMainFrame: false), CheTheaterVerdict.blockDownload);
      expect(guard.check('https://www.example.com/profile.mobileconfig', isMainFrame: true), CheTheaterVerdict.blockDownload);
    });

    test('owner can allow a site once', () {
      final guard = CheTheaterGuard()..allowSite('https://a.com');
      expect(guard.check('https://b.co.uk/x', isMainFrame: true), CheTheaterVerdict.blockRedirect);
      guard.allowSite('https://b.co.uk/x');
      expect(guard.check('https://www.b.co.uk/y', isMainFrame: true), CheTheaterVerdict.allow);
    });
  });

  group('Password vault commands', () {
    test('parses save with username and keeps password case', () {
      final c = CheVaultCommand.parse('Save my Gmail password Hunter2! username me@x.com')!;
      expect(c.kind, 'save');
      expect(c.site, 'gmail');
      expect(c.password, 'Hunter2!');
      expect(c.username, 'me@x.com');
    });

    test('parses Apple Passwords CSV exports', () {
      final rows = CheVault.parseCsv('Title,URL,Username,Password,Notes\r\n"Gmail","https://accounts.google.com","me@x.com","p,a""ss",""\n');
      expect(rows.length, 2);
      expect(rows[1][3], 'p,a"ss');
      expect(CheVaultCommand.parse('import my passwords')!.kind, 'import');
    });

    test('parses read, delete and list', () {
      expect(CheVaultCommand.parse("What's my Netflix password?")!.kind, 'read');
      expect(CheVaultCommand.parse("What's my Netflix password?")!.site, 'netflix');
      expect(CheVaultCommand.parse('delete my gmail password')!.kind, 'delete');
      expect(CheVaultCommand.parse('what passwords do you have')!.kind, 'list');
      expect(CheVaultCommand.parse('what is the weather'), isNull);
    });
  });

  group('Web versions of apps', () {
    test('whole-word matching and new web apps', () {
      expect(cheAppForName('netflix')!.name, 'Netflix');
      expect(cheAppForName('gmail')!.webUrl, 'https://mail.google.com');
      expect(cheAppForName('whatsapp')!.webUrl, 'https://web.whatsapp.com');
      expect(cheAppForName('x')!.name, 'X');
      expect(cheNoWebVersionReason('iwebtv'), isNotNull);
    });
  });
}
