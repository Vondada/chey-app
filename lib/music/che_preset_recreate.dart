// "BandLab preset import", done honestly. Research (2026-10-25, web search; the BandLab help pages themselves could
// not be opened from the development machine, so this rests on the search engine's text from those pages):
//  - BandLab's help centre documents its import and export formats as audio and MIDI only (WAV, MP3, M4A, MIDI):
//    https://help.bandlab.com/hc/en-us/articles/360036010533-Supported-Audio-Formats-
//  - Effects presets are shared inside BandLab, as a post on a profile or a link that another BandLab user opens in
//    their own Studio and saves; no preset file download is documented:
//    https://help.bandlab.com/hc/en-us/articles/6443820016665-Sharing-your-Presets
//    https://help.bandlab.com/hc/en-us/articles/115002945473-Adding-Effects
//  - A preset seller's blog claims chains are small JSON files with an "Import Chain" option; BandLab documents no
//    such thing, so CHE does not rely on it.
// BandLab also publishes no parameter values for its stock vocal presets. So CHE cannot import a BandLab preset and
// never claims to. It RECREATES one: the owner names a chain ("BandLab Hip Hop Vocal") or describes it ("cut the lows,
// bright, heavy compression, short delay, big reverb"), and CHE maps that onto the studio's own effects. Every
// recreated preset is labelled "recreated, not imported". Starting values come from widely published vocal-mixing
// ranges (search results, 2026-10-25): high-pass around 80 to 100 Hz; a broad 2 to 3 dB presence boost at 3 to
// 5 kHz; de-essing around 5 to 8 kHz; compression 2:1 to 4:1 with 10 to 20 ms attack and 50 to 100 ms release;
// delay 100 to 400 ms (reverb.com "How to Mix Rap Vocals: Basic Techniques and Effects", violetrecording.com
// "Vocal chain for rap", audiofanzine "Mixing rap vocals, part 2: EQ").
import 'che_song.dart';

const cheRecreatedLabel = 'recreated, not imported';

/// What CHE says when asked to import a BandLab preset file.
const cheBandLabImportAnswer = 'I can\'t import BandLab presets: BandLab doesn\'t publish a preset file format. Its presets are shared '
    'as links that only open inside BandLab, and its export formats are audio and MIDI. I can recreate one instead: say '
    '"recreate BandLab Hip Hop Vocal", or describe the chain, for example "recreate a preset with cut lows, bright, '
    'heavy compression, short delay and big reverb". It will be labelled recreated, not imported.';

/// Where the starting values come from, for the receipt and the docs.
const cheRecreateSources = [
  'BandLab Help: Supported Import and Export File Formats (help.bandlab.com/hc/en-us/articles/360036010533)',
  'BandLab Help: Sharing your Presets (help.bandlab.com/hc/en-us/articles/6443820016665)',
  'reverb.com: How to Mix Rap Vocals: Basic Techniques and Effects',
  'violetrecording.com: Vocal chain for rap',
  'audiofanzine: Mixing rap vocals, part 2: EQ',
];

class CheRecreatedPreset {
  const CheRecreatedPreset({required this.name, required this.aliases, required this.basis, required this.build});
  final String name;
  final List<String> aliases;

  /// Why each setting is what it is, in words CHE can say.
  final String basis;
  final CheEffects Function() build;

  String get label => '$name ($cheRecreatedLabel)';

  CheEffects effects() => build()..preset = label;
}

/// Compression amount for a ratio on the studio's compressor (ratio = 1.5 + 4.5 x amount).
double cheCompressForRatio(double ratio) => ((ratio - 1.5) / 4.5).clamp(0, 1).toDouble();

/// The ratio and threshold the studio's compressor uses at [amount] (che_song.dart cheRenderTrack).
(double, double) cheCompressorSettings(double amount) => (1.5 + 4.5 * amount, -10 - 20 * amount);

