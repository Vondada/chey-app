// CHE Knowledge Atlas page (owner issue #346): coding and trading cards from beginner to
// expert, read from the bundled assets/atlas/knowledge_atlas.json, which the Worker's
// knowledge_atlas.js writes (tool/dump_knowledge_atlas.mjs), so the page works offline and
// says exactly what CHE says in Chat.
//
// Opening it, filtering and moving between cards are quiet. "Read aloud" and the owner's own
// spoken requests speak. Every button has a spoken route while the page is open
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
    required this.cheNote,
    required this.measured,
    required this.sources,
    required this.revision,
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
  final String cheNote;
  final bool measured;
  final List<String> sources;
  final int revision;

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
      cheNote: '${j['che_note'] ?? ''}',
      measured: j['measured'] is Map,
      sources: [
        for (final s in (j['sources'] as List? ?? const []).whereType<Map>()) '${s['title']}',
      ],
      revision: (j['revision'] as num?)?.toInt() ?? 1,
    );
  }

  String get domainLabel => domain == 'coding' ? 'Coding' : 'Trading';

  /// The worked example in words, as CHE says it (code itself is shown, not read).
  String get exampleWords {
    if (example['kind'] == 'code') return '${example['explain'] ?? ''}';
    final steps = (example['steps'] as List? ?? const []).map((s) => '$s').toList();
    return '${steps.join('; ')}.';
  }

  String get formulaWords => formula == null ? '' : 'Formula: ${formula!['spoken']}. Written: ${formula!['expression']}.';
}

class CheKnowledgeAtlas {
  CheKnowledgeAtlas(this.cards) {
    for (final c in cards) {
      for (final name in [c.id, c.title, ...c.aliases]) {
        final key = cheAtlasTopicKey(name);
        if (key.isNotEmpty) _byKey.putIfAbsent(key, () => c);
      }
    }
  }

  static const asset = 'assets/atlas/knowledge_atlas.json';
  final List<CheAtlasCard> cards;
  final Map<String, CheAtlasCard> _byKey = {};

  factory CheKnowledgeAtlas.fromJson(Map<String, dynamic> j) => CheKnowledgeAtlas([
        for (final c in (j['cards'] as List? ?? const []).whereType<Map>()) CheAtlasCard.fromJson(Map<String, dynamic>.from(c)),
      ]);

  static Future<CheKnowledgeAtlas> load() async =>
      CheKnowledgeAtlas.fromJson(Map<String, dynamic>.from(jsonDecode(await rootBundle.loadString(asset)) as Map));

  List<CheAtlasCard> inDomain(String domain) => domain == 'all' ? cards : cards.where((c) => c.domain == domain).toList();

  CheAtlasCard? byId(String id) {
    for (final c in cards) {
      if (c.id == id) return c;
    }
    return null;
  }

  /// The card a topic names exactly, the same rule as the Worker's; never a near guess.
  CheAtlasCard? find(String topic) {
    final key = cheAtlasTopicKey(topic);
    return key.isEmpty ? null : _byKey[key];
  }

  /// The next card in its domain's curriculum order, or null after the last.
  CheAtlasCard? next(CheAtlasCard c) {
    final list = inDomain(c.domain);
    final i = list.indexOf(c);
    return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
  }
}

// Same filler words and singulars as knowledge_atlas.js topicKey().
const _filler = {
  'about', 'on', 'in', 'the', 'a', 'an', 'how', 'what', 'to', 'of', 'me', 'some', 'is', 'are', 'works', 'work', 'means', 'mean',
  'concept', 'idea', 'basics', 'basic', 'again', 'now', 'today', 'detail', 'step', 'by', 'more', 'please', 'that', 'this', 'with',
  'it', 'its', 'and', 'for', 'python', 'javascript', 'js', 'dart', 'code', 'programming', 'trading', 'futures', 'whole', 'topic',
  'lesson', 'card',
};

String cheAtlasTopicKey(String text) => text
    .toLowerCase()
    .replaceAll("'", '')
    .replaceAll('’', '')
    .replaceAll(RegExp(r'[^a-z0-9²]+'), ' ')
    .trim()
    .split(' ')
    .where((w) => w.isNotEmpty && !_filler.contains(w))
    .map((w) => w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.substring(0, w.length - 1) : w)
    .join(' ');

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

