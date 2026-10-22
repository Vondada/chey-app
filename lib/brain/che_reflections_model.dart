// CHE daily reflections: a pure view model (no Flutter, no HTTP).
//
// The Worker contract (another lane):
//   GET  /api/reflections?day=YYYY-MM-DD  -> {reflections:[{id, day, items:[{category, text, reply, reply_text}]}]}
//   POST /api/reflections/generate {day}  -> the new reflection, or {status:'model_unavailable'}
//   POST /api/reflections/reply {id, item_index, reply, reply_text}
// Here `reply` on an item is the owner's state: 'replied', 'skipped', or absent/empty while open.
// `reply_text` holds the owner's words. Nothing in this file speaks.

const List<String> kReflectionCategories = [
  'lesson',
  'idea',
  'mistake',
  'money_opportunity',
  'question_for_owner',
  'book',
];

const String kReflectionEmptyMessage = 'No reflection for this day yet';

const String kReflectionModelUnavailableMessage =
    "CHE's model is unavailable right now, so no reflection was made. Try again later.";

/// Human label for a category id. Unknown categories are grouped under "Other".
String reflectionCategoryLabel(String category) => switch (category) {
      'lesson' => 'Lesson',
      'idea' => 'Idea',
      'mistake' => 'Mistake',
      'money_opportunity' => 'Money opportunity',
      'question_for_owner' => 'Question for you',
      'book' => 'Book',
      _ => 'Other',
    };

/// Room label for an item's source (chat, office, trading, create, brain, or any other room in the data).
String reflectionRoomLabel(String room) => switch (room) {
      'chat' => 'Chat',
      'office' => 'Office',
      'trading' => 'Trading',
      'create' => 'Create',
      'brain' => 'Brain',
      '' || 'other' => 'Other',
      _ => room[0].toUpperCase() + room.substring(1),
    };

/// The owner's state for one item.
enum ReflectionReply { open, replied, skipped }

/// Formats a date as the Worker's `day` key (YYYY-MM-DD) from its calendar fields.
String reflectionDayKey(DateTime day) {
  final y = day.year.toString().padLeft(4, '0');
  final m = day.month.toString().padLeft(2, '0');
  final d = day.day.toString().padLeft(2, '0');
  return '$y-$m-$d';
}

class ReflectionItem {
  const ReflectionItem({
    required this.category,
    required this.text,
    this.room = 'other',
    this.reply = ReflectionReply.open,
    this.replyText = '',
  });

  factory ReflectionItem.fromJson(Map<String, dynamic> json) {
    final replyText = json['reply_text'] is String ? (json['reply_text'] as String).trim() : '';
    final room = json['room'];
    return ReflectionItem(
      category: json['category'] is String ? json['category'] as String : 'other',
      text: json['text'] is String ? json['text'] as String : '',
      room: room is String && room.isNotEmpty ? room : 'other',
      reply: _replyFrom(json['reply'], replyText),
      replyText: replyText,
    );
  }

  final String category;
  final String text;
  final String room;
  final ReflectionReply reply;
  final String replyText;

  String get categoryLabel => reflectionCategoryLabel(category);

  String get roomLabel => reflectionRoomLabel(room);

  /// Plain-language state, so the result never depends on colour alone.
  String get stateText => switch (reply) {
        ReflectionReply.open => 'Not answered yet.',
        ReflectionReply.replied => 'Your reply: $replyText',
        ReflectionReply.skipped => 'Skipped.',
      };

  ReflectionItem copyWith({ReflectionReply? reply, String? replyText}) => ReflectionItem(
        category: category,
        text: text,
        room: room,
        reply: reply ?? this.reply,
        replyText: replyText ?? this.replyText,
      );

  static ReflectionReply _replyFrom(Object? reply, String replyText) {
    final r = reply is String ? reply.trim().toLowerCase() : '';
    if (r == 'skipped' || r == 'skip') return ReflectionReply.skipped;
    if (r == 'replied' || r == 'reply' || replyText.isNotEmpty) return ReflectionReply.replied;
    return ReflectionReply.open;
  }
}

