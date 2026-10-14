import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

// Models and the update-service client for CHE's iPhone builds. The screen,
// banners and the update controller live in their own files.

/// The build this copy of CHE is running, as iOS reports it through the
/// native `appVersion` call (CFBundleShortVersionString and CFBundleVersion).
///
/// There is no fallback value. A build that cannot be read is null, and CHE
/// then says so instead of comparing against a number it made up.
class CheInstalledBuild {
  const CheInstalledBuild(this.version, this.build);
  final String version;
  final String build;
  static const _shell = MethodChannel('che/native_shell');

  /// Reads the native reply. Returns null unless both values are present.
  static CheInstalledBuild? fromNative(Map<String, dynamic>? raw) {
    final version = '${raw?['version'] ?? ''}'.trim();
    final build = '${raw?['build'] ?? ''}'.trim();
    if (version.isEmpty || build.isEmpty) return null;
    return CheInstalledBuild(version, build);
  }

  static Future<CheInstalledBuild?> read() async {
    try {
      final raw = await _shell.invokeMapMethod<String, dynamic>('appVersion');
      return fromNative(raw == null ? null : Map<String, dynamic>.from(raw));
    } catch (_) {
      return null;
    }
  }
}

/// Whether SideStore may be handed this build. A normal update is only ever a
/// newer build than the running one. A rollback is the owner's own choice of an
/// earlier verified build, so it may be older, but never the running build. An
/// unknown running build is never guessed at, so nothing is handed off.
bool canHandOffInstall({
  required CheInstalledBuild? installed,
  required CheMobileUpdateInfo target,
  bool rollback = false,
  bool repair = false,
}) {
  // Recovery is an explicit owner-confirmed reinstall of the newest verified
  // release, not evidence that this release is newer than the unknown build.
  // Only the controller can authorize the Worker-supplied latest target.
  if (repair) {
    return !rollback && installed == null && target.valid &&
        RegExp(r'^[a-fA-F0-9]{64}$').hasMatch(target.sha256);
  }
  final current = installed;
  if (current == null) return false;
  if (rollback) {
    return !target.isNewerThan(current) && target.buildNumber != current.build;
  }
  return target.isNewerThan(current);
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

/// What /api/update/latest said: the newest verified build, and whether the
/// newest release attempt failed.
class CheLatestRead {
  const CheLatestRead({required this.latest, required this.newestBuildFailed});

  final CheMobileUpdateInfo? latest;
  final bool newestBuildFailed;
}

/// Reads one /api/update/latest reply. A failed newest build comes back as a
/// 503 with `latest_attempt.state == 'failure'`, and that is reported as a
/// failed build. Any other reply without a usable build throws, so CHE says
/// "could not check" and never "up to date".
CheLatestRead readLatestBuild(int status, String body) {
  Map<String, dynamic>? payload;
  try {
    final raw = jsonDecode(body);
    if (raw is Map) payload = Map<String, dynamic>.from(raw);
  } catch (_) {}
  final attempt = payload?['latest_attempt'];
  final newestBuildFailed = attempt is Map && attempt['state'] == 'failure';
  final ok = payload;
  if (status == 200 && ok != null && ok['ok'] == true) {
    final parsed = CheMobileUpdateInfo.fromJson(ok);
    if (parsed.valid) {
      return CheLatestRead(
        latest: parsed,
        newestBuildFailed: newestBuildFailed,
      );
    }
  }
  if (newestBuildFailed) {
    return const CheLatestRead(latest: null, newestBuildFailed: true);
  }
  throw const FormatException(
    'The update service did not return a usable build.',
  );
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

  final read = readLatestBuild(responses[0].statusCode, responses[0].body);

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
    latest: read.latest,
    history: history,
    newestBuildFailed: read.newestBuildFailed,
  );
}

typedef CheSpeak = Future<void> Function(String text);
