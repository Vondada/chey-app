// Owner (2026-10-23, "CHE UI Refinement" items 11-17): sign in once. Closing and reopening CHE, backgrounding,
// rebooting and launching offline keep the sign-in; only logout, a revoked device or a refused login end it. Tokens
// live in protected storage, never in plain preferences.
import 'dart:async';

import 'package:chey/rithmic/rithmic_client.dart';
import 'package:chey/rithmic/rithmic_live.dart';
import 'package:chey/rithmic/rithmic_session.dart';
import 'package:chey/rithmic/rithmic_wire.dart';
import 'package:chey/security/che_password_vault.dart';
import 'package:chey/security/che_session_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The Keychain: survives app restarts and reboots (it is the same map across "cold starts").
class FakeKeychain implements CheSecureKv {
  final items = <String, String>{};
  bool locked = false; // before the first unlock after a reboot
  bool dropWrites = false;
  @override
  Future<String?> read(String key) async {
    if (locked) throw StateError('errSecInteractionNotAllowed');
    return items[key];
  }

  @override
  Future<void> write(String key, String value) async {
    if (locked) throw StateError('errSecInteractionNotAllowed');
    if (!dropWrites) items[key] = value;
  }

  @override
  Future<void> delete(String key) async => items.remove(key);
}

const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';

void main() {
  late FakeKeychain keychain;
  CheSessionStore coldStart() => CheSessionStore(kv: keychain); // a fresh app process, same device storage

  setUp(() {
    keychain = FakeKeychain();
    SharedPreferences.setMockInitialValues({});
  });

  group('Worker sign-in', () {
    test('after pairing once, a restart or reboot restores the sign-in from the Keychain, not plain preferences', () async {
      await coldStart().save(token);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(CheSessionStore.tokenKey), isNull, reason: 'never in plain storage');
      expect(keychain.items[CheSessionStore.tokenKey], token);

      for (var launch = 0; launch < 3; launch++) {
        expect(await coldStart().deviceToken(), token, reason: 'launch $launch restores without pairing');
      }
      expect(await coldStart().lastEnd(), CheSessionEnd.none);
    });

    test('an older build\'s plain token moves to the Keychain once and the plain copy is deleted', () async {
      SharedPreferences.setMockInitialValues({CheSessionStore.tokenKey: token});
      expect(await coldStart().deviceToken(), token);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(CheSessionStore.tokenKey), isNull);
      expect(keychain.items[CheSessionStore.tokenKey], token);
      expect(await coldStart().deviceToken(), token, reason: 'next launch reads the Keychain');
    });

    test('if the Keychain did not keep the write, the plain copy is not deleted (the owner stays signed in)', () async {
      SharedPreferences.setMockInitialValues({CheSessionStore.tokenKey: token});
      keychain.dropWrites = true;
      expect(await coldStart().deviceToken(), token);
      expect((await SharedPreferences.getInstance()).getString(CheSessionStore.tokenKey), token);
    });

    test('a launch before the first unlock after a reboot deletes nothing and signs in once the device unlocks', () async {
      await coldStart().save(token);
      keychain.locked = true;
      final early = coldStart();
      expect(await early.deviceToken(), isNull, reason: 'cannot read yet');
      expect(keychain.items[CheSessionStore.tokenKey], token, reason: 'nothing was deleted');
      keychain.locked = false;
      expect(await early.deviceToken(), token, reason: 'the next read after unlock restores it');
    });

    test('logout (unpair) clears the sign-in everywhere and it stays signed out across restarts', () async {
      final store = coldStart();
      await store.save(token);
      await store.clear(CheSessionEnd.unpaired);
      expect(keychain.items, isEmpty);
      final next = coldStart();
      expect(await next.deviceToken(), isNull, reason: 'no automatic sign-in after logout');
      expect(await next.lastEnd(), CheSessionEnd.unpaired);
      expect(cheSessionEndMessage(CheSessionEnd.unpaired), contains('signed this phone out'));
    });

    test('pairing again clears the signed-out note', () async {
      final store = coldStart();
      await store.clear(CheSessionEnd.revoked);
      await store.save(token);
      expect(await coldStart().lastEnd(), CheSessionEnd.none);
      expect(await coldStart().deviceToken(), token);
    });

    test('only an unknown or revoked device ends the sign-in; Face ID requests, server errors and offline do not', () {
      expect(cheSessionRevoked(401, '{"detail":"Pair your phone to CHE."}'), isTrue);
      expect(cheSessionRevoked(401, '{"detail":"This CHE device was revoked."}'), isTrue);
      expect(cheSessionRevoked(401, '{"detail":"This needs Face ID first (no session).","reason":"no_session","needs_scope":"security"}'), isFalse);
      for (final status in [0, 200, 403, 408, 429, 500, 502, 503, 504]) {
        expect(cheSessionRevoked(status, ''), isFalse, reason: '$status keeps the sign-in');
      }
      expect(cheSessionEndMessage(CheSessionEnd.revoked), contains('Pair again'));
    });

    test('the token never appears in what the owner is shown', () {
      for (final why in CheSessionEnd.values) {
        expect(cheSessionEndMessage(why), isNot(contains(token)));
      }
    });
  });

  group('Rithmic sign-in', () {
    late FakeStore store;
    late CheRithmicLive live;
    late List<FakeFeed> feeds;

    setUp(() {
      store = FakeStore();
      live = CheRithmicLive();
      feeds = [];
    });

    Future<RithmicResume> launch({Object? error, Map<String, Object> prefs = const {}}) {
      return cheRithmicResume(
        live: live,
        store: store,
        preferences: SharedPreferences.getInstance,
        routeFinder: FakeFinder(),
        feedFactory: (_) {
          final f = FakeFeed(error: error);
          feeds.add(f);
          return f;
        },
        now: () => DateTime.utc(2026, 10, 23, 14),
      );
    }

    test('first launch with no sign-in yet connects nothing', () async {
      expect(await launch(), RithmicResume.notWanted);
      expect(feeds, isEmpty);
      expect(live.attached, isFalse);
    });

    test('after a Connect Rithmic accepted, the next launch reconnects with the vault login', () async {
      SharedPreferences.setMockInitialValues({kRithmicAutoConnectKey: true, 'che_rithmic_label': 'FundYourEdge / Rithmic'});
      store.saved[kRithmicVaultSite] = const CheVaultEntry(site: kRithmicVaultSite, username: 'FYE123', password: 'pw');
      expect(await launch(), RithmicResume.connected);
      expect(feeds.single.user, 'FYE123');
      expect(live.attached, isTrue);
      expect(feeds.single.symbol, 'MNQZ6');
      expect(await launch(), RithmicResume.alreadyLive, reason: 'a resume while connected does nothing');
      expect(feeds, hasLength(1));
    });

    test('Disconnect is a sign-out: no automatic reconnect afterwards', () async {
      SharedPreferences.setMockInitialValues({kRithmicAutoConnectKey: false});
      store.saved[kRithmicVaultSite] = const CheVaultEntry(site: kRithmicVaultSite, username: 'FYE123', password: 'pw');
      expect(await launch(), RithmicResume.notWanted);
      expect(feeds, isEmpty);
    });

    test('offline launch keeps the login and the automatic reconnect for next time', () async {
      SharedPreferences.setMockInitialValues({kRithmicAutoConnectKey: true});
      store.saved[kRithmicVaultSite] = const CheVaultEntry(site: kRithmicVaultSite, username: 'FYE123', password: 'pw');
      expect(await launch(error: const SocketExceptionLike()), RithmicResume.failed);
      expect(feeds.single.closed, isTrue);
      expect((await SharedPreferences.getInstance()).getBool(kRithmicAutoConnectKey), isTrue);
      expect(store.saved, contains(kRithmicVaultSite));
      expect(live.statusLabel, contains('offline'));
    });

    test('a refused login turns the automatic reconnect off and asks the owner to sign in again', () async {
      SharedPreferences.setMockInitialValues({kRithmicAutoConnectKey: true});
      store.saved[kRithmicVaultSite] = const CheVaultEntry(site: kRithmicVaultSite, username: 'FYE123', password: 'old');
      final refused = launch(error: const RithmicException(RithmicFailure.badLogin, 'Rithmic rejected the username or password (13).'));
      expect(await refused, RithmicResume.signInAgain);
      expect((await SharedPreferences.getInstance()).getBool(kRithmicAutoConnectKey), isFalse);
      expect(live.statusLabel, contains('sign in again'));
      expect(live.statusLabel, isNot(contains('old')), reason: 'the password is never shown');
      expect(await launch(), RithmicResume.notWanted, reason: 'a bad password is never retried');
    });

    test('a saved setting without a vault login connects nothing', () async {
      SharedPreferences.setMockInitialValues({kRithmicAutoConnectKey: true});
      expect(await launch(), RithmicResume.noSavedLogin);
      expect(feeds, isEmpty);
    });
  });
}

