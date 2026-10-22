// CHE Knowledge Library screen: the owner's reference catalog and the indexed passages CHE can quote.
//
// Reads the Worker's /api/knowledge (status per category) and /api/knowledge/search (cited answers). Every answer
// shows its citations as text, and cataloged works are said to be unread. Voice: each button has a label, the answer
// is large text, and "Read aloud" is offered only when the host gives an onSpeak callback. Nothing is spoken on open.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';

class CheKnowledgeLibraryScreen extends StatefulWidget {
  const CheKnowledgeLibraryScreen({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.client,
    this.onSpeak,
  });

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  final void Function(String text)? onSpeak;

  @override
  State<CheKnowledgeLibraryScreen> createState() => _CheKnowledgeLibraryScreenState();
}

class _CategoryStatus {
  const _CategoryStatus(this.name, this.indexed, this.cataloged);
  final String name;
  final int indexed;
  final int cataloged;
}

class _CheKnowledgeLibraryScreenState extends State<CheKnowledgeLibraryScreen> {
  final _search = TextEditingController();
  late final http.Client _client = widget.client ?? http.Client();
  List<_CategoryStatus> _categories = const [];
  String _answer = '';
  bool _loading = true;
  bool _searching = false;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  @override
  void dispose() {
    _search.dispose();
    if (widget.client == null) _client.close();
    super.dispose();
  }

  Future<void> _loadStatus() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final res = await _client
          .get(Uri.parse('${widget.baseUrl()}/api/knowledge'), headers: widget.headers())
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) throw Exception('The library answered ${res.statusCode}.');
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final rows = (body['categories'] as List? ?? const []).whereType<Map>().map((c) => _CategoryStatus(
            '${c['name'] ?? ''}',
            (c['indexed'] as num?)?.toInt() ?? 0,
            (c['cataloged'] as num?)?.toInt() ?? 0,
          ));
      if (!mounted) return;
      setState(() {
        _categories = rows.toList();
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'I could not load the knowledge library. $error';
      });
    }
  }

  Future<void> _runSearch() async {
    final question = _search.text.trim();
    if (question.isEmpty) return;
    setState(() {
      _searching = true;
      _answer = '';
    });
    try {
      final uri = Uri.parse('${widget.baseUrl()}/api/knowledge/search').replace(queryParameters: {'q': question});
      final res = await _client.get(uri, headers: widget.headers()).timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) throw Exception('The search answered ${res.statusCode}.');
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final text = '${body['text'] ?? ''}'.trim();
      if (!mounted) return;
      setState(() {
        _searching = false;
        _answer = text.isEmpty ? 'Nothing in the knowledge library answers that.' : text;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _searching = false;
        _answer = 'The search failed. $error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final indexed = _categories.fold<int>(0, (n, c) => n + c.indexed);
    final cataloged = _categories.fold<int>(0, (n, c) => n + c.cataloged);
    final hud = cheHudActive;
    // HUD glass: small mono ice section labels; the earlier theme headings otherwise.
    final section = hud ? CheHud.label.copyWith(fontSize: 12) : Theme.of(context).textTheme.titleMedium;
    return Scaffold(
      backgroundColor: hud ? CheColors.screen : null,
      appBar: AppBar(
        backgroundColor: hud ? Colors.transparent : null,
        title: hud ? CheChromeText('Knowledge Library', style: CheType.headline) : const Text('Knowledge Library'),
        actions: [
          IconButton(
            tooltip: 'Refresh the library status',
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _loadStatus,
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          if (_error.isNotEmpty)
            Semantics(
              liveRegion: true,
              label: _error,
              child: Text(_error, style: Theme.of(context).textTheme.bodyLarge),
            ),
          Semantics(
            header: true,
            child: Text('Status', style: section),
          ),
          const SizedBox(height: 4),
          if (_loading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('Loading the library.'),
            )
          else
            Text(
              '$indexed indexed reference${indexed == 1 ? '' : 's'} with text I can quote, $cataloged catalogued only.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          const SizedBox(height: 8),
          for (final c in _categories)
            Semantics(
              container: true,
              label: '${c.name}: ${c.indexed} indexed, ${c.cataloged} catalogued only',
              child: ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text(c.name),
                trailing: Text('${c.indexed} / ${c.cataloged}'),
              ),
            ),
          const Divider(height: 32),
          Semantics(
            header: true,
            child: Text('Ask the library', style: section),
          ),
          const SizedBox(height: 8),
          Semantics(
            textField: true,
            label: 'Search the knowledge library',
            child: TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _runSearch(),
              decoration: const InputDecoration(
                labelText: 'Question or topic',
                border: OutlineInputBorder(),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Semantics(
                button: true,
                label: 'Search the knowledge library',
                child: FilledButton(
                  onPressed: _searching ? null : _runSearch,
                  child: const Text('Search'),
                ),
              ),
              if (widget.onSpeak != null && _answer.isNotEmpty) ...[
                const SizedBox(width: 12),
                Semantics(
                  button: true,
                  label: 'Read the answer aloud',
                  child: OutlinedButton(
                    onPressed: () => widget.onSpeak!(_answer),
                    child: const Text('Read aloud'),
                  ),
                ),
              ],
            ],
          ),
          if (_searching) const Padding(padding: EdgeInsets.only(top: 12), child: Text('Searching.')),
          if (_answer.isNotEmpty) ...[
            const SizedBox(height: 16),
            Semantics(
              liveRegion: true,
              label: 'Answer from the knowledge library: $_answer',
              child: SelectableText(_answer, style: Theme.of(context).textTheme.bodyLarge),
            ),
          ],
        ],
      ),
    );
  }
}
