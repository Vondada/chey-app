import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Native CHE alerts on iPhone.
///
/// These are local iOS notifications: they work without putting any secret or
/// push credential in Flutter. Remote APNs delivery from a terminated app is a
/// separate capability that requires an Apple push entitlement/provisioning.
class CheNotifications {
  CheNotifications._();

  static const MethodChannel _shell = MethodChannel('che/native_shell');
  static bool _asked = false;

  static Future<bool> requestPermission() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return false;
    if (_asked) return true;
    _asked = true;
    try {
      return await _shell.invokeMethod<bool>('requestNotifications') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  static Future<bool> show({
    required String title,
    required String body,
    String? id,
  }) async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return false;
    if (!await requestPermission()) return false;
    final cleanTitle = title.replaceAll(RegExp(r'\s+'), ' ').trim();
    final cleanBody = body.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (cleanTitle.isEmpty || cleanBody.isEmpty) return false;
    try {
      return await _shell.invokeMethod<bool>('showNotification', {
            'id': id,
            'title': cleanTitle,
            'body': cleanBody,
          }) ??
          false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }
}
