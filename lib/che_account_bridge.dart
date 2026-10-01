import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_app_portal.dart';
import 'che_theme.dart';

class CheAccountBridge {
  static const MethodChannel _channel = MethodChannel('che/account_bridge');

  static Future<bool> authenticate({
    String reason = 'Unlock CHE accounts',
    bool requireFaceId = false,
  }) async {
    try {
      return (await _channel.invokeMethod<bool>('authenticate', {
            'reason': reason,
            'requireFaceId': requireFaceId,
          })) ??
          false;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> setSecret(String key, String value) async {
    try {
      return (await _channel.invokeMethod<bool>('secureSet', {'key': key, 'value': value})) ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<String?> getSecret(String key) async {
    try {
      return await _channel.invokeMethod<String>('secureGet', {'key': key});
    } catch (_) {
      return null;
    }
  }

  static Future<bool> deleteSecret(String key) async {
    try {
      return (await _channel.invokeMethod<bool>('secureDelete', {'key': key})) ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<void> open(BuildContext context) async {
    await Navigator.of(context).push<void>(
      CupertinoPageRoute(builder: (_) => const CheAccountBridgeScreen()),
    );
  }
}

class CheAccountBridgeScreen extends StatefulWidget {
  const CheAccountBridgeScreen({super.key});

  @override
  State<CheAccountBridgeScreen> createState() => _CheAccountBridgeScreenState();
}

class _CheAccountBridgeScreenState extends State<CheAccountBridgeScreen> {
  bool unlocked = false;
  bool busy = false;

  Future<void> _unlock() async {
    if (busy) return;
    setState(() => busy = true);
    final ok = await CheAccountBridge.authenticate(
      reason: 'Use Face ID to unlock CHE connected accounts',
    );
    if (!mounted) return;
    setState(() {
      unlocked = ok;
      busy = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bgDeep,
      appBar: AppBar(title: const Text('CHE Account Bridge')),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: CheColors.panel,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: Colors.white10),
            ),
            child: Column(
              children: [
                Icon(
                  unlocked ? Icons.verified_user : Icons.face,
                  size: 42,
                  color: CheColors.accent,
                ),
                const SizedBox(height: 12),
                Text(
                  unlocked ? 'Account vault unlocked' : 'Unlock with Face ID',
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 8),
                const Text(
                  'CHE can keep owner-authorized service tokens in the iPhone Keychain. Web apps inside CHE keep their own website sessions so you normally sign in once.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: CheColors.textDim, height: 1.35),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: busy ? null : _unlock,
                  icon: const Icon(Icons.face),
                  label: Text(busy ? 'CHECKING…' : 'UNLOCK'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          ListTile(
            leading: const Icon(Icons.apps, color: CheColors.accent),
            title: const Text('Apps inside CHE'),
            subtitle: const Text(
              'Open supported web apps. Their web sign-in can stay persistent inside CHE.',
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: unlocked
                ? () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const Scaffold(
                          body: SafeArea(child: CheAppsHubTab()),
                        ),
                      ),
                    )
                : _unlock,
          ),
          const SizedBox(height: 10),
          const Text(
            'iOS does not let one app copy another app’s private login session. CHE uses official sign-in/OAuth, persistent web sessions, passkeys/AutoFill, and owner-authorized tokens instead.',
            style: TextStyle(color: CheColors.textDim, fontSize: 12.5, height: 1.35),
          ),
        ],
      ),
    );
  }
}
