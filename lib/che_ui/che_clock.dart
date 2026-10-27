// CHE's always-visible clock and trading-session hours (owner, 2026-10-22). The owner's time is America/Chicago on a
// 12-hour clock, with CDT or CST shown. The market sessions use the same hours as server/cloudflare/trading_clock.js.
// Everything here is computed on the phone from the UTC instant, so it works offline. Nothing here speaks: the clock
// is quiet text (owner rule, 2026-10-11).
import 'dart:async';

import 'package:flutter/material.dart';

import 'che_hud.dart';
import 'che_theme.dart';

/// The US daylight-saving rule (since 2007): DST starts the second Sunday of March at 2 AM local and ends the first
/// Sunday of November at 2 AM local. Expressed in UTC, the switch happens at 07:00 UTC for New York and 08:00 UTC for
/// Chicago (start), and at 06:00 / 07:00 UTC (end).
bool _usDst(DateTime utc, {required int startHourUtc, required int endHourUtc}) {
  final start = _nthWeekday(utc.year, DateTime.march, DateTime.sunday, 2).add(Duration(hours: startHourUtc));
  final end = _nthWeekday(utc.year, DateTime.november, DateTime.sunday, 1).add(Duration(hours: endHourUtc));
  return !utc.isBefore(start) && utc.isBefore(end);
}

/// The UK and EU rule: summer time from the last Sunday of March to the last Sunday of October, both at 01:00 UTC.
bool _ukDst(DateTime utc) {
  final start = _lastWeekday(utc.year, DateTime.march, DateTime.sunday).add(const Duration(hours: 1));
  final end = _lastWeekday(utc.year, DateTime.october, DateTime.sunday).add(const Duration(hours: 1));
  return !utc.isBefore(start) && utc.isBefore(end);
}

DateTime _nthWeekday(int year, int month, int weekday, int n) {
  final first = DateTime.utc(year, month, 1);
  final offset = (weekday - first.weekday + 7) % 7;
  return DateTime.utc(year, month, 1 + offset + (n - 1) * 7);
}

DateTime _lastWeekday(int year, int month, int weekday) {
  final last = DateTime.utc(year, month + 1, 0);
  final back = (last.weekday - weekday + 7) % 7;
  return DateTime.utc(year, month, last.day - back);
}

/// The owner's Central time at a UTC instant: local wall-clock time and its zone label (CDT or CST).
class CheChicagoTime {
  const CheChicagoTime._(this.local, this.isDst);

  final DateTime local;
  final bool isDst;

  factory CheChicagoTime.at(DateTime instant) {
    final utc = instant.toUtc();
    final dst = _usDst(utc, startHourUtc: 8, endHourUtc: 7);
    return CheChicagoTime._(utc.add(Duration(hours: dst ? -5 : -6)), dst);
  }

  String get zone => isDst ? 'CDT' : 'CST';

  /// "9:30 PM CDT": 12-hour, never 24-hour.
  String get text => '${cheTwelveHour(local.hour, local.minute)} $zone';
}

/// "12:05 AM", "9:30 AM", "12:00 PM", "3:15 PM".
String cheTwelveHour(int hour, int minute) {
  final h = hour % 12 == 0 ? 12 : hour % 12;
  return '$h:${minute.toString().padLeft(2, '0')} ${hour < 12 ? 'AM' : 'PM'}';
}

/// One market session at an instant: whether it is open, with the local time of that market.
class CheMarketSession {
  const CheMarketSession({required this.name, required this.open, required this.localText});

  final String name;
  final bool open;
  final String localText;
}

// Same hours as trading_clock.js. Local open and close, in minutes after midnight.
const _cashOpen = {'Tokyo': 9 * 60, 'London': 8 * 60, 'New York': 9 * 60 + 30};
const _cashClose = {'Tokyo': 15 * 60, 'London': 16 * 60 + 30, 'New York': 16 * 60};

