// The Brain Room's owner regions and sections (owner, 2026-10-24, from his original Brain Room reference):
// ten colour-coded regions of one neural brain, sixteen sidebar sections, eight dashboard cards, link strength,
// the Live Activity feed and the Real-Time Learning events. Pure functions over CHE's real records
// (CheMemoryDot, the phone's Brain replica and the Worker lists) and the Brain Population Ledger
// (/api/brain/ledger). Nothing here invents a record, a count, a link or a learning event: an empty input
// gives an empty answer, and an idle ledger says idle.

import 'package:flutter/material.dart';

import '../home/che_memory_brain.dart' show CheMemoryDot, cheRelatedMemoryEdgesTyped;
import 'che_brain_sections.dart';

/// The owner's colour key: blue memories, cyan conversations, purple knowledge, pink creative, orange trading,
/// green coding, yellow agents, light-blue media, white verified, red errors.
enum CheBrainRegion { memories, conversations, knowledge, creative, trading, coding, agents, media, verified, errors }

extension CheBrainRegionInfo on CheBrainRegion {
  String get label => switch (this) {
    CheBrainRegion.memories => 'Memories',
    CheBrainRegion.conversations => 'Conversations',
    CheBrainRegion.knowledge => 'Knowledge',
    CheBrainRegion.creative => 'Creative',
    CheBrainRegion.trading => 'Trading',
    CheBrainRegion.coding => 'Coding',
    CheBrainRegion.agents => 'Agents',
    CheBrainRegion.media => 'Media',
    CheBrainRegion.verified => 'Verified',
    CheBrainRegion.errors => 'Errors',
  };

  Color get color => switch (this) {
    CheBrainRegion.memories => const Color(0xFF3D7BFF),
    CheBrainRegion.conversations => const Color(0xFF22E4F2),
    CheBrainRegion.knowledge => const Color(0xFFA35BFF),
    CheBrainRegion.creative => const Color(0xFFFF4FC8),
    CheBrainRegion.trading => const Color(0xFFFF9A2E),
    CheBrainRegion.coding => const Color(0xFF2EE57A),
    CheBrainRegion.agents => const Color(0xFFFFD23F),
    CheBrainRegion.media => const Color(0xFF7CC8FF),
    CheBrainRegion.verified => const Color(0xFFF4F8FF),
    CheBrainRegion.errors => const Color(0xFFFF4A5C),
  };

  IconData get icon => switch (this) {
    CheBrainRegion.memories => Icons.memory_rounded,
    CheBrainRegion.conversations => Icons.forum_rounded,
    CheBrainRegion.knowledge => Icons.menu_book_rounded,
    CheBrainRegion.creative => Icons.auto_awesome_rounded,
    CheBrainRegion.trading => Icons.show_chart_rounded,
    CheBrainRegion.coding => Icons.code_rounded,
    CheBrainRegion.agents => Icons.smart_toy_outlined,
    CheBrainRegion.media => Icons.photo_library_outlined,
    CheBrainRegion.verified => Icons.verified_rounded,
    CheBrainRegion.errors => Icons.error_outline_rounded,
  };
}

final _creativeWords = RegExp(r'\b(?:creat\w*|invent\w*|design\w*|film|movie|art|artwork|thumbnail|character|studio|song|beat|music|render\w*)\b');
final _mediaWords = RegExp(r'\b(?:photo|image|picture|video|youtube|mp4|clip|media|gallery)\b');
final _codingWords = RegExp(r'\b(?:cod(?:e|ing)|commit|pull request|deploy\w*|repo\w*|ci|workflow run|coding_job)\b');
final _tradingWords = RegExp(r'\b(?:trad(?:e|es|ing)|strategy|backtest|mnq|futures|crypto|btc|eth|paper order|sim_run)\b');

