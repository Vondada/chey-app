// Rithmic market data, set up on the phone. Read-only: prices only, no order controls.
//
// Passwords and the developer key are saved in the on-device vault (lib/security/che_password_vault.dart) and are
// read here to connect. They are never sent to the Worker, a model or a log. The gateway address, system name and
// app identity are not secret and are kept in preferences. Nothing connects until the owner presses Connect.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../security/che_password_vault.dart';
import 'rithmic_client.dart';
import 'rithmic_wire.dart';

const kRithmicVaultSite = 'rithmic';
const kRithmicKeySite = 'rithmic-developer-key';

typedef RithmicFeedFactory = RithmicMarketFeed Function();

/// Where the Rithmic login and developer key live: the on-device vault in the app, a fake in tests.
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
  const CheRithmicScreen({super.key, this.feedFactory, this.store, this.preferences});

  /// Tests inject a fake feed; the app uses the real RithmicClient over the phone's network.
  final RithmicFeedFactory? feedFactory;
  final RithmicCredentialStore? store;
  final Future<SharedPreferences> Function()? preferences;

  @override
  State<CheRithmicScreen> createState() => _CheRithmicScreenState();
}

class _CheRithmicScreenState extends State<CheRithmicScreen> {
  final _gateway = TextEditingController();
  final _system = TextEditingController();
  final _login = TextEditingController();
  final _password = TextEditingController();
  final _appName = TextEditingController(text: 'CHE');
  final _appVersion = TextEditingController(text: '1.0');
  final _symbol = TextEditingController(text: 'MNQZ6');
  final _exchange = TextEditingController(text: 'CME');
  final _devKey = TextEditingController();

  RithmicCredentialStore get _vault => widget.store ?? const CheVaultCredentialStore();
  RithmicMarketFeed? _feed;
  StreamSubscription<RithmicLastTrade>? _tradeSub;
  String _status = 'Not connected.';
  String _error = '';
  String _savedNote = '';
  double? _lastPrice;
  bool _up = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tradeSub?.cancel();
    _feed?.close();
    for (final c in [_gateway, _system, _login, _password, _appName, _appVersion, _symbol, _exchange, _devKey]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final prefs = await (widget.preferences?.call() ?? SharedPreferences.getInstance());
    final entry = await _vault.find(kRithmicVaultSite);
    if (!mounted) return;
    setState(() {
      _gateway.text = prefs.getString('che_rithmic_gateway') ?? '';
      _system.text = prefs.getString('che_rithmic_system') ?? '';
      _appName.text = prefs.getString('che_rithmic_app_name') ?? _appName.text;
      _appVersion.text = prefs.getString('che_rithmic_app_version') ?? _appVersion.text;
      _symbol.text = prefs.getString('che_rithmic_symbol') ?? _symbol.text;
      _exchange.text = prefs.getString('che_rithmic_exchange') ?? _exchange.text;
      _login.text = entry?.username ?? '';
      _savedNote = entry == null ? 'No Rithmic login saved yet.' : 'Login and password are saved in the vault on this phone.';
    });
  }

  /// Saves the settings and the secrets. Blank password or key fields keep what is already saved.
  Future<void> _save() async {
    setState(() => _error = '');
    try {
      final prefs = await (widget.preferences?.call() ?? SharedPreferences.getInstance());
      await prefs.setString('che_rithmic_gateway', _gateway.text.trim());
      await prefs.setString('che_rithmic_system', _system.text.trim());
      await prefs.setString('che_rithmic_app_name', _appName.text.trim());
      await prefs.setString('che_rithmic_app_version', _appVersion.text.trim());
      await prefs.setString('che_rithmic_symbol', _symbol.text.trim());
      await prefs.setString('che_rithmic_exchange', _exchange.text.trim());
      if (_login.text.trim().isNotEmpty && _password.text.isNotEmpty) {
        await _vault.save(CheVaultEntry(site: kRithmicVaultSite, username: _login.text.trim(), password: _password.text));
        _password.clear();
      }
      if (_devKey.text.isNotEmpty) {
        await _vault.save(CheVaultEntry(site: kRithmicKeySite, password: _devKey.text));
        _devKey.clear();
      }
      if (!mounted) return;
      setState(() => _savedNote = 'Saved. The password and developer key stay in the vault on this phone.');
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not save: $e');
    }
  }

