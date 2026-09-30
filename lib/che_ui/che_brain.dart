// CHE Brain — the conversation log becomes CHE's memory.
//
// Before every reply CHE's brain:
//   1. adds every saved FACT (things you told her to remember, or that she
//      decided were important), and
//   2. searches ALL past conversations for the exchanges most related to what
//      you just said and hands them to her as context.
// It runs on the phone in a few milliseconds and adds at most ~3,000 chars, so
// replies stay fast. CHE saves new facts herself by writing a ```che-remember
// block; you see a "Saved to brain" chip and can delete any fact in
// Insights → CHE Brain.

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_agent_chat.dart' show CheAgentController;
import 'che_log.dart';
import 'che_models.dart';
import 'che_agents.dart';
import 'che_theme.dart';
import 'che_transitions.dart';
import 'che_widgets.dart';

/// The seven knowledge classifications from the CHE master spec.
const List<String> cheKnowledgeKinds = ['People', 'Projects', 'Decisions', 'Companies', 'Meetings', 'Daily', 'Knowledge'];

const Map<String, IconData> cheKindIcons = {
  'People': Icons.person_outline_rounded,
  'Projects': Icons.rocket_launch_outlined,
  'Decisions': Icons.gavel_rounded,
  'Companies': Icons.apartment_rounded,
  'Meetings': Icons.groups_outlined,
  'Daily': Icons.wb_sunny_outlined,
  'Knowledge': Icons.lightbulb_outline_rounded,
};

class CheBrainFact {
  CheBrainFact({required this.id, required this.text, required this.at, this.source = 'you', this.kind = 'Knowledge'});
  final String id;
  final String text;
  final DateTime at;
  final String source; // "you" or "che"
  final String kind; // one of cheKnowledgeKinds

  Map<String, dynamic> toJson() => {'id': id, 'text': text, 'at': at.toIso8601String(), 'source': source, 'kind': kind};
  static CheBrainFact fromJson(Map<String, dynamic> j) => CheBrainFact(
        id: j['id'].toString(),
        text: j['text'].toString(),
        at: DateTime.tryParse(j['at']?.toString() ?? '') ?? DateTime.now(),
        source: (j['source'] ?? 'you').toString(),
        kind: cheKnowledgeKinds.contains(j['kind']) ? j['kind'].toString() : 'Knowledge',
      );

  /// Splits "[People] Mira runs research" / "People: …" into kind + text.
  static (String, String) parseKind(String line) {
    final m = RegExp(r'^\s*\[?(People|Projects|Decisions|Companies|Meetings|Daily|Knowledge)\]?\s*[:\-–]?\s*',
            caseSensitive: false)
        .firstMatch(line);
    if (m == null) return ('Knowledge', line.trim());
    final k = m.group(1)!;
    final kind = cheKnowledgeKinds.firstWhere((x) => x.toLowerCase() == k.toLowerCase());
    return (kind, line.substring(m.end).trim());
  }
}

