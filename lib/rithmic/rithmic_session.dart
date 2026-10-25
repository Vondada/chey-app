// Opening the Rithmic market-data session, shared by the Rithmic screen (the owner's Connect) and the app launch
// (reconnecting a session the owner left on).
//
// - The owner signs in once. After Rithmic accepts the login, the password sits in the on-device vault and the session
//   comes back by itself when CHE launches or returns to the screen and finds the socket dropped.
// - Disconnect is the owner's sign-out: it turns the automatic reconnect off until he presses Connect again.
// - A login Rithmic refuses turns the automatic reconnect off as well, so CHE never retries a bad password.
// - The password never leaves the phone: not the Worker, not a model, not a log.
import 'package:shared_preferences/shared_preferences.dart';

import '../security/che_password_vault.dart';
import 'rithmic_client.dart';
import 'rithmic_live.dart';

const kRithmicVaultSite = 'rithmic';

/// On after a Connect Rithmic accepted; off after Disconnect or a refused login.
const kRithmicAutoConnectKey = 'che_rithmic_auto_connect';

typedef RithmicFeedFactory = RithmicMarketFeed Function(Uri gateway);

/// Where the Rithmic login lives: the on-device vault in the app, a fake in tests.
abstract class RithmicCredentialStore {
  Future<CheVaultEntry?> find(String site);
  Future<void> save(CheVaultEntry entry);
}

class CheVaultCredentialStore implements RithmicCredentialStore {
  const CheVaultCredentialStore();
  @override
  Future<CheVaultEntry?> find(String site) => CheVault.instance.find(site);
  @override
  Future<void> save(CheVaultEntry entry) => CheVault.instance.save(entry);
}

/// What a connection needs besides the login: the account label and the Advanced overrides (blank means automatic).
class RithmicSettings {
  const RithmicSettings({
    this.label = '',
    this.gateway = '',
    this.system = '',
    this.symbolOverride = '',
    this.exchange = 'CME',
    this.appName = '',
    this.appVersion = '',
  });

  final String label, gateway, system, symbolOverride, exchange, appName, appVersion;

  static RithmicSettings fromPrefs(SharedPreferences prefs) => RithmicSettings(
        label: prefs.getString('che_rithmic_label') ?? '',
        gateway: prefs.getString('che_rithmic_gateway') ?? '',
        system: prefs.getString('che_rithmic_system') ?? '',
        symbolOverride: prefs.getString('che_rithmic_symbol_override') ?? '',
        exchange: prefs.getString('che_rithmic_exchange') ?? 'CME',
        appName: prefs.getString('che_rithmic_app_name') ?? '',
        appVersion: prefs.getString('che_rithmic_app_version') ?? '',
      );

  Future<void> save(SharedPreferences prefs, {required String exchangeUsed}) async {
    await prefs.setString('che_rithmic_label', label);
    await prefs.setString('che_rithmic_gateway', gateway);
    await prefs.setString('che_rithmic_system', system);
    await prefs.setString('che_rithmic_symbol_override', symbolOverride);
    await prefs.setString('che_rithmic_exchange', exchangeUsed);
    await prefs.setString('che_rithmic_app_name', appName);
    await prefs.setString('che_rithmic_app_version', appVersion);
  }
}

class RithmicOpened {
  const RithmicOpened(this.feed, this.route, this.symbol, this.exchange);
  final RithmicMarketFeed feed;
  final RithmicRoute route;
  final String symbol, exchange;
}

