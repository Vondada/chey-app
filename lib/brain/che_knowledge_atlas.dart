// CHE Knowledge Atlas page (owner issue #346): coding and trading cards from beginner to
// expert, read from the bundled assets/atlas/knowledge_atlas.json, which the Worker's
// knowledge_atlas.js writes (tool/dump_knowledge_atlas.mjs), so the page works offline and
// matches words with the Worker's own filler and number lists.
//
// Opening it, filtering and moving between cards are quiet. "Read aloud" and the owner's own
// spoken requests speak. What the page shows and what Read aloud says are one list of lines
// (CheAtlasLine), so they cannot differ. Every button has a spoken route while the page is open
// (CheKnowledgeAtlasVoice, offered the owner's words first by Chat's voice pipeline).
// Recorded trading numbers are never shown from the phone: "Ask CHE for my recorded numbers"
// sends /learn through the normal chat turn, where CHE reads her own records.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_screen_awareness.dart';
import '../che_ui/che_theme.dart';

const cheAtlasLevels = ['beginner', 'intermediate', 'expert'];

class CheAtlasQuestion {
  const CheAtlasQuestion(this.q, this.a);
  final String q;
  final String a;
}

/// A coding exercise (phase 2): the question, any code, numbered options and the checked answer.
class CheAtlasExercise {
  const CheAtlasExercise({required this.prompt, required this.code, required this.options, required this.answer, required this.explain, this.topic = ''});
  final String prompt;
  final String topic;
  final String code;
  final List<String> options;
  final String answer;
  final String explain;
}

/// A review drill: buggy code, what is wrong with it, and the fix.
class CheAtlasDrill {
  const CheAtlasDrill({required this.title, required this.code, required this.finding, required this.fixed, required this.from});
  final String title;
  final String code;
  final String finding;
  final String fixed;
  final String from;
}

class CheAtlasCard {
  const CheAtlasCard({
    required this.id,
    required this.domain,
    required this.title,
    required this.level,
    required this.summary,
    required this.aliases,
    required this.related,
    required this.levels,
    required this.analogy,
    required this.formula,
    required this.example,
    required this.quiz,
    required this.misconceptions,
    this.limitations = const [],
    required this.cheNote,
    required this.measured,
    required this.sources,
    required this.revision,
    this.exercises = const [],
    this.drills = const [],
    this.repoExamples = const [],
  });

  final String id;
  final String domain;
  final String title;
  final String level;
  final String summary;
  final List<String> aliases;
  final List<String> related;
  final Map<String, String> levels;
  final String analogy;
  final Map<String, dynamic>? formula;
  final Map<String, dynamic> example;
  final List<CheAtlasQuestion> quiz;
  final List<String> misconceptions;
  final List<String> limitations;
  final String cheNote;
  final bool measured;
  final List<String> sources;
  final int revision;
  final List<CheAtlasExercise> exercises;
  final List<CheAtlasDrill> drills;

  /// "path, symbol: what it shows. Tested by test." for each place in CHE's own code.
  final List<String> repoExamples;

  static List<String> _strings(Object? v) => v is List ? v.map((e) => '$e').toList() : const [];

  factory CheAtlasCard.fromJson(Map<String, dynamic> j) {
    final levels = j['levels'] is Map ? Map<String, dynamic>.from(j['levels'] as Map) : const <String, dynamic>{};
    return CheAtlasCard(
      id: '${j['id']}',
      domain: '${j['domain']}',
      title: '${j['title']}',
      level: '${j['level']}',
      summary: '${j['summary'] ?? ''}',
      aliases: _strings(j['aliases']),
      related: _strings(j['related']),
      levels: {for (final l in cheAtlasLevels) l: '${levels[l] ?? ''}'},
      analogy: '${j['analogy'] ?? ''}',
      formula: j['formula'] is Map ? Map<String, dynamic>.from(j['formula'] as Map) : null,
      example: j['example'] is Map ? Map<String, dynamic>.from(j['example'] as Map) : const {},
      quiz: [
        for (final q in (j['quiz'] as List? ?? const []).whereType<Map>()) CheAtlasQuestion('${q['q']}', '${q['a']}'),
      ],
      misconceptions: _strings(j['misconceptions']),
      limitations: _strings(j['limitations']),
      cheNote: '${j['che_note'] ?? ''}',
      measured: j['measured'] is Map,
      sources: [
        for (final s in (j['sources'] as List? ?? const []).whereType<Map>()) '${s['title']}',
      ],
      revision: (j['revision'] as num?)?.toInt() ?? 1,
      exercises: [
        for (final x in (j['exercises'] as List? ?? const []).whereType<Map>())
          CheAtlasExercise(prompt: '${x['prompt']}', code: '${x['code'] ?? ''}', options: _strings(x['options']), answer: '${x['answer']}', explain: '${x['explain'] ?? ''}', topic: '${x['topic'] ?? ''}'),
      ],
      drills: [
        for (final d in (j['review_drills'] as List? ?? const []).whereType<Map>())
          CheAtlasDrill(title: '${d['title']}', code: '${d['code']}', finding: '${d['finding']}', fixed: '${d['fixed'] ?? ''}', from: '${d['from'] ?? ''}'),
      ],
      repoExamples: [
        for (final e in (j['repo_examples'] as List? ?? const []).whereType<Map>()) '${e['path']}, ${e['symbol']}: ${e['what']}. Tested by ${e['test']}.',
      ],
    );
  }

