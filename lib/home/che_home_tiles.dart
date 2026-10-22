// HUD Home tiles (owner, 2026-10-22: "I actually like this style better", the glass HUD concept with MNQ, Flagstaff,
// Office and Next tiles). Every number is real: MNQ comes from the Worker's own chart feed (/api/trading/chart, the
// futures paper account, labelled with the feed's own status such as DELAYED), Flagstaff from the unread count, the
// Office from the live runtime, and Next from the market clock. A tile with no data says so; nothing is invented.
// Nothing here speaks by itself.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_clock.dart';
import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';
import '../che_ui/che_widgets.dart';

/// MNQ as the Worker's chart feed reports it.
class CheHomeQuote {
  const CheHomeQuote({required this.last, required this.changePct, required this.closes, required this.status, required this.stale});

  final double last;
  final double? changePct;
  final List<double> closes;
  final String status;
  final bool stale;

  /// From an /api/trading/chart answer: the last close, the change from the first bar of the latest trading day, and the
  /// last 36 closes for the line. Null when there are no bars.
  static CheHomeQuote? fromChart(Map<String, dynamic> j) {
    final bars = [
      for (final b in (j['bars'] is List ? j['bars'] as List : const []))
        if (b is Map && b['c'] is num && b['o'] is num) b,
    ];
    if (bars.isEmpty) return null;
    final last = (bars.last['c'] as num).toDouble();
    DateTime? time(Object? v) => v is num
        ? DateTime.fromMillisecondsSinceEpoch(v > 1e12 ? v.toInt() : (v * 1000).toInt(), isUtc: true)
        : (v is String ? DateTime.tryParse(v)?.toUtc() : null);
    final lastDay = time(bars.last['t']);
    final dayOpen = bars.firstWhere(
      (b) {
        final t = time(b['t']);
        return lastDay != null && t != null && t.year == lastDay.year && t.month == lastDay.month && t.day == lastDay.day;
      },
      orElse: () => bars.first,
    );
    final open = (dayOpen['o'] as num).toDouble();
    final feed = j['feed'] is Map ? j['feed'] as Map : const {};
    return CheHomeQuote(
      last: last,
      changePct: open == 0 ? null : (last - open) / open * 100,
      closes: [for (final b in bars.skip(math.max(0, bars.length - 36))) (b['c'] as num).toDouble()],
      status: '${feed['status'] ?? 'UNKNOWN'}'.toUpperCase(),
      stale: feed['stale'] == true,
    );
  }
}

/// The next market event at [instant]: the New York cash open or close, with its New York time. Weekends move to Monday.
({String label, DateTime at}) cheNextMarketEvent(DateTime instant) {
  final utc = instant.toUtc();
  final open = cheMarketSessions(utc).firstWhere((s) => s.name == 'New York').open;
  // New York offset from the same rule the clock uses: a New York session's local time is UTC-4 in summer, UTC-5 in winter.
  final probe = DateTime.utc(utc.year, utc.month, utc.day, 12);
  final summer = _nyOffsetHours(probe) == -4;
  final offset = Duration(hours: summer ? -4 : -5);
  final ny = utc.add(offset);
  DateTime nyTime(DateTime day, int h, int m) => DateTime.utc(day.year, day.month, day.day, h, m).subtract(offset);
  if (open) return (label: 'NY CLOSE', at: nyTime(ny, 16, 0));
  var day = ny;
  if (ny.hour * 60 + ny.minute >= 9 * 60 + 30) day = day.add(const Duration(days: 1));
  while (day.weekday == DateTime.saturday || day.weekday == DateTime.sunday) {
    day = day.add(const Duration(days: 1));
  }
  return (label: 'NY OPEN', at: nyTime(day, 9, 30));
}

int _nyOffsetHours(DateTime utc) {
  // New York observes daylight time from the second Sunday of March to the first Sunday of November.
  DateTime nthSunday(int month, int n) {
    var d = DateTime.utc(utc.year, month, 1);
    while (d.weekday != DateTime.sunday) {
      d = d.add(const Duration(days: 1));
    }
    return d.add(Duration(days: 7 * (n - 1)));
  }

  final start = nthSunday(3, 2).add(const Duration(hours: 7));
  final end = nthSunday(11, 1).add(const Duration(hours: 6));
  return utc.isAfter(start) && utc.isBefore(end) ? -4 : -5;
}

/// "T−00:49" until [at].
String cheCountdown(DateTime now, DateTime at) {
  final d = at.difference(now);
  if (d.isNegative) return 'T−00:00';
  final h = d.inHours;
  final m = d.inMinutes.remainder(60);
  return 'T−${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';
}

/// A tilted glass tile: the panes lean toward the centre like a curved HUD. Flat with Reduce Motion.
class CheHudTile extends StatelessWidget {
  const CheHudTile({
    super.key,
    required this.semantics,
    required this.onTap,
    required this.leanRight,
    required this.height,
    required this.child,
    this.glow,
  });

  final String semantics;
  final VoidCallback onTap;
  final bool leanRight;
  final double height;
  final Widget child;
  final Color? glow;