/// The record's domain region, from what the record itself says (its Brain region, kind, source and category).
/// A failed record is an Error. Verified is never a domain: it is a state counted across every region.
CheBrainRegion cheBrainRegionOf(CheMemoryDot d) {
  if (d.outcome == 'failed' || d.verification == 'contradicted') return CheBrainRegion.errors;
  final region = d.region;
  final kinds = '${d.kind} ${d.sourceInfo['kind'] ?? ''} ${d.sourceInfo['room'] ?? ''} ${d.path}'.toLowerCase().replaceAll('_', ' ');
  if (region == 'Conversations and Corrections' || d.category == 'Conversations' || cheBrainSectionOf(d) == CheBrainSection.conversations) {
    return CheBrainRegion.conversations;
  }
  if (region == 'Personal Memory' || d.category == 'Memory' || d.category == 'About you') return CheBrainRegion.memories;
  if (region == 'Trading and Market Research' || _tradingWords.hasMatch(kinds)) return CheBrainRegion.trading;
  if (region == 'Coding and Development' || _codingWords.hasMatch(kinds)) return CheBrainRegion.coding;
  if (_creativeWords.hasMatch(kinds)) return CheBrainRegion.creative;
  if (region == 'YouTube and Media' || _mediaWords.hasMatch(kinds)) return CheBrainRegion.media;
  if (region == 'Office Agents' || region == 'Active and Historical Tasks' || d.category == 'Agents') return CheBrainRegion.agents;
  return CheBrainRegion.knowledge;
}

/// Verified with proof: the record's own status (Brain Room list rules, #486).
bool cheBrainIsVerifiedRecord(CheMemoryDot d) => cheBrainStatusOf(d) == CheBrainStatus.verified;

/// Real counts per region. The eight domains and Errors partition the records; Verified counts the verified ones
/// across every domain. Archived records are counted (they are still knowledge).
Map<CheBrainRegion, int> cheBrainRegionCounts(Iterable<CheMemoryDot> dots) {
  final out = {for (final r in CheBrainRegion.values) r: 0};
  for (final d in dots) {
    final r = cheBrainRegionOf(d);
    out[r] = out[r]! + 1;
    if (cheBrainIsVerifiedRecord(d)) out[CheBrainRegion.verified] = out[CheBrainRegion.verified]! + 1;
  }
  return out;
}

// ─── Links ──────────────────────────────────────────────────────────────────

/// How strong a connection is, from real state only:
/// verified   an explicit link (Worker brain link, a record's own links, a shared ML cluster) between two verified records;
/// developing an explicit link where at least one side is not verified yet;
/// weak       only shared words connect them (no recorded relationship).
enum CheBrainLinkStrength { weak, developing, verified }

extension CheBrainLinkStrengthInfo on CheBrainLinkStrength {
  String get label => switch (this) {
    CheBrainLinkStrength.verified => 'Strong',
    CheBrainLinkStrength.developing => 'Developing',
    CheBrainLinkStrength.weak => 'Weak',
  };

  String get meaning => switch (this) {
    CheBrainLinkStrength.verified => 'A recorded relationship between two verified records.',
    CheBrainLinkStrength.developing => 'A recorded relationship; one side is not verified yet.',
    CheBrainLinkStrength.weak => 'Only shared words connect them; no relationship is recorded.',
  };

  Color get color => switch (this) {
    CheBrainLinkStrength.verified => const Color(0xFF22E4F2),
    CheBrainLinkStrength.developing => const Color(0xFFFFE08A),
    CheBrainLinkStrength.weak => const Color(0xFFFF8FA3),
  };
}

class CheBrainLink {
  const CheBrainLink(this.a, this.b, this.strength);
  final CheMemoryDot a;
  final CheMemoryDot b;
  final CheBrainLinkStrength strength;
}

/// Every connection the Brain draws, with its strength. Same edges as the neural view (cheRelatedMemoryEdges).
List<CheBrainLink> cheBrainLinks(List<CheMemoryDot> dots, {List<Map<String, dynamic>> brainLinks = const []}) {
  final byId = {for (final d in dots) d.id: d};
  return [
    for (final (a, b, explicit) in cheRelatedMemoryEdgesTyped(dots, brainLinks: brainLinks))
      if (byId[a] != null && byId[b] != null)
        CheBrainLink(
          byId[a]!,
          byId[b]!,
          !explicit
              ? CheBrainLinkStrength.weak
              : cheBrainIsVerifiedRecord(byId[a]!) && cheBrainIsVerifiedRecord(byId[b]!)
              ? CheBrainLinkStrength.verified
              : CheBrainLinkStrength.developing,
        ),
  ];
}

