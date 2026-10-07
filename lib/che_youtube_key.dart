// YouTube token row for the keys page.
// Saving here stores the token on the phone. It does not upload a video.

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

class CheYouTubeKey extends StatefulWidget {
  const CheYouTubeKey({super.key});

  @override
  State<CheYouTubeKey> createState() => _CheYouTubeKeyState();
}

class _CheYouTubeKeyState extends State<CheYouTubeKey> {
  final _controller = TextEditingController();
  var _saved = false;

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((prefs) {
      _controller.text = prefs.getString('che.youtube.token') ?? '';
      if (mounted) setState(() => _saved = _controller.text.isNotEmpty);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    final token = _controller.text.trim();
    if (token.isEmpty) {
      await prefs.remove('che.youtube.token');
    } else {
      await prefs.setString('che.youtube.token', token);
    }
    if (mounted) setState(() => _saved = token.isNotEmpty);
  }

  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: const Text('YouTube'),
      subtitle: Text(_saved ? 'Token saved on this phone' : 'Paste the token for Cognitive.Horizon.Engine'),
      trailing: IconButton(onPressed: _save, icon: const Icon(Icons.save_alt)),
      onTap: () async {
        await showDialog<void>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: const Text('YouTube token'),
            content: TextField(
              controller: _controller,
              obscureText: true,
              decoration: const InputDecoration(hintText: 'Paste token'),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
              FilledButton(
                onPressed: () async {
                  await _save();
                  if (dialogContext.mounted) Navigator.pop(dialogContext);
                },
                child: const Text('Save'),
              ),
            ],
          ),
        );
      },
    );
  }
}