  /// "Practice: 4 exercises and 1 review drill.", or empty for a card with none.
  String get practiceWords {
    if (exercises.isEmpty && drills.isEmpty) return '';
    final parts = [
      if (exercises.isNotEmpty) '${exercises.length} exercise${exercises.length == 1 ? '' : 's'}',
      if (drills.isNotEmpty) '${drills.length} review drill${drills.length == 1 ? '' : 's'}',
    ];
    return 'Practice: ${parts.join(' and ')}. Say "exercise" or "review drill" to start one.';
  }

  String get domainLabel => domain == 'coding' ? 'Coding' : 'Trading';

  /// The worked example in words, as CHE says it.
  String get exampleWords {
    if (example['kind'] == 'code') return '${example['explain'] ?? ''}';
    final steps = (example['steps'] as List? ?? const []).map((s) => '$s').toList();
    return '${steps.join('; ')}.';
  }
}

class CheKnowledgeAtlas {
  CheKnowledgeAtlas(this.cards, {Set<String>? filler, Map<String, int>? numbers, Set<String>? languages, this.referencesLabel = 'Reference links, not opened or checked by CHE'})
      : filler = filler ?? const <String>{},
        numbers = numbers ?? const <String, int>{},
        languages = languages ?? const <String>{} {
    for (final c in cards) {
      // Titles and aliases only, as in the Worker: an id such as "c-python" would reduce to "c".
      for (final name in [c.title, ...c.aliases]) {
        final key = topicKey(name);
        if (key.isNotEmpty) _byKey.putIfAbsent(key, () => c);
      }
    }
  }

  static const asset = 'assets/atlas/knowledge_atlas.json';
  final List<CheAtlasCard> cards;

  /// The Worker's own filler and number words (knowledge_atlas.js), read from the asset.
  final Set<String> filler;
  final Map<String, int> numbers;

  /// Language names that are the topic when said on their own: "teach me Python".
  final Set<String> languages;

  /// How the cards name their references, the same words as in Chat.
  final String referencesLabel;
  final Map<String, CheAtlasCard> _byKey = {};

  factory CheKnowledgeAtlas.fromJson(Map<String, dynamic> j) {
    final matching = j['matching'] is Map ? Map<String, dynamic>.from(j['matching'] as Map) : const <String, dynamic>{};
    final numbers = matching['numbers'] is Map ? Map<String, dynamic>.from(matching['numbers'] as Map) : const <String, dynamic>{};
    return CheKnowledgeAtlas(
      [for (final c in (j['cards'] as List? ?? const []).whereType<Map>()) CheAtlasCard.fromJson(Map<String, dynamic>.from(c))],
      filler: {for (final w in (matching['filler'] as List? ?? const [])) '$w'},
      numbers: {for (final e in numbers.entries) if (e.value is num) e.key: (e.value as num).toInt()},
      languages: {for (final w in (matching['languages'] as List? ?? const [])) '$w'},
      referencesLabel: '${j['references_label'] ?? 'Reference links, not opened or checked by CHE'}',
    );
  }

  static Future<CheKnowledgeAtlas> load() async =>
      CheKnowledgeAtlas.fromJson(Map<String, dynamic>.from(jsonDecode(await rootBundle.loadString(asset)) as Map));

  /// A topic as the Worker's topicKey() compares it: no punctuation, no filler words, light singulars;
  /// a language said on its own, exactly ("Python"), is the topic ("lang:python").
  String topicKey(String text) {
    final words = text.toLowerCase().replaceAll("'", '').replaceAll('’', '').replaceAll(RegExp(r'[^a-z0-9²]+'), ' ').trim().split(' ').where((w) => w.isNotEmpty);
    final kept = words
        .where((w) => !filler.contains(w))
        .map((w) => w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.substring(0, w.length - 1) : w)
        .toList();
    // Only the language's own name, as in the Worker: never "this python code" or "that javascript".
    final name = RegExp(r'^(?:the )?([a-z]+)(?: (?:programming|language|programming language))?$').firstMatch(words.join(' '));
    if (name != null && languages.contains(name.group(1))) return 'lang:${name.group(1)}';
    return kept.join(' ');
  }

  int? numberOf(String w) => int.tryParse(w) ?? numbers[w];

  List<CheAtlasCard> inDomain(String domain) => domain == 'all' ? cards : cards.where((c) => c.domain == domain).toList();

  CheAtlasCard? byId(String id) {
    for (final c in cards) {
      if (c.id == id) return c;
    }
    return null;
  }

  /// The card a topic names exactly, the same rule as the Worker's; never a near guess.
  CheAtlasCard? find(String topic) {
    final key = topicKey(topic);
    return (key.isEmpty ? null : _byKey[key]) ?? byId(topic.trim().toLowerCase());
  }