Map<CheBrainLinkStrength, int> cheBrainLinkCounts(Iterable<CheBrainLink> links) {
  final out = {for (final s in CheBrainLinkStrength.values) s: 0};
  for (final l in links) {
    out[l.strength] = out[l.strength]! + 1;
  }
  return out;
}

/// The records connected to [d], strongest first.
List<(CheMemoryDot, CheBrainLinkStrength)> cheBrainRelated(CheMemoryDot d, Iterable<CheBrainLink> links, {int limit = 12}) {
  final out = <(CheMemoryDot, CheBrainLinkStrength)>[
    for (final l in links)
      if (l.a.id == d.id) (l.b, l.strength) else if (l.b.id == d.id) (l.a, l.strength),
  ]..sort((x, y) => y.$2.index.compareTo(x.$2.index));
  return out.take(limit).toList();
}

// ─── Sidebar sections ───────────────────────────────────────────────────────

enum CheBrainNav {
  overview,
  activity,
  search,
  memories,
  conversations,
  media,
  agents,
  trading,
  coding,
  library,
  research,
  skills,
  learningTasks,
  connections,
  verification,
  analytics,
}

extension CheBrainNavInfo on CheBrainNav {
  String get label => switch (this) {
    CheBrainNav.overview => 'Brain Overview',
    CheBrainNav.activity => 'Live Activity',
    CheBrainNav.search => 'Search',
    CheBrainNav.memories => 'Memories',
    CheBrainNav.conversations => 'Conversations',
    CheBrainNav.media => 'Media',
    CheBrainNav.agents => 'Agents',
    CheBrainNav.trading => 'Trading',
    CheBrainNav.coding => 'Coding',
    CheBrainNav.library => 'Knowledge Library',
    CheBrainNav.research => 'Research',
    CheBrainNav.skills => 'Skills & Training',
    CheBrainNav.learningTasks => 'Learning Tasks',
    CheBrainNav.connections => 'Connections',
    CheBrainNav.verification => 'Verification',
    CheBrainNav.analytics => 'Analytics',
  };

  IconData get icon => switch (this) {
    CheBrainNav.overview => Icons.psychology_rounded,
    CheBrainNav.activity => Icons.bolt_rounded,
    CheBrainNav.search => Icons.search_rounded,
    CheBrainNav.memories => Icons.memory_rounded,
    CheBrainNav.conversations => Icons.forum_rounded,
    CheBrainNav.media => Icons.photo_library_outlined,
    CheBrainNav.agents => Icons.smart_toy_outlined,
    CheBrainNav.trading => Icons.show_chart_rounded,
    CheBrainNav.coding => Icons.code_rounded,
    CheBrainNav.library => Icons.menu_book_rounded,
    CheBrainNav.research => Icons.science_outlined,
    CheBrainNav.skills => Icons.school_rounded,
    CheBrainNav.learningTasks => Icons.task_alt_rounded,
    CheBrainNav.connections => Icons.hub_rounded,
    CheBrainNav.verification => Icons.verified_rounded,
    CheBrainNav.analytics => Icons.insights_rounded,
  };

  /// The colour of the region the section shows (cards and the sidebar's active mark).
  Color get color => switch (this) {
    CheBrainNav.memories => CheBrainRegion.memories.color,
    CheBrainNav.conversations => CheBrainRegion.conversations.color,
    CheBrainNav.media => CheBrainRegion.media.color,
    CheBrainNav.agents => CheBrainRegion.agents.color,
    CheBrainNav.trading => CheBrainRegion.trading.color,
    CheBrainNav.coding => CheBrainRegion.coding.color,
    CheBrainNav.library => CheBrainRegion.knowledge.color,
    CheBrainNav.research => const Color(0xFF5B8CFF),
    CheBrainNav.skills => const Color(0xFF2EE5C0),
    CheBrainNav.learningTasks => const Color(0xFFFFB84D),
    CheBrainNav.connections => const Color(0xFFB98BFF),
    CheBrainNav.verification => CheBrainRegion.verified.color,
    CheBrainNav.analytics => const Color(0xFFFF6FB1),
    _ => const Color(0xFF7FE9FF),
  };

