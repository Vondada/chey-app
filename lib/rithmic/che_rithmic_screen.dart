// Rithmic market data, set up on the phone. Read-only: prices only, no order controls.
//
// Routine use is a normal login: an account label, the username (trader code) and the password, then Connect. The
// Rithmic system and gateway are discovered from Rithmic's bootstrap endpoint and the front-month contract is worked
// out from the date (rithmic_client.dart). Advanced keeps manual overrides for debugging, hidden by default.
//
// The password is saved in the on-device vault (lib/security/che_password_vault.dart), and only after Rithmic accepted
// it. It is never sent to the Worker, a model or a log. The label and Advanced overrides are not secret and are kept in
// preferences. Nothing connects until the owner presses Connect.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../security/che_password_vault.dart';
import 'rithmic_client.dart';
import 'rithmic_live.dart';
import 'rithmic_recorder.dart';
import 'rithmic_wire.dart';

const kRithmicVaultSite = 'rithmic';

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

class CheRithmicScreen extends StatefulWidget {
  const CheRithmicScreen({super.key, this.feedFactory, this.routeFinder, this.store, this.preferences, this.now, this.live});

  /// Tests inject a fake feed and route finder; the app uses the real client over the phone's network.
  final RithmicFeedFactory? feedFactory;
  final RithmicRouteFinder? routeFinder;
  final RithmicCredentialStore? store;
  final Future<SharedPreferences> Function()? preferences;
  final DateTime Function()? now;

  /// The shared live session the Trading Room chart draws from; tests pass their own.
  final CheRithmicLive? live;

  @override
  State<CheRithmicScreen> createState() => _CheRithmicScreenState();
}

class _CheRithmicScreenState extends State<CheRithmicScreen> {
  final _label = TextEditingController(text: 'FundYourEdge / Rithmic');
  final _login = TextEditingController();
  final _password = TextEditingController();
  // Advanced (manual override and debugging). Blank means automatic.
  final _gateway = TextEditingController();
  final _system = TextEditingController();
  final _symbol = TextEditingController();
  final _exchange = TextEditingController(text: 'CME');
  final _appName = TextEditingController(text: kRithmicAppName);
  final _appVersion = TextEditingController(text: kRithmicAppVersion);

  RithmicCredentialStore get _vault => widget.store ?? const CheVaultCredentialStore();
  CheRithmicLive get _live => widget.live ?? CheRithmicLive.instance;
  RithmicMarketFeed? _feed;
  StreamSubscription<RithmicLastTrade>? _tradeSub;
  String _status = 'Not connected.';
  List<String> _details = const [];
  String _error = '';
  String _savedNote = '';
  double? _lastPrice;
  bool _up = false;
  bool _busy = false;

  List<TextEditingController> get _all => [_label, _login, _password, _gateway, _system, _symbol, _exchange, _appName, _appVersion];

  String get _autoSymbol => rithmicFrontMonth('MNQ', (widget.now ?? DateTime.now)());

  @override
  void initState() {
    super.initState();
    // A connection made earlier keeps streaming to the chart after this screen closes; coming back shows it.
    if (_live.attached) {
      _up = true;
      _status = 'Connected.';
      _details = ['Live data: ${_live.symbol} on ${_live.exchange}, streaming to the Trading Room chart.', 'Read-only prices. Balances and orders are not connected here.'];
    }
    _load();
  }

  @override
  void dispose() {
    _tradeSub?.cancel();
    // The connected feed belongs to the shared live session (the chart keeps using it); only an unhanded one closes.
    if (_feed != null && !_live.attached) _feed?.close();
    for (final c in _all) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final prefs = await (widget.preferences?.call() ?? SharedPreferences.getInstance());
    final entry = await _vault.find(kRithmicVaultSite);
    if (!mounted) return;
    setState(() {
      _label.text = prefs.getString('che_rithmic_label') ?? _label.text;
      _gateway.text = prefs.getString('che_rithmic_gateway') ?? '';
      _system.text = prefs.getString('che_rithmic_system') ?? '';
      _symbol.text = prefs.getString('che_rithmic_symbol_override') ?? '';
      _exchange.text = prefs.getString('che_rithmic_exchange') ?? _exchange.text;
      _appName.text = prefs.getString('che_rithmic_app_name') ?? _appName.text;
      _appVersion.text = prefs.getString('che_rithmic_app_version') ?? _appVersion.text;
      _login.text = entry?.username ?? '';
      _savedNote = entry == null ? 'No Rithmic login saved yet.' : 'Your login is saved in the vault on this phone.';
    });
  }

