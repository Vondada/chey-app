// The FundYourEdge trade draft (owner, 2026-10-22): a read-only preview that CHE prepares and the owner copies into a
// trading platform by hand. It has no send control anywhere. The banner says NOT SUBMITTED, and every value the
// Worker could not verify reads "unknown". Data comes from GET /api/trading/fye/draft (owner-only).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

/// The draft card. `baseUrl` and `headers` are read at load time, so a changed sign-in is picked up.
class CheFyeDraftCard extends StatefulWidget {
  const CheFyeDraftCard({super.key, required this.baseUrl, required this.headers, this.client});

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;

  @override
  State<CheFyeDraftCard> createState() => _CheFyeDraftCardState();
}

class _CheFyeDraftCardState extends State<CheFyeDraftCard> {
  late final http.Client _http = widget.client ?? http.Client();
  Map<String, dynamic>? _draft;
  bool _loading = true;
  String _error = '';
  String _copyStatus = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    if (widget.client == null) _http.close();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await _http.get(Uri.parse('${widget.baseUrl()}/api/trading/fye/draft'), headers: widget.headers());
      // Decoded as UTF-8 whatever the response headers say: the status line uses an em dash.
      final body = jsonDecode(utf8.decode(res.bodyBytes));
      if (res.statusCode != 200 || body is! Map) throw StateError('HTTP ${res.statusCode}');
      if (!mounted) return;
      setState(() {
        _draft = body['draft'] is Map ? Map<String, dynamic>.from(body['draft']) : null;
        _error = '';
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'I could not load the FundYourEdge draft. Check the connection and try again.';
        _loading = false;
      });
    }
  }

  Future<void> _copy(String text) async {
    try {
      await Clipboard.setData(ClipboardData(text: text));
      if (mounted) setState(() => _copyStatus = 'Copied. Nothing was sent to any broker.');
    } catch (_) {
      if (mounted) setState(() => _copyStatus = 'Copy did not work. Select the text in the draft to copy it by hand.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (_loading) return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
    if (_error.isNotEmpty) return Padding(padding: const EdgeInsets.all(12), child: Text(_error));
    final draft = _draft;
    if (draft == null) {
      return const Padding(
        padding: EdgeInsets.all(12),
        child: Text(
          'No FundYourEdge draft yet. Ask CHE to prepare one, for example: "Prepare a FundYourEdge MNQ long 1, entry 21450, stop 21420, target 21510."',
        ),
      );
    }
    final rows = [for (final r in draft['rows'] as List? ?? const []) if (r is Map) Map<String, dynamic>.from(r)];
    final warnings = [for (final w in draft['warnings'] as List? ?? const []) '$w'];
    final assumptions = [for (final a in draft['assumptions'] as List? ?? const []) '$a'];
    final copyText = '${draft['copy_text'] ?? ''}';
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // The status is written in words and set in a bordered banner, never by colour alone.
          Semantics(
            container: true,
            label: 'Draft status: ${draft['status']}',
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(border: Border.all(color: theme.colorScheme.error, width: 2), borderRadius: BorderRadius.circular(10)),
              child: Text('${draft['status']}', style: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 0.6)),
            ),
          ),
          const SizedBox(height: 10),
          Text('FundYourEdge trade draft: a read-only preview. Copy the details into your trading platform by hand. Nothing here is sent or placed.', style: theme.textTheme.bodySmall),
          const SizedBox(height: 10),
          for (final r in rows)
            Semantics(
              label: '${r['label']}: ${r['value']}${r['note'] == null || '${r['note']}'.isEmpty ? '' : '. ${r['note']}'}',
              child: Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${r['label']}: ${r['value']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                    if (r['note'] != null && '${r['note']}'.isNotEmpty) Text('${r['note']}', style: theme.textTheme.bodySmall),
                  ],
                ),
              ),
            ),
          for (final w in warnings)
            Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('Warning: $w', style: const TextStyle(fontWeight: FontWeight.w700))),
          const SizedBox(height: 6),
          Text('Assumptions', style: theme.textTheme.titleSmall),
          for (final a in assumptions) Text('• $a', style: theme.textTheme.bodySmall),
          const SizedBox(height: 12),
          // The only action: copying text. There is no control that sends an order.
          Semantics(
            button: true,
            label: 'Copy Order Details. Copies the draft text. Nothing is sent.',
            excludeSemantics: true,
            child: SizedBox(
              width: double.infinity,
              height: 48,
              child: OutlinedButton(
                onPressed: copyText.isEmpty ? null : () => _copy(copyText),
                child: const Text('Copy Order Details'),
              ),
            ),
          ),
          if (_copyStatus.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Semantics(liveRegion: true, child: Text(_copyStatus)),
            ),
        ],
      ),
    );
  }
}