  /// The next card in its domain's curriculum order, or null after the last.
  CheAtlasCard? next(CheAtlasCard c) {
    final list = inDomain(c.domain);
    final i = list.indexOf(c);
    return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
  }
}

/// The owner's words as the page compares them: no wake word, politeness, apostrophes or punctuation.
String cheAtlasWords(String raw) => raw
    .trim()
    .toLowerCase()
    .replaceAll(RegExp(r"['’]"), '')
    .replaceFirst(RegExp(r'^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chay|chey|shay)(?![a-z])[\s,.:;!?-]*'), '')
    .replaceFirst(RegExp(r'^(?:(?:please|can you|could you)\s+)+'), '')
    .replaceAll(RegExp(r'[.!?,]+'), ' ')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

enum CheAtlasLineKind { title, meta, heading, body, formula, code, answer }

/// One line of the page: shown exactly as written, and spoken in the same words by Read aloud.
/// [slot] marks where the page puts a control after the line (a button is not read as content).
class CheAtlasLine {
  const CheAtlasLine(this.text, [this.kind = CheAtlasLineKind.body, this.slot = '']);
  final String text;
  final CheAtlasLineKind kind;
  final String slot;
}

/// What Read aloud says for these lines: every line, in order, as shown.
String cheAtlasSpoken(List<CheAtlasLine> lines) => lines.map((l) => l.text).join('\n');

/// The list of cards, as shown and as read.
List<CheAtlasLine> cheAtlasListLines(List<CheAtlasCard> shown, String label) => [
      CheAtlasLine('$label: ${shown.length}.', CheAtlasLineKind.title),
      for (final (i, c) in shown.indexed) ...[
        CheAtlasLine('${i + 1}. ${c.title}', CheAtlasLineKind.heading, 'open:${c.id}'),
        CheAtlasLine('${c.domainLabel}, ${c.level}. ${c.summary}', CheAtlasLineKind.meta),
      ],
    ];

/// One card at one level, as shown and as read.
List<CheAtlasLine> cheAtlasCardLines(CheKnowledgeAtlas atlas, CheAtlasCard c, String level) {
  final f = c.formula;
  final code = c.example['kind'] == 'code' ? '${c.example['code'] ?? ''}' : '';
  final related = [for (final id in c.related) atlas.byId(id)?.title].whereType<String>().toList();
  return [
    CheAtlasLine('${c.title}, $level level.', CheAtlasLineKind.title),
    CheAtlasLine('${c.domainLabel}, starts at ${c.level}, curated teaching content, revision ${c.revision}.', CheAtlasLineKind.meta, 'levels'),
    CheAtlasLine(c.levels[level] ?? ''),
    if (level == 'beginner') ...[
      const CheAtlasLine('Analogy, and only an analogy', CheAtlasLineKind.heading),
      CheAtlasLine(c.analogy),
    ],
    if (f != null) ...[
      const CheAtlasLine('Formula', CheAtlasLineKind.heading),
      CheAtlasLine('${f['expression']}', CheAtlasLineKind.formula),
      CheAtlasLine('${f['spoken']}.', CheAtlasLineKind.meta),
      CheAtlasLine('Assumptions: ${f['assumptions']}', CheAtlasLineKind.meta),
    ],
    const CheAtlasLine('Worked example', CheAtlasLineKind.heading),
    CheAtlasLine(c.exampleWords),
    if (code.isNotEmpty) CheAtlasLine(code, CheAtlasLineKind.code),
    if (level == 'expert' && c.misconceptions.isNotEmpty) ...[
      const CheAtlasLine('Common mistake', CheAtlasLineKind.heading),
      CheAtlasLine(c.misconceptions.first),
    ],
    if (c.cheNote.isNotEmpty) ...[
      const CheAtlasLine('In CHE', CheAtlasLineKind.heading),
      CheAtlasLine(c.cheNote),
    ],
    if (c.repoExamples.isNotEmpty) ...[
      const CheAtlasLine("In CHE's own code", CheAtlasLineKind.heading),
      for (final e in c.repoExamples) CheAtlasLine(e),
    ],
    if (c.limitations.isNotEmpty) ...[
      const CheAtlasLine('Limitations', CheAtlasLineKind.heading),
      for (final l in c.limitations) CheAtlasLine(l),
    ],
    if (c.practiceWords.isNotEmpty) ...[
      const CheAtlasLine('Practice', CheAtlasLineKind.heading),
      CheAtlasLine(c.practiceWords, CheAtlasLineKind.body, 'practice'),
    ],
    if (c.measured) ...[
      const CheAtlasLine('Your recorded numbers', CheAtlasLineKind.heading),
      const CheAtlasLine('CHE reads these from her paper journal and stored backtest only, never from this card.', CheAtlasLineKind.meta, 'measured'),
    ],
    if (related.isNotEmpty) CheAtlasLine('Related cards: ${related.join(', ')}.', CheAtlasLineKind.meta, 'related'),
    CheAtlasLine('${atlas.referencesLabel}: ${c.sources.join('; ')}.', CheAtlasLineKind.meta, 'end'),
  ];
}