/// The three cash sessions and CME micro Nasdaq futures at a UTC instant.
List<CheMarketSession> cheMarketSessions(DateTime instant) {
  final utc = instant.toUtc();
  final newYorkDst = _usDst(utc, startHourUtc: 7, endHourUtc: 6);
  final londonDst = _ukDst(utc);
  final local = <String, DateTime>{
    'Tokyo': utc.add(const Duration(hours: 9)),
    'London': utc.add(Duration(hours: londonDst ? 1 : 0)),
    'New York': utc.add(Duration(hours: newYorkDst ? -4 : -5)),
  };
  final sessions = <CheMarketSession>[];
  for (final name in _cashOpen.keys) {
    final at = local[name]!;
    final minutes = at.hour * 60 + at.minute;
    final weekend = at.weekday == DateTime.saturday || at.weekday == DateTime.sunday;
    final open = !weekend && minutes >= _cashOpen[name]! && minutes < _cashClose[name]!;
    sessions.add(CheMarketSession(name: name, open: open, localText: '${cheTwelveHour(at.hour, at.minute)} $name time'));
  }
  sessions.add(CheMarketSession(name: 'MNQ futures', open: cheFuturesOpen(utc), localText: 'CME, New York time'));
  return sessions;
}

/// When a market next changes state (opens or closes) after [instant], found by scanning the same calendar in 5-minute
/// steps (every session boundary falls on that grid), for up to eight days.
DateTime? cheNextSessionChange(String name, DateTime instant) {
  final now = instant.toUtc();
  final open = cheMarketSessions(now).firstWhere((s) => s.name == name).open;
  // Boundaries fall on the 5-minute grid, so the scan starts at the first grid point after [now].
  var at = DateTime.utc(now.year, now.month, now.day, now.hour, now.minute - now.minute % 5).add(const Duration(minutes: 5));
  final end = now.add(const Duration(days: 8));
  while (at.isBefore(end)) {
    if (cheMarketSessions(at).firstWhere((s) => s.name == name).open != open) return at;
    at = at.add(const Duration(minutes: 5));
  }
  return null;
}

/// CME micro Nasdaq futures: open Sunday 6:00 PM to Friday 5:00 PM New York time, with a daily 5:00 to 6:00 PM break.
bool cheFuturesOpen(DateTime utc) {
  final newYorkDst = _usDst(utc.toUtc(), startHourUtc: 7, endHourUtc: 6);
  final ny = utc.toUtc().add(Duration(hours: newYorkDst ? -4 : -5));
  final minutes = ny.hour * 60 + ny.minute;
  switch (ny.weekday) {
    case DateTime.saturday:
      return false;
    case DateTime.sunday:
      return minutes >= 18 * 60;
    case DateTime.friday:
      return minutes < 17 * 60;
    default:
      return !(minutes >= 17 * 60 && minutes < 18 * 60);
  }
}

/// The clock strip: "9:30 PM CDT · New York open · London closed · Tokyo closed · MNQ open". Refreshes each minute.
/// It is quiet text, with the whole reading in one accessible label, and it never speaks.
class CheClockStrip extends StatefulWidget {
  const CheClockStrip({super.key, this.now});

  /// For tests and previews: a fixed instant. Null uses the device clock.
  final DateTime Function()? now;

  @override
  State<CheClockStrip> createState() => _CheClockStripState();
}

class _CheClockStripState extends State<CheClockStrip> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final instant = widget.now?.call() ?? DateTime.now();
    final chicago = CheChicagoTime.at(instant);
    final sessions = cheMarketSessions(instant);
    final line = [
      chicago.text,
      for (final s in sessions) '${s.name} ${s.open ? 'open' : 'closed'}',
    ].join(' · ');
    return Semantics(
      container: true,
      label: 'Clock and markets: ${chicago.text}. ${sessions.map((s) => '${s.name} ${s.open ? 'open' : 'closed'}, ${s.localText}').join('. ')}.',
      excludeSemantics: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: CheSpace.md, vertical: 4),
        // HUD: quiet mono text straight on the backdrop.
        color: cheHudActive ? Colors.transparent : const Color(0xE6081012),
        child: FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            line,
            maxLines: 1,
            style: cheHudActive
                ? CheHud.label.copyWith(fontSize: 10.5, letterSpacing: 1.0, color: CheColors.textDim)
                : CheType.caption.copyWith(fontSize: 11, color: CheColors.textDim, fontFeatures: const [FontFeature.tabularFigures()]),
          ),
        ),
      ),
    );
  }
}
