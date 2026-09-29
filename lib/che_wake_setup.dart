// Phone-only setup for CHE's "Chay" wake word (Picovoice Porcupine). Everything
// happens on the iPhone: the owner gets a free AccessKey and a "Chay" keyword
// file from console.picovoice.ai in Safari, then saves both here. They are
// stored only in this iPhone's Keychain.

import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_wake_word.dart';

const String cheWakeSetupSteps =
    'To set up the Chay wake word on this iPhone: '
    'One. In Safari, open console dot picovoice dot ai and sign up for free. '
    'Two. Copy your AccessKey from the home page. '
    'Three. Open Porcupine, type the wake word Chay, choose iOS, then train and download it. It saves a file ending in dot p p n to Files. '
    'Four. Come back here, paste the AccessKey, and choose that file.';

/// Opens the wake-word setup sheet. Returns true when a new setup was saved.
Future<bool> showCheWakeSetup(BuildContext context, {Future<void> Function(String text)? speak}) async {
  final saved = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _CheWakeSetupSheet(speak: speak),
  );
  return saved == true;
}

class _CheWakeSetupSheet extends StatefulWidget {
  const _CheWakeSetupSheet({this.speak});
  final Future<void> Function(String text)? speak;
  @override
  State<_CheWakeSetupSheet> createState() => _CheWakeSetupSheetState();
}

class _CheWakeSetupSheetState extends State<_CheWakeSetupSheet> {
  final TextEditingController _key = TextEditingController();
  String? _keywordBase64;
  String? _keywordName;
  String _status = '';
  bool _hasSaved = false;

  @override
  void initState() {
    super.initState();
    CheWakeWordEngine.hasLocalConfig().then((v) {
      if (mounted) setState(() => _hasSaved = v);
    });
  }

  @override
  void dispose() {
    _key.dispose();
    super.dispose();
  }

  void _say(String text) {
    setState(() => _status = text);
    widget.speak?.call(text);
  }

  Future<void> _pasteKey() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text?.trim() ?? '';
    if (text.isEmpty) {
      _say('The clipboard is empty. Copy your Picovoice AccessKey first.');
      return;
    }
    _key.text = text;
    _say('AccessKey pasted.');
  }

  Future<void> _chooseFile() async {
    final result = await FilePicker.platform.pickFiles(withData: true);
    final file = result?.files.single;
    if (file == null) return;
    final bytes = file.bytes;
    if (bytes == null || bytes.isEmpty || !file.name.toLowerCase().endsWith('.ppn')) {
      _say('That is not a wake word file. Choose the file ending in .ppn that Picovoice downloaded.');
      return;
    }
    setState(() {
      _keywordBase64 = base64Encode(bytes);
      _keywordName = file.name;
    });
    _say('Wake word file ${file.name} chosen.');
  }

  Future<void> _save() async {
    final key = _key.text.trim();
    if (key.length < 20 || _keywordBase64 == null) {
      _say(key.length < 20 ? 'Paste your Picovoice AccessKey first.' : 'Choose the Chay wake word file first.');
      return;
    }
    await CheWakeWordEngine.saveLocalConfig(accessKey: key, keywordPpnBase64: _keywordBase64!);
    HapticFeedback.mediumImpact();
    _say('Saved. Say Chay any time CHE is asleep in the app.');
    if (mounted) Navigator.of(context).pop(true);
  }

  Future<void> _remove() async {
    await CheWakeWordEngine.clearLocalConfig();
    setState(() => _hasSaved = false);
    _say('Removed the wake word setup from this iPhone. CHE uses her built-in listener instead.');
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text('Wake word “Chay”', style: Theme.of(context).textTheme.titleLarge),
              ),
            ),
            IconButton(
              tooltip: 'Read the setup steps aloud',
              onPressed: () => _say(cheWakeSetupSteps),
              icon: const Icon(Icons.volume_up_rounded),
            ),
          ]),
          const SizedBox(height: 8),
          Text(
            _hasSaved
                ? 'A wake word is saved on this iPhone. Save again to replace it.'
                : '1. In Safari, open console.picovoice.ai and sign up (free).\n'
                    '2. Copy your AccessKey.\n'
                    '3. In Porcupine, type “Chay”, pick iOS, train and download the .ppn file.\n'
                    '4. Paste the key and choose the file below.',
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _key,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              labelText: 'Picovoice AccessKey',
              suffixIcon: IconButton(
                tooltip: 'Paste AccessKey',
                onPressed: _pasteKey,
                icon: const Icon(Icons.content_paste_rounded),
              ),
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _chooseFile,
            icon: const Icon(Icons.upload_file_rounded),
            label: Text(_keywordName ?? 'Choose the Chay .ppn file', maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          const SizedBox(height: 12),
          FilledButton(onPressed: _save, child: const Text('Save wake word')),
          if (_hasSaved)
            TextButton(onPressed: _remove, child: const Text('Remove saved wake word')),
          if (_status.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Semantics(liveRegion: true, child: Text(_status)),
            ),
        ]),
      ),
    );
  }
}