/// One exercise or review drill, as shown and as read: the answer appears (and is read) only once revealed.
List<CheAtlasLine> cheAtlasPracticeLines(CheAtlasCard c, String kind, int i, {bool revealed = false}) {
  if (kind == 'drill') {
    final d = c.drills[i];
    return [
      CheAtlasLine('Review drill ${i + 1} of ${c.drills.length} on ${c.title}.', CheAtlasLineKind.title, 'levels'),
      CheAtlasLine('${d.title}.${d.from.isEmpty ? '' : ' ${d.from}.'} What is wrong with this code?'),
      CheAtlasLine(d.code, CheAtlasLineKind.code, revealed ? '' : 'reveal'),
      if (revealed) ...[
        CheAtlasLine('Finding: ${d.finding}', CheAtlasLineKind.answer),
        if (d.fixed.isNotEmpty) CheAtlasLine(d.fixed, CheAtlasLineKind.code),
      ],
      const CheAtlasLine('Say "next review drill", "exercise", or "back to the card".', CheAtlasLineKind.meta, 'practice-next'),
    ];
  }
  final x = c.exercises[i];
  return [
    CheAtlasLine('Exercise ${i + 1} of ${c.exercises.length} on ${c.title}.', CheAtlasLineKind.title, 'levels'),
    CheAtlasLine(x.prompt),
    if (x.code.isNotEmpty) CheAtlasLine(x.code, CheAtlasLineKind.code),
    if (x.options.isNotEmpty) CheAtlasLine([for (final (n, o) in x.options.indexed) 'Option ${n + 1}: $o.'].join(' ')),
    // The phone shows the answer; only Chat checks one, so it says so instead of pretending.
    // The phone does not check answers, and an exercise opened here is not open in Chat, so it says how.
    if (!revealed) CheAtlasLine('To have an answer checked, ask for this exercise in Chat: say "give me an exercise on ${x.topic.isEmpty ? c.title : x.topic}". Or say "show the answer" to see it here.', CheAtlasLineKind.meta, 'reveal'),
    if (revealed) CheAtlasLine('Answer: ${x.answer}. ${x.explain}', CheAtlasLineKind.answer),
    const CheAtlasLine('Say "next exercise", "review drill", or "back to the card".', CheAtlasLineKind.meta, 'practice-next'),
  ];
}

/// A card's quiz, as shown and as read: an answer appears (and is read) only once revealed.
List<CheAtlasLine> cheAtlasQuizLines(CheAtlasCard c, Set<int> revealed) => [
      CheAtlasLine('Quiz on ${c.title}.', CheAtlasLineKind.title, 'levels'),
      for (final (i, q) in c.quiz.indexed) ...[
        CheAtlasLine('${i + 1}. ${q.q}', CheAtlasLineKind.body, revealed.contains(i) ? '' : 'answer:$i'),
        if (revealed.contains(i)) CheAtlasLine('Answer: ${q.a}', CheAtlasLineKind.answer),
      ],
    ];

/// Spoken control of the open Atlas page. Null when the page is closed.
class CheKnowledgeAtlasVoice {
  CheKnowledgeAtlasVoice._();
  static Future<String?> Function(String words)? handler;
}

class CheKnowledgeAtlasPage extends StatefulWidget {
  const CheKnowledgeAtlasPage({super.key, required this.onSpeak, this.atlas, this.onListen, this.onAskChe});

  /// Speaks a line the owner asked for (Read aloud); the page never speaks by itself.
  final void Function(String text) onSpeak;

  /// The cards; the app loads the bundled asset when this is null.
  final CheKnowledgeAtlas? atlas;

  /// "Speak to CHE": Chat's microphone, whose words this page hears first.
  final VoidCallback? onListen;

  /// Sends a request through the normal chat turn and returns CHE's reply.
  final Future<String> Function(String message)? onAskChe;

  @override
  State<CheKnowledgeAtlasPage> createState() => _CheKnowledgeAtlasPageState();
}

class _CheKnowledgeAtlasPageState extends State<CheKnowledgeAtlasPage> {
  CheKnowledgeAtlas? _atlas;
  String _error = '';
  String _domain = 'all';
  CheAtlasCard? _card;
  String _level = 'beginner';
  bool _quiz = false;
  final Set<int> _answers = {};
  // An exercise or drill on this card: '' for none, 'exercise' or 'drill'; its answer stays hidden until asked for.
  String _practice = '';
  int _practiceAt = 0;
  bool _practiceRevealed = false;
  String _status = '';
  bool _asking = false;
  Object? _screen;