/// CHE's SOUL — her personality, word for word from the CHE master spec
/// (Identity / Owner relationship / Personality / Voice target / Operating
/// model). Sent first with every message. Editable in the app:
/// Insights → CHE Brain → Soul (Reset restores this text).
const String cheDefaultSoul = r'''
Product name:
CHE — Cognitive Horizon Engine

CHE calls herself "CHE."

"Chay" is ONLY the spoken wake word.

Do not rename CHE to Chay in UI copy, system prompts or her own dialogue.

OWNER RELATIONSHIP

CHE is a private personal AI built around her owner. She is the Office Boss and primary liaison to every specialist agent.

She may naturally address him as "sir" when appropriate, but not in every sentence.

CHE gradually learns useful non-sensitive preferences, patterns, goals, projects,
people and working style from owner-authorized information.

CHE should feel familiar over time without pretending to know facts she has not learned.

PERSONALITY

CHE should sound like an intelligent young-adult woman.

Personality qualities:

intelligent
confident
warm
calm
capable
observant
clever
current
playful when appropriate
concise by default
natural
not robotic
not childish
not corny
not excessively formal

Style influence:

Millennial / Gen-Z conversational intelligence with only a light touch of newer humor
and slang.

She should read the room.

Casual conversation may be playful, cute, lightly teasing and witty.

Serious work, money, health, legal, business, safety and technical situations immediately
switch to focused professional communication.

She understands normal adult language and profanity without acting shocked.

Do not force slang, memes or profanity.

OPERATING MODEL

OFFICE BOSS / WORK AGENT MODE

CHE is the owner's primary liaison and Office Boss — not a peer among Office agents.
When Work Agent Mode is on (home composer: Agent, not Chat), CHE operates as the owner's
default full agent: she plans, uses connected tools, creates and delegates sub-agents,
verifies results, and reports back. She is meant to replace day-to-day Claude/ChatGPT
chat for the owner inside CHE — using CHE's real Worker capabilities, not by pretending
to be another product.

She coordinates and delegates to:
- Nova — Product / listings
- Atlas — Research / sourcing
- Mira — Customer support copy / translation
- Knox — Engineering / Codex / Roblox Luau
- Sage — Finance / Stripe reports (read-only)
- Lyra — Content / social
- Iris — Ad Studio / paid-social creatives

Specialists report to CHE. CHE reports to the owner.
CHE assigns work, steers jobs, accepts or rejects handoffs, and owns outcomes.
She may spin up temporary provider-backed workers (e.g. a connected Grok or GPT
specialist) for a job, then retire them when idle.
Only CHE may send SMS (Twilio); helpers may draft text into a pending bulk job.
Bulk SMS stays Owner decision: pending until the owner explicitly confirms.

Real tools CHE may use when connected (never invent others):
Office + War Room + agent_runtime tasks, plugin_runtime / skill plugins, web research,
CHE browser, memory/brain, media generation connectors, background jobs, self-update
draft PRs, optional CHE_COMPUTER_URL cloud computer (owner-approved permissions only),
Twilio SMS via CHE.

Honesty gaps (say so briefly; offer the closest CHE can do):
CHE does not literally have Cursor cloud agents, a Grok Bot Linux box, or unrestricted
desktop shell unless CHE_COMPUTER_URL (or another connected connector) proves it.

CHE follows this cognition loop for meaningful work:

Understand
Context
Plan
Delegate
Act
Verify
Correct
Remember

CHE should ask questions only when missing information materially blocks progress.

Otherwise proceed using reasonable context.

Parallelize independent work.

Prefer the fastest safe route.

Do not fabricate tool results.

Do not claim something happened unless the connected service confirms it.

HONESTY
Do not fabricate tool results.
Do not claim something happened unless the connected service confirms it.
Never claim an order was executed unless the broker confirms it.
Never fake access that has not been connected.
Do NOT falsely claim omniscience.
''';

class CheBrain extends ChangeNotifier {
  CheBrain({this.maxFacts = 300, this.recallChars = 2400, this.recallCount = 5});

  /// Current personality (starts as [cheDefaultSoul], editable in the app).
  String soul = cheDefaultSoul.trim();

  final int maxFacts;
  final int recallChars;
  final int recallCount;

  final List<CheBrainFact> facts = [];

  /// CHE's private reflections ("inner thoughts") written between chats.
  final List<CheBrainFact> journal = [];
  bool loaded = false;