const _numbers = {
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'for': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18,
  'nineteen': 19, 'twenty': 20, 'first': 1, 'second': 2, 'third': 3,
};
int? _numberOf(String w) => int.tryParse(w) ?? _numbers[w];

/// What Read aloud says for a card at a level: exactly the text the page shows.
String cheAtlasCardText(CheAtlasCard c, String level) {
  final lines = <String>['${c.title}, $level level. ${c.levels[level]}'];
  if (level == 'beginner') lines.add('Analogy, and only an analogy: ${c.analogy}');
  if (level != 'beginner' && c.formula != null) lines.add(c.formulaWords);
  lines.add('Worked example: ${c.exampleWords}');
  if (c.cheNote.isNotEmpty) lines.add('In CHE: ${c.cheNote}');
  return lines.join('\n');
}

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
  String _status = '';
  bool _asking = false;
  Object? _screen;

  @override
  void initState() {
    super.initState();
    CheKnowledgeAtlasVoice.handler = _voice;
    _screen = CheScreenAwareness.register(context, () => CheScreenReport(
          page: 'the Knowledge Atlas',
          tab: _card == null ? (_domain == 'all' ? 'All cards' : '${_domain == 'coding' ? 'Coding' : 'Trading'} cards') : _card!.title,
          detail: _atlas == null
              ? (_error.isEmpty ? 'The cards are loading' : _error)
              : _card == null
                  ? '${_shown.length} cards: ${[for (final (i, c) in _shown.indexed) '${i + 1}. ${c.title}'].join(', ')}'
                  : '${_card!.title}, $_level level${_quiz ? ', quiz open' : ''}',
          controls: _card == null
              ? const ['Back', 'Read aloud', 'Speak to CHE', 'All', 'Coding', 'Trading', 'the cards']
              : const ['Back', 'Read aloud', 'Speak to CHE', 'Beginner', 'Intermediate', 'Expert', 'Quiz me', 'Next card', 'All cards'],
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

  void _open(CheAtlasCard c, {String? level}) {
    HapticFeedback.selectionClick();
    setState(() {
      _card = c;
      _level = level ?? 'beginner';
      _quiz = false;
      _answers.clear();
      _status = '';
    });
  }

  void _setLevel(String level) {
    HapticFeedback.selectionClick();
    setState(() => _level = level);
  }

  void _setDomain(String domain) {
    HapticFeedback.selectionClick();
    setState(() {
      _domain = domain;
      _card = null;
      _status = '';
    });
  }

  String _listText() {
    final label = _domain == 'all' ? 'All cards' : '${_domain == 'coding' ? 'Coding' : 'Trading'} cards';
    return '$label: ${_shown.length}. ${[for (final (i, c) in _shown.indexed) '${i + 1}. ${c.title}, ${c.level}.'].join(' ')} Say a number to open one.';
  }

  String _quizText(CheAtlasCard c) =>
      'Quiz on ${c.title}. ${[for (final (i, q) in c.quiz.indexed) '${i + 1}. ${q.q}'].join(' ')} Say "quiz answers" to hear the answers.';

  String _answersText(CheAtlasCard c) => 'Answers. ${[for (final (i, q) in c.quiz.indexed) '${i + 1}. ${q.a}'].join(' ')}';

  String _formulaText(CheAtlasCard c) => c.formula == null
      ? '${c.title} has no single formula: it is a concept, not a calculation.'
      : 'The formula for ${c.title}: ${c.formula!['spoken']}. Written: ${c.formula!['expression']}. Assumptions: ${c.formula!['assumptions']}';

  void _readAloud() {
    final c = _card;
    final text = c == null ? _listText() : _quiz ? _quizText(c) : cheAtlasCardText(c, _level);
    setState(() => _status = c == null ? 'Reading the list aloud.' : 'Reading ${c.title} aloud.');
    widget.onSpeak(text);
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
    if (RegExp(r'^(?:go back|back|close|close (?:the )?(?:knowledge )?atlas|all cards|show all cards)$').hasMatch(t)) {
      if (card != null) {
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
          : 'Your options: 1. Read aloud. 2. Beginner, intermediate or expert version. 3. The formula. 4. The example. 5. Quiz me. 6. Next card. 7. Go back.');
    }
    if (RegExp(r'^(?:read (?:this|it|that|aloud|the card|this card|the list)|read it (?:to me|aloud)|read aloud|read this aloud)$').hasMatch(t)) {
      final c = card;
      return _result(c == null ? _listText() : _quiz ? _quizText(c) : cheAtlasCardText(c, _level));
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
      return _result(_listText());
    }
    final pick = RegExp(r'^(?:(?:open )?(?:number|card) )?(\d{1,2}|[a-z]+)$').firstMatch(t);
    final n = pick == null ? null : _numberOf(pick.group(1)!);
    if (n != null && card == null) {
      if (n < 1 || n > _shown.length) return _result('There is no number $n here. Say a number from 1 to ${_shown.length}.', ok: false);
      _open(_shown[n - 1]);
      return _result(cheAtlasCardText(_shown[n - 1], 'beginner'));
    }
    final quizOn = RegExp(r'^quiz me on (.+)$').firstMatch(t);
    if (quizOn != null && !(card != null && RegExp(r'^(?:this|it|this card|that)$').hasMatch(quizOn.group(1)!))) {
      final found = atlas.find(quizOn.group(1)!);
      if (found == null) return null;
      _open(found);
      setState(() => _quiz = true);
      return _result(_quizText(found));
    }
    final teach = RegExp(r'^(?:teach me|open|show me|explain|tell me about|go to)\s+(.+?)$').firstMatch(t);
    if (teach != null) {
      final found = atlas.find(teach.group(1)!);
      if (found != null) {
        _open(found);
        return _result(cheAtlasCardText(found, 'beginner'));
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
      setState(() => _quiz = false);
      return _result(cheAtlasCardText(card, target));
    }
    if (card == null) return null;
    if (RegExp(r'^(?:what(?:s| is) the |show me the |read me the |the )?(?:formula|equation|math)$').hasMatch(t)) return _result(_formulaText(card));
    if (RegExp(r'^(?:(?:show|read|give) me )?(?:the |an )?(?:worked |code )?example$|^show me the code$').hasMatch(t)) {
      return _result('Worked example: ${card.exampleWords}${card.example['kind'] == 'code' ? ' The code is on screen.' : ''}');
    }
    if (RegExp(r'^(?:quiz me|start the quiz|quiz|quiz me on (?:this|it|this card|that))$').hasMatch(t)) {
      setState(() {
        _quiz = true;
        _answers.clear();
      });
      return _result(_quizText(card));
    }
    if (RegExp(r'^(?:(?:show|read|give) me )?(?:the )?(?:quiz )?answers?$').hasMatch(t)) {
      setState(() {
        _quiz = true;
        _answers.addAll(List.generate(card.quiz.length, (i) => i));
      });
      return _result(_answersText(card));
    }
    if (RegExp(r'^(?:next|next card|next lesson|what(?:s| is) next(?: after this)?|go to the next (?:card|one))$').hasMatch(t)) {
      final next = atlas.next(card);
      if (next == null) return _result('${card.title} is the last ${card.domain} card for now.', ok: false);
      _open(next);
      return _result(cheAtlasCardText(next, 'beginner'));
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

  Widget _section(String title, List<Widget> children) => Padding(
        padding: const EdgeInsets.only(top: 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(header: true, child: Text(title, style: CheType.headline.copyWith(color: CheColors.accent))),
          const SizedBox(height: 6),
          ...children,
        ]),
      );

  static const _big = TextStyle(fontSize: 18, height: 1.45, color: CheColors.text);
  static const _dim = TextStyle(fontSize: 16, height: 1.4, color: CheColors.textDim);

  Widget _list() {
    final atlas = _atlas!;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 8, runSpacing: 8, children: [
        _chip('All ${atlas.cards.length}', _domain == 'all', () => _setDomain('all')),
        _chip('Coding ${atlas.inDomain('coding').length}', _domain == 'coding', () => _setDomain('coding')),
        _chip('Trading ${atlas.inDomain('trading').length}', _domain == 'trading', () => _setDomain('trading')),
      ]),
      const SizedBox(height: 8),
      for (final (i, c) in _shown.indexed)
        ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 4),
          title: Text('${i + 1}. ${c.title}', style: _big.copyWith(fontWeight: FontWeight.w700)),
          subtitle: Text('${c.domainLabel} · ${c.level} · ${c.summary}', style: _dim),
          onTap: () => _open(c),
        ),
    ]);
  }

  Widget _detail(CheAtlasCard c) {
    final atlas = _atlas!;
    final f = c.formula;
    final code = c.example['kind'] == 'code' ? '${c.example['code'] ?? ''}' : '';
    final next = atlas.next(c);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Semantics(header: true, child: Text(c.title, style: CheType.title)),
      Text('${c.domainLabel} · starts at ${c.level} · curated teaching content, revision ${c.revision}', style: _dim),
      const SizedBox(height: 10),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final l in cheAtlasLevels) _chip('${l[0].toUpperCase()}${l.substring(1)}', _level == l && !_quiz, () {
          _setLevel(l);
          setState(() => _quiz = false);
        }),
        _chip('Quiz me', _quiz, () => setState(() {
              HapticFeedback.selectionClick();
              _quiz = true;
            })),
      ]),
      if (_quiz)
        _section('Quiz', [
          for (final (i, q) in c.quiz.indexed) ...[
            Text('${i + 1}. ${q.q}', style: _big),
            if (_answers.contains(i))
              Padding(padding: const EdgeInsets.only(left: 12, bottom: 8), child: Text('Answer: ${q.a}', style: _big.copyWith(color: CheColors.success)))
            else
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(onPressed: () => setState(() => _answers.add(i)), child: Text('Show answer ${i + 1}', style: const TextStyle(fontSize: 16))),
              ),
          ],
        ])
      else ...[
        const SizedBox(height: 12),
        Text(c.levels[_level] ?? '', style: _big),
        if (_level == 'beginner') _section('Analogy, and only an analogy', [Text(c.analogy, style: _big)]),
        if (f != null)
          _section('Formula', [
            SelectableText('${f['expression']}', style: CheType.mono.copyWith(fontSize: 17)),
            const SizedBox(height: 4),
            Text('${f['spoken']}.', style: _dim),
            Text('Assumptions: ${f['assumptions']}', style: _dim),
          ]),
        _section('Worked example', [
          Text(c.exampleWords, style: _big),
          if (code.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: CheColors.surface, border: Border.all(color: CheColors.stroke), borderRadius: BorderRadius.circular(8)),
              child: SelectableText(code, style: CheType.mono.copyWith(fontSize: 14)),
            ),
        ]),
        if (_level == 'expert' && c.misconceptions.isNotEmpty) _section('Common mistake', [Text(c.misconceptions.first, style: _big)]),
        if (c.cheNote.isNotEmpty) _section('In CHE', [Text(c.cheNote, style: _big)]),
        if (c.measured)
          _section('Your recorded numbers', [
            const Text('CHE reads these from her paper journal and stored backtest only, never from this card.', style: _dim),
            if (widget.onAskChe != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: OutlinedButton(onPressed: _asking ? null : () => _askRecorded(c), child: const Text('Ask CHE for my recorded numbers')),
              ),
          ]),
      ],
      _section('Related cards', [
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final id in c.related)
            if (atlas.byId(id) case final r?) OutlinedButton(onPressed: () => _open(r), child: Text(r.title)),
        ]),
      ]),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 8, children: [
        if (next != null) FilledButton(onPressed: () => _open(next), child: Text('Next card: ${next.title}')),
        OutlinedButton(onPressed: () => _setDomain(_domain), child: const Text('All cards')),
      ]),
      const SizedBox(height: 8),
      Text('References: ${c.sources.join('; ')}.', style: _dim),
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
                if (atlas == null)
                  Text(_error.isEmpty ? 'Loading the cards…' : _error, style: _dim)
                else if (card == null)
                  _list()
                else
                  _detail(card),
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