  @override
  void initState() {
    super.initState();
    CheKnowledgeAtlasVoice.handler = _voice;
    _screen = CheScreenAwareness.register(context, () => CheScreenReport(
          page: 'the Knowledge Atlas',
          tab: _card == null ? _listLabel : _card!.title,
          detail: _atlas == null
              ? (_error.isEmpty ? 'The cards are loading' : _error)
              : _card == null
                  ? '${_shown.length} cards: ${[for (final (i, c) in _shown.indexed) '${i + 1}. ${c.title}'].join(', ')}'
                  : '${_card!.title}, $_level level${_quiz ? ', quiz open' : ''}',
          controls: _card == null
              ? const ['Back', 'Read aloud', 'Speak to CHE', 'All', 'Coding', 'Trading', 'the cards']
              : [
                  'Back', 'Read aloud', 'Speak to CHE', 'Beginner', 'Intermediate', 'Expert', 'Quiz me', 'Next card', 'All cards',
                  if (_card!.exercises.isNotEmpty) 'Exercise',
                  if (_card!.drills.isNotEmpty) 'Review drill',
                ],
        ));
    if (widget.atlas != null) {
      _atlas = widget.atlas;
    } else {
      _loadBundled();
    }
  }

  Future<void> _loadBundled() async {
    try {
      final atlas = await CheKnowledgeAtlas.load();
      if (mounted) setState(() => _atlas = atlas);
    } catch (_) {
      if (mounted) setState(() => _error = 'The Knowledge Atlas cards could not be read on this phone.');
    }
  }

  @override
  void dispose() {
    CheScreenAwareness.unregister(_screen);
    if (CheKnowledgeAtlasVoice.handler == _voice) CheKnowledgeAtlasVoice.handler = null;
    super.dispose();
  }

  List<CheAtlasCard> get _shown => _atlas?.inDomain(_domain) ?? const [];

  String get _listLabel => _domain == 'all' ? 'All cards' : '${_domain == 'coding' ? 'Coding' : 'Trading'} cards';

  // The lines on screen right now; the same list is what Read aloud says.
  List<CheAtlasLine> get _lines {
    final atlas = _atlas;
    final c = _card;
    if (atlas == null) return const [];
    if (c == null) return cheAtlasListLines(_shown, _listLabel);
    if (_practice.isNotEmpty) return cheAtlasPracticeLines(c, _practice, _practiceAt, revealed: _practiceRevealed);
    return _quiz ? cheAtlasQuizLines(c, _answers) : cheAtlasCardLines(atlas, c, _level);
  }

  // A result the owner asked for: shown large, announced, felt, and returned for CHE to say.
  String _result(String line, {bool ok = true}) {
    if (ok) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    if (mounted) setState(() => _status = line);
    return line;
  }

  void _open(CheAtlasCard c) {
    HapticFeedback.selectionClick();
    setState(() {
      _card = c;
      _level = 'beginner';
      _quiz = false;
      _answers.clear();
      _practice = '';
      _status = '';
    });
  }

  // Opens an exercise or drill on the open card; "next" moves on from the one shown.
  String _startPractice(CheAtlasCard c, String kind, {bool next = false}) {
    final total = kind == 'drill' ? c.drills.length : c.exercises.length;
    final name = kind == 'drill' ? 'review drill' : 'exercise';
    if (total == 0) return _result('${c.title} has no ${name}s yet. Say "quiz me" for its quiz.', ok: false);
    final at = next && _practice == kind ? _practiceAt + 1 : 0;
    if (at >= total) return _result('That was the last $name on ${c.title}.', ok: false);
    HapticFeedback.selectionClick();
    setState(() {
      _practice = kind;
      _practiceAt = at;
      _practiceRevealed = false;
      _quiz = false;
    });
    // The practice itself is the page; the banner only says what changed, so it is not read twice.
    _result('${name[0].toUpperCase()}${name.substring(1)} ${at + 1} of $total shown.');
    return cheAtlasSpoken(_lines);
  }

  String _reveal() {
    setState(() => _practiceRevealed = true);
    _result(_practice == 'drill' ? 'Finding shown.' : 'Answer shown.');
    return cheAtlasSpoken(_lines);
  }

  void _setLevel(String level) {
    HapticFeedback.selectionClick();
    setState(() {
      _level = level;
      _quiz = false;
      _practice = '';
    });
  }

  void _setDomain(String domain) {
    HapticFeedback.selectionClick();
    setState(() {
      _domain = domain;
      _card = null;
      _quiz = false;
      _status = '';
    });
  }

  String _formulaText(CheAtlasCard c) => c.formula == null
      ? '${c.title} has no single formula: it is a concept, not a calculation.'
      : 'The formula for ${c.title}: ${c.formula!['spoken']}. Written: ${c.formula!['expression']}. Assumptions: ${c.formula!['assumptions']}';

  void _readAloud() {
    final c = _card;
    setState(() => _status = c == null ? 'Reading the list aloud.' : 'Reading ${c.title} aloud.');
    widget.onSpeak(cheAtlasSpoken(_lines));
  }

  Future<void> _askRecorded(CheAtlasCard c) async {
    final ask = widget.onAskChe;
    if (ask == null || _asking) return;
    setState(() {
      _asking = true;
      _status = 'Asking CHE for your recorded numbers…';
    });
    try {
      final reply = (await ask('/learn ${c.aliases.isEmpty ? c.title : c.aliases.first}')).trim();
      _result(reply.isEmpty ? 'CHE did not answer. Nothing was read from your records.' : reply, ok: reply.isNotEmpty);
    } catch (_) {
      _result('CHE did not answer. Nothing was read from your records.', ok: false);
    } finally {
      if (mounted) setState(() => _asking = false);
    }
  }

