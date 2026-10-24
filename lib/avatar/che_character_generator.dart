// Character Generator in CHE World (owner, 2026-10-24): one reusable, parametric 3D character instead of a new face each
// time. It edits the identity presets the Worker keeps (server/cloudflare/avatar_identity.js over
// tools/avatar_face/identities.json): pick CHE or an office agent, pick a look (photoreal, hybrid, stylized), move the
// face sliders and colours, then Generate (a seeded variant), Preview (queues real Blender renders on the owner's
// Colab T4 through the GPU queue), Save (a custom preset) and Apply (that agent uses it).
// Preview only queues: a picture appears only when the GPU queue has a real one. The screen never speaks on open
// (owner rule, 2026-10-11); Read aloud speaks the current state when he asks. Each action shows its real result as a
// large banner with a haptic.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_gpu_jobs.dart';

/// Plain names for the face sliders, in the order the owner sees them.
const cheFaceSliderNames = <String, String>{
  'eye_size': 'Eye size',
  'eye_tilt': 'Eye tilt',
  'eyefold': 'Eyelid fold',
  'brow_height': 'Brow height',
  'nose_tip_width': 'Nose tip width',
  'nose_width': 'Nose width',
  'nose_length': 'Nose length',
  'lip_upper': 'Upper lip fullness',
  'lip_lower': 'Lower lip fullness',
  'cupids_bow': "Cupid's bow",
  'mouth_width': 'Mouth width',
  'cheek_volume': 'Cheek fullness',
  'cheekbones': 'Cheekbones',
  'chin_width': 'Chin width',
  'chin_height': 'Chin height',
  'face_width': 'Face width',
  'face_round': 'Round face',
  'face_oval': 'Oval face',
};

/// Sliders that only go one way (MakeHuman has no opposite target for them).
const cheOneWaySliders = {'face_round', 'face_oval'};

const cheLookNames = {'photoreal': 'Photoreal', 'hybrid': 'Hybrid', 'stylized': 'Stylized'};

const cheHairStyleNames = {
  'long_wavy': 'Long wavy',
  'wavy_medium': 'Medium wavy',
  'bun_high': 'High bun',
  'bun_low': 'Low bun',
  'curly_short': 'Short curls',
  'afro': 'Afro',
  'beanie': 'Beanie',
  'close_crop': 'Close-cropped',
};

/// Named colour choices, so VoiceOver says a colour name instead of a hex code.
const cheSkinTones = <(String, String)>[
  // The lightest tones stop at what the renderer accepts as a skin albedo (the Worker refuses lighter ones).
  ('#e4bb9c', 'fair'), ('#e3b597', 'light'), ('#e7b48e', 'light warm'), ('#e2b089', 'light peach'), ('#dca27a', 'medium'),
  ('#d7a986', 'medium neutral'), ('#d29a72', 'medium warm'), ('#c98b62', 'tan'), ('#8c5a3c', 'brown'), ('#7a4a2e', 'deep brown'),
  ('#502e20', 'deep'),
];
const cheIrisColors = <(String, String)>[
  ('#4a2e1c', 'very dark brown'), ('#4a3220', 'dark brown'), ('#5a3a22', 'brown'), ('#5e3e28', 'warm brown'),
  ('#5e3c22', 'chestnut'), ('#6a4a2e', 'light brown'), ('#4e3a52', 'violet brown'), ('#5f6b45', 'hazel green'), ('#4f7fb5', 'blue'),
];
const cheHairColors = <(String, String)>[
  ('#141010', 'black'), ('#16110e', 'jet black'), ('#1a1210', 'brown black'), ('#1c1210', 'soft black'), ('#2a1a12', 'dark brown'),
  ('#3b2416', 'chestnut'), ('#4a2c1c', 'brown'), ('#6a2e1a', 'auburn'),
  ('#d8b46a', 'blonde'), ('#8d64d6', 'purple'),
];