/// Finds the route and logs in. On failure the half-open feed is closed and the error rethrown.
Future<RithmicOpened> cheRithmicOpen({
  required String user,
  required String password,
  required RithmicSettings settings,
  RithmicRouteFinder? routeFinder,
  RithmicFeedFactory? feedFactory,
  DateTime Function()? now,
  void Function(RithmicMarketFeed feed)? onFeed,
}) async {
  if (user.isEmpty) throw const RithmicException(RithmicFailure.badLogin, 'Enter your Rithmic username or trader code.');
  if (password.isEmpty) throw const RithmicException(RithmicFailure.badLogin, 'Enter your Rithmic password.');

  // The route: the Advanced override when one is set, otherwise Rithmic's own discovery.
  final RithmicRoute route;
  final manual = settings.gateway.trim();
  final system = settings.system.trim();
  if (manual.isNotEmpty) {
    final uri = Uri.tryParse(manual);
    if (uri == null || uri.scheme != 'wss') {
      throw const RithmicException(RithmicFailure.connection, 'The Advanced gateway address must start with wss://. Leave it blank to find it automatically.');
    }
    if (system.isEmpty) {
      throw const RithmicException(RithmicFailure.systemUnavailable, 'With a manual gateway, also enter the system name under Advanced.');
    }
    route = RithmicRoute(system: system, gatewayName: 'manual', gatewayUri: uri);
  } else {
    final preferPaper = RegExp(r'fund\s*your\s*edge|fye|paper|evaluation|prop', caseSensitive: false).hasMatch(settings.label);
    final found = await (routeFinder ?? RithmicBootstrapDiscovery()).find(preferPaper: preferPaper);
    route = system.isEmpty ? found : RithmicRoute(system: system, gatewayName: found.gatewayName, gatewayUri: found.gatewayUri);
  }
  final symbol = settings.symbolOverride.trim().isEmpty
      ? rithmicFrontMonth('MNQ', (now ?? DateTime.now)())
      : settings.symbolOverride.trim().toUpperCase();
  final exchange = settings.exchange.trim().isEmpty ? 'CME' : settings.exchange.trim().toUpperCase();

  final feed = feedFactory?.call(route.gatewayUri) ?? RithmicClient(uri: route.gatewayUri);
  onFeed?.call(feed);
  try {
    await feed.connect(
      user: user,
      password: password,
      systemName: route.system,
      appName: settings.appName.trim().isEmpty ? kRithmicAppName : settings.appName.trim(),
      appVersion: settings.appVersion.trim().isEmpty ? kRithmicAppVersion : settings.appVersion.trim(),
      symbol: symbol,
      exchange: exchange,
    );
  } catch (_) {
    await feed.close();
    rethrow;
  }
  return RithmicOpened(feed, route, symbol, exchange);
}

/// The outcome of an automatic reconnect, for the quiet status line (never spoken unprompted).
enum RithmicResume { notWanted, alreadyLive, noSavedLogin, connected, failed, signInAgain }

/// Brings back the session the owner left on, using the login saved in the vault. Does nothing after a Disconnect,
/// while a session is attached, or without a saved login. A refused login turns the automatic reconnect off.
Future<RithmicResume> cheRithmicResume({
  CheRithmicLive? live,
  RithmicCredentialStore store = const CheVaultCredentialStore(),
  Future<SharedPreferences> Function()? preferences,
  RithmicRouteFinder? routeFinder,
  RithmicFeedFactory? feedFactory,
  DateTime Function()? now,
}) async {
  final session = live ?? CheRithmicLive.instance;
  if (session.attached) return RithmicResume.alreadyLive;
  final prefs = await (preferences?.call() ?? SharedPreferences.getInstance());
  if (prefs.getBool(kRithmicAutoConnectKey) != true) {
    session.notConnected('the automatic reconnect is off (Disconnect was pressed, or no session was started yet). Open Rithmic and press Connect');
    return RithmicResume.notWanted;
  }
  final saved = await store.find(kRithmicVaultSite);
  if (saved == null || saved.username.isEmpty || saved.password.isEmpty) {
    session.notConnected('no Rithmic login is saved on this phone. Open Rithmic and sign in');
    return RithmicResume.noSavedLogin;
  }
  if (_resuming) return RithmicResume.failed;
  _resuming = true;
  try {
    final opened = await cheRithmicOpen(
      user: saved.username,
      password: saved.password,
      settings: RithmicSettings.fromPrefs(prefs),
      routeFinder: routeFinder,
      feedFactory: feedFactory,
      now: now,
    );
    if (session.attached) {
      // The owner connected by hand while this was in flight: keep his session.
      await opened.feed.close();
      return RithmicResume.alreadyLive;
    }
    session.attach(opened.feed, symbol: opened.symbol, exchange: opened.exchange);
    return RithmicResume.connected;
  } on RithmicException catch (e) {
    final refused = e.kind == RithmicFailure.badLogin || e.kind == RithmicFailure.loginRejected;
    if (refused) {
      await prefs.setBool(kRithmicAutoConnectKey, false);
      session.loginFailed('Rithmic refused the saved login. Open Rithmic and sign in again.');
      return RithmicResume.signInAgain;
    }
    session.loginFailed('Could not reconnect to Rithmic: ${e.message}');
    return RithmicResume.failed;
  } catch (e) {
    // Offline or the gateway is down: the login stays saved and CHE tries again on the next launch or return.
    session.loginFailed('Could not reconnect to Rithmic right now (offline or gateway down).');
    return RithmicResume.failed;
  } finally {
    _resuming = false;
  }
}

bool _resuming = false;

/// One step of "Diagnose Rithmic": what was checked, whether it passed, and the plain reason.
class RithmicCheck {
  const RithmicCheck(this.step, this.ok, this.detail);
  final String step;
  final bool? ok; // null: not run, because an earlier step decides it
  final String detail;
}