/// One item plus its position in the day, which the reply endpoint needs as `item_index`.
class ReflectionEntry {
  const ReflectionEntry(this.index, this.item);
  final int index;
  final ReflectionItem item;
}

/// Items of one category, in the order they were stored.
class ReflectionGroup {
  const ReflectionGroup(this.category, this.label, this.entries);
  final String category;
  final String label;
  final List<ReflectionEntry> entries;
}

class ReflectionDay {
  const ReflectionDay({required this.id, required this.day, required this.items});

  factory ReflectionDay.fromJson(Map<String, dynamic> json) {
    final raw = json['items'];
    final items = <ReflectionItem>[];
    if (raw is List) {
      for (final entry in raw) {
        if (entry is Map<String, dynamic>) items.add(ReflectionItem.fromJson(entry));
      }
    }
    return ReflectionDay(
      id: json['id'] is String ? json['id'] as String : '',
      day: json['day'] is String ? json['day'] as String : '',
      items: items,
    );
  }

  final String id;
  final String day;
  final List<ReflectionItem> items;

  bool get isEmpty => items.isEmpty;

  int get openCount => items.where((i) => i.reply == ReflectionReply.open).length;

  /// Room ids present in this day's items, in first-seen order (for the room filter).
  List<String> get rooms {
    final seen = <String>[];
    for (final i in items) {
      if (!seen.contains(i.room)) seen.add(i.room);
    }
    return seen;
  }

  /// Groups by category in the fixed order of [kReflectionCategories], then any other categories as "Other".
  /// [room] keeps only items from that room; null keeps all rooms.
  List<ReflectionGroup> groupsFor({String? room}) {
    final byCategory = <String, List<ReflectionEntry>>{};
    for (var i = 0; i < items.length; i++) {
      if (room != null && items[i].room != room) continue;
      final known = kReflectionCategories.contains(items[i].category) ? items[i].category : 'other';
      byCategory.putIfAbsent(known, () => []).add(ReflectionEntry(i, items[i]));
    }
    return [
      for (final c in [...kReflectionCategories, 'other'])
        if (byCategory.containsKey(c)) ReflectionGroup(c, reflectionCategoryLabel(c), byCategory[c]!),
    ];
  }

  List<ReflectionGroup> get groups => groupsFor();

  /// Returns a copy with item [index] replaced. An out-of-range index returns this unchanged.
  ReflectionDay withItem(int index, ReflectionItem Function(ReflectionItem) change) {
    if (index < 0 || index >= items.length) return this;
    final next = [...items];
    next[index] = change(items[index]);
    return ReflectionDay(id: id, day: day, items: next);
  }

  /// The owner's words for item [index]. Blank text is refused (returns this) so a reply is never empty.
  ReflectionDay withReply(int index, String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return this;
    return withItem(index, (i) => i.copyWith(reply: ReflectionReply.replied, replyText: trimmed));
  }

  ReflectionDay withSkip(int index) =>
      withItem(index, (i) => i.copyWith(reply: ReflectionReply.skipped, replyText: ''));
}

/// Reads the reflection for a day from a GET response. Returns null when there is none for that day.
ReflectionDay? reflectionDayFromResponse(Object? json) {
  if (json is! Map<String, dynamic>) return null;
  final list = json['reflections'];
  if (list is List) {
    for (final r in list) {
      if (r is Map<String, dynamic>) return ReflectionDay.fromJson(r);
    }
    return null;
  }
  // A generate response may be the reflection itself.
  if (json['items'] is List) return ReflectionDay.fromJson(json);
  return null;
}

/// True when the Worker could not make a reflection because the model is unavailable.
bool isReflectionModelUnavailable(Object? json) => json is Map && json['status'] == 'model_unavailable';
