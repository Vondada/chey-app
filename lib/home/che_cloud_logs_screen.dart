// Cloud copies of CHE's conversation logs, stored on the owner's CHE Worker
// so they can be read from any paired device.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../che_ui/che_theme.dart';

class CheCloudLogsScreen extends StatefulWidget {
  const CheCloudLogsScreen({super.key, required this.baseUrl, required this.headers, this.client});
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;
  @override
  State<CheCloudLogsScreen> createState() => _CheCloudLogsScreenState();
}

class _CheCloudLogsScreenState extends State<CheCloudLogsScreen> {
  late final http.Client _http = widget.client ?? http.Client();
  List<Map<String, dynamic>> _logs = const [];
  String? _error;
  bool _loading = true;
  String _q = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<Map<String, dynamic>> _get(String path) async {
    final r = await _http
        .get(Uri.parse('${widget.baseUrl()}$path'), headers: widget.headers())
        .timeout(const Duration(seconds: 20));
    final body = jsonDecode(r.body);
    if (r.statusCode != 200) {
      throw Exception(body is Map ? '${body['detail'] ?? 'Error ${r.statusCode}'}' : 'Error ${r.statusCode}');
    }
    return body as Map<String, dynamic>;
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final j = await _get('/api/logs');
      _logs = [for (final l in (j['logs'] as List? ?? const [])) if (l is Map<String, dynamic>) l];
      _error = null;
    } catch (e) {
      _error = '$e';
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _open(Map<String, dynamic> log) async {
    try {
      final j = await _get('/api/logs/${Uri.encodeComponent('${log['id']}')}');
      final turns = [for (final t in (j['turns'] as List? ?? const [])) if (t is Map) t];
      final text = turns
          .map((t) => '[${t['at'] ?? ''}] ${t['source'] == 'voice' ? '🎙 ' : ''}You: ${t['user'] ?? ''}\nCHE: ${t['che'] ?? ''}')
          .join('\n\n');
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => Theme(
          data: CheTheme.dark(),
          child: Scaffold(
            appBar: AppBar(
              title: Text('${j['title'] ?? 'Conversation'}', maxLines: 1, overflow: TextOverflow.ellipsis),
              actions: [
                IconButton(
                  tooltip: 'Copy all',
                  onPressed: () => Clipboard.setData(ClipboardData(text: text)),
                  icon: const Icon(Icons.copy_all_rounded),
                ),
              ],
            ),
            body: SafeArea(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(CheSpace.gutter),
                child: SelectableText(text.isEmpty ? 'Empty conversation.' : text, style: CheType.body),
              ),
            ),
          ),
        ),
      ));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _q.toLowerCase();
    final shown = q.isEmpty
        ? _logs
        : _logs.where((l) => '${l['title']} ${l['preview']}'.toLowerCase().contains(q)).toList();
    return Theme(
      data: CheTheme.dark(),
      child: Scaffold(
        backgroundColor: CheColors.bg,
        appBar: AppBar(title: const Text('Cloud conversation logs')),
        body: SafeArea(
          child: RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              padding: const EdgeInsets.all(CheSpace.gutter),
              children: [
                TextField(
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded), hintText: 'Search logs'),
                  onChanged: (v) => setState(() => _q = v),
                ),
                const SizedBox(height: CheSpace.md),
                if (_loading) const Center(child: CircularProgressIndicator()),
                if (_error != null) Text(_error!, style: CheType.bodyDim),
                if (!_loading && _error == null && shown.isEmpty) Text('No cloud logs yet.', style: CheType.bodyDim),
                for (final l in shown)
                  Card(
                    color: CheColors.surfaceHi,
                    child: ListTile(
                      onTap: () => _open(l),
                      title: Text('${l['title'] ?? 'Conversation'}', maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text('${l['turns'] ?? 0} turns • ${l['updated_at'] ?? ''}\n${l['preview'] ?? ''}',
                          maxLines: 3, overflow: TextOverflow.ellipsis, style: CheType.caption),
                      isThreeLine: true,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