/// "Diagnose Rithmic": the four things that decide whether the session comes back, in order, each with its real
/// result: a saved login, the automatic reconnect setting, the socket to Rithmic's gateway, and Rithmic's answer to
/// the login. Uses the same route finder and client as Connect. Never shows or sends the password; the username is
/// masked. A test session opened here is closed again, so nothing changes; a live session is left untouched.
Future<List<RithmicCheck>> cheRithmicDiagnose({
  CheRithmicLive? live,
  RithmicCredentialStore store = const CheVaultCredentialStore(),
  Future<SharedPreferences> Function()? preferences,
  RithmicRouteFinder? routeFinder,
  RithmicFeedFactory? feedFactory,
  DateTime Function()? now,
}) async {
  final session = live ?? CheRithmicLive.instance;
  final prefs = await (preferences?.call() ?? SharedPreferences.getInstance());
  final saved = await store.find(kRithmicVaultSite);
  final hasLogin = saved != null && saved.username.isNotEmpty && saved.password.isNotEmpty;
  final masked = hasLogin ? '${saved.username.substring(0, saved.username.length < 2 ? saved.username.length : 2)}••••' : '';
  final auto = prefs.getBool(kRithmicAutoConnectKey) == true;
  final out = <RithmicCheck>[
    RithmicCheck('Saved login', hasLogin, hasLogin ? 'A Rithmic login ($masked) is saved in the vault on this phone.' : 'No Rithmic login is saved on this phone. Open Rithmic and sign in once.'),
    RithmicCheck('Automatic reconnect', auto, auto ? 'On: CHE reconnects by itself when it opens.' : 'Off: Disconnect was pressed, a login was refused, or no session was started yet. Press Connect to turn it on.'),
  ];
  if (session.attached) {
    return [
      ...out,
      RithmicCheck('Socket to Rithmic', true, 'A session is live now (${session.symbol} on ${session.exchange}); it was not touched.'),
      const RithmicCheck('Login response', true, 'Rithmic accepted the login for the live session.'),
    ];
  }
  if (!hasLogin) {
    return [...out, const RithmicCheck('Socket to Rithmic', null, 'Not tried: there is no saved login to test.'), const RithmicCheck('Login response', null, 'Not tried.')];
  }
  try {
    final opened = await cheRithmicOpen(
      user: saved.username,
      password: saved.password,
      settings: RithmicSettings.fromPrefs(prefs),
      routeFinder: routeFinder,
      feedFactory: feedFactory,
      now: now,
    );
    await opened.feed.close();
    return [
      ...out,
      RithmicCheck('Socket to Rithmic', true, 'Reached ${opened.route.system} through ${opened.route.gatewayName}.'),
      RithmicCheck('Login response', true, 'Rithmic accepted the saved login.${auto ? '' : ' The automatic reconnect is off, so press Connect once to stay connected.'}'),
    ];
  } on RithmicException catch (e) {
    final socket = e.kind == RithmicFailure.connection || e.kind == RithmicFailure.gatewayDiscovery || e.kind == RithmicFailure.systemUnavailable;
    return [
      ...out,
      RithmicCheck('Socket to Rithmic', !socket, socket ? e.message : 'The gateway answered.'),
      RithmicCheck('Login response', socket ? null : false, socket ? 'Not reached: the socket did not open.' : e.message),
    ];
  } catch (_) {
    return [...out, const RithmicCheck('Socket to Rithmic', false, 'Could not reach Rithmic (offline, or the gateway is down).'), const RithmicCheck('Login response', null, 'Not reached.')];
  }
}

/// "Diagnose Rithmic", "check my Rithmic connection", "why isn't Rithmic connecting".
bool cheRithmicDiagnoseCommand(String message) => RegExp(
      r"\b(?:diagnose|troubleshoot|test|check)\s+(?:my\s+|the\s+)?rithmic\b|\bwhy\s+(?:is(?:n'?t| not)|won'?t|doesn'?t|does not)\s+rithmic\s+(?:connect|work)",
      caseSensitive: false,
    ).hasMatch(message.replaceAll('’', "'"));

/// The spoken and shown summary: the first failing step, then each step in order.
String cheRithmicDiagnosisText(List<RithmicCheck> checks) {
  final bad = checks.where((c) => c.ok == false).toList();
  final head = bad.isEmpty ? 'Rithmic diagnosis: every check passed.' : 'Rithmic diagnosis: ${bad.first.step} failed.';
  final lines = [
    for (var i = 0; i < checks.length; i++) '${i + 1}. ${checks[i].step}: ${checks[i].ok == null ? 'not tried' : checks[i].ok! ? 'OK' : 'failed'}. ${checks[i].detail}',
  ];
  return '$head ${lines.join(' ')}';
}