  /// Every action's result is shown, announced to VoiceOver and felt, so it is known without looking.
  void _report(String said, {required bool ok}) {
    if (ok) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    unawaited(SemanticsService.sendAnnouncement(View.of(context), said, TextDirection.ltr));
  }

  Future<void> _connect() async {
    setState(() {
      _busy = true;
      _error = '';
      _details = const [];
      _status = 'Connecting to Rithmic…';
    });
    RithmicMarketFeed? feed;
    try {
      final saved = await _vault.find(kRithmicVaultSite);
      final user = _login.text.trim().isNotEmpty ? _login.text.trim() : (saved?.username ?? '');
      final typed = _password.text;
      final password = typed.isNotEmpty ? typed : (saved != null && saved.username == user ? saved.password : '');
      if (user.isEmpty) throw const RithmicException(RithmicFailure.badLogin, 'Enter your Rithmic username or trader code.');
      if (password.isEmpty) throw const RithmicException(RithmicFailure.badLogin, 'Enter your Rithmic password.');

      // The route: the Advanced override when one is set, otherwise Rithmic's own discovery.
      final RithmicRoute route;
      final manual = _gateway.text.trim();
      if (manual.isNotEmpty) {
        final uri = Uri.tryParse(manual);
        if (uri == null || uri.scheme != 'wss') {
          throw const RithmicException(RithmicFailure.connection, 'The Advanced gateway address must start with wss://. Leave it blank to find it automatically.');
        }
        if (_system.text.trim().isEmpty) {
          throw const RithmicException(RithmicFailure.systemUnavailable, 'With a manual gateway, also enter the system name under Advanced.');
        }
        route = RithmicRoute(system: _system.text.trim(), gatewayName: 'manual', gatewayUri: uri);
      } else {
        final preferPaper = RegExp(r'fund\s*your\s*edge|fye|paper|evaluation|prop', caseSensitive: false).hasMatch(_label.text);
        final found = await (widget.routeFinder ?? RithmicBootstrapDiscovery()).find(preferPaper: preferPaper);
        route = _system.text.trim().isEmpty
            ? found
            : RithmicRoute(system: _system.text.trim(), gatewayName: found.gatewayName, gatewayUri: found.gatewayUri);
      }
      final symbol = _symbol.text.trim().isEmpty ? _autoSymbol : _symbol.text.trim().toUpperCase();
      final exchange = _exchange.text.trim().isEmpty ? 'CME' : _exchange.text.trim().toUpperCase();

      feed = widget.feedFactory?.call(route.gatewayUri) ?? RithmicClient(uri: route.gatewayUri);
      _feed = feed;
      await feed.connect(
        user: user,
        password: password,
        systemName: route.system,
        appName: _appName.text.trim().isEmpty ? kRithmicAppName : _appName.text.trim(),
        appVersion: _appVersion.text.trim().isEmpty ? kRithmicAppVersion : _appVersion.text.trim(),
        symbol: symbol,
        exchange: exchange,
      );

      // Rithmic accepted the login: only now is it saved, in the vault on this phone.
      if (typed.isNotEmpty || saved?.username != user) {
        await _vault.save(CheVaultEntry(site: kRithmicVaultSite, username: user, password: password));
      }
      _password.clear();
      final prefs = await (widget.preferences?.call() ?? SharedPreferences.getInstance());
      await prefs.setString('che_rithmic_label', _label.text.trim());
      await prefs.setString('che_rithmic_gateway', manual);
      await prefs.setString('che_rithmic_system', _system.text.trim());
      await prefs.setString('che_rithmic_symbol_override', _symbol.text.trim());
      await prefs.setString('che_rithmic_exchange', exchange);
      await prefs.setString('che_rithmic_app_name', _appName.text.trim());
      await prefs.setString('che_rithmic_app_version', _appVersion.text.trim());

      _live.attach(feed, symbol: symbol, exchange: exchange);
      _tradeSub = feed.trades.listen((t) {
        if (!mounted || t.price == null) return;
        setState(() => _lastPrice = t.price);
      });
      if (!mounted) return;
      final live = feed.subscriptionConfirmed
          ? 'Live data: $symbol on $exchange, confirmed by Rithmic.'
          : 'Live data: $symbol on $exchange requested; Rithmic has not confirmed it yet.';
      setState(() {
        _up = true;
        _status = 'Connected.';
        _details = [
          'System: ${route.system}',
          'Account: ${_label.text.trim().isEmpty ? 'Rithmic' : _label.text.trim()}',
          live,
          'The Trading Room MNQ PAPER chart now builds 1- and 5-minute candles from these trades.',
          CheRithmicLive.backgroundNote,
          CheRithmicRecorder.keptNote,
          'Read-only prices. Balances and orders are not connected here.',
        ];
        _savedNote = 'Your login is saved in the vault on this phone.';
      });
      _report('Rithmic connected on ${route.system}. $live', ok: true);
    } catch (e) {
      await _tradeSub?.cancel();
      _tradeSub = null;
      await (feed ?? _feed)?.close();
      _feed = null;
      final said = e is RithmicException ? e.message : 'Rithmic did not connect: $e. Nothing was saved.';
      _live.loginFailed(said);
      if (mounted) {
        setState(() {
          _up = false;
          _status = 'Not connected.';
          _error = said;
        });
        _report(said, ok: false);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _disconnect() async {
    // The subscription is dropped first; closing the feed is what stops the stream, so it is not held behind the cancel.
    unawaited(_tradeSub?.cancel());
    _tradeSub = null;
    final feed = _feed;
    _feed = null;
    if (_live.attached) {
      await _live.disconnect();
    } else {
      await feed?.close();
    }
    if (mounted) {
      setState(() {
        _up = false;
        _details = const [];
        _status = 'Disconnected. Nothing is streaming.';
      });
      _report('Rithmic disconnected. Nothing is streaming.', ok: true);
    }
  }

  Widget _field(TextEditingController c, String label, {bool secret = false, String hint = ''}) => Semantics(
        textField: true,
        label: label,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: TextField(
            controller: c,
            obscureText: secret,
            autocorrect: false,
            enableSuggestions: !secret,
            style: const TextStyle(fontSize: 18),
            decoration: InputDecoration(labelText: label, hintText: hint, border: const OutlineInputBorder()),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    const big = Size.fromHeight(56);
    return Scaffold(
      appBar: AppBar(title: const Text('Rithmic market data')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          Text('Sign in with your Rithmic login for read-only prices. Your password stays on this phone. CHE places no orders from here.',
              style: theme.textTheme.bodyLarge),
          const SizedBox(height: 14),
          _field(_label, 'Account label'),
          _field(_login, 'Username or trader code'),
          _field(_password, 'Password', secret: true, hint: 'leave blank to use the saved one'),
          Semantics(
            button: true,
            label: 'Connect to Rithmic market data',
            child: FilledButton(
              style: FilledButton.styleFrom(minimumSize: big, textStyle: const TextStyle(fontSize: 18)),
              onPressed: _busy || _up ? null : _connect,
              child: Text(_busy ? 'Connecting…' : 'Connect'),
            ),
          ),
          const SizedBox(height: 10),
          Semantics(
            button: true,
            label: 'Disconnect from Rithmic',
            child: OutlinedButton(
              style: OutlinedButton.styleFrom(minimumSize: big, textStyle: const TextStyle(fontSize: 18)),
              onPressed: _up ? _disconnect : null,
              child: const Text('Disconnect'),
            ),
          ),
          const SizedBox(height: 16),
          Semantics(
            liveRegion: true,
            label: 'Rithmic status: $_status ${_details.join(' ')}',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_status, style: theme.textTheme.titleMedium),
                for (final line in _details) Text(line, style: theme.textTheme.bodyLarge),
              ],
            ),
          ),
          if (_lastPrice != null) Text('Last trade: ${_lastPrice!.toStringAsFixed(2)}', style: theme.textTheme.titleMedium),
          if (_error.isNotEmpty)
            Semantics(
              liveRegion: true,
              label: 'Rithmic error: $_error',
              child: Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error, style: theme.textTheme.bodyLarge?.copyWith(color: theme.colorScheme.error)),
              ),
            ),
          const SizedBox(height: 12),
          Text(_savedNote, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 12),
          Semantics(
            label: 'Advanced Rithmic settings, for manual override and debugging',
            child: ExpansionTile(
              title: const Text('Advanced'),
              subtitle: Text('Found automatically. Contract now: $_autoSymbol'),
              childrenPadding: const EdgeInsets.only(top: 8),
              children: [
                _field(_gateway, 'Gateway address override (wss://…)', hint: 'blank: found automatically'),
                _field(_system, 'System name override', hint: 'blank: found automatically'),
                _field(_symbol, 'Contract override', hint: 'blank: $_autoSymbol, rolled automatically'),
                _field(_exchange, 'Exchange'),
                _field(_appName, 'App name'),
                _field(_appVersion, 'App version'),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