  String get meaning => switch (this) {
    CheBrainNav.overview => 'The neural brain: rotate, zoom and inspect every record.',
    CheBrainNav.activity => 'The newest real records, newest first, by category.',
    CheBrainNav.search => 'Search memories, conversations, media, research and knowledge.',
    CheBrainNav.memories => 'Your own facts and preferences.',
    CheBrainNav.conversations => 'What you, CHE and other AIs said.',
    CheBrainNav.media => 'Images, videos, music and creative work CHE recorded.',
    CheBrainNav.agents => 'Office workers and the work they did.',
    CheBrainNav.trading => 'Trading research, strategies and trade records.',
    CheBrainNav.coding => 'Coding jobs, commits, pull requests and deploys.',
    CheBrainNav.library => 'Everything CHE knows: lessons, references and the Knowledge Atlas.',
    CheBrainNav.research => 'Sources CHE read and things she investigated.',
    CheBrainNav.skills => 'Skills, tools, lessons and practice.',
    CheBrainNav.learningTasks => 'Learning work in progress and what is pending.',
    CheBrainNav.connections => 'How records connect, strongest first.',
    CheBrainNav.verification => 'What is verified, what is not, and what failed.',
    CheBrainNav.analytics => 'How the Brain has grown, by region, state and week.',
  };

  /// Sections that are a list of records (the others are their own views).
  bool get isRecordList => switch (this) {
    CheBrainNav.memories ||
    CheBrainNav.conversations ||
    CheBrainNav.media ||
    CheBrainNav.agents ||
    CheBrainNav.trading ||
    CheBrainNav.coding ||
    CheBrainNav.library ||
    CheBrainNav.research ||
    CheBrainNav.skills ||
    CheBrainNav.learningTasks => true,
    _ => false,
  };
}

/// The dashboard cards under the brain (owner's newer concept), in his order.
const cheBrainDashboardCards = [
  CheBrainNav.conversations,
  CheBrainNav.research,
  CheBrainNav.library,
  CheBrainNav.memories,
  CheBrainNav.skills,
  CheBrainNav.learningTasks,
  CheBrainNav.connections,
  CheBrainNav.analytics,
];

bool _isSkill(CheMemoryDot d) {
  final kind = '${d.kind} ${d.sourceInfo['kind'] ?? ''}'.toLowerCase();
  return d.region == 'Skills and Tools' ||
      d.region == 'Experiments and Lessons' ||
      d.category == 'Knowledge Atlas' ||
      RegExp(r'\b(?:skill|capability|procedure|concept_card|atlas_progress|lesson|practice|experiment)\b').hasMatch(kind);
}

/// Whether a record belongs in a record-list section. One record can sit in more than one section (a trading lesson
/// is Trading and Skills); the region counts never double count.
bool cheBrainNavIncludes(CheBrainNav s, CheMemoryDot d) => switch (s) {
  CheBrainNav.memories => cheBrainRegionOf(d) == CheBrainRegion.memories,
  CheBrainNav.conversations => cheBrainRegionOf(d) == CheBrainRegion.conversations,
  CheBrainNav.media => cheBrainRegionOf(d) == CheBrainRegion.media || cheBrainRegionOf(d) == CheBrainRegion.creative,
  CheBrainNav.agents => cheBrainRegionOf(d) == CheBrainRegion.agents || d.workers.isNotEmpty,
  CheBrainNav.trading => cheBrainRegionOf(d) == CheBrainRegion.trading,
  CheBrainNav.coding => cheBrainRegionOf(d) == CheBrainRegion.coding,
  CheBrainNav.library => cheBrainSectionOf(d) == CheBrainSection.knowledge,
  CheBrainNav.research => cheBrainSectionOf(d) == CheBrainSection.research,
  CheBrainNav.skills => _isSkill(d),
  CheBrainNav.learningTasks => d.outcome == 'live' || cheBrainStatusOf(d) == CheBrainStatus.pending,
  _ => false,
};