  Future<void> _connect() async {
    setState(() {
      _busy = true;
      _error = '';
      _status = 'Connecting to Rithmic…';
    });
    try {
      final gateway = _gateway.text.trim();
      final uri = Uri.tryParse(gateway);
      if (uri == null || uri.scheme != 'wss') {
        throw const FormatException('The gateway address must start with wss://. Paste it from your Rithmic developer kit.');
      }
      final entry = await _vault.find(kRithmicVaultSite);
      if (entry == null) throw StateError('No Rithmic login is saved. Enter the login and password, then press Save.');
      final feed = widget.feedFactory?.call() ?? RithmicClient(uri: uri);
      _feed = feed;
      await feed.connect(
        user: entry.username,
        password: entry.password,
        systemName: _system.text.trim(),
        appName: _appName.text.trim(),
        appVersion: _appVersion.text.trim(),
        symbol: _symbol.text.trim(),
        exchange: _exchange.text.trim(),
      );
      _tradeSub = feed.trades.listen((t) {
        if (!mounted || t.price == null) return;
        setState(() => _lastPrice = t.price);
      });
      if (!mounted) return;
      setState(() {
        _up = true;
        _status = 'Connected: live market data for ${_symbol.text.trim()} on ${_exchange.text.trim()}.';
      });
    } catch (e) {
      await _tradeSub?.cancel();
      _tradeSub = null;
      await _feed?.close();
      _feed = null;
      if (mounted) {
        setState(() {
          _up = false;
          _status = 'Not connected.';
          _error = e is FormatException || e is StateError ? e.toString() : 'Rithmic did not connect: $e';
        });
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
    await feed?.close();
    if (mounted) {
      setState(() {
        _up = false;
        _status = 'Disconnected. Nothing is streaming.';
      });
    }
  }

  Widget _field(TextEditingController c, String label, {bool secret = false, String hint = ''}) => Semantics(
        textField: true,
        label: label,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: TextField(
            controller: c,
            obscureText: secret,
            autocorrect: false,
            enableSuggestions: !secret,
            decoration: InputDecoration(labelText: label, hintText: hint, border: const OutlineInputBorder()),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Rithmic market data')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          Text('Read-only prices from your Rithmic account. Your password stays on this phone. CHE places no orders from here.',
              style: theme.textTheme.bodyMedium),
          const SizedBox(height: 12),
          _field(_gateway, 'Gateway address (wss://…)', hint: 'from your Rithmic developer kit'),
          _field(_system, 'System name', hint: 'e.g. the Rithmic system your broker gives you'),
          _field(_login, 'Login'),
          _field(_password, 'Password', secret: true, hint: 'leave blank to keep the saved one'),
          _field(_appName, 'App name'),
          _field(_appVersion, 'App version'),
          _field(_symbol, 'Front-month contract (e.g. MNQZ6 or NQZ6)'),
          _field(_exchange, 'Exchange'),
          _field(_devKey, 'Developer key (optional)', secret: true, hint: 'leave blank to keep the saved one'),
          Wrap(spacing: 10, runSpacing: 10, children: [
            Semantics(
              button: true,
              label: 'Save Rithmic settings and login to the vault',
              child: OutlinedButton(onPressed: _busy ? null : _save, child: const Text('Save')),
            ),
            Semantics(
              button: true,
              label: 'Connect Rithmic market data',
              child: FilledButton(onPressed: _busy || _up ? null : _connect, child: const Text('Connect')),
            ),
            Semantics(
              button: true,
              label: 'Disconnect Rithmic',
              child: OutlinedButton(onPressed: _up ? _disconnect : null, child: const Text('Disconnect')),
            ),
          ]),
          const SizedBox(height: 16),
          Semantics(liveRegion: true, label: 'Rithmic status: $_status', child: Text(_status, style: theme.textTheme.titleSmall)),
          if (_lastPrice != null) Text('Last trade: ${_lastPrice!.toStringAsFixed(2)}', style: theme.textTheme.bodyLarge),
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
          Text(_savedNote, style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}
