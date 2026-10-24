// One month as a Monday-first grid, shared by the Trading P&L calendar and the Office calendar (owner, 2026-10-24).
// The Worker sends the weeks (server/cloudflare/che_calendars.js monthGrid: each week lists only its in-month days);
// this widget pads the first and last week and draws one tappable, VoiceOver-labelled cell per day.
import 'package:flutter/material.dart';

const cheCalendarGreen = Color(0xFF34D399);
const cheCalendarRed = Color(0xFFF87171);
const cheCalendarYellow = Color(0xFFFBBF24);
const cheCalendarPanel = Color(0xFF0E1418);
const cheCalendarStroke = Color(0xFF2A3540);

/// The Worker's color word as a color; null (nothing recorded) stays plain.
Color? cheCalendarColor(Object? word) => switch (word) { 'green' => cheCalendarGreen, 'red' => cheCalendarRed, 'yellow' => cheCalendarYellow, _ => null };

const _monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const _weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/// "2026-09" → "September 2026".
String cheMonthLabel(String month) {
  final parts = month.split('-');
  final m = parts.length == 2 ? int.tryParse(parts[1]) : null;
  return m == null || m < 1 || m > 12 ? month : '${_monthNames[m - 1]} ${parts[0]}';
}

/// "2026-09-22" → "Tuesday, September 22".
String cheDayLabel(String date) {
  final d = DateTime.tryParse('${date}T12:00:00Z');
  if (d == null) return date;
  return '${_weekdays[d.weekday - 1]}, ${_monthNames[d.month - 1]} ${d.day}';
}

List<Map<String, dynamic>> cheCalendarRows(Object? v) => v is List ? v.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : [];

class CheCalendarGrid extends StatelessWidget {
  const CheCalendarGrid({super.key, required this.weeks, required this.cellText, required this.cellLabel, required this.onTapDay});

  final List<Map<String, dynamic>> weeks;

  /// The one or two short lines inside a cell under the day number ('' for an empty day).
  final String Function(Map<String, dynamic> day) cellText;

  /// The whole cell read by VoiceOver: date, result and count.
  final String Function(Map<String, dynamic> day) cellLabel;
  final void Function(String date) onTapDay;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[
      Row(children: [for (final w in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) Expanded(child: ExcludeSemantics(child: Center(child: Text(w, style: const TextStyle(color: Colors.white70, fontSize: 13, fontWeight: FontWeight.w600)))))]),
      const SizedBox(height: 4),
    ];
    for (var i = 0; i < weeks.length; i++) {
      final days = cheCalendarRows(weeks[i]['days']);
      if (days.isEmpty) continue;
      final first = DateTime.tryParse('${days.first['date']}T12:00:00Z');
      final lead = i == 0 && first != null ? first.weekday - 1 : 0;
      final cells = <Widget>[for (var k = 0; k < lead; k++) const Expanded(child: SizedBox())];
      for (final d in days) {
        cells.add(Expanded(child: _Cell(day: d, text: cellText(d), label: cellLabel(d), onTap: () => onTapDay('${d['date']}'))));
      }
      while (cells.length < 7) {
        cells.add(const Expanded(child: SizedBox()));
      }
      rows.add(Row(crossAxisAlignment: CrossAxisAlignment.start, children: cells));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
  }
}

class _Cell extends StatelessWidget {
  const _Cell({required this.day, required this.text, required this.label, required this.onTap});
  final Map<String, dynamic> day;
  final String text;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = cheCalendarColor(day['color']);
    final date = '${day['date']}';
    return Padding(
      padding: const EdgeInsets.all(2),
      child: Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: InkWell(
          key: Key('calendar_day_$date'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Container(
            constraints: const BoxConstraints(minHeight: 64),
            padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 4),
            decoration: BoxDecoration(
              color: color == null ? cheCalendarPanel : color.withValues(alpha: 0.18),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: color ?? cheCalendarStroke, width: color == null ? 1 : 1.5),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(date.length >= 10 ? '${int.tryParse(date.substring(8)) ?? date.substring(8)}' : date, style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700)),
              if (text.isNotEmpty) Text(text, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: color ?? Colors.white70, fontSize: 12, fontWeight: FontWeight.w600, height: 1.15)),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Previous month, the month's name, next month; each a labelled button.
class CheMonthNav extends StatelessWidget {
  const CheMonthNav({super.key, required this.month, required this.onPrev, required this.onNext});
  final String month;
  final VoidCallback onPrev;
  final VoidCallback onNext;

  @override
  Widget build(BuildContext context) => Row(children: [
        IconButton(key: const Key('calendar_prev'), tooltip: 'Previous month', onPressed: onPrev, icon: const Icon(Icons.chevron_left_rounded, color: Colors.white, size: 30)),
        Expanded(child: Semantics(header: true, child: Text(cheMonthLabel(month), textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800)))),
        IconButton(key: const Key('calendar_next'), tooltip: 'Next month', onPressed: onNext, icon: const Icon(Icons.chevron_right_rounded, color: Colors.white, size: 30)),
      ]);
}
