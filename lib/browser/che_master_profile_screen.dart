// The owner's master profile editor: Personal and CHE Office profiles, each
// field with its own Approve switch. Only approved fields are ever used to
// fill forms. Values stay in this iPhone's Keychain (che_master_profile.dart).
// Voice route: "set my business phone to ...", "open my master profile".

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_master_profile.dart';

class CheMasterProfileScreen extends StatefulWidget {
  const CheMasterProfileScreen({super.key, this.store});
  final CheMasterProfileStore? store;

  @override
  State<CheMasterProfileScreen> createState() => _CheMasterProfileScreenState();
}

class _CheMasterProfileScreenState extends State<CheMasterProfileScreen> {
  CheMasterProfileStore get _store => widget.store ?? CheMasterProfileStore.instance;
  CheProfileKind _kind = CheProfileKind.personal;
  CheProfiles? _profiles;
  final Map<String, TextEditingController> _text = {};
  String _banner = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in _text.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final p = await _store.load();
    if (!mounted) return;
    setState(() {
      _profiles = p;
      for (final key in cheProfileFieldLabels.keys) {
        (_text['${_kind.name}:$key'] ??= TextEditingController()).text = p.of(_kind)[key]?.value ?? '';
      }
    });
  }

  List<String> get _keys => [
        for (final k in cheProfileFieldLabels.keys)
          if (_kind == CheProfileKind.office || !cheOfficeOnlyFields.contains(k)) k,
      ];

  Future<void> _saveField(String key, {required bool approve}) async {
    final label = cheProfileFieldLabels[key]!;
    final raw = _text['${_kind.name}:$key']?.text ?? '';
    if (raw.trim().isEmpty) {
      _say('$label is empty, so there is nothing to approve.');
      return;
    }
    final errors = <String>[];
    final value = cheNormalizeProfileValue(key, raw, error: errors);
    if (value == null) {
      _say(errors.isEmpty ? 'I couldn\'t save $label.' : errors.first);
      return;
    }
    await _store.setField(_kind, key, value, approved: approve);
    HapticFeedback.mediumImpact();
    _say(approve ? '$label approved for your ${_kind.spoken} profile.' : '$label saved, not approved yet; CHE won\'t use it until you approve it.');
    await _load();
  }

  Future<void> _toggle(String key, bool approved) async {
    final label = cheProfileFieldLabels[key]!;
    if (_profiles?.of(_kind)[key] == null) {
      await _saveField(key, approve: approved);
      return;
    }
    await _store.approve(_kind, key, approved);
    HapticFeedback.selectionClick();
    _say(approved ? '$label approved.' : '$label no longer approved; CHE won\'t use it.');
    await _load();
  }

  void _say(String text) {
    // The banner is a live region, so VoiceOver reads the result of his own action once.
    setState(() => _banner = text);
  }

  @override
  Widget build(BuildContext context) {
    final p = _profiles;
    return Scaffold(
      appBar: AppBar(title: const Text('Master profile')),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Semantics(
                container: true,
                label: 'Choose profile',
                child: SegmentedButton<CheProfileKind>(
                  segments: const [
                    ButtonSegment(value: CheProfileKind.personal, label: Text('Personal')),
                    ButtonSegment(value: CheProfileKind.office, label: Text('CHE Office')),
                  ],
                  selected: {_kind},
                  onSelectionChanged: (s) {
                    setState(() => _kind = s.first);
                    _load();
                  },
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Text(
                'Only approved fields are used when you say "use my master profile". Everything stays on this iPhone; '
                'nothing here is sent to CHE\'s server or any AI. You can also say "set my business phone to" and the number.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
            if (_banner.isNotEmpty)
              Semantics(
                liveRegion: true,
                child: Container(
                  width: double.infinity,
                  margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: Theme.of(context).colorScheme.secondaryContainer, borderRadius: BorderRadius.circular(12)),
                  child: Text(_banner, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
                ),
              ),
            Expanded(
              child: p == null
                  ? const Center(child: CircularProgressIndicator())
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                      children: [for (final key in _keys) _row(p, key)],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(CheProfiles p, String key) {
    final label = cheProfileFieldLabels[key]!;
    final stored = p.of(_kind)[key];
    final approved = stored?.approved ?? false;
    final controller = _text['${_kind.name}:$key'] ??= TextEditingController(text: stored?.value ?? '');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Semantics(
              textField: true,
              label: '${_kind.spoken} $label',
              hint: key == 'bday' ? 'For example May 14 1990' : null,
              child: TextField(
                key: ValueKey('profile-${_kind.name}-$key'),
                controller: controller,
                keyboardType: switch (key) {
                  'email' => TextInputType.emailAddress,
                  'tel' => TextInputType.phone,
                  'url' => TextInputType.url,
                  _ => TextInputType.text,
                },
                decoration: InputDecoration(labelText: label, border: const OutlineInputBorder()),
                onSubmitted: (_) => _saveField(key, approve: approved),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Semantics(
            label: approved ? 'Approved: $label. Double tap to stop CHE using it.' : 'Approve $label for CHE to use',
            toggled: approved,
            button: true,
            excludeSemantics: true,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Switch(
                  key: ValueKey('approve-${_kind.name}-$key'),
                  value: approved,
                  onChanged: (v) => _toggle(key, v),
                ),
                Text(approved ? 'Approved' : 'Approve', style: const TextStyle(fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
