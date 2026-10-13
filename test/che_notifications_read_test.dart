import 'package:chey/platform/che_platform_models.dart';
import 'package:flutter_test/flutter_test.dart';

ChePlatformNotification note(
  String id,
  DateTime at, {
  DateTime? readAt,
  String priority = 'urgent',
}) => ChePlatformNotification(
  id: id,
  tenantId: 'owner',
  source: 'CHE',
  title: 'Title $id',
  body: 'Body $id',
  priority: priority,
  target: '',
  createdAt: at,
  readAt: readAt,
);

void main() {
  final first = DateTime.utc(2026, 10, 13, 9);
  final second = DateTime.utc(2026, 10, 13, 10);

  test('opening the list reads only the unread items, newest first', () {
    final items = [
      note('old', first),
      note('new', second),
      note('done', second, readAt: second),
    ];
    final toMark = cheUnreadToMarkRead(items).map((n) => n.id).toList();
    expect(toMark, ['new', 'old']);
  });

  test('one open marks at most the cap, so it never sends a long run', () {
    final items = [for (var i = 0; i < 30; i++) note('n$i', first.add(Duration(minutes: i)))];
    expect(cheUnreadToMarkRead(items), hasLength(20));
    expect(cheUnreadToMarkRead(items, max: 5), hasLength(5));
  });

  test('the home banner counts only unread top-priority notifications, so reading clears it', () {
    final unread = [note('a', second), note('b', first, priority: 'normal')];
    expect(cheTopPriorityBanners(unread).map((n) => n.id), ['a']);

    final read = [note('a', second, readAt: second), note('b', first, priority: 'normal')];
    expect(cheTopPriorityBanners(read), isEmpty);
  });
}
