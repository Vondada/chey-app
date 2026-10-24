import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Character Studio: how CHE and her crew look and move, as versioned presentation settings the runtime applies
/// without a new build. Every value here is presentation only (assets/characters/app/che_animator.js reads it);
/// nothing in this file grants an agent a tool, a permission or an app.
class CheAnimationSettings {
  const CheAnimationSettings({
    this.fluidity = 0.6,
    this.gesture = 0.6,
    this.expressiveness = 0.6,
    this.walk = 'graceful',
    this.idleVariety = 0.6,
    this.eyeContact = 0.7,
    this.speed = 1.0,
    this.hairCloth = 0.6,
    this.preset = 'natural',
  });

  /// Crossfade length and acceleration: 0 is sharp, 1 is the slowest, smoothest blends.
  final double fluidity;

  /// Weight of the upper-body gesture layer while speaking or thinking.
  final double gesture;

  /// How strongly the mood faces and speech brows show.
  final double expressiveness;

  /// Which walking take plays: graceful, confident or plain.
  final String walk;

  /// How often the idle take changes and how much the posture drifts.
  final double idleVariety;

  /// How far the head and eyes follow the owner's camera.
  final double eyeContact;

  /// Playback speed of every clip.
  final double speed;

  /// Hair and cloth secondary motion (applies to builds that carry it).
  final double hairCloth;

  /// The preset this came from, or custom.
  final String preset;

  static const walks = ['graceful', 'confident', 'plain'];
  static const presets = {
    'natural': CheAnimationSettings(),
    'professional': CheAnimationSettings(fluidity: 0.7, gesture: 0.35, expressiveness: 0.45, walk: 'plain', idleVariety: 0.4, eyeContact: 0.85, speed: 1.0, hairCloth: 0.4, preset: 'professional'),
    'expressive': CheAnimationSettings(fluidity: 0.55, gesture: 0.95, expressiveness: 0.95, walk: 'confident', idleVariety: 0.9, eyeContact: 0.7, speed: 1.05, hairCloth: 0.8, preset: 'expressive'),
    'cinematic': CheAnimationSettings(fluidity: 0.9, gesture: 0.7, expressiveness: 0.8, walk: 'graceful', idleVariety: 0.7, eyeContact: 0.6, speed: 0.92, hairCloth: 1.0, preset: 'cinematic'),
  };

  CheAnimationSettings copyWith({double? fluidity, double? gesture, double? expressiveness, String? walk, double? idleVariety, double? eyeContact, double? speed, double? hairCloth, String? preset}) =>
      CheAnimationSettings(
        fluidity: fluidity ?? this.fluidity,
        gesture: gesture ?? this.gesture,
        expressiveness: expressiveness ?? this.expressiveness,
        walk: walk ?? this.walk,
        idleVariety: idleVariety ?? this.idleVariety,
        eyeContact: eyeContact ?? this.eyeContact,
        speed: speed ?? this.speed,
        hairCloth: hairCloth ?? this.hairCloth,
        preset: preset ?? 'custom',
      );

  /// The keys the page's animator reads (same names as che_animator.js settings).
  Map<String, Object?> toJson() => {
        'fluidity': fluidity, 'gesture': gesture, 'expressiveness': expressiveness, 'walk': walk,
        'idleVariety': idleVariety, 'eyeContact': eyeContact, 'speed': speed, 'hairCloth': hairCloth, 'preset': preset,
      };

  static double _num(Object? v, double fallback) => v is num ? v.toDouble().clamp(0.0, 2.0) : fallback;

  factory CheAnimationSettings.fromJson(Map<String, dynamic> j) {
    const d = CheAnimationSettings();
    final walk = j['walk']?.toString() ?? d.walk;
    return CheAnimationSettings(
      fluidity: _num(j['fluidity'], d.fluidity).clamp(0.0, 1.0),
      gesture: _num(j['gesture'], d.gesture).clamp(0.0, 1.0),
      expressiveness: _num(j['expressiveness'], d.expressiveness).clamp(0.0, 1.0),
      walk: walks.contains(walk) ? walk : d.walk,
      idleVariety: _num(j['idleVariety'], d.idleVariety).clamp(0.0, 1.0),
      eyeContact: _num(j['eyeContact'], d.eyeContact).clamp(0.0, 1.0),
      speed: _num(j['speed'], d.speed).clamp(0.5, 1.5),
      hairCloth: _num(j['hairCloth'], d.hairCloth).clamp(0.0, 1.0),
      preset: j['preset']?.toString() ?? 'custom',
    );
  }

  /// Applies a spoken request the Worker understood ("make your walking more natural" → walk graceful, fluidity up).
  CheAnimationSettings applyPatch(Map<String, dynamic> patch) {
    var next = this;
    final p = patch['preset']?.toString();
    if (p != null && presets.containsKey(p)) next = presets[p]!;
    double bump(double v, Object? delta) => (v + (delta is num ? delta.toDouble() : 0)).clamp(0.0, 1.0);
    if (patch.containsKey('fluidity')) next = next.copyWith(fluidity: bump(next.fluidity, patch['fluidity']));
    if (patch.containsKey('gesture')) next = next.copyWith(gesture: bump(next.gesture, patch['gesture']));
    if (patch.containsKey('expressiveness')) next = next.copyWith(expressiveness: bump(next.expressiveness, patch['expressiveness']));
    if (patch.containsKey('idleVariety')) next = next.copyWith(idleVariety: bump(next.idleVariety, patch['idleVariety']));
    if (patch.containsKey('eyeContact')) next = next.copyWith(eyeContact: bump(next.eyeContact, patch['eyeContact']));
    if (patch.containsKey('hairCloth')) next = next.copyWith(hairCloth: bump(next.hairCloth, patch['hairCloth']));
    if (patch.containsKey('speed')) next = next.copyWith(speed: (next.speed + (patch['speed'] is num ? (patch['speed'] as num).toDouble() : 0)).clamp(0.5, 1.5));
    final walk = patch['walk']?.toString();
    if (walk != null && walks.contains(walk)) next = next.copyWith(walk: walk);
    return next;
  }