  // Spoken control while this page is the open route. Anything else goes on to Chat.
  Future<String?> _voice(String words) async {
    if (!mounted || ModalRoute.of(context)?.isCurrent == false) return null;
    final atlas = _atlas;
    final t = cheAtlasWords(words);
    if (atlas == null || t.isEmpty || t.startsWith('/')) return null;
    final card = _card;
    // Already here: a second "open the knowledge atlas" must not stack a second page.
    if (RegExp(r"^(?:open|show(?: me)?|go to|take me to|bring up)\s+(?:the\s+|my\s+|your\s+|ches\s+)?knowledge atlas(?:\s+(?:page|screen|cards))?$").hasMatch(t)) {
      return _result('The Knowledge Atlas is already open.');
    }
    if (RegExp(r'^(?:go back|back|close|close (?:the )?(?:knowledge )?atlas|all cards|show all cards)$').hasMatch(t)) {
      if (card != null) {
        if (_practice.isNotEmpty) {
          setState(() => _practice = '');
          return _result(cheAtlasSpoken(_lines));
        }
        setState(() {
          _card = null;
          _quiz = false;
        });
        return _result('Back to the ${_shown.length} cards.');
      }
      final closed = await Navigator.of(context).maybePop();
      return closed ? 'Closed the Knowledge Atlas.' : _result('I could not close the Knowledge Atlas.', ok: false);
    }
    if (RegExp(r'^(?:what can i do(?: here)?|read (?:me )?my options|what are my options|options|help)$').hasMatch(t)) {
      return _result(card == null
          ? 'Your options: 1. Read aloud. 2. Coding cards. 3. Trading cards. 4. A number, to open that card. 5. Teach me, and a topic. 6. Go back.'
          : 'Your options: 1. Read aloud. 2. Beginner, intermediate or expert version. 3. The formula. 4. The example. 5. Quiz me. 6. Next card. 7. Go back.'
              '${card.exercises.isNotEmpty ? ' 8. Exercise.' : ''}${card.drills.isNotEmpty ? ' ${card.exercises.isNotEmpty ? 9 : 8}. Review drill.' : ''}');
    }
    if (RegExp(r'^(?:read (?:this|it|that|aloud|the card|this card|the list)|read it (?:to me|aloud)|read aloud|read this aloud)$').hasMatch(t)) {
      return _result(cheAtlasSpoken(_lines));
    }
    final list = RegExp(r'^(?:(?:list|show|read)(?: me)? (?:the |all )?)?(coding|code|trading|all) cards$').firstMatch(t) ??
        RegExp(r'^(?:list|show|read)(?: me)? (?:the |all )?(?:(coding|trading) )?cards$').firstMatch(t);
    if (list != null) {
      final d = list.group(1) == 'code' ? 'coding' : list.group(1) ?? 'all';
      setState(() {
        _domain = d;
        _card = null;
        _quiz = false;
      });
      return _result(cheAtlasSpoken(_lines));
    }
    final pick = RegExp(r'^(?:(?:open )?(?:number|card) )?(\d{1,2}|[a-z]+)$').firstMatch(t);
    final n = pick == null ? null : atlas.numberOf(pick.group(1)!);
    if (n != null && card == null) {
      if (n < 1 || n > _shown.length) return _result('There is no number $n here. Say a number from 1 to ${_shown.length}.', ok: false);
      _open(_shown[n - 1]);
      return _result(cheAtlasSpoken(_lines));
    }
    final quizOn = RegExp(r'^quiz me on (.+)$').firstMatch(t);
    if (quizOn != null && !(card != null && RegExp(r'^(?:this|it|this card|that)$').hasMatch(quizOn.group(1)!))) {
      final found = atlas.find(quizOn.group(1)!);
      if (found == null) return null;
      _open(found);
      setState(() => _quiz = true);
      return _result(cheAtlasSpoken(_lines));
    }
    final teach = RegExp(r'^(?:teach me|open|show me|explain|tell me about|go to)\s+(.+?)$').firstMatch(t);
    if (teach != null) {
      final found = atlas.find(teach.group(1)!);
      if (found != null) {
        _open(found);
        return _result(cheAtlasSpoken(_lines));
      }
    }
    final level = RegExp(r'^(?:(?:give|show|read) me )?(?:the )?(beginner|simple|intermediate|practical|expert|advanced) (?:version|level)$|^(beginner|intermediate|expert)$').firstMatch(t);
    final nudge = RegExp(r'^(?:go deeper|deeper|more advanced|simpler|make it simpler|easier)$').firstMatch(t);
    if (level != null || nudge != null) {
      if (card == null) return _result('Open a card first: say a number, or "teach me" and a topic.', ok: false);
      final word = level?.group(1) ?? level?.group(2) ?? '';
      var target = const {'simple': 'beginner', 'practical': 'intermediate', 'advanced': 'expert'}[word] ?? word;
      if (target.isEmpty) {
        final at = cheAtlasLevels.indexOf(_level);
        target = RegExp(r'simpl|easi').hasMatch(t) ? cheAtlasLevels[at > 0 ? at - 1 : 0] : cheAtlasLevels[at < 2 ? at + 1 : 2];
      }
      _setLevel(target);
      return _result(cheAtlasSpoken(_lines));
    }
    if (card == null) return null;
    // Practice on this card, offline: an exercise or a drill, then its answer when asked.
    final practice = RegExp(r'^(?:give me |start |do |try )?(?:an? |another |the )?(next )?(?:coding )?(exercise|practice|practice question|review drill|drill)$').firstMatch(t);
    if (practice != null) {
      return _startPractice(card, practice.group(2)!.contains('drill') ? 'drill' : 'exercise', next: practice.group(1) != null || t.contains('another'));
    }
    if (_practice.isNotEmpty && RegExp(r'^(?:(?:show|tell|give|read) me |show )?(?:the )?(?:answer|finding|bug)$').hasMatch(t)) return _reveal();
    if (_practice.isNotEmpty && RegExp(r'^(?:back to the card|go back to the card|the card)$').hasMatch(t)) {
      setState(() => _practice = '');
      return _result(cheAtlasSpoken(_lines));
    }
    if (RegExp(r'^(?:what(?:s| is) the |show me the |read me the |the )?(?:formula|equation|math)$').hasMatch(t)) return _result(_formulaText(card));
    if (RegExp(r'^(?:(?:show|read|give) me )?(?:the |an )?(?:worked |code )?example$|^show me the code$').hasMatch(t)) {
      return _result('Worked example: ${card.exampleWords}${card.example['kind'] == 'code' ? ' The code is on screen.' : ''}');
    }
    if (RegExp(r'^(?:quiz me|start the quiz|quiz|quiz me on (?:this|it|this card|that))$').hasMatch(t)) {
      setState(() {
        _quiz = true;
        _practice = '';
        _answers.clear();
      });
      return _result(cheAtlasSpoken(_lines));
    }
    if (RegExp(r'^(?:(?:show|read|give) me )?(?:the )?(?:quiz )?answers?$').hasMatch(t)) {
      setState(() {
        _quiz = true;
        _practice = '';
        _answers.addAll(List.generate(card.quiz.length, (i) => i));
      });
      return _result(cheAtlasSpoken(_lines));
    }
    if (RegExp(r'^(?:next|next card|next lesson|what(?:s| is) next(?: after this)?|go to the next (?:card|one))$').hasMatch(t)) {
      final next = atlas.next(card);
      if (next == null) return _result('${card.title} is the last ${card.domain} card for now.', ok: false);
      _open(next);
      return _result(cheAtlasSpoken(_lines));
    }
    if (RegExp(r'^(?:my (?:recorded )?numbers|what are my (?:recorded )?numbers|ask che for my (?:recorded )?numbers)$').hasMatch(t) && card.measured) {
      await _askRecorded(card);
      return _status;
    }
    return null;
  }