class SocketExceptionLike implements Exception {
  const SocketExceptionLike();
  @override
  String toString() => 'SocketException: Network is unreachable';
}

class FakeStore implements RithmicCredentialStore {
  final saved = <String, CheVaultEntry>{};
  @override
  Future<CheVaultEntry?> find(String site) async => saved[site];
  @override
  Future<void> save(CheVaultEntry entry) async => saved[entry.site] = entry;
}

class FakeFeed implements RithmicMarketFeed {
  FakeFeed({this.error});
  final Object? error;
  final _trades = StreamController<RithmicLastTrade>.broadcast();
  final _quotes = StreamController<RithmicBestBidOffer>.broadcast();
  String? user, symbol;
  bool closed = false;
  @override
  Stream<RithmicLastTrade> get trades => _trades.stream;
  @override
  Stream<RithmicBestBidOffer> get quotes => _quotes.stream;
  @override
  bool get subscriptionConfirmed => true;
  @override
  Future<void> connect({required String user, required String password, required String systemName, required String appName, required String appVersion, required String symbol, required String exchange}) async {
    this.user = user;
    this.symbol = symbol;
    if (error != null) throw error!;
  }

  @override
  Future<void> close() async => closed = true;
}

class FakeFinder implements RithmicRouteFinder {
  @override
  Future<RithmicRoute> find({required bool preferPaper}) async =>
      RithmicRoute(system: 'Rithmic Paper Trading', gatewayName: 'Chicago Area', gatewayUri: Uri.parse('wss://chicago.example:443'));
}