Color cheHexColor(String hex) {
  final h = hex.replaceFirst('#', '');
  return Color(int.tryParse('FF$h', radix: 16) ?? 0xFF808080);
}

String cheColorName(List<(String, String)> palette, String hex) {
  for (final (h, name) in palette) {
    if (h.toLowerCase() == hex.toLowerCase()) return name;
  }
  return 'custom colour';
}

Map<String, dynamic> _deepCopy(Map<String, dynamic> m) => Map<String, dynamic>.from(jsonDecode(jsonEncode(m)) as Map);

class CheCharacterGenerator extends StatefulWidget {
  const CheCharacterGenerator({super.key, required this.baseUrl, required this.headers, this.client, this.onRead, this.initialAgent});

  final String baseUrl;
  final Map<String, String> headers;
  final http.Client? client;

  /// Speaks text only when the owner presses Read aloud.
  final void Function(String text)? onRead;
  final String? initialAgent;

  static Route<void> route({required String baseUrl, required Map<String, String> headers, void Function(String text)? onRead, String? agent}) =>
      MaterialPageRoute<void>(builder: (_) => CheCharacterGenerator(baseUrl: baseUrl, headers: headers, onRead: onRead, initialAgent: agent));

  /// While the generator is open, typed or spoken words reach it first (lib/home_state/send.dart): every button and
  /// setting has a voice route. Returns null for anything that is not a generator command, so it goes to Chat.
  static Future<String?> Function(String words)? voiceHandler;

  @override
  State<CheCharacterGenerator> createState() => CheCharacterGeneratorState();
}

class CheCharacterGeneratorState extends State<CheCharacterGenerator> {
  late final http.Client _http = widget.client ?? http.Client();
  List<Map<String, dynamic>> presets = const [];
  Map<String, String> active = const {};
  List<String> styles = const ['photoreal', 'hybrid', 'stylized'];
  List<String> sliders = cheFaceSliderNames.keys.toList();
  List<String> hairStyles = cheHairStyleNames.keys.toList();
  Set<String> hairBuilt = const {'long_wavy'};

  /// The character being edited (CHE or an agent) and the working preset for it.
  String agent = 'che';
  Map<String, dynamic> preset = const {};
  String style = 'photoreal';
  bool allLooks = true;
  bool dirty = false;
  bool loading = true;
  bool busy = false;
  int _seed = 1;
  String? banner;
  bool bannerOk = true;
  List<Map<String, dynamic>> jobs = const [];

  Map<String, String> get _json => {...widget.headers, 'Content-Type': 'application/json'};

  @override
  void initState() {
    super.initState();
    if (widget.initialAgent != null) agent = widget.initialAgent!;
    CheCharacterGenerator.voiceHandler = voice;
    unawaited(load());
  }

  @override
  void dispose() {
    if (CheCharacterGenerator.voiceHandler == voice) CheCharacterGenerator.voiceHandler = null;
    super.dispose();
  }