  @override
  Widget build(BuildContext context) {
    final flat = CheMotion.reduced(context);
    final tilt = Matrix4.identity()
      ..setEntry(3, 2, 0.0012)
      ..rotateY(leanRight ? 0.12 : -0.12)
      ..rotateX(0.04);
    return Semantics(
      container: true,
      button: true,
      label: semantics,
      excludeSemantics: true,
      child: ChePressable(
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: Transform(
          alignment: leanRight ? Alignment.centerRight : Alignment.centerLeft,
          transform: flat ? Matrix4.identity() : tilt,
          // At least [height]; taller when large text needs it, so nothing is clipped.
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: height),
            child: CheGlass(radius: 24, glow: glow, padding: const EdgeInsets.fromLTRB(15, 14, 15, 12), child: child),
          ),
        ),
      ),
    );
  }
}

class _TileLabel extends StatelessWidget {
  const _TileLabel(this.icon, this.text);

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(children: [
      Icon(icon, size: 14, color: CheHud.ice),
      const SizedBox(width: 7),
      Flexible(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label)),
    ]);
  }
}

/// MNQ from the Worker's chart feed, refreshed each minute while Home is on screen.
class CheHomeMarketTile extends StatefulWidget {
  const CheHomeMarketTile({super.key, required this.baseUrl, required this.headers, required this.onOpen, this.client, this.height = 140});

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final VoidCallback onOpen;
  final http.Client? client;
  final double height;

  @override
  State<CheHomeMarketTile> createState() => _CheHomeMarketTileState();
}

class _CheHomeMarketTileState extends State<CheHomeMarketTile> {
  CheHomeQuote? _quote;
  String? _error;
  Timer? _timer;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    // Only while this tile's tab is on screen (TickerMode), so a hidden Home makes no requests.
    _timer = Timer.periodic(const Duration(seconds: 60), (_) {
      if (mounted && TickerMode.valuesOf(context).enabled) unawaited(_load());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    if (_loading || widget.baseUrl().isEmpty) return;
    _loading = true;
    final client = widget.client ?? http.Client();
    try {
      final uri = Uri.parse('${widget.baseUrl()}/api/trading/chart').replace(queryParameters: {'account': 'futures_paper', 'tf': '5m'});
      final r = await client.get(uri, headers: widget.headers()).timeout(const Duration(seconds: 20));
      final j = jsonDecode(r.body);
      if (!mounted) return;
      if (r.statusCode != 200 || j is! Map<String, dynamic>) {
        setState(() => _error = 'No price right now');
        return;
      }
      final quote = CheHomeQuote.fromChart(j);
      setState(() {
        _quote = quote;
        _error = quote == null ? 'No bars yet' : null;
      });
    } catch (_) {
      if (mounted) setState(() => _error = 'No price right now');
    } finally {
      if (widget.client == null) client.close();
      _loading = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _quote;
    final up = (q?.changePct ?? 0) >= 0;
    final change = q?.changePct == null ? '' : '${up ? '+' : ''}${q!.changePct!.toStringAsFixed(2)}%';
    final status = q == null ? '' : (q.stale ? 'STALE' : q.status);
    final price = q == null ? '—' : _price(q.last);
    return CheHudTile(
      semantics: q == null
          ? 'Trading. MNQ: ${_error ?? 'loading'}. Double tap to open.'
          : 'Trading. MNQ $price, ${change.isEmpty ? '' : '${q.changePct!.toStringAsFixed(2)} percent today, '}${status.toLowerCase()} data. Double tap to open.',
      onTap: widget.onOpen,
      leanRight: true,
      height: widget.height,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _TileLabel(Icons.show_chart_rounded, status.isEmpty ? 'MNQ' : 'MNQ · $status'),
          const SizedBox(height: 8),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: CheChromeText(price, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()])),
          ),
          if (change.isNotEmpty)
            Row(children: [
              // The direction as a drawn triangle, so no font is needed for it.
              CustomPaint(size: const Size(9, 8), painter: _TrianglePainter(up: up, color: up ? CheHud.mint : CheEnergyRed.red)),
              const SizedBox(width: 5),
              Text(change, style: CheHud.label.copyWith(fontSize: 11.5, letterSpacing: 0.6, color: up ? CheHud.mint : CheEnergyRed.red)),
            ])
          else if (q == null)
            Text(_error ?? 'Loading', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.caption.copyWith(color: CheColors.textDim)),
          if (q != null && q.closes.length > 1) ...[
            const SizedBox(height: 6),
            SizedBox(height: 34, width: double.infinity, child: ExcludeSemantics(child: CustomPaint(painter: _SparkPainter(q.closes)))),
          ],
        ]),
    );
  }

  static String _price(double v) {
    final fixed = v.toStringAsFixed(2);
    final parts = fixed.split('.');
    final whole = parts[0].replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
    return '$whole.${parts[1]}';
  }
}

/// The down colour, kept with the tile so the tile file needs no other palette.
class CheEnergyRed {
  CheEnergyRed._();
  static const Color red = Color(0xFFFF7A90);
}

class _TrianglePainter extends CustomPainter {
  _TrianglePainter({required this.up, required this.color});