final cheRecreatedPresets = <CheRecreatedPreset>[
  CheRecreatedPreset(
    name: 'BandLab Hip Hop Vocal',
    aliases: ['hip hop vocal', 'hip hop', 'rap vocal', 'rap'],
    basis: 'high-pass at 90 Hz (published range 80 to 100), plus 3 dB of presence at 4 kHz (published 2 to 3 dB at 3 to 5 kHz), '
        'de-esser, about 4 to 1 compression (published 2:1 to 4:1), a 250 ms delay (published 100 to 400 ms) and a small room',
    build: () => CheEffects(noise: true, highPass: 90, eqLow: -2, eqMid: 3, midHz: 4000, eqHigh: 1, deEss: 0.5,
        compress: cheCompressForRatio(4), delay: 0.15, delayMs: 250, reverb: 0.1, room: 0.4),
  ),
  CheRecreatedPreset(
    name: 'BandLab Trap Vocal',
    aliases: ['trap vocal', 'trap'],
    basis: 'hard pitch correction, high-pass at 100 Hz, 3 dB of presence at 4.5 kHz, de-esser, about 4.5 to 1 compression, '
        'a 300 ms delay and a short reverb',
    build: () => CheEffects(noise: true, pitch: 0.85, highPass: 100, eqLow: -2, eqMid: 3, midHz: 4500, eqHigh: 2, deEss: 0.5,
        compress: cheCompressForRatio(4.5), delay: 0.2, delayMs: 300, reverb: 0.15, room: 0.5),
  ),
  CheRecreatedPreset(
    name: 'BandLab R&B Vocal',
    aliases: ['r&b vocal', 'rnb vocal', 'r and b vocal', 'r&b', 'rnb'],
    basis: 'gentle pitch correction, high-pass at 80 Hz, 2 dB of presence at 3.5 kHz and 3 dB of air, light de-essing, '
        'about 3.5 to 1 compression, a 400 ms delay and a larger reverb',
    build: () => CheEffects(noise: true, pitch: 0.4, highPass: 80, eqMid: 2, midHz: 3500, eqHigh: 3, deEss: 0.4,
        compress: cheCompressForRatio(3.5), delay: 0.12, delayMs: 400, reverb: 0.35, room: 0.75),
  ),
  CheRecreatedPreset(
    name: 'BandLab Pop Vocal',
    aliases: ['pop vocal', 'pop'],
    basis: 'pitch correction, high-pass at 90 Hz, 2 dB of presence at 4 kHz and 3 dB of air, de-esser, about 4 to 1 '
        'compression, a quiet 350 ms delay and a medium reverb',
    build: () => CheEffects(noise: true, pitch: 0.6, highPass: 90, eqMid: 2, midHz: 4000, eqHigh: 3, deEss: 0.45,
        compress: cheCompressForRatio(4), delay: 0.12, delayMs: 350, reverb: 0.25, room: 0.6),
  ),
  CheRecreatedPreset(
    name: 'BandLab Lo-fi Vocal',
    aliases: ['lo fi vocal', 'lofi vocal', 'lo-fi vocal', 'lo fi', 'lofi'],
    basis: 'a telephone-style band: high-pass at 150 Hz and 6 dB less top, a 2 dB mid bump, about 3.5 to 1 compression, '
        'a 350 ms delay and a soft room',
    build: () => CheEffects(highPass: 150, eqMid: 2, eqHigh: -6, compress: cheCompressForRatio(3.5), delay: 0.2, delayMs: 350,
        reverb: 0.3, room: 0.55),
  ),
];

/// The recreated preset the words name, or null. Longer aliases win ("trap vocal" before "rap").
CheRecreatedPreset? cheFindRecreatedPreset(String words) {
  final s = _norm(words);
  CheRecreatedPreset? best;
  var bestLen = 0;
  for (final p in cheRecreatedPresets) {
    for (final a in [p.name.toLowerCase(), ...p.aliases]) {
      final n = _norm(a);
      if (n.length > bestLen && RegExp('\\b${RegExp.escape(n)}\\b').hasMatch(s)) {
        best = p;
        bestLen = n.length;
      }
    }
  }
  return best;
}

