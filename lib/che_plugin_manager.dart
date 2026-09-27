import 'dart:convert';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

/// The catalog lives on CHE's server; the phone only displays approved entries.
class ChePluginManager extends StatefulWidget {
  const ChePluginManager({
    super.key,
    required this.baseUrl,
    required this.deviceToken,
  });

  final String baseUrl;
  final String deviceToken;

  static Future<void> open(BuildContext context, String baseUrl, String token) {
    return Navigator.of(context).push<void>(CupertinoPageRoute(
      builder: (_) => ChePluginManager(baseUrl: baseUrl, deviceToken: token),
    ));
  }

  @override
  State<ChePluginManager> createState() => _ChePluginManagerState();
}

class _ChePluginManagerState extends State<ChePluginManager> {
  List<Map<String, dynamic>> plugins = [];
  String? error;
  String? busyId;
  bool loading = true;

  Map<String, String> get headers => {
    'Authorization': 'Bearer ${widget.deviceToken}',
    'Content-Type': 'application/json',
  };

  @override
  void initState() {
    super.initState();
    refresh();
  }

  void updateFromResponse(http.Response response) {
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode != 200) {
      throw Exception(data['detail']?.toString() ?? 'CHE could not load plugins.');
    }
    plugins = (data['plugins'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  Future<void> refresh() async {
    try {
      final response = await http.get(
        Uri.parse('${widget.baseUrl}/api/plugins'), headers: headers,
      ).timeout(const Duration(seconds: 12));
      if (!mounted) return;
      setState(() {
        updateFromResponse(response);
        error = null;
        loading = false;
      });
    } catch (_) {
      if (mounted) setState(() { error = 'Could not load plugins. Check CHE’s connection and pairing.'; loading = false; });
    }
  }

  Future<void> toggle(String id, bool enabled) async {
    setState(() { busyId = id; error = null; });
    try {
      final response = await http.post(
        Uri.parse('${widget.baseUrl}/api/plugins/toggle'),
        headers: headers,
        body: jsonEncode({'id': id, 'enabled': enabled}),
      ).timeout(const Duration(seconds: 12));
      if (!mounted) return;
      setState(() { updateFromResponse(response); busyId = null; });
    } catch (e) {
      if (mounted) setState(() { error = e.toString().replaceFirst('Exception: ', ''); busyId = null; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('CHE Plugins')),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text('Connected skills appear here. Switch on the ones CHE may use in conversation.'),
            const SizedBox(height: 12),
            if (error != null) Text(error!, style: const TextStyle(color: Colors.orangeAccent)),
            if (loading) const Center(child: CircularProgressIndicator()),
            if (!loading && plugins.isEmpty)
              const ListTile(
                title: Text('No plugins connected yet'),
                subtitle: Text('Add a read-only service to CHE’s server catalog. It will appear here without reinstalling the app.'),
              ),
            for (final plugin in plugins)
              SwitchListTile(
                title: Text(plugin['name']?.toString() ?? plugin['id'].toString()),
                subtitle: Text('${plugin['description'] ?? ''}\n${plugin['ready'] == true ? 'Ready · Read only' : 'Needs server setup'}'),
                isThreeLine: true,
                value: plugin['enabled'] == true,
                onChanged: plugin['ready'] == true && busyId == null
                    ? (value) => toggle(plugin['id'].toString(), value)
                    : null,
              ),
          ],
        ),
      ),
    );
  }
}
