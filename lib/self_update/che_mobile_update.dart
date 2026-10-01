import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shorebird_code_push/shorebird_code_push.dart';
import 'package:url_launcher/url_launcher.dart';

const _fallbackVersion =
    String.fromEnvironment('CHE_APP_VERSION', defaultValue: '1.4.6');
const _fallbackBuild =
    String.fromEnvironment('CHE_BUILD_NUMBER', defaultValue: '15');

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
    required this.sideStoreInstallUrl,
    required this.sideStoreSourceUrl,
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
  final String sideStoreInstallUrl;
  final String sideStoreSourceUrl;
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
        sideStoreInstallUrl: '${json['sidestore_install_url'] ?? ''}',
        sideStoreSourceUrl: '${json['sidestore_source_url'] ?? ''}',
        shorebirdBase: json['shorebird_base'] == true,
      );

  bool get valid =>
      version.trim().isNotEmpty &&
      buildNumber.trim().isNotEmpty &&
      downloadUrl.startsWith('https://');

  bool isNewerThan(CheInstalledBuild installed) {
    final versionCompare = compareVersion(version, installed.version);
    if (versionCompare != 0) return versionCompare > 0;
    final mine = int.tryParse(buildNumber);
    final theirs = int.tryParse(installed.build);
    if (mine != null && theirs != null) return mine > theirs;
    return buildNumber != installed.build;
  }

  static int compareVersion(String a, String b) {
    final aa =
        a.split(RegExp(r'[.+-]')).map((e) => int.tryParse(e) ?? 0).toList();
    final bb =
        b.split(RegExp(r'[.+-]')).map((e) => int.tryParse(e) ?? 0).toList();
    final length = aa.length > bb.length ? aa.length : bb.length;
    for (var i = 0; i < length; i++) {
      final av = i < aa.length ? aa[i] : 0;
      final bv = i < bb.length ? bb[i] : 0;
      if (av != bv) return av.compareTo(bv);
    }
    return 0;
  }
}

typedef CheSpeak = Future<void> Function(String text);

Future<CheMobileUpdateInfo?> cheLatestMobileUpdate(String baseUrl) async {
  final base = baseUrl.replaceFirst(RegExp(r'/+$'), '');
  final response = await http
      .get(Uri.parse('$base/api/update/latest'))
      .timeout(const Duration(seconds: 15));
  if (response.statusCode != 200) return null;
  final raw = jsonDecode(response.body);
  if (raw is! Map<String, dynamic> || raw['ok'] != true) return null;
  final update = CheMobileUpdateInfo.fromJson(raw);
  return update.valid ? update : null;
}

class CheMobileUpdateScreen extends StatefulWidget {
  const CheMobileUpdateScreen({
    super.key,
    required this.baseUrl,
    required this.onSpeak,
    this.showHistoryInitially = false,
  });

  final String baseUrl;
  final CheSpeak onSpeak;
  final bool showHistoryInitially;

  @override
  State<CheMobileUpdateScreen> createState() => _CheMobileUpdateScreenState();
}

class _CheMobileUpdateScreenState extends State<CheMobileUpdateScreen> {
  final _shorebird = ShorebirdUpdater();
  CheInstalledBuild? _installed;
  CheMobileUpdateInfo? _latest;
  List<CheMobileUpdateInfo> _history = const [];
  UpdateStatus? _patchStatus;
  String _error = '';
  String _latestAttemptFailure = '';
  bool _loading = true;
  bool _busy = false;
  bool _showHistory = false;

  String get _base => widget.baseUrl.replaceFirst(RegExp(r'/+$'), '');

  @override
  void initState() {
    super.initState();
    _showHistory = widget.showHistoryInitially;
    unawaited(_check(announce: true));
  }