/// A section's records, newest first.
List<CheMemoryDot> cheBrainNavRecords(CheBrainNav s, Iterable<CheMemoryDot> dots) {
  final out = [for (final d in dots) if (cheBrainNavIncludes(s, d)) d];
  out.sort((a, b) => (b.at ?? DateTime(0)).compareTo(a.at ?? DateTime(0)));
  return out;
}

/// The number a dashboard card shows, and the verified share of it (null when the card is not a record count).
({int count, int verified, String unit}) cheBrainCardFigure(CheBrainNav s, List<CheMemoryDot> dots, List<CheBrainLink> links) {
  if (s == CheBrainNav.connections) {
    final c = cheBrainLinkCounts(links);
    return (count: links.length, verified: c[CheBrainLinkStrength.verified]!, unit: 'links');
  }
  if (s == CheBrainNav.analytics) {
    return (count: dots.length, verified: dots.where(cheBrainIsVerifiedRecord).length, unit: 'records');
  }
  final list = cheBrainNavRecords(s, dots);
  return (count: list.length, verified: list.where(cheBrainIsVerifiedRecord).length, unit: s == CheBrainNav.learningTasks ? 'in progress' : 'records');
}

// ─── Live Activity ──────────────────────────────────────────────────────────

enum CheBrainActivityFilter { all, memories, conversations, media, agents, trading, coding, verified }

extension CheBrainActivityFilterInfo on CheBrainActivityFilter {
  String get label => switch (this) {
    CheBrainActivityFilter.all => 'All',
    CheBrainActivityFilter.memories => 'Memories',
    CheBrainActivityFilter.conversations => 'Conversations',
    CheBrainActivityFilter.media => 'Media',
    CheBrainActivityFilter.agents => 'Agents',
    CheBrainActivityFilter.trading => 'Trading',
    CheBrainActivityFilter.coding => 'Coding',
    CheBrainActivityFilter.verified => 'Verified',
  };
}

bool cheBrainActivityMatches(CheBrainActivityFilter f, CheMemoryDot d) => switch (f) {
  CheBrainActivityFilter.all => true,
  CheBrainActivityFilter.memories => cheBrainNavIncludes(CheBrainNav.memories, d),
  CheBrainActivityFilter.conversations => cheBrainNavIncludes(CheBrainNav.conversations, d),
  CheBrainActivityFilter.media => cheBrainNavIncludes(CheBrainNav.media, d),
  CheBrainActivityFilter.agents => cheBrainNavIncludes(CheBrainNav.agents, d),
  CheBrainActivityFilter.trading => cheBrainNavIncludes(CheBrainNav.trading, d),
  CheBrainActivityFilter.coding => cheBrainNavIncludes(CheBrainNav.coding, d),
  CheBrainActivityFilter.verified => cheBrainIsVerifiedRecord(d),
};

/// Dated records only, newest first: an undated record has no place in a timeline.
List<CheMemoryDot> cheBrainActivity(Iterable<CheMemoryDot> dots, {CheBrainActivityFilter filter = CheBrainActivityFilter.all, int limit = 200}) {
  final out = [for (final d in dots) if (d.at != null && cheBrainActivityMatches(filter, d)) d];
  out.sort((a, b) => b.at!.compareTo(a.at!));
  return out.take(limit).toList();
}

/// A real picture for a record, only when the record names one (an image URL it holds). Null otherwise: the feed then
/// shows the region's glyph, never a stock picture.
String? cheBrainThumbnailOf(CheMemoryDot d) {
  final src = d.sourceInfo;
  final refs = src['refs'] is Map ? src['refs'] as Map : const {};
  for (final v in [src['thumbnail_url'], src['thumbnail'], src['image_url'], src['preview_url'], refs['thumbnail_url'], refs['image_url'], src['url']]) {
    final s = '${v ?? ''}'.trim();
    if (RegExp(r'^https://\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?$', caseSensitive: false).hasMatch(s)) return s;
  }
  return null;
}