  Widget _chip(String label, bool selected, VoidCallback onTap) => ChoiceChip(
        label: Text(label, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
        selected: selected,
        onSelected: (_) => onTap(),
      );

  static const _big = TextStyle(fontSize: 18, height: 1.45, color: CheColors.text);
  static const _dim = TextStyle(fontSize: 16, height: 1.4, color: CheColors.textDim);

  // One line as the page shows it. Each carries its index as a key, so a test can read the screen
  // in order and compare it with what Read aloud says.
  Widget _line(int i, CheAtlasLine l) {
    final key = ValueKey('atlas-line-$i');
    switch (l.kind) {
      case CheAtlasLineKind.title:
        return Semantics(header: true, child: Text(l.text, key: key, style: CheType.title));
      case CheAtlasLineKind.heading:
        return Padding(
          padding: const EdgeInsets.only(top: 14),
          child: Semantics(header: true, child: Text(l.text, key: key, style: CheType.headline.copyWith(color: CheColors.accent))),
        );
      case CheAtlasLineKind.formula:
        return SelectableText(l.text, key: key, style: CheType.mono.copyWith(fontSize: 17));
      case CheAtlasLineKind.code:
        return Container(
          margin: const EdgeInsets.only(top: 8),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: CheColors.surface, border: Border.all(color: CheColors.stroke), borderRadius: BorderRadius.circular(8)),
          child: SelectableText(l.text, key: key, style: CheType.mono.copyWith(fontSize: 14)),
        );
      case CheAtlasLineKind.answer:
        return Padding(padding: const EdgeInsets.only(left: 12, bottom: 8), child: Text(l.text, key: key, style: _big.copyWith(color: CheColors.success)));
      case CheAtlasLineKind.meta:
        return Padding(padding: const EdgeInsets.only(top: 4), child: Text(l.text, key: key, style: _dim));
      case CheAtlasLineKind.body:
        return Padding(padding: const EdgeInsets.only(top: 6), child: Text(l.text, key: key, style: _big));
    }
  }