  Future<void> _check({bool announce = false}) async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = '';
        _latestAttemptFailure = '';
      });
    }
    final installed = await CheInstalledBuild.read();
    UpdateStatus? patch;
    if (_shorebird.isAvailable) {
      try {
        patch = await _shorebird.checkForUpdate();
      } catch (_) {}
    }

    CheMobileUpdateInfo? latest;
    var history = <CheMobileUpdateInfo>[];
    var latestAttemptFailure = '';
    try {
      final responses = await Future.wait([
        http
            .get(Uri.parse('$_base/api/update/latest'))
            .timeout(const Duration(seconds: 15)),
        http
            .get(Uri.parse('$_base/api/update/history'))
            .timeout(const Duration(seconds: 15)),
      ]);
      final latestRaw = jsonDecode(responses[0].body);
      if (latestRaw is Map) {
        final payload = Map<String, dynamic>.from(latestRaw);
        if (responses[0].statusCode == 200 && payload['ok'] == true) {
          final parsed = CheMobileUpdateInfo.fromJson(payload);
          if (parsed.valid) latest = parsed;
        }
        final attempt = payload['latest_attempt'];
        if (attempt is Map && attempt['state'] == 'failure') {
          latestAttemptFailure =
              '${payload['detail'] ?? attempt['detail'] ?? 'The newest CHE mobile build failed.'}';
        }
      }

      if (responses[1].statusCode == 200) {
        final raw = jsonDecode(responses[1].body);
        final builds = raw is Map ? raw['builds'] : null;
        if (builds is List) {
          history = builds
              .whereType<Map>()
              .map((e) =>
                  CheMobileUpdateInfo.fromJson(Map<String, dynamic>.from(e)))
              .where((e) => e.valid)
              .toList();
        }
      }
    } catch (_) {}

    if (!mounted) return;
    setState(() {
      _installed = installed;
      _latest = latest;
      _history = history;
      _patchStatus = patch;
      _latestAttemptFailure = latestAttemptFailure;
      _loading = false;
      if (latestAttemptFailure.isNotEmpty) {
        _error = latestAttemptFailure;
      } else if (latest == null && patch != UpdateStatus.outdated) {
        _error = 'I could not find a newer verified CHE build.';
      }
    });

    if (!announce) return;
    if (latestAttemptFailure.isNotEmpty) {
      await widget.onSpeak(
        '$latestAttemptFailure Your previous verified CHE build remains available, sir.',
      );
    } else if (latest?.isNewerThan(installed) == true) {
      await widget.onSpeak(
        'Sir, a new native CHE update is ready. '
        'Option 1, install with SideStore. '
        'Option 2, read what changed. Option 3, not now.',
      );
    } else if (patch == UpdateStatus.outdated) {
      await widget.onSpeak(
        'Sir, a fast CHE update is ready. It can install through Shorebird without a new IPA.',
      );
    } else {
      await widget.onSpeak('CHE is up to date, sir.');
    }
  }

  Future<void> _applyFastPatch() async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.onSpeak('Installing the fast CHE update now, sir.');
    try {
      await _shorebird.update();
      final status = await _shorebird.checkForUpdate();
      if (mounted) setState(() => _patchStatus = status);
      if (status == UpdateStatus.restartRequired) {
        HapticFeedback.mediumImpact();
        await widget.onSpeak(
          'The fast update is downloaded, sir. Close CHE fully and reopen it to apply the update.',
        );
      } else {
        await widget.onSpeak(
          'Shorebird did not confirm the update is ready yet. Your current CHE build is unchanged.',
        );
      }
    } catch (_) {
      await widget.onSpeak(
        'The fast update did not finish. Your current CHE build is still safe, sir.',
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Uri _installUri(CheMobileUpdateInfo update) {
    if (update.sideStoreInstallUrl.startsWith('sidestore://')) {
      return Uri.parse(update.sideStoreInstallUrl);
    }
    return Uri(
      scheme: 'sidestore',
      host: 'install',
      queryParameters: {'url': update.downloadUrl},
    );
  }

  Future<void> _install(CheMobileUpdateInfo update) async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.onSpeak(
      'Opening SideStore with CHE version ${update.version}, build ${update.buildNumber}. '
      'SideStore or iOS will ask you to confirm the install.',
    );
    var opened = false;
    try {
      opened = await launchUrl(_installUri(update),
          mode: LaunchMode.externalApplication);
    } catch (_) {}
    if (!opened) {
      try {
        opened = await launchUrl(Uri.parse(update.downloadUrl),
            mode: LaunchMode.externalApplication);
      } catch (_) {}
      await widget.onSpeak(
        opened
            ? 'SideStore did not accept the direct handoff, so I opened the verified IPA download in Safari instead, sir.'
            : 'I could not open SideStore or the IPA download. I left your current build unchanged, sir.',
      );
    } else {
      await widget.onSpeak(
        'SideStore is open, sir. Confirm the CHE installation there. I will not claim it installed until iOS finishes.',
      );
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _addSource() async {
    final direct = _latest?.sideStoreSourceUrl ?? '';
    final uri = direct.startsWith('sidestore://')
        ? Uri.parse(direct)
        : Uri(
            scheme: 'sidestore',
            host: 'source',
            queryParameters: {'url': '$_base/api/update/source'},
          );
    await widget.onSpeak(
      'Opening SideStore to add the CHE update source, sir. SideStore will ask you to confirm it.',
    );
    try {
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        await widget.onSpeak(
          'SideStore did not open. Your CHE installation was not changed.',
        );
      }
    } catch (_) {
      await widget.onSpeak(
        'SideStore did not open. Your CHE installation was not changed.',
      );
    }
  }

  Future<void> _readChanges() async {
    final update = _latest;
    if (update == null) {
      await widget.onSpeak('There is no newer full CHE build to read, sir.');
      return;
    }
    final notes = update.releaseNotes.trim();
    await widget.onSpeak(notes.isEmpty
        ? 'CHE version ${update.version}, build ${update.buildNumber}, is ready.'
        : 'Here is what changed. $notes');
  }

  Future<void> _openPrevious(CheMobileUpdateInfo update) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Install an older CHE build?'),
        content: Text(
          'This will open SideStore with CHE ${update.version}, build ${update.buildNumber}. '
          'Your current app is not changed until you confirm installation in SideStore.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Keep current build'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Open in SideStore'),
          ),
        ],
      ),
    );
    if (ok == true) await _install(update);
  }

  @override
  Widget build(BuildContext context) {
    final installed = _installed;
    final latest = _latest;
    final nativeReady =
        installed != null && latest?.isNewerThan(installed) == true;
    final fastReady = _patchStatus == UpdateStatus.outdated;
    final restartReady = _patchStatus == UpdateStatus.restartRequired;

    String status = 'CHE is up to date';
    if (_loading) status = 'Checking for updates…';
    if (nativeReady) status = 'New native update ready';
    if (!nativeReady && fastReady) status = 'Fast update ready';
    if (restartReady) status = 'Restart CHE to apply update';
    if (_latestAttemptFailure.isNotEmpty) {
      status = 'Newest mobile build failed — previous verified build is safe';
    }

    return Scaffold(
      appBar: AppBar(title: const Text('CHE Updates')),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () => _check(),
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Semantics(
                liveRegion: true,
                label: status,
                child: Text(status,
                    style: Theme.of(context).textTheme.headlineSmall),
              ),
              const SizedBox(height: 8),
              if (installed != null)
                Text('Installed: ${installed.version} · build ${installed.build}'),
              if (latest != null)
                Text(
                    'Latest full build: ${latest.version} · build ${latest.buildNumber}'),
              if (latest?.sha256.isNotEmpty == true)
                Text(
                  'Verified SHA-256: ${latest!.sha256.substring(0, (latest.sha256.length < 16 ? latest.sha256.length : 16))}…',
                  semanticsLabel: 'The latest IPA has a SHA 256 checksum.',
                ),
              if (_error.isNotEmpty && !_loading) ...[
                const SizedBox(height: 12),
                Text(_error),
              ],
              const SizedBox(height: 20),
              if (nativeReady)
                Semantics(
                  button: true,
                  label: 'Option 1. Install the new CHE build with SideStore.',
                  child: FilledButton.icon(
                    onPressed: _busy ? null : () => _install(latest!),
                    icon: const Icon(Icons.system_update_rounded),
                    label: const Text('1. Install with SideStore'),
                  ),
                )
              else if (fastReady)
                Semantics(
                  button: true,
                  label: 'Option 1. Install the fast CHE update.',
                  child: FilledButton.icon(
                    onPressed: _busy ? null : _applyFastPatch,
                    icon: const Icon(Icons.bolt_rounded),
                    label: const Text('1. Install fast update'),
                  ),
                ),
              const SizedBox(height: 10),
              Semantics(
                button: true,
                label: 'Option 2. Read what changed.',
                child: OutlinedButton.icon(
                  onPressed: _loading ? null : _readChanges,
                  icon: const Icon(Icons.record_voice_over_rounded),
                  label: const Text('2. Read what changed'),
                ),
              ),
              const SizedBox(height: 10),
              Semantics(
                button: true,
                label: 'Option 3. Not now. Return to CHE.',
                child: TextButton(
                  onPressed: () => Navigator.maybePop(context),
                  child: const Text('3. Not now'),
                ),
              ),
              const Divider(height: 36),
              Semantics(
                button: true,
                label: 'Add CHE as a SideStore update source.',
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : _addSource,
                  icon: const Icon(Icons.add_link_rounded),
                  label: const Text('Add CHE to SideStore Sources'),
                ),
              ),
              TextButton.icon(
                onPressed: _loading
                    ? null
                    : () => setState(() => _showHistory = !_showHistory),
                icon: Icon(
                    _showHistory ? Icons.expand_less : Icons.history_rounded),
                label: Text(_showHistory
                    ? 'Hide previous builds'
                    : 'Previous verified builds'),
              ),
              if (_showHistory)
                for (final item in _history.where((item) =>
                    installed == null ||
                    item.version != installed.version ||
                    item.buildNumber != installed.build))
                  Semantics(
                    button: true,
                    label:
                        'CHE ${item.version}, build ${item.buildNumber}. Open this previous build in SideStore.',
                    child: ListTile(
                      leading: const Icon(Icons.restore_rounded),
                      title:
                          Text('CHE ${item.version} · ${item.buildNumber}'),
                      subtitle: Text(
                        item.releaseNotes.isEmpty
                            ? item.buildDate
                            : item.releaseNotes,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      onTap: _busy ? null : () => _openPrevious(item),
                    ),
                  ),
              TextButton.icon(
                onPressed: _loading ? null : () => _check(announce: true),
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Check again'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class CheMobileUpdateNotice extends StatefulWidget {
  const CheMobileUpdateNotice({
    super.key,
    required this.baseUrl,
    required this.onSpeak,
  });

  final String baseUrl;
  final CheSpeak onSpeak;

  @override
  State<CheMobileUpdateNotice> createState() => _CheMobileUpdateNoticeState();
}

class _CheMobileUpdateNoticeState extends State<CheMobileUpdateNotice> {
  CheMobileUpdateInfo? _update;
  bool _announced = false;

  @override
  void initState() {
    super.initState();
    unawaited(_check());
  }

  Future<void> _check() async {
    try {
      final installed = await CheInstalledBuild.read();
      final update = await cheLatestMobileUpdate(widget.baseUrl);
      if (update == null || !update.isNewerThan(installed) || !mounted) return;
      setState(() => _update = update);
      if (!_announced) {
        _announced = true;
        HapticFeedback.mediumImpact();
        await widget.onSpeak('Sir, a new native CHE update is ready.');
      }
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final update = _update;
    if (update == null) return const SizedBox.shrink();
    return Material(
      color: const Color(0xFF0C695F),
      child: SafeArea(
        bottom: false,
        child: Semantics(
          button: true,
          liveRegion: true,
          label:
              'A new native CHE update is ready. Double tap to open CHE Updates.',
          child: ListTile(
            leading:
                const Icon(Icons.system_update_rounded, color: Colors.white),
            title: const Text('New CHE update ready',
                style: TextStyle(color: Colors.white)),
            subtitle: Text(
              '${update.version} · build ${update.buildNumber}',
              style: const TextStyle(color: Colors.white70),
            ),
            trailing:
                const Icon(Icons.chevron_right_rounded, color: Colors.white),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => CheMobileUpdateScreen(
                  baseUrl: widget.baseUrl,
                  onSpeak: widget.onSpeak,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
