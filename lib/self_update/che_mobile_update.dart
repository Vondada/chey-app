import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

// Models and the update-service client for CHE's iPhone builds. The screen,
// banners and the update controller live in their own files.

const _fallbackVersion = String.fromEnvironment(
  'CHE_APP_VERSION',
  defaultValue: '1.4.6',
);
const _fallbackBuild = String.fromEnvironment(
  'CHE_BUILD_NUMBER',
  defaultValue: '15',
);

class CheInstalledBuild {
  const CheInstalledBuild(this.version, this.build);
  final String version;
  final String build;
  static const _shell = MethodChannel('che/native_shell');

  static Future<CheInstalledBuild> read() async {
    try {
      final raw = await _shell.invokeMapMethod<String, dynamic>('appVersion');
      final version = '${raw?['version'] ?? ''}'.trim();
      final build = '${raw?['build'] ?? ''}'.trim();
      if (version.isNotEmpty && build.isNotEmpty) {
        return CheInstalledBuild(version, build);
      }
    } catch (_) {}
    return const CheInstalledBuild(_fallbackVersion, _fallbackBuild);
  }
}

class CheMobileUpdateInfo {
  const CheMobileUpdateInfo({
    required this.version,
    required this.buildNumber,
    required this.commitSha,
    required this.buildDate,
    required this.downloadUrl,
    required this.sha256,
    required this.size,
    required this.releaseNotes,
    required this.shorebirdBase,
  });

  final String version;
  final String buildNumber;
  final String commitSha;
  final String buildDate;
  final String downloadUrl;
  final String sha256;
  final int size;
  final String releaseNotes;
  final bool shorebirdBase;

  factory CheMobileUpdateInfo.fromJson(Map<String, dynamic> json) =>
      CheMobileUpdateInfo(
        version: '${json['version'] ?? ''}',
        buildNumber: '${json['build_number'] ?? ''}',
        commitSha: '${json['commit_sha'] ?? ''}',
        buildDate: '${json['build_date'] ?? ''}',
        downloadUrl:
            '${json['download_url'] ?? json['ipa_download_url'] ?? ''}',
        sha256: '${json['sha256'] ?? ''}',
        size: (json['size'] as num?)?.toInt() ?? 0,
        releaseNotes: '${json['release_notes'] ?? ''}',
        shorebirdBase: json['shorebird_base'] == true,
      );

  bool get valid =>
      version.trim().isNotEmpty &&
      buildNumber.trim().isNotEmpty &&
      downloadUrl.startsWith('https://');

  /// A short label for speech and status text, such as "CHE 1.4.2, build 3800".
  String get label => 'CHE $version, build $buildNumber';

  bool isNewerThan(CheInstalledBuild installed) {
    final versionCompare = compareVersion(version, installed.version);
    if (versionCompare != 0) return versionCompare > 0;
    final mine = int.tryParse(buildNumber);
    final theirs = int.tryParse(installed.build);
    if (mine != null && theirs != null) return mine > theirs;
    // An unparseable build number is not proof that a release is newer.
    return false;
  }

  static int compareVersion(String a, String b) {
    final aa = a
        .split(RegExp(r'[.+-]'))
        .map((e) => int.tryParse(e) ?? 0)
        .toList();
    final bb = b
        .split(RegExp(r'[.+-]'))
        .map((e) => int.tryParse(e) ?? 0)
        .toList();
    final length = aa.length > bb.length ? aa.length : bb.length;
    for (var i = 0; i < length; i++) {
      final av = i < aa.length ? aa[i] : 0;
      final bv = i < bb.length ? bb[i] : 0;
      if (av != bv) return av.compareTo(bv);
    }
    return 0;
  }
}

/// The newest verified full build, the earlier verified builds, and whether
/// the newest release attempt failed.
class CheMobileBuilds {
  const CheMobileBuilds({
    required this.latest,
    required this.history,
    required this.newestBuildFailed,
  });

  final CheMobileUpdateInfo? latest;
  final List<CheMobileUpdateInfo> history;
  final bool newestBuildFailed;
}

/// Reads the update service. Throws when the network or the JSON fails, so the
/// caller can show "could not check" instead of "up to date".
Future<CheMobileBuilds> fetchMobileBuilds(String base) async {
  final responses = await Future.wait([
    http
        .get(Uri.parse('$base/api/update/latest'))
        .timeout(const Duration(seconds: 15)),
    http
        .get(Uri.parse('$base/api/update/history'))
        .timeout(const Duration(seconds: 15)),
  ]);

  CheMobileUpdateInfo? latest;
  var newestBuildFailed = false;
  if (responses[0].statusCode == 200) {
    final raw = jsonDecode(responses[0].body);
    if (raw is Map) {
      final payload = Map<String, dynamic>.from(raw);
      if (payload['ok'] == true) {
        final parsed = CheMobileUpdateInfo.fromJson(payload);
        if (parsed.valid) latest = parsed;
      }
      final attempt = payload['latest_attempt'];
      newestBuildFailed = attempt is Map && attempt['state'] == 'failure';
    }
  }

  var history = <CheMobileUpdateInfo>[];
  if (responses[1].statusCode == 200) {
    final raw = jsonDecode(responses[1].body);
    final builds = raw is Map ? raw['builds'] : null;
    if (builds is List) {
      history = builds
          .whereType<Map>()
          .map(
            (e) => CheMobileUpdateInfo.fromJson(Map<String, dynamic>.from(e)),
          )
          .where((e) => e.valid)
          .toList();
    }
  }
  return CheMobileBuilds(
    latest: latest,
    history: history,
    newestBuildFailed: newestBuildFailed,
  );
}

typedef CheSpeak = Future<void> Function(String text);