  final bool up;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final path = up
        ? (Path()
          ..moveTo(size.width / 2, 0)
          ..lineTo(size.width, size.height)
          ..lineTo(0, size.height))
        : (Path()
          ..moveTo(0, 0)
          ..lineTo(size.width, 0)
          ..lineTo(size.width / 2, size.height));
    canvas.drawPath(path..close(), Paint()..color = color);
  }

  @override
  bool shouldRepaint(_TrianglePainter old) => old.up != up || old.color != color;
}

class _SparkPainter extends CustomPainter {
  _SparkPainter(this.values);

  final List<double> values;

  @override
  void paint(Canvas canvas, Size size) {
    final lo = values.reduce(math.min);
    final hi = values.reduce(math.max);
    final span = hi - lo == 0 ? 1 : hi - lo;
    final path = Path();
    for (var i = 0; i < values.length; i++) {
      final x = size.width * i / (values.length - 1);
      final y = size.height - (values[i] - lo) / span * (size.height - 4) - 2;
      i == 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    }
    final fill = Path.from(path)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(
      fill,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [CheHud.iceDeep.withValues(alpha: 0.4), CheHud.iceDeep.withValues(alpha: 0)],
        ).createShader(Offset.zero & size),
    );
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.8
        ..color = const Color(0xFFBFF1FF),
    );
  }

  @override
  bool shouldRepaint(_SparkPainter old) => old.values != values;
}

/// Flagstaff: the real unread count.
class CheHomeFlagstaffTile extends StatelessWidget {
  const CheHomeFlagstaffTile({super.key, required this.unread, required this.onOpen, this.height = 140});

  final int unread;
  final VoidCallback onOpen;
  final double height;

  @override
  Widget build(BuildContext context) {
    return CheHudTile(
      semantics: unread > 0 ? 'Flagstaff, $unread unread. Double tap to open.' : 'Flagstaff, nothing unread. Double tap to open.',
      onTap: onOpen,
      leanRight: false,
      height: height,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const _TileLabel(Icons.mail_outline_rounded, 'FLAGSTAFF'),
        const SizedBox(height: 8),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: CheChromeText(unread > 0 ? '$unread unread' : 'All read', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: 6),
        Text('Messages, reports and notices', maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption.copyWith(color: CheColors.textDim, fontSize: 12.5)),
      ]),
    );
  }
}

/// The Office: agents working out of the whole team, as a ring.
class CheHomeOfficeTile extends StatelessWidget {
  const CheHomeOfficeTile({super.key, required this.working, required this.total, required this.onOpen, this.height = 106});

  final int working;
  final int total;
  final VoidCallback onOpen;
  final double height;

  @override
  Widget build(BuildContext context) {
    final share = total == 0 ? 0.0 : (working / total).clamp(0.0, 1.0);
    return CheHudTile(
      semantics: 'The Office. $working of $total agents working. Double tap to open.',
      onTap: onOpen,
      leanRight: true,
      height: height,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const _TileLabel(Icons.groups_rounded, 'OFFICE'),
        const SizedBox(height: 8),
        Row(children: [
          SizedBox(width: 40, height: 40, child: CustomPaint(painter: _RingPainter(share))),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text('$working / $total', style: CheType.headline.copyWith(fontSize: 19, fontWeight: FontWeight.w700))),
              Text('AGENTS ACTIVE', maxLines: 1, style: CheHud.label.copyWith(fontSize: 9.5, color: CheColors.textDim)),
            ]),
          ),
        ]),
      ]),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.share);

  final double share;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2 - 3;
    canvas.drawCircle(c, r, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4
      ..color = CheHud.ice.withValues(alpha: 0.2));
    if (share > 0) {
      canvas.drawArc(Rect.fromCircle(center: c, radius: r), -math.pi / 2, 2 * math.pi * share, false, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 4
        ..strokeCap = StrokeCap.round
        ..color = CheHud.ice);
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.share != share;
}

/// Next: the New York open or close, with a countdown from the market clock.
class CheHomeNextTile extends StatelessWidget {
  const CheHomeNextTile({super.key, required this.now, required this.onOpen, this.height = 106});

  final DateTime now;
  final VoidCallback onOpen;
  final double height;

  @override
  Widget build(BuildContext context) {
    final next = cheNextMarketEvent(now);
    final chicago = CheChicagoTime.at(next.at);
    final time = cheTwelveHour(chicago.local.hour, chicago.local.minute);
    final countdown = cheCountdown(now, next.at);
    return CheHudTile(
      semantics: 'Next: ${next.label == 'NY OPEN' ? 'New York opens' : 'New York closes'} at $time ${chicago.zone}. Double tap to open Trading.',
      onTap: onOpen,
      leanRight: false,
      height: height,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const _TileLabel(Icons.calendar_month_rounded, 'NEXT'),
        const SizedBox(height: 8),
        FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: CheChromeText(time, style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w700))),
        Text('${next.label} · $countdown', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheHud.label.copyWith(fontSize: 10, letterSpacing: 1, color: CheColors.textDim)),
      ]),
    );
  }
}