String _norm(String s) => s.toLowerCase().replaceAll(RegExp(r"[^a-z0-9&]"), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();

/// Builds an effects chain from the owner's description of a preset. Returns the chain and what CHE understood,
/// or null when the words describe no effect.
(CheEffects, List<String>)? cheEffectsFromDescription(String words) {
  final s = _norm(words);
  bool has(String p) => RegExp(p).hasMatch(s);
  final fx = CheEffects();
  final got = <String>[];
  final hpf = RegExp(r'\b(?:high ?pass|low ?cut)\D{0,8}(\d{2,3}) ?(?:hz|hertz)?\b').firstMatch(s);
  if (hpf != null) {
    fx.highPass = double.parse(hpf.group(1)!).clamp(20, 400).toDouble();
    got.add('high-pass at ${fx.highPass.round()} Hz');
  } else if (has(r'\b(cut|remove|less|no|thin out) (the )?(lows?|low end|bass|mud|rumble)\b|\bhigh ?pass\b|\blow ?cut\b')) {
    fx
      ..highPass = 100
      ..eqLow = -3;
    got.add('lows cut (high-pass at 100 Hz, low shelf -3 dB)');
  } else if (has(r'\b(warm|full|fat|more (low end|lows|bass)|boost (the )?(lows?|bass))\b')) {
    fx.eqLow = 3;
    got.add('low shelf +3 dB');
  }
  if (has(r'\b(presence|upfront|up front|forward|cut through)\b')) {
    fx
      ..eqMid = 3
      ..midHz = 4000;
    got.add('presence +3 dB at 4 kHz');
  }
  if (has(r'\b(bright|brighter|air|airy|crisp|shiny|sparkle)\b')) {
    fx.eqHigh = 3;
    got.add('high shelf +3 dB');
  } else if (has(r'\b(dark|darker|muffled|telephone|lo ?fi)\b')) {
    fx.eqHigh = -6;
    got.add('high shelf -6 dB');
  }
  if (has(r'\b(de ?ess(er|ing)?|sibilan(ce|t)|harsh s|esses)\b')) {
    fx.deEss = 0.5;
    got.add('de-esser 50%');
  }
  if (has(r'\b(heavy|hard|lots of|strong|squash(ed)?|smash(ed)?) (compression|compressor|compressed)\b|\bsquash')) {
    fx.compress = 0.75;
  } else if (has(r'\b(light|gentle|soft|little|touch of) (compression|compressor)\b')) {
    fx.compress = 0.3;
  } else if (has(r'\b(compression|compressor|compressed|compress)\b')) {
    fx.compress = 0.5;
  }
  if (fx.compress > 0) {
    final (ratio, threshold) = cheCompressorSettings(fx.compress);
    got.add('compression ${ratio.toStringAsFixed(1)} to 1 from ${threshold.round()} dB');
  }
  final ms = RegExp(r'\b(\d{2,4}) ?(?:ms|milliseconds?) (?:delay|echo)\b|\b(?:delay|echo) (?:of |at )?(\d{2,4}) ?(?:ms|milliseconds?)\b').firstMatch(s);
  if (ms != null) {
    fx
      ..delay = 0.2
      ..delayMs = double.parse(ms.group(1) ?? ms.group(2)!).clamp(40, 1500).toDouble();
  } else if (has(r'\b(short|quick|slap ?back|slap) (delay|echo)\b|\bslap ?back\b')) {
    fx
      ..delay = 0.2
      ..delayMs = 120;
  } else if (has(r'\b(long|big|wide) (delay|echo)\b')) {
    fx
      ..delay = 0.25
      ..delayMs = 500;
  } else if (has(r'\b(delay|echo)\b')) {
    fx
      ..delay = 0.2
      ..delayMs = 300;
  }
  if (fx.delay > 0) got.add('delay ${(fx.delay * 100).round()}% at ${fx.delayMs.round()} ms');
  if (has(r'\b(big|huge|large|lots of|long|wet|hall) (reverb|room|verb)\b|\bhall\b')) {
    fx
      ..reverb = 0.5
      ..room = 0.85;
  } else if (has(r'\b(small|little|short|touch of|bit of|dry|tight) (reverb|room|verb)\b')) {
    fx
      ..reverb = 0.15
      ..room = 0.4;
  } else if (has(r'\b(reverb|verb)\b')) {
    fx.reverb = 0.3;
  }
  if (fx.reverb > 0) got.add('reverb ${(fx.reverb * 100).round()}%, room ${(fx.room * 100).round()}%');
  if (has(r'\b(hard tune|robot|t ?pain)\b')) {
    fx.pitch = 1;
    got.add('hard pitch correction');
  } else if (has(r'\b(auto ?tune|pitch correct(ion|ed)?|tuned|tuning)\b')) {
    fx.pitch = 0.7;
    got.add('pitch correction 70%');
  }
  if (has(r'\b(noise reduction|gate|noise gate|clean up)\b')) {
    fx.noise = true;
    got.add('noise reduction');
  }
  if (got.isEmpty) return null;
  return (fx, got);
}

/// True when the words ask to read a BandLab preset file (which CHE cannot do) rather than recreate one.
bool cheAsksBandLabFileImport(String words) {
  final s = _norm(words);
  if (RegExp(r'\b(recreate|rebuild|make|copy|like|style)\b').hasMatch(s)) return false;
  return RegExp(r'\bbandlab\b').hasMatch(s) && RegExp(r'\b(import|load|open|read)\b|\bfile\b|\bjson\b|\blink\b').hasMatch(s);
}