/// "Just now", "5m ago", "3h ago", "Yesterday", "Oct 20".
String cheBrainAgo(DateTime? at, {DateTime? now}) {
  if (at == null) return 'date not recorded';
  final n = now ?? DateTime.now();
  final d = n.difference(at);
  if (d.isNegative || d.inSeconds < 60) return 'Just now';
  if (d.inMinutes < 60) return '${d.inMinutes}m ago';
  if (d.inHours < 24) return '${d.inHours}h ago';
  if (d.inDays == 1) return 'Yesterday';
  if (d.inDays < 7) return '${d.inDays}d ago';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final l = at.toLocal();
  return '${months[l.month - 1]} ${l.day}${l.year == n.year ? '' : ', ${l.year}'}';
}

// ─── Search ─────────────────────────────────────────────────────────────────

enum CheBrainSearchScope { all, conversations, memories, media, research, knowledge }

extension CheBrainSearchScopeInfo on CheBrainSearchScope {
  String get label => switch (this) {
    CheBrainSearchScope.all => 'All',
    CheBrainSearchScope.conversations => 'Conversations',
    CheBrainSearchScope.memories => 'Memories',
    CheBrainSearchScope.media => 'Media',
    CheBrainSearchScope.research => 'Research',
    CheBrainSearchScope.knowledge => 'Knowledge',
  };

  bool includes(CheMemoryDot d) => switch (this) {
    CheBrainSearchScope.all => true,
    CheBrainSearchScope.conversations => cheBrainNavIncludes(CheBrainNav.conversations, d),
    CheBrainSearchScope.memories => cheBrainNavIncludes(CheBrainNav.memories, d),
    CheBrainSearchScope.media => cheBrainNavIncludes(CheBrainNav.media, d),
    CheBrainSearchScope.research => cheBrainNavIncludes(CheBrainNav.research, d),
    CheBrainSearchScope.knowledge => cheBrainNavIncludes(CheBrainNav.library, d),
  };
}

/// Search results by scope, with their real counts (every word must appear; the same rule as the Brain list).
({List<CheMemoryDot> results, Map<CheBrainSearchScope, int> counts}) cheBrainSearchScoped(Iterable<CheMemoryDot> dots, String query, CheBrainSearchScope scope) {
  final all = query.trim().isEmpty ? <CheMemoryDot>[] : cheBrainSearch(dots, query);
  final counts = {for (final s in CheBrainSearchScope.values) s: all.where(s.includes).length};
  return (results: all.where(scope.includes).toList(), counts: counts);
}

/// How many times the query's words occur in the record (the "3 matches" badge).
int cheBrainMatchCount(CheMemoryDot d, String query) {
  final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  final text = '${d.title}\n${d.body}'.toLowerCase();
  var n = 0;
  for (final w in words) {
    var i = text.indexOf(w);
    while (i >= 0) {
      n++;
      i = text.indexOf(w, i + w.length);
    }
  }
  return n;
}