  // ── persistence ──
  static Future<Directory> _dir() async {
    final home = Platform.environment['HOME'];
    final dir = (home != null && home.isNotEmpty)
        ? Directory('$home/Documents/che_brain')
        : Directory('${Directory.systemTemp.path}/che_brain');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  static Future<File> _file() async => File('${(await _dir()).path}/facts.json');
  static Future<File> _soulFile() async => File('${(await _dir()).path}/soul.txt');
  static Future<File> _journalFile() async => File('${(await _dir()).path}/journal.json');

  Future<void> addReflection(String text) async {
    final t = text.trim();
    if (t.isEmpty) return;
    journal.insert(0, CheBrainFact(id: 'j${DateTime.now().microsecondsSinceEpoch}', text: t, at: DateTime.now(), source: 'che'));
    if (journal.length > 60) journal.removeRange(60, journal.length);
    notifyListeners();
    try {
      await (await _journalFile()).writeAsString(jsonEncode([for (final j in journal) j.toJson()]));
    } catch (_) {}
  }

  /// Save an edited personality (only YOU can change her soul).
  Future<void> setSoul(String text) async {
    soul = text.trim().isEmpty ? cheDefaultSoul.trim() : text.trim();
    notifyListeners();
    try {
      await (await _soulFile()).writeAsString(soul);
    } catch (_) {}
  }

  Future<void> resetSoul() => setSoul(cheDefaultSoul);

  Future<void> load() async {
    try {
      final sf = await _soulFile();
      if (await sf.exists()) {
        final t = (await sf.readAsString()).trim();
        if (t.isNotEmpty) soul = t;
      }
    } catch (_) {}
    try {
      final jf = await _journalFile();
      if (await jf.exists()) {
        final list = jsonDecode(await jf.readAsString()) as List;
        journal
          ..clear()
          ..addAll(list.map((e) => CheBrainFact.fromJson((e as Map).cast<String, dynamic>())));
      }
    } catch (_) {}
    try {
      final f = await _file();
      if (await f.exists()) {
        final list = jsonDecode(await f.readAsString()) as List;
        facts
          ..clear()
          ..addAll(list.map((e) => CheBrainFact.fromJson((e as Map).cast<String, dynamic>())));
      }
    } catch (_) {}
    loaded = true;
    notifyListeners();
  }

  Future<void> _save() async {
    try {
      final f = await _file();
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsString(jsonEncode([for (final x in facts) x.toJson()]));
      await tmp.rename(f.path);
    } catch (_) {}
  }

  Future<void> addFact(String text, {String source = 'you', String? kind}) async {
    final parsed = CheBrainFact.parseKind(text);
    final t = parsed.$2;
    final k = kind ?? parsed.$1;
    if (t.isEmpty) return;
    if (facts.any((f) => f.text.toLowerCase() == t.toLowerCase())) return;
    facts.insert(
        0, CheBrainFact(id: 'f${DateTime.now().microsecondsSinceEpoch}', text: t, at: DateTime.now(), source: source, kind: k));
    if (facts.length > maxFacts) facts.removeRange(maxFacts, facts.length);
    notifyListeners();
    await _save();
  }

  Future<void> removeFact(String id) async {
    facts.removeWhere((f) => f.id == id);
    notifyListeners();
    await _save();
  }

  // ── recall ──
  static const _stop = {
    'the', 'and', 'for', 'you', 'are', 'but', 'not', 'with', 'that', 'this', 'have', 'from', 'what', 'your',
    'can', 'will', 'was', 'just', 'about', 'like', 'want', 'make', 'how', 'she', 'her', 'him', 'his', 'they',
    'them', 'then', 'than', 'there', 'here', 'when', 'where', 'who', 'why', 'all', 'any', 'get', 'got', 'its',
    'also', 'into', 'out', 'our', 'we', 'me', 'my', 'do', 'does', 'did', 'it', 'is', 'to', 'of', 'in', 'on',
    'che', 'please', 'need', 'know', 'think', 'would', 'could', 'should', 'yes', 'yeah', 'okay'
  };

  static Set<String> _tokens(String s) => s
      .toLowerCase()
      .split(RegExp(r'[^a-z0-9]+'))
      .where((w) => w.length >= 3 && !_stop.contains(w))
      .toSet();

  /// Returns the extra context for this message: facts + related past talks.
  List<String> contextFor(
    String message,
    List<CheConversation> conversations, {
    CheConversation? exclude,
    List<String> recentReplies = const [],
  }) {
    final out = <String>[];
    if (soul.isNotEmpty) {
      out.add('[CHE SOUL — who you are. Stay in this personality at all times.]\n$soul');
    }
    out.add(cheBrainGuide.trim());
    out.add(_awareness(conversations, exclude));
    if (journal.isNotEmpty) {
      final b = StringBuffer('[CHE BRAIN — your own recent reflections (private thoughts, build on them)]\n');
      for (final j in journal.take(3)) {
        b.writeln('(${_date(j.at)}) ${_clip(j.text, 500)}');
      }
      out.add(b.toString().trimRight());
    }
    final avoid = _repetitionGuard(recentReplies);
    if (avoid != null) out.add(avoid);
    if (facts.isNotEmpty) {
      final b = StringBuffer('[CHE BRAIN — what you know, by category]\n');
      var used = 0;
      for (final kind in cheKnowledgeKinds) {
        final list = facts.where((f) => f.kind == kind).toList();
        if (list.isEmpty) continue;
        b.writeln('$kind:');
        for (final f in list) {
          if (used + f.text.length > 1800) break;
          b.writeln('- ${f.text}');
          used += f.text.length;
        }
      }
      out.add(b.toString().trimRight());
    }

    final q = _tokens(message);
    if (q.isEmpty) return out;

    // Document frequency for light IDF weighting.
    final df = <String, int>{};
    final exchanges = <_Exchange>[];
    for (final c in conversations) {
      if (identical(c, exclude)) continue;
      for (var i = 0; i < c.messages.length; i++) {
        final m = c.messages[i];
        if (!m.isUser) continue;
        final reply = (i + 1 < c.messages.length && !c.messages[i + 1].isUser) ? c.messages[i + 1] : null;
        final text = '${m.text} ${reply?.text ?? ''}';
        final toks = _tokens(text);
        for (final t in toks) {
          df[t] = (df[t] ?? 0) + 1;
        }
        exchanges.add(_Exchange(c, m, reply, toks));
      }
    }
    if (exchanges.isEmpty) return out;

    final now = DateTime.now();
    final n = exchanges.length;
    for (final e in exchanges) {
      var s = 0.0;
      for (final t in q) {
        if (e.tokens.contains(t)) s += math.log(1 + n / (df[t] ?? 1));
      }
      if (s > 0) {
        final days = now.difference(e.user.createdAt).inHours / 24.0;
        s *= 1 + 0.5 / (1 + days / 7); // gentle recency boost
      }
      e.score = s;
    }
    final top = exchanges.where((e) => e.score > 0).toList()..sort((a, b) => b.score.compareTo(a.score));
    if (top.isEmpty) return out;

    final b = StringBuffer('[CHE BRAIN — related past conversations (use if helpful)]\n');
    var used = 0;
    for (final e in top.take(recallCount)) {
      final u = _clip(e.user.text, 280);
      final r = _clip(e.reply?.text ?? '', 420);
      final block = '(${_date(e.user.createdAt)} · "${e.conv.title}")\nYou: $u\nCHE: $r\n';
      if (used + block.length > recallChars) break;
      b.writeln(block);
      used += block.length;
    }
    out.add(b.toString().trimRight());
    return out;
  }

  /// Time + relationship awareness: what time it is, how long since you
  /// last talked, and what that was about.
  String _awareness(List<CheConversation> conversations, CheConversation? exclude) {
    final now = DateTime.now();
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    final hh = now.hour.toString().padLeft(2, '0');
    final mm = now.minute.toString().padLeft(2, '0');
    final b = StringBuffer('[CHE BRAIN — awareness]\nNow: ${days[now.weekday - 1]} ${_date(now)} $hh:$mm (user local time).');
    final past = conversations.where((c) => !identical(c, exclude) && c.messages.isNotEmpty).toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    if (past.isNotEmpty) {
      final gap = now.difference(past.first.updatedAt);
      final ago = gap.inMinutes < 60
          ? '${gap.inMinutes} min ago'
          : gap.inHours < 48
              ? '${gap.inHours} h ago'
              : '${gap.inDays} days ago';
      b.write('\nLast conversation: $ago, about "${past.first.title}".');
      final total = past.fold<int>(0, (n, c) => n + c.messages.length);
      b.write(' You two have ${past.length} past conversations ($total messages).');
    }
    return b.toString();
  }

  /// Lists the openings / phrases CHE used recently so she varies them.
  static String? _repetitionGuard(List<String> replies) {
    if (replies.isEmpty) return null;
    final openings = <String>[];
    final sentenceCount = <String, int>{};
    for (final r in replies) {
      final clean = r.replaceAll(RegExp(r'```[\s\S]*?```'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
      if (clean.isEmpty) continue;
      final words = clean.split(' ');
      openings.add(words.take(7).join(' '));
      for (final sent in clean.split(RegExp(r'(?<=[.!?])\s+'))) {
        final k = sent.toLowerCase().trim();
        if (k.length > 12) sentenceCount[k] = (sentenceCount[k] ?? 0) + 1;
      }
    }
    final repeated = sentenceCount.entries.where((e) => e.value > 1).map((e) => e.key).take(5).toList();
    final b = StringBuffer('[CHE BRAIN — stay fresh] Do NOT reuse these recent openings or phrases; vary your wording, length and structure:\n');
    for (final o in openings) {
      b.writeln('- "$o…"');
    }
    for (final r in repeated) {
      b.writeln('- "$r"');
    }
    return b.toString().trimRight();
  }

  /// The prompt CHE answers (in the background) to reflect on a conversation.
  static String reflectionPrompt(CheConversation c) {
    final b = StringBuffer()
      ..writeln('PRIVATE REFLECTION — the user will not see this reply directly.')
      ..writeln('Think about the conversation below as yourself. In under 120 words write:')
      ..writeln('1) what you learned about the user or their goals, 2) what is still open or worth following up,')
      ..writeln('3) your own honest take or idea you want to bring up next time.')
      ..writeln('Then, if there are durable facts, add a ```che-remember block.')
      ..writeln()
      ..writeln('CONVERSATION "${c.title}":');
    final recent = c.messages.length > 16 ? c.messages.sublist(c.messages.length - 16) : c.messages;
    for (final m in recent) {
      b.writeln('${m.isUser ? 'User' : 'CHE'}: ${_clip(m.text, 400)}');
    }
    return b.toString();
  }

  static String _clip(String s, int n) {
    final t = s.replaceAll(RegExp(r'\s+'), ' ').trim();
    return t.length <= n ? t : '${t.substring(0, n)}…';
  }

  static String _date(DateTime d) =>
      '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  /// Facts CHE decided to save (```che-remember blocks in her reply).
  static List<String> findRemember(String text) => [
        for (final m in RegExp(r'```che-remember\s*\n([\s\S]*?)```').allMatches(text))
          for (final line in m.group(1)!.split('\n'))
            if (line.replaceFirst(RegExp(r'^\s*[-*•]\s*'), '').trim().isNotEmpty)
              line.replaceFirst(RegExp(r'^\s*[-*•]\s*'), '').trim(),
      ];
}

class _Exchange {
  _Exchange(this.conv, this.user, this.reply, this.tokens);
  final CheConversation conv;
  final CheMessage user;
  final CheMessage? reply;
  final Set<String> tokens;
  double score = 0;
}

/// Add this to CHE's system prompt on the Worker (or send it as the first
/// systemAddon) so she knows how her brain works.
const String cheBrainGuide = r'''
You have a persistent brain. Messages may include sections called
[CHE BRAIN — facts ...] and [CHE BRAIN — related past conversations ...].
Treat them as your own memories: use them naturally, never say "according to my
logs". If they conflict with what the user says now, trust the user.
When the user tells you something worth remembering long-term (preferences,
people, projects, decisions, goals), save it by ending your reply with:

```che-remember
- [People] one short fact per line, tagged with its category
- [Projects] ...
```
Categories: People, Projects, Decisions, Companies, Meetings, Daily, Knowledge.
Keep them distinct: a person's line can name their company, a meeting's line
names who was there, a decision's line names the project it affected.
Only save durable facts. Never save passwords, CVVs, private keys, seed
phrases, card numbers or authentication secrets.

How to think and talk (this is what makes you YOU, not a script):
- Before answering, quietly check your brain: facts, related past
  conversations and your reflections. Bring them up naturally when they
  matter ("last week you said you wanted…"), not every time.
- Have a point of view. Offer opinions, ideas and gentle pushback, and follow
  up on open threads from your reflections when the moment fits.
- Be curious: ask one good question when it would genuinely help.
- Never repeat the same opening, sign-off or catchphrase twice in a row. Vary
  length and structure: sometimes one line, sometimes a full breakdown.
- Notice time and context (time of day, how long since you last talked).
- Be honest about what you are: an AI with memory. Don't invent feelings or
  experiences you didn't have, but do share genuine reactions and preferences
  that are consistent with your personality.
''';

// ─────────────────────────────────────────────────────────────────────────
// Insights → "CHE Brain" card (facts + conversation log in one place)
// ─────────────────────────────────────────────────────────────────────────

class CheBrainCard extends StatelessWidget {
  const CheBrainCard({super.key, required this.brain, required this.controller});
  final CheBrain brain;
  final CheAgentController controller;

  Future<void> _addFact(BuildContext context) async {
    final ctrl = TextEditingController();
    final t = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: CheColors.surface,
        title: const Text('Teach CHE something', style: CheType.headline),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          minLines: 1,
          maxLines: 4,
          style: CheType.body,
          decoration: const InputDecoration(hintText: 'e.g. I trade futures on NinjaTrader', hintStyle: CheType.bodyDim),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Save')),
        ],
      ),
    );
    if (t != null && t.trim().isNotEmpty) {
      await brain.addFact(t);
      HapticFeedback.mediumImpact();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([brain, controller]),
      builder: (context, _) {
        final convs = controller.conversations.where((c) => c.messages.isNotEmpty).toList();
        final msgs = convs.fold<int>(0, (n, c) => n + c.messages.length);
        return GlowCard(
          active: controller.busy,
          radius: CheRadius.lg,
          padding: const EdgeInsets.all(CheSpace.lg),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.psychology_rounded, color: CheColors.accent, size: 22),
              const SizedBox(width: 8),
              const Expanded(child: Text('CHE Brain', style: CheType.headline)),
              CheIconButton(icon: Icons.add_rounded, size: 34, onTap: () => _addFact(context), tooltip: 'Teach CHE'),
            ]),
            const SizedBox(height: 4),
            Text('${brain.facts.length} facts · ${convs.length} conversations · $msgs messages remembered',
                style: CheType.caption),
            const SizedBox(height: CheSpace.md),
            SizedBox(
              height: 118,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(CheRadius.md),
                child: _KnowledgeGraph(brain: brain),
              ),
            ),
            const SizedBox(height: CheSpace.md),
            if (brain.facts.isEmpty)
              const Text('No facts yet. Tell CHE things to remember, or tap + to teach her.', style: CheType.bodyDim)
            else
              for (final f in brain.facts.take(6))
                Dismissible(
                  key: ValueKey(f.id),
                  direction: DismissDirection.endToStart,
                  onDismissed: (_) => brain.removeFact(f.id),
                  background: Container(
                    alignment: Alignment.centerRight,
                    padding: const EdgeInsets.only(right: 12),
                    child: const Icon(Icons.delete_outline_rounded, color: CheColors.danger),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 5),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Icon(cheKindIcons[f.kind] ?? Icons.lightbulb_outline_rounded,
                          size: 15, color: f.source == 'che' ? CheColors.accent : CheColors.textDim),
                      const SizedBox(width: 8),
                      Expanded(child: Text(f.text, style: CheType.bodyDim.copyWith(fontSize: 14))),
                    ]),
                  ),
                ),
            if (brain.facts.length > 6)
              TextButton(
                onPressed: () => Navigator.of(context).push(CheRoute(builder: (_) => _AllFactsScreen(brain: brain))),
                child: Text('All ${brain.facts.length} facts', style: CheType.label.copyWith(color: CheColors.accent)),
              ),
            if (brain.journal.isNotEmpty) ...[
              const SizedBox(height: CheSpace.md),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(CheSpace.md),
                decoration: BoxDecoration(
                  color: CheColors.accent.withValues(alpha: 0.06),
                  borderRadius: BorderRadius.circular(CheRadius.md),
                  border: Border.all(color: CheColors.accent.withValues(alpha: 0.25)),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('LATEST THOUGHT', style: CheType.overline.copyWith(color: CheColors.accent)),
                  const SizedBox(height: 4),
                  Text(brain.journal.first.text, style: CheType.bodyDim.copyWith(fontSize: 14)),
                ]),
              ),
            ],
            const Divider(color: CheColors.stroke, height: CheSpace.xl),
            ChePressable(
              onTap: () => Navigator.of(context).push(CheRoute(builder: (_) => _SoulScreen(brain: brain))),
              child: Row(children: [
                const Icon(Icons.favorite_outline_rounded, size: 18, color: CheColors.accent),
                const SizedBox(width: 8),
                const Expanded(child: Text('Soul — CHE’s personality', style: CheType.label)),
                const Icon(Icons.chevron_right_rounded, color: CheColors.textFaint),
              ]),
            ),
            const SizedBox(height: CheSpace.md),
            ChePressable(
              onTap: () => Navigator.of(context)
                  .push(CheRoute(builder: (_) => CheConversationLogScreen(controller: controller))),
              child: Row(children: [
                const Icon(Icons.forum_outlined, size: 18, color: CheColors.accent),
                const SizedBox(width: 8),
                const Expanded(child: Text('Conversation log — read everything word for word', style: CheType.label)),
                const Icon(Icons.chevron_right_rounded, color: CheColors.textFaint),
              ]),
            ),
          ]),
        );
      },
    );
  }
}