  /// One spoken sentence a blind owner can check against.
  String describe() {
    String level(double v) => v < 0.34 ? 'low' : v < 0.67 ? 'medium' : 'high';
    return 'Preset $preset. Fluidity ${level(fluidity)}, gestures ${level(gesture)}, facial expression ${level(expressiveness)}, '
        '$walk walk, idle variety ${level(idleVariety)}, eye contact ${level(eyeContact)}, speed ${(speed * 100).round()} percent, hair and cloth motion ${level(hairCloth)}.';
  }

  @override
  bool operator ==(Object other) => other is CheAnimationSettings && jsonEncode(other.toJson()) == jsonEncode(toJson());

  @override
  int get hashCode => jsonEncode(toJson()).hashCode;
}

/// One saved version of an agent's settings: what changed, when, and from where (studio, voice, rollback).
class CheStudioVersion {
  const CheStudioVersion({required this.version, required this.at, required this.source, required this.settings, this.note = ''});
  final int version;
  final DateTime at;
  final String source;
  final CheAnimationSettings settings;
  final String note;

  Map<String, Object?> toJson() => {'version': version, 'at': at.toIso8601String(), 'source': source, 'note': note, 'settings': settings.toJson()};

  factory CheStudioVersion.fromJson(Map<String, dynamic> j) => CheStudioVersion(
        version: (j['version'] as num?)?.toInt() ?? 0,
        at: DateTime.tryParse(j['at']?.toString() ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0),
        source: j['source']?.toString() ?? 'studio',
        note: j['note']?.toString() ?? '',
        settings: CheAnimationSettings.fromJson((j['settings'] as Map?)?.cast<String, dynamic>() ?? const {}),
      );
}

/// Every agent registered in the system (crew models plus the Worker roster's named agents).
const cheStudioAgents = ['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris', 'orion', 'vale'];

/// The app's one store: the 3D crew page reads it on load, the Studio and spoken requests write to it.
final CheCharacterStudioStore cheCharacterStudio = CheCharacterStudioStore();

/// Versioned, per-agent settings on the phone (SharedPreferences). Each save appends a version; rollback restores
/// an earlier one as a new version, so the history is never rewritten.
class CheCharacterStudioStore extends ChangeNotifier {
  CheCharacterStudioStore({Future<SharedPreferences> Function()? prefs}) : _prefs = prefs ?? SharedPreferences.getInstance;

  final Future<SharedPreferences> Function() _prefs;
  static const _key = 'che_character_studio_v1';
  static const maxVersions = 40;
  final Map<String, List<CheStudioVersion>> _history = {};
  bool _loaded = false;

  bool get loaded => _loaded;

  Future<void> load() async {
    try {
      final raw = (await _prefs()).getString(_key);
      if (raw != null) {
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          for (final e in decoded.entries) {
            final list = e.value;
            if (list is List) _history[e.key.toString()] = [for (final v in list) if (v is Map) CheStudioVersion.fromJson(v.cast<String, dynamic>())];
          }
        }
      }
    } catch (_) {}
    _loaded = true;
    notifyListeners();
  }

  Future<void> _save() async {
    try {
      await (await _prefs()).setString(_key, jsonEncode({for (final e in _history.entries) e.key: [for (final v in e.value) v.toJson()]}));
    } catch (_) {}
  }

  List<CheStudioVersion> history(String agent) => List.unmodifiable(_history[agent] ?? const []);

  CheAnimationSettings current(String agent) => _history[agent]?.isNotEmpty == true ? _history[agent]!.last.settings : const CheAnimationSettings();

  /// Saves a new version. Returns it.
  Future<CheStudioVersion> save(String agent, CheAnimationSettings settings, {String source = 'studio', String note = ''}) async {
    final list = _history.putIfAbsent(agent, () => []);
    final v = CheStudioVersion(version: (list.isEmpty ? 0 : list.last.version) + 1, at: DateTime.now(), source: source, settings: settings, note: note);
    list.add(v);
    if (list.length > maxVersions) list.removeRange(0, list.length - maxVersions);
    await _save();
    notifyListeners();
    return v;
  }

  /// Restores an earlier version as a new one (the history keeps both). Null when that version does not exist.
  Future<CheStudioVersion?> rollback(String agent, int version) async {
    final old = (_history[agent] ?? const []).where((v) => v.version == version).toList();
    if (old.isEmpty) return null;
    return save(agent, old.first.settings, source: 'rollback', note: 'restored version $version');
  }

  /// A spoken request the Worker parsed into a patch (character_studio.js). Saved as a voice version.
  Future<CheStudioVersion> applyVoicePatch(String agent, Map<String, dynamic> patch, {String said = ''}) =>
      save(agent, current(agent).applyPatch(patch), source: 'voice', note: said);
}