  // The controls that sit after a line: they are buttons, not content, so they are not read.
  List<Widget> _controls(CheAtlasLine l) {
    final atlas = _atlas!;
    final c = _card;
    final slot = l.slot;
    if (c == null) return const [];
    if (slot == 'levels') {
      return [
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final lv in cheAtlasLevels) _chip('${lv[0].toUpperCase()}${lv.substring(1)}', _level == lv && !_quiz, () => _setLevel(lv)),
          _chip('Quiz me', _quiz, () => setState(() {
                HapticFeedback.selectionClick();
                _quiz = true;
                _practice = '';
              })),
          if (c.exercises.isNotEmpty) _chip('Exercise', _practice == 'exercise', () => _startPractice(c, 'exercise')),
          if (c.drills.isNotEmpty) _chip('Review drill', _practice == 'drill', () => _startPractice(c, 'drill')),
        ]),
      ];
    }
    if (slot == 'reveal') {
      return [
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(onPressed: _reveal, child: Text(_practice == 'drill' ? 'Show the finding' : 'Show the answer', style: const TextStyle(fontSize: 16))),
        ),
      ];
    }
    if (slot == 'practice-next') {
      final kind = _practice;
      final more = kind == 'drill' ? _practiceAt + 1 < c.drills.length : _practiceAt + 1 < c.exercises.length;
      return [
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (more) FilledButton(onPressed: () => _startPractice(c, kind, next: true), child: Text(kind == 'drill' ? 'Next review drill' : 'Next exercise')),
          OutlinedButton(onPressed: () => setState(() => _practice = ''), child: const Text('Back to the card')),
        ]),
      ];
    }
    if (slot.startsWith('answer:')) {
      final i = int.tryParse(slot.substring(7)) ?? 0;
      return [Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () => setState(() => _answers.add(i)), child: Text('Show answer ${i + 1}', style: const TextStyle(fontSize: 16))))];
    }
    if (slot == 'measured' && widget.onAskChe != null) {
      return [Padding(padding: const EdgeInsets.only(top: 6), child: OutlinedButton(onPressed: _asking ? null : () => _askRecorded(c), child: const Text('Ask CHE for my recorded numbers')))];
    }
    if (slot == 'related') {
      return [
        const SizedBox(height: 6),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final id in c.related)
            if (atlas.byId(id) case final r?) OutlinedButton(onPressed: () => _open(r), child: Text(r.title)),
        ]),
      ];
    }
    if (slot == 'end') {
      final next = atlas.next(c);
      return [
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (next != null) FilledButton(onPressed: () => _open(next), child: Text('Next card: ${next.title}')),
          OutlinedButton(onPressed: () => _setDomain(_domain), child: const Text('All cards')),
        ]),
      ];
    }
    return const [];
  }

  Widget _content() {
    final atlas = _atlas!;
    final lines = _lines;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (_card == null) ...[
        Wrap(spacing: 8, runSpacing: 8, children: [
          _chip('All ${atlas.cards.length}', _domain == 'all', () => _setDomain('all')),
          _chip('Coding ${atlas.inDomain('coding').length}', _domain == 'coding', () => _setDomain('coding')),
          _chip('Trading ${atlas.inDomain('trading').length}', _domain == 'trading', () => _setDomain('trading')),
        ]),
        const SizedBox(height: 8),
      ],
      for (final (i, l) in lines.indexed) ...[
        // A card's name in the list opens it when touched, like its "Open" button.
        if (l.slot.startsWith('open:'))
          InkWell(onTap: () => _open(atlas.byId(l.slot.substring(5))!), child: _line(i, l))
        else
          _line(i, l),
        ..._controls(l),
      ],
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final atlas = _atlas;
    final card = _card;
    return Scaffold(
      backgroundColor: CheColors.bg,
      appBar: AppBar(title: const Text('Knowledge Atlas'), backgroundColor: Colors.transparent),
      body: SafeArea(
        child: Column(children: [
          Expanded(
            child: ListView(
              // Each view starts at its top: a card opened from far down the list opens at its title.
              key: ValueKey(card == null ? 'list:$_domain' : 'card:${card.id}'),
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
              children: [
                Wrap(spacing: 8, runSpacing: 8, children: [
                  FilledButton.icon(
                    onPressed: atlas == null ? null : _readAloud,
                    icon: const Icon(Icons.volume_up_rounded),
                    label: const Text('Read aloud'),
                  ),
                  if (widget.onListen != null)
                    OutlinedButton.icon(onPressed: widget.onListen, icon: const Icon(Icons.mic_rounded), label: const Text('Speak to CHE')),
                ]),
                const SizedBox(height: 12),
                if (atlas == null) Text(_error.isEmpty ? 'Loading the cards…' : _error, style: _dim) else _content(),
              ],
            ),
          ),
          // The result of the owner's own action: a banner that stays in view, large, and
          // announced to VoiceOver, so it is read even when the card is scrolled.
          if (_status.isNotEmpty)
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.35),
              child: Container(
                width: double.infinity,
                decoration: const BoxDecoration(color: CheColors.surface, border: Border(top: BorderSide(color: CheColors.stroke))),
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                  child: Semantics(liveRegion: true, child: Text(_status, style: _big.copyWith(color: CheColors.accent))),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}