  /// The spoken or typed control: "generate", "preview", "save", "apply" (or 1 to 4), "edit Nova", "stylized",
  /// "all three looks" / "only this look", "eye size 30 percent", "increase cheekbones", "skin tan", "eyes blue",
  /// "hair colour auburn", "hair style long wavy", "read". Each action answers with its actual result.
  Future<String?> voice(String words) async {
    var t = words.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '').replaceAll('\u2019', "'");
    t = t.replaceFirst(RegExp(r'^(?:hey\s+)?(?:che|chey|chay)[,:]?\s+'), '').replaceFirst(RegExp(r'^(?:please\s+)'), '').trim();
    if (loading) return null;
    String? done(String? text) => text ?? banner ?? '';
    if (RegExp(r"^(?:read(?: aloud| it| this| the screen)?|what(?:'s| is) on (?:the |this )?screen|describe (?:the |this )?screen)$").hasMatch(t)) {
      return spokenSummary;
    }
    final n = RegExp(r'^(?:option |number |button )?([1-4])$').firstMatch(t)?.group(1);
    if (n == '1' || RegExp(r'^generate(?: a)?(?: new)?(?: variant| variation| one)?$').hasMatch(t)) { await generate(); return done(null); }
    if (n == '2' || RegExp(r'^(?:preview|render|queue(?: the)? preview|preview (?:it|this|on the gpu))$').hasMatch(t)) { await preview(); return done(null); }
    if (n == '3' || RegExp(r'^save(?: it| this| the preset)?$').hasMatch(t)) { await save(); return done(null); }
    if (n == '4' || RegExp(r'^apply(?: it| this| the preset)?$').hasMatch(t)) { await apply(); return done(null); }
    final who = RegExp(r'^(?:edit|switch to|open|show|character)\s+(\w+)$').firstMatch(t)?.group(1);
    if (who != null) {
      final c = characters.firstWhere((p) => '${p['name']}'.toLowerCase() == who || p['id'] == who, orElse: () => const {});
      if (c.isEmpty) return 'There is no character called $who here. The characters are ${characters.map((p) => p['name']).join(', ')}.';
      setState(() => _select('${c['id']}'));
      _report(true, 'Editing ${c['name']}.');
      return done(null);
    }
    final look = RegExp(r'^(?:use |switch to |make it )?(photoreal|photorealistic|hybrid|stylized|stylised)(?: look)?$').firstMatch(t)?.group(1);
    if (look != null) {
      final s = look.startsWith('photo') ? 'photoreal' : (look.startsWith('styl') ? 'stylized' : 'hybrid');
      setState(() => style = s);
      _report(true, 'Look: ${cheLookNames[s]}.');
      return done(null);
    }
    if (RegExp(r'^(?:preview )?all(?: three)? looks$').hasMatch(t)) { setState(() => allLooks = true); _report(true, 'Previews will queue all three looks.'); return done(null); }
    if (RegExp(r'^(?:preview )?(?:only )?(?:this|one) look(?: only)?$').hasMatch(t)) { setState(() => allLooks = false); _report(true, 'Previews will queue only the ${cheLookNames[style]} look.'); return done(null); }
    String? sliderFor(String phrase) {
      for (final e in cheFaceSliderNames.entries) {
        if (e.value.toLowerCase().replaceAll("'", '') == phrase.replaceAll("'", '') || e.key.replaceAll('_', ' ') == phrase) return e.key;
      }
      return null;
    }
    final step = RegExp(r'^(increase|raise|more|decrease|lower|less|reduce)\s+(?:the\s+)?(.+)$').firstMatch(t);
    if (step != null) {
      final k = sliderFor(step.group(2)!);
      if (k != null) {
        final up = RegExp(r'increase|raise|more').hasMatch(step.group(1)!);
        setSlider(k, (sliderValue(k) + (up ? 0.1 : -0.1)).clamp(cheOneWaySliders.contains(k) ? 0.0 : -1.0, 1.0));
        _report(true, '${cheFaceSliderNames[k]} ${(sliderValue(k) * 100).round()} percent. Not saved yet.');
        return done(null);
      }
    }
    final set = RegExp(r'^(?:set\s+)?(?:the\s+)?(.+?)\s+(?:to\s+)?(minus\s+|-)?(\d{1,3})(?:\s*(?:percent|%))?$').firstMatch(t);
    if (set != null) {
      final k = sliderFor(set.group(1)!);
      if (k != null) {
        final v = (int.parse(set.group(3)!) / 100 * (set.group(2) == null ? 1 : -1)).clamp(cheOneWaySliders.contains(k) ? 0.0 : -1.0, 1.0);
        setSlider(k, v.toDouble());
        _report(true, '${cheFaceSliderNames[k]} ${(sliderValue(k) * 100).round()} percent. Not saved yet.');
        return done(null);
      }
    }
    final colour = RegExp(r'^(skin(?: tone)?|eyes?|eye colou?r|hair colou?r)\s+(?:to\s+)?(.+)$').firstMatch(t);
    if (colour != null) {
      final which = colour.group(1)!;
      final (part, key, palette) = which.startsWith('skin')
          ? ('skin', 'tone', cheSkinTones)
          : which.startsWith('hair') ? ('hair', 'color', cheHairColors) : ('eyes', 'iris', cheIrisColors);
      final hit = palette.where((c) => c.$2 == colour.group(2)).toList();
      if (hit.isEmpty) return 'The ${part == 'eyes' ? 'eye' : part} colours are ${palette.map((c) => c.$2).join(', ')}.';
      _setPart(part, key, hit.first.$1);
      _report(true, '${part == 'eyes' ? 'Eyes' : part == 'hair' ? 'Hair colour' : 'Skin'} ${hit.first.$2}. Not saved yet.');
      return done(null);
    }
    final hs = RegExp(r'^hair(?: style)?\s+(?:to\s+)?(.+)$').firstMatch(t)?.group(1);
    if (hs != null) {
      final hit = cheHairStyleNames.entries.where((e) => e.value.toLowerCase() == hs || e.key.replaceAll('_', ' ') == hs).toList();
      if (hit.isEmpty) return 'The hair styles are ${cheHairStyleNames.values.join(', ')}.';
      _setPart('hair', 'style', hit.first.key);
      final built = hairBuilt.contains(hit.first.key);
      _report(true, 'Hair style ${hit.first.value}${built ? '' : ', which renders close-cropped until its strands are built'}. Not saved yet.');
      return done(null);
    }
    return null;
  }

  Future<void> load() async {
    try {
      final r = await _http.get(Uri.parse('${widget.baseUrl}/api/gpu/identities'), headers: widget.headers).timeout(const Duration(seconds: 12));
      if (r.statusCode != 200) throw StateError('status ${r.statusCode}');
      final d = jsonDecode(r.body);
      if (d is! Map) throw const FormatException('not a map');
      final list = [for (final p in (d['presets'] as List? ?? const [])) if (p is Map && '${p['id'] ?? ''}'.isNotEmpty) Map<String, dynamic>.from(p)];
      if (!mounted) return;
      setState(() {
        presets = list;
        active = {for (final e in (d['active'] as Map? ?? const {}).entries) '${e.key}': '${e.value}'};
        if (d['styles'] is List) styles = [for (final s in d['styles'] as List) '$s'];
        // The Worker sends each slider as {id, min, max}; plain names are accepted too.
        if (d['face_sliders'] is List) sliders = [for (final s in d['face_sliders'] as List) if (s is Map) '${s['id']}' else '$s'];
        if (d['hair_styles'] is List) hairStyles = [for (final s in d['hair_styles'] as List) '$s'];
        if (d['hair_built'] is List) hairBuilt = {for (final s in d['hair_built'] as List) '$s'};
        loading = false;
        _select(agent);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => loading = false);
      _report(false, 'Could not load the character presets from CHE. Use Refresh to try again.');
    }
  }

  /// The base presets: one per character (CHE and the agents); saved variants are listed with them.
  List<Map<String, dynamic>> get characters => [for (final p in presets) if ('${p['base'] ?? ''}'.isEmpty) p];

  void _select(String id) {
    final activeId = active[id];
    final chosen = presets.firstWhere((p) => p['id'] == activeId, orElse: () => presets.firstWhere((p) => p['id'] == id, orElse: () => presets.isEmpty ? const <String, dynamic>{} : presets.first));
    agent = id;
    preset = chosen.isEmpty ? const {} : _deepCopy(chosen);
    dirty = false;
    jobs = const [];
  }

  void _report(bool ok, String text) {
    if (ok) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    if (mounted) {
      setState(() {
        banner = text;
        bannerOk = ok;
      });
    }
  }

  Future<Map<String, dynamic>?> _post(String path, Map<String, dynamic> body) async {
    setState(() => busy = true);
    try {
      final r = await _http.post(Uri.parse('${widget.baseUrl}$path'), headers: _json, body: jsonEncode(body)).timeout(const Duration(seconds: 20));
      final d = jsonDecode(r.body);
      if (d is! Map) throw const FormatException('not a map');
      final m = Map<String, dynamic>.from(d);
      if (r.statusCode >= 300 && m['ok'] != false) m['ok'] = false;
      m['detail'] ??= 'CHE answered with status ${r.statusCode}';
      return m;
    } catch (_) {
      return {'ok': false, 'detail': 'CHE could not be reached'};
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  double sliderValue(String name) {
    final f = preset['face'];
    final v = f is Map ? f[name] : null;
    return v is num ? v.toDouble() : 0;
  }

  void setSlider(String name, double value) {
    setState(() {
      final face = Map<String, dynamic>.from((preset['face'] as Map?) ?? const {});
      final v = double.parse(value.toStringAsFixed(2));
      if (v == 0) {
        face.remove(name);
      } else {
        face[name] = v;
      }
      preset = {...preset, 'face': face};
      dirty = true;
    });
  }

  void _setPart(String part, String key, Object value) {
    setState(() {
      preset = {...preset, part: {...((preset[part] as Map?) ?? const {}), key: value}};
      dirty = true;
    });
  }

  String _part(String part, String key) => '${(preset[part] as Map?)?[key] ?? ''}';

  Future<void> generate() async {
    final base = '${preset['base'] ?? ''}'.isNotEmpty ? '${preset['base']}' : '${preset['id'] ?? agent}';
    final d = await _post('/api/gpu/identities/generate', {'base_id': base, 'seed': _seed++, 'amount': 0.3});
    if (d?['ok'] == true && d!['preset'] is Map) {
      setState(() {
        preset = Map<String, dynamic>.from(d['preset'] as Map);
        dirty = true;
        jobs = const [];
      });
      _report(true, 'Generated a new variant of ${_name(base)}. Not rendered yet: use Preview to queue it on your Colab GPU, or Save to keep it.');
    } else {
      _report(false, 'Generate did not work: ${d?['detail'] ?? 'no answer'}.');
    }
  }

  Future<void> preview() async {
    final looks = allLooks ? styles : [style];
    final d = await _post('/api/gpu/identities/preview', {'preset': preset, 'styles': looks});
    if (d?['ok'] == true) {
      // The preview route answers {style, job, duplicate} per look; the job card reads the job itself.
      final list = cheGpuJobsFrom({'jobs': [for (final e in (d!['jobs'] as List? ?? const [])) if (e is Map && e['job'] is Map) e['job'] else e]});
      setState(() => jobs = list);
      final names = looks.map((s) => cheLookNames[s] ?? s).join(', ');
      _report(true, 'Queued for your Colab T4 session: ${list.length} preview job${list.length == 1 ? '' : 's'} ($names; front, three-quarter and side). Nothing is rendered until the notebook runs.');
    } else {
      _report(false, 'Preview was not queued: ${d?['detail'] ?? 'no answer'}.');
    }
  }

  Future<void> save() async {
    // Built-in characters are never overwritten: an edited CHE or agent is saved as that character's own custom preset.
    final toSave = _deepCopy(preset)..remove('built_in');
    if ('${toSave['base'] ?? ''}'.isEmpty) {
      toSave['base'] = toSave['id'];
      toSave['id'] = '${toSave['id']}_c${DateTime.now().millisecondsSinceEpoch % 100000}';
      toSave['name'] = '${toSave['name']} custom';
    }
    final d = await _post('/api/gpu/identities', {'preset': toSave});
    if (d?['ok'] == true && d!['preset'] is Map) {
      final saved = Map<String, dynamic>.from(d['preset'] as Map);
      setState(() {
        presets = [...presets.where((p) => p['id'] != saved['id']), saved];
        preset = _deepCopy(saved);
        dirty = false;
      });
      _report(true, 'Saved the preset ${saved['name'] ?? saved['id']}.');
    } else {
      _report(false, 'Save did not work: ${d?['detail'] ?? 'no answer'}.');
    }
  }

  Future<void> apply() async {
    if (dirty) {
      _report(false, 'Not applied: this preset has unsaved changes. Save it first, then Apply.');
      return;
    }
    final id = '${preset['id'] ?? ''}';
    final d = await _post('/api/gpu/identities/apply', {'agent': agent, 'preset_id': id});
    if (d?['ok'] == true) {
      setState(() {
        active = d!['active'] is Map ? {for (final e in (d['active'] as Map).entries) '${e.key}': '${e.value}'} : {...active, agent: id};
      });
      _report(true, '${_name(agent)} now uses the preset ${preset['name'] ?? id}.');
    } else {
      _report(false, 'Apply did not work: ${d?['detail'] ?? 'no answer'}.');
    }
  }

  String _name(String id) => '${presets.firstWhere((p) => p['id'] == id, orElse: () => {'name': id})['name']}';

  /// What Read aloud says: the character, look, what changed and the last result.
  String get spokenSummary {
    final face = (preset['face'] as Map?) ?? const {};
    final changes = [
      for (final e in face.entries)
        if (e.value is num && (e.value as num) != 0) '${cheFaceSliderNames[e.key] ?? e.key} ${((e.value as num) * 100).round()} percent',
    ];
    final hair = _part('hair', 'style');
    return [
      'Character Generator. Editing ${_name(agent)}, preset ${preset['name'] ?? preset['id'] ?? 'none'}${dirty ? ', with unsaved changes' : ''}.',
      'Look: ${cheLookNames[style] ?? style}${allLooks ? ', previews queue all three looks' : ''}.',
      if (changes.isNotEmpty) 'Face: ${changes.join(', ')}.',
      'Skin ${cheColorName(cheSkinTones, _part('skin', 'tone'))}, eyes ${cheColorName(cheIrisColors, _part('eyes', 'iris'))}, hair ${cheHairStyleNames[hair] ?? hair}, ${cheColorName(cheHairColors, _part('hair', 'color'))}.',
      'Buttons: 1 Generate, 2 Preview, 3 Save, 4 Apply.',
      if (banner != null) 'Last result: $banner',
    ].join(' ');
  }

  @override
  Widget build(BuildContext context) {
    const quiet = TextStyle(color: Colors.white60, fontSize: 13, height: 1.4);
    const head = TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700);
    return Scaffold(
      backgroundColor: const Color(0xFF07090C),
      appBar: AppBar(
        backgroundColor: const Color(0xFF07090C),
        foregroundColor: Colors.white,
        title: Semantics(header: true, child: const Text('Character Generator')),
        actions: [
          Semantics(
            button: true,
            label: 'Read the Character Generator aloud',
            excludeSemantics: true,
            child: IconButton(
              icon: const Icon(Icons.volume_up_rounded),
              onPressed: widget.onRead == null || preset.isEmpty ? null : () => widget.onRead!(spokenSummary),
            ),
          ),
          Semantics(
            button: true,
            label: 'Refresh the character presets',
            excludeSemantics: true,
            child: IconButton(icon: const Icon(Icons.refresh_rounded), onPressed: busy ? null : () => unawaited(load())),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (banner != null) _banner(),
            if (loading) const Text('Loading the character presets…', style: quiet),
            if (!loading && presets.isEmpty) const Text('No character presets yet.', style: quiet),
            if (preset.isNotEmpty) ...[
              const Text('Character', style: head),
              const SizedBox(height: 6),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final c in characters)
                  Semantics(
                    button: true,
                    selected: c['id'] == agent,
                    label: 'Edit ${c['name']}, ${c['role'] ?? ''}',
                    excludeSemantics: true,
                    child: ChoiceChip(
                      key: ValueKey('char-${c['id']}'),
                      showCheckmark: false,
                      label: Text('${c['name']}'),
                      selected: c['id'] == agent,
                      onSelected: (_) => setState(() => _select('${c['id']}')),
                    ),
                  ),
              ]),
              const SizedBox(height: 6),
              Text('Preset: ${preset['name'] ?? preset['id']}${dirty ? ' (unsaved changes)' : ''}${active[agent] == preset['id'] ? ' · applied' : ''}', style: quiet),
              if ('${preset['references'] ?? ''}'.isNotEmpty) Text('${preset['references']}', style: quiet),
              const SizedBox(height: 14),
              const Text('Look', style: head),
              const SizedBox(height: 6),
              Wrap(spacing: 8, children: [
                for (final s in styles)
                  Semantics(
                    button: true,
                    selected: s == style,
                    label: '${cheLookNames[s] ?? s} look',
                    excludeSemantics: true,
                    child: ChoiceChip(
                      key: ValueKey('look-$s'),
                      showCheckmark: false,
                      label: Text(cheLookNames[s] ?? s),
                      selected: s == style,
                      onSelected: (_) => setState(() => style = s),
                    ),
                  ),
              ]),
              Semantics(
                toggled: allLooks,
                label: 'Preview all three looks',
                excludeSemantics: true,
                child: SwitchListTile(
                  key: const ValueKey('all-looks'),
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Preview all three looks', style: TextStyle(color: Colors.white)),
                  value: allLooks,
                  onChanged: (v) => setState(() => allLooks = v),
                ),
              ),
              _actions(),
              if (jobs.isNotEmpty) _jobs(quiet),
              const SizedBox(height: 14),
              const Text('Face', style: head),
              for (final name in sliders) _slider(name),
              const SizedBox(height: 14),
              const Text('Skin, eyes and hair', style: head),
              const SizedBox(height: 6),
              _swatches('Skin tone', 'skin', 'tone', cheSkinTones),
              _swatches('Eye colour', 'eyes', 'iris', cheIrisColors),
              _swatches('Hair colour', 'hair', 'color', cheHairColors),
              const SizedBox(height: 6),
              const Text('Hair style', style: TextStyle(color: Colors.white, fontSize: 14)),
              const SizedBox(height: 4),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final h in hairStyles)
                  Semantics(
                    button: true,
                    selected: _part('hair', 'style') == h,
                    label: 'Hair style ${cheHairStyleNames[h] ?? h}${hairBuilt.contains(h) ? '' : ', renders close-cropped until its strands are built'}',
                    excludeSemantics: true,
                    child: ChoiceChip(
                      key: ValueKey('hair-$h'),
                      showCheckmark: false,
                      label: Text('${cheHairStyleNames[h] ?? h}${hairBuilt.contains(h) || h == 'close_crop' ? '' : ' (close-cropped until built)'}'),
                      selected: _part('hair', 'style') == h,
                      onSelected: (_) => _setPart('hair', 'style', h),
                    ),
                  ),
              ]),
            ],
          ],
        ),
      ),
    );
  }

  Widget _banner() => Semantics(
        liveRegion: true,
        container: true,
        label: banner,
        excludeSemantics: true,
        child: Container(
          key: const ValueKey('generator-banner'),
          width: double.infinity,
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: bannerOk ? const Color(0xFF12352B) : const Color(0xFF3A1717),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: bannerOk ? const Color(0xFF3DDC97) : const Color(0xFFFF6B6B)),
          ),
          child: Text(banner!, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w600, height: 1.35)),
        ),
      );

  Widget _actions() {
    Widget big(String key, String label, String semantics, IconData icon, Future<void> Function() onTap) => Semantics(
          button: true,
          label: semantics,
          excludeSemantics: true,
          child: FilledButton.icon(
            key: ValueKey(key),
            style: FilledButton.styleFrom(minimumSize: const Size(150, 56), textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            onPressed: busy ? null : () => unawaited(onTap()),
            icon: Icon(icon),
            label: Text(label),
          ),
        );
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(spacing: 10, runSpacing: 10, children: [
        big('gen-generate', 'Generate', 'Generate a new variant of this character', Icons.auto_awesome_rounded, generate),
        big('gen-preview', 'Preview', 'Preview: queue GPU renders on your Colab T4', Icons.play_arrow_rounded, preview),
        big('gen-save', 'Save', 'Save this preset', Icons.save_rounded, save),
        big('gen-apply', 'Apply', 'Apply this preset to ${_name(agent)}', Icons.check_circle_rounded, apply),
      ]),
    );
  }

  Widget _jobs(TextStyle quiet) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final j in jobs)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${j['title'] ?? 'GPU job'}', style: const TextStyle(color: Colors.white, fontSize: 14)),
                Text(cheGpuStateLabel('${j['state'] ?? ''}'), style: quiet),
                if (j['previews'] is Map && (j['previews'] as Map).isNotEmpty)
                  Row(children: [
                    for (final e in (j['previews'] as Map).entries)
                      Padding(
                        padding: const EdgeInsets.only(right: 8, top: 4),
                        child: Semantics(
                          image: true,
                          label: 'GPU picture, ${const {'0': 'front', '45': 'three-quarter', '90': 'side'}['${e.key}'] ?? '${e.key} degrees'} view',
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(10),
                            child: Image.network('${widget.baseUrl}/api/media/${e.value}/image',
                                headers: widget.headers, width: 72, height: 90, fit: BoxFit.cover, cacheWidth: 200,
                                errorBuilder: (_, _, _) => const SizedBox(width: 72, height: 90)),
                          ),
                        ),
                      ),
                  ]),
              ]),
            ),
        ]),
      );

  Widget _slider(String name) {
    final label = cheFaceSliderNames[name] ?? name;
    final oneWay = cheOneWaySliders.contains(name);
    final v = sliderValue(name).clamp(oneWay ? 0.0 : -1.0, 1.0);
    return Row(children: [
      SizedBox(width: 150, child: ExcludeSemantics(child: Text(label, style: const TextStyle(color: Colors.white70, fontSize: 14)))),
      Expanded(
        child: Semantics(
          label: label,
          child: Slider(
            key: ValueKey('slider-$name'),
            min: oneWay ? 0 : -1,
            max: 1,
            divisions: oneWay ? 20 : 40,
            value: v,
            semanticFormatterCallback: (x) => '${(x * 100).round()} percent',
            onChanged: (x) => setSlider(name, x),
          ),
        ),
      ),
    ]);
  }

  Widget _swatches(String title, String part, String key, List<(String, String)> palette) {
    final current = _part(part, key).toLowerCase();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(children: [
        SizedBox(width: 110, child: ExcludeSemantics(child: Text(title, style: const TextStyle(color: Colors.white70, fontSize: 14)))),
        Expanded(
          child: Wrap(spacing: 6, runSpacing: 6, children: [
            for (final (hex, name) in palette)
              Semantics(
                button: true,
                selected: current == hex,
                label: '$title $name',
                excludeSemantics: true,
                child: InkWell(
                  key: ValueKey('swatch-$part-$hex'),
                  borderRadius: BorderRadius.circular(22),
                  onTap: () => _setPart(part, key, hex),
                  child: Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: cheHexColor(hex),
                      shape: BoxShape.circle,
                      border: Border.all(color: current == hex ? Colors.white : Colors.white24, width: current == hex ? 3 : 1),
                    ),
                  ),
                ),
              ),
          ]),
        ),
      ]),
    );
  }
}