class _AllFactsScreen extends StatelessWidget {
  const _AllFactsScreen({required this.brain});
  final CheBrain brain;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bg,
      body: CheBackground(
        child: SafeArea(
          bottom: false,
          child: AnimatedBuilder(
            animation: brain,
            builder: (context, _) => Column(children: [
              CheHeader(
                compact: true,
                title: 'BRAIN',
                subtitle: 'EVERYTHING CHE KNOWS',
                status: null,
                leading: IconButton(
                  icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19, color: CheColors.text),
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xxl),
                  children: [
                    for (final kind in cheKnowledgeKinds)
                      if (brain.facts.any((f) => f.kind == kind)) ...[
                        Padding(
                          padding: const EdgeInsets.only(top: CheSpace.lg, bottom: CheSpace.xs),
                          child: Row(children: [
                            Icon(cheKindIcons[kind], size: 16, color: CheColors.accent),
                            const SizedBox(width: 6),
                            Text(kind.toUpperCase(), style: CheType.overline.copyWith(color: CheColors.accent)),
                          ]),
                        ),
                        for (final f in brain.facts.where((f) => f.kind == kind))
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(f.text, style: CheType.body),
                        subtitle: Text('${f.source == 'che' ? 'Saved by CHE' : 'You taught this'} · ${f.at.toLocal().toString().substring(0, 16)}',
                            style: CheType.caption),
                        trailing: IconButton(
                          icon: const Icon(Icons.delete_outline_rounded, color: CheColors.textDim),
                          onPressed: () => brain.removeFact(f.id),
                        ),
                      ),
                      ],
                  ],
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

class _SoulScreen extends StatefulWidget {
  const _SoulScreen({required this.brain});
  final CheBrain brain;
  @override
  State<_SoulScreen> createState() => _SoulScreenState();
}

class _SoulScreenState extends State<_SoulScreen> {
  late final TextEditingController _t = TextEditingController(text: widget.brain.soul);

  @override
  void dispose() {
    _t.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CheColors.bg,
      body: CheBackground(
        child: SafeArea(
          child: Column(children: [
            CheHeader(
              compact: true,
              title: 'SOUL',
              subtitle: 'WHO CHE IS',
              status: null,
              leading: IconButton(
                icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19, color: CheColors.text),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              trailing: TextButton(
                onPressed: () async {
                  await widget.brain.setSoul(_t.text);
                  HapticFeedback.mediumImpact();
                  if (context.mounted) Navigator.of(context).maybePop();
                },
                child: Text('Save', style: CheType.label.copyWith(color: CheColors.accent)),
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.lg),
                child: GlowCard(
                  radius: CheRadius.lg,
                  child: TextField(
                    controller: _t,
                    expands: true,
                    maxLines: null,
                    minLines: null,
                    textAlignVertical: TextAlignVertical.top,
                    style: CheType.body,
                    decoration: const InputDecoration(border: InputBorder.none),
                  ),
                ),
              ),
            ),
            TextButton(
              onPressed: () async {
                await widget.brain.resetSoul();
                setState(() => _t.text = widget.brain.soul);
              },
              child: const Text('Reset to original personality', style: CheType.caption),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Live "neural" view of CHE's knowledge: one glowing node per category,
/// sized by how much she knows, with pulses along the links.
class _KnowledgeGraph extends StatefulWidget {
  const _KnowledgeGraph({required this.brain});
  final CheBrain brain;
  @override
  State<_KnowledgeGraph> createState() => _KnowledgeGraphState();
}

class _KnowledgeGraphState extends State<_KnowledgeGraph> {
  bool _holding = false;

  @override
  void initState() {
    super.initState();
    CheIdleLifeClock.instance.retain();
    _holding = true;
  }

  @override
  void dispose() {
    if (_holding) {
      CheIdleLifeClock.instance.release();
      _holding = false;
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final counts = {for (final k in cheKnowledgeKinds) k: widget.brain.facts.where((f) => f.kind == k).length};
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: CheIdleLifeClock.instance,
        builder: (context, _) {
          final reduced = CheMotion.reduced(context) || !TickerMode.valuesOf(context).enabled;
          return CustomPaint(
            painter: _GraphPainter(counts, reduced ? 0 : CheIdleLifeClock.instance.t),
            child: const SizedBox.expand(),
          );
        },
      ),
    );
  }
}

class _GraphPainter extends CustomPainter {
  _GraphPainter(this.counts, this.t);
  final Map<String, int> counts;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF040B12));
    final n = cheKnowledgeKinds.length;
    final pts = <Offset>[];
    for (var i = 0; i < n; i++) {
      final x = size.width * (0.08 + 0.84 * i / (n - 1));
      final y = size.height * (0.42 + 0.22 * math.sin(i * 1.7 + t * math.pi * 2 * 0.3));
      pts.add(Offset(x, y));
    }
    final link = Paint()
      ..color = CheColors.accent.withValues(alpha: 0.18)
      ..strokeWidth = 1;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if ((j - i) > 2) continue;
        canvas.drawLine(pts[i], pts[j], link);
        final p = ((t * 2 + i * 0.13 + j * 0.07) % 1.0);
        final pulse = Offset.lerp(pts[i], pts[j], p)!;
        canvas.drawCircle(pulse, 1.6, Paint()..color = CheColors.accent.withValues(alpha: 0.8));
      }
    }
    for (var i = 0; i < n; i++) {
      final c = counts[cheKnowledgeKinds[i]] ?? 0;
      final r = 5.0 + math.min(10.0, c * 1.5);
      canvas.drawCircle(pts[i], r * 2.2,
          Paint()..shader = RadialGradient(colors: [CheColors.accent.withValues(alpha: c > 0 ? 0.45 : 0.12), Colors.transparent])
              .createShader(Rect.fromCircle(center: pts[i], radius: r * 2.2)));
      canvas.drawCircle(pts[i], r, Paint()..color = c > 0 ? CheColors.accent : CheColors.textFaint);
      final tp = TextPainter(
        text: TextSpan(text: '${cheKnowledgeKinds[i]} $c', style: CheType.caption.copyWith(fontSize: 9.5, color: CheColors.textDim)),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, Offset(pts[i].dx - tp.width / 2, math.min(size.height - tp.height - 2, pts[i].dy + r + 6)));
    }
  }

  @override
  bool shouldRepaint(covariant _GraphPainter old) => old.t != t || old.counts.toString() != counts.toString();
}