/// The text split into plain and matching runs, around the first match (about [window] characters).
List<(String, bool)> cheBrainHighlight(String text, String query, {int window = 110}) {
  final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (words.isEmpty) return [(flat.length > window ? '${flat.substring(0, window)}…' : flat, false)];
  final lower = flat.toLowerCase();
  var first = -1;
  for (final w in words) {
    final i = lower.indexOf(w);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  var start = 0, end = flat.length;
  if (flat.length > window) {
    start = first < 0 ? 0 : (first - window ~/ 3).clamp(0, flat.length);
    end = (start + window).clamp(0, flat.length);
  }
  final slice = flat.substring(start, end);
  final sliceLower = slice.toLowerCase();
  final hits = List<bool>.filled(slice.length, false);
  for (final w in words) {
    var i = sliceLower.indexOf(w);
    while (i >= 0) {
      for (var k = i; k < i + w.length; k++) {
        hits[k] = true;
      }
      i = sliceLower.indexOf(w, i + w.length);
    }
  }
  final out = <(String, bool)>[];
  if (start > 0) out.add(('… ', false));
  var runStart = 0;
  for (var k = 1; k <= slice.length; k++) {
    if (k == slice.length || hits[k] != hits[runStart]) {
      out.add((slice.substring(runStart, k), hits[runStart]));
      runStart = k;
    }
  }
  if (end < flat.length) out.add((' …', false));
  return out;
}

// ─── Real-Time Learning (the Brain Population Ledger) ───────────────────────

/// The ledger's knowledge-state progression (brain_ledger.js STATES), for the progress bar of one event.
const cheBrainLedgerProgression = ['PENDING', 'DISCOVERED', 'INDEXED', 'UNDERSTOOD', 'PROCEDURE', 'IMPLEMENTED', 'TESTED', 'VERIFIED', 'AVAILABLE'];

/// The owner's seven kinds of learning, from the ledger's event type.
String cheBrainLearningKind(String eventType) => switch (eventType) {
  'SOURCE_DISCOVERED' || 'SOURCE_INDEXED' || 'SOURCE_USED' || 'KNOWLEDGE_EXTRACTED' => 'Reading and indexing',
  'EVIDENCE_UPDATED' || 'EVIDENCE_STRENGTHENED' => 'Connecting ideas',
  'OWNER_MEMORY_SAVED' || 'OWNER_PREFERENCE_SAVED' || 'CONVERSATION_REMEMBERED' || 'KNOWLEDGE_SAVED' || 'KNOWLEDGE_UPDATED' => 'Updating memories',
  'PROJECT_KNOWLEDGE_UPDATED' || 'WORKFLOW_PROMOTED' || 'BATCH_RECEIPT' => 'Learning from completed work',
  'PROCEDURE_CREATED' || 'CAPABILITY_TESTED' => 'Developing and testing a skill',
  'CAPABILITY_VERIFIED' || 'CAPABILITY_STATE' => 'Improving a capability',
  'CORRECTION' || 'SOURCE_FAILED' || 'REJECTED' || 'REMOVED' => 'Recording a mistake or correction',
  'PENDING' => 'Waiting to learn',
  _ => 'Updating knowledge',
};

/// The ledger category → the brain region that lights up.
CheBrainRegion cheBrainRegionForLedger(String category, String subcategory, String eventType) {
  if (eventType == 'SOURCE_FAILED' || eventType == 'REJECTED') return CheBrainRegion.errors;
  if (eventType == 'CAPABILITY_VERIFIED') return CheBrainRegion.verified;
  return switch (category) {
    'Trading' => CheBrainRegion.trading,
    'Coding' => CheBrainRegion.coding,
    'Agents' => CheBrainRegion.agents,
    'Owner Preferences' => CheBrainRegion.memories,
    'Music' || 'Create' => CheBrainRegion.creative,
    'Video' || 'Images' => CheBrainRegion.media,
    'General Knowledge' when subcategory == 'Conversations' => CheBrainRegion.conversations,
    _ => CheBrainRegion.knowledge,
  };
}

class CheBrainLearningEvent {
  const CheBrainLearningEvent({
    required this.id,
    required this.title,
    required this.category,
    required this.subcategory,
    required this.eventType,
    required this.status,
    required this.time,
    required this.at,
    required this.source,
    required this.state,
    this.spoken = '',
    this.recordId = '',
  });

  /// One ledger row as /api/brain/ledger returns it (brain_ledger.js view()). Null when it is not a ledger row.
  static CheBrainLearningEvent? fromLedger(Object? raw) {
    if (raw is! Map) return null;
    final id = '${raw['brain_event_id'] ?? ''}';
    final title = '${raw['title'] ?? ''}'.trim();
    final ms = raw['ms'];
    if (id.isEmpty || title.isEmpty || ms is! num) return null;
    return CheBrainLearningEvent(
      id: id,
      title: title,
      category: '${raw['category'] ?? ''}',
      subcategory: '${raw['subcategory'] ?? ''}',
      eventType: '${raw['event_type'] ?? ''}',
      status: '${raw['status'] ?? ''}',
      time: '${raw['time'] ?? ''}',
      at: DateTime.fromMillisecondsSinceEpoch(ms.toInt(), isUtc: true),
      source: '${raw['source_type'] ?? ''}',
      state: '${raw['new_state'] ?? ''}',
      spoken: '${raw['spoken'] ?? ''}',
      recordId: '${raw['record_id'] ?? ''}',
    );
  }

  final String id;
  final String title;
  final String category;
  final String subcategory;
  final String eventType;
  final String status;
  final String time;
  final DateTime at;
  final String source;
  final String state;
  final String spoken;
  final String recordId;

  String get kind => cheBrainLearningKind(eventType);
  CheBrainRegion get region => cheBrainRegionForLedger(category, subcategory, eventType);

  /// 0..1 along the knowledge-state progression, or null when the ledger recorded no state for it.
  double? get progress {
    final i = cheBrainLedgerProgression.indexOf(state.toUpperCase());
    return i < 0 ? null : (i + 1) / cheBrainLedgerProgression.length;
  }

  String get sourceWords => switch (source) {
    'OWNER' => 'From you',
    'CONVERSATION' => 'From conversation',
    'PAPER TRADE' => 'Paper trade',
    'BACKTEST' => 'Backtest',
    'SYSTEM EVENT' => 'System event',
    'AGENT RESULT' => 'Agent result',
    'TOOL RESULT' => 'Tool result',
    '' => 'Source not recorded',
    _ => source[0] + source.substring(1).toLowerCase(),
  };
}

/// What the ledger overview says, parsed. [events] are newest first.
class CheBrainLearning {
  const CheBrainLearning({this.events = const [], this.totals = const {}, this.fetchedAt, this.error});

  factory CheBrainLearning.fromLedger(Map<String, dynamic> v, {DateTime? fetchedAt}) {
    final events = [
      for (final e in (v['recent'] as List?) ?? const []) ?CheBrainLearningEvent.fromLedger(e),
    ]..sort((a, b) => b.at.compareTo(a.at));
    final totals = <String, int>{
      for (final MapEntry(:key, :value) in ((v['totals'] as Map?) ?? const {}).entries)
        if (value is num) '$key': value.toInt(),
    };
    return CheBrainLearning(events: events, totals: totals, fetchedAt: fetchedAt ?? DateTime.now());
  }

  final List<CheBrainLearningEvent> events;
  final Map<String, int> totals;
  final DateTime? fetchedAt;
  final String? error;

  /// Something entered the Brain in the last [window]: the Brain is learning now. Otherwise it is idle.
  bool isActive(DateTime now, {Duration window = const Duration(minutes: 10)}) => events.isNotEmpty && now.difference(events.first.at) <= window;

  /// The one-line state: Learning now / Idle — waiting for work / not loaded.
  String headline(DateTime now) {
    if (error != null) return 'Learning feed unavailable: $error';
    if (fetchedAt == null) return 'Checking what CHE is learning…';
    if (events.isEmpty) return 'Idle — waiting for work. Nothing has entered the Brain yet.';
    if (isActive(now)) return 'Learning now: ${events.first.kind.toLowerCase()} · ${events.first.title}';
    return 'Idle — waiting for work. Last learned ${cheBrainAgo(events.first.at, now: now)}.';
  }

  /// Events that are new compared with [before] (the regions these light up).
  List<CheBrainLearningEvent> newSince(CheBrainLearning? before) {
    if (before == null || before.fetchedAt == null) return const [];
    final seen = {for (final e in before.events) e.id};
    final newest = before.events.isEmpty ? null : before.events.first.at;
    return [for (final e in events) if (!seen.contains(e.id) && (newest == null || !e.at.isBefore(newest))) e];
  }
}
