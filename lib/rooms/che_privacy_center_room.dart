// Privacy Center room (owner, 2026-10-25; docs/CHE_PRIVACY_CENTER.md). An opt-in screen on the iPhone, separate
// from GPU and compute features. Opening it is silent: the page shows its state as large text and says nothing
// until the owner presses Read Aloud or speaks. Every action reports its real result with a banner, a haptic and
// CHE's voice. Every control has a VoiceOver label and a spoken route (lib/security/che_privacy_center.dart
// cheParsePrivacyVoice). All logic and data live in ChePrivacyCenter, on the phone.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_screen_awareness.dart';
import '../security/che_privacy_center.dart';

/// Answers the room's voice routes while it is on screen (numbered actions, yes/no, add, read).
class ChePrivacyCenterVoice {
  ChePrivacyCenterVoice._();
  static Future<String?> Function(String)? handler;
}

class ChePrivacyCenterRoom extends StatefulWidget {
  const ChePrivacyCenterRoom({super.key, required this.center, this.onSpeak, this.onListen, this.initialAction = ''});
  final ChePrivacyCenter center;
  final ValueChanged<String>? onSpeak;
  final VoidCallback? onListen;

  /// What the owner asked when the room was opened for him (brokers, credit, passwords...); shown, never spoken.
  final String initialAction;

  /// True while the room is on screen.
  static bool get isOpen => _openCount > 0;
  static int _openCount = 0;

  @override
  State<ChePrivacyCenterRoom> createState() => _ChePrivacyCenterRoomState();
}

class _ChePrivacyCenterRoomState extends State<ChePrivacyCenterRoom> {
  StreamSubscription<void>? _changes;
  Object? _screen;
  String _banner = '';
  bool _busy = false;

  ChePrivacyCenter get _c => widget.center;

  @override
  void initState() {
    super.initState();
    ChePrivacyCenterRoom._openCount++;
    ChePrivacyCenterVoice.handler = _voice;
    _changes = _c.changes.stream.listen((_) {
      if (mounted) setState(() {});
    });
    if (widget.initialAction == 'brokers') _c.lastList = 'brokers';
    if (widget.initialAction == 'credit' || widget.initialAction == 'email') _c.lastList = 'links';
    // Loading is quiet: no speech, no forced announcement.
    if (!_c.loaded) unawaited(_c.load());
    _screen = CheScreenAwareness.register(context, () => CheScreenReport(
          page: 'Privacy Center',
          detail: _c.state.on
              ? 'On since ${_c.state.consentAt}. ${_c.inventory.length} services listed, ${cheDataBrokers.length} people-search sites, ${cheOfficialPrivacyLinks.length} official links'
              : 'Off: nothing is kept. ${cheOfficialPrivacyLinks.length} official links are shown',
          controls: [
            'Read Aloud',
            _c.state.on ? 'Turn off Privacy Center' : 'Turn on Privacy Center',
            if (_c.state.on) 'Check my passwords for breaches',
          ],
        ));
  }

  @override
  void dispose() {
    ChePrivacyCenterRoom._openCount--;
    if (ChePrivacyCenterVoice.handler == _voice) ChePrivacyCenterVoice.handler = null;
    CheScreenAwareness.unregister(_screen);
    unawaited(_changes?.cancel());
    super.dispose();
  }

  Future<String?> _voice(String words) async {
    final command = cheParsePrivacyVoice(words, inRoom: true, awaitingYes: _c.awaitingTurnOff);
    if (command == null) return null;
    final reply = await _c.handle(command);
    _show(reply, ok: !reply.startsWith('There is no') && !reply.contains('did not open'));
    return reply;
  }

  void _show(String text, {bool ok = true}) {
    if (!mounted) return;
    if (ok) {
      HapticFeedback.lightImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    setState(() => _banner = text);
  }

  /// A button press: run it, show the real result, and say it (the owner asked for this action).
  Future<void> _run(Future<String> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    HapticFeedback.selectionClick();
    final reply = await action();
    if (!mounted) return;
    setState(() => _busy = false);
    _show(reply);
    widget.onSpeak?.call(reply);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    final on = _c.state.on;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Privacy Center'),
        actions: [
          IconButton(tooltip: 'Talk to CHE about the Privacy Center', icon: const Icon(Icons.mic_rounded), onPressed: widget.onListen),
        ],
      ),
      body: !_c.loaded
          ? Center(child: Text('Loading the Privacy Center…', style: theme.titleMedium?.copyWith(color: Theme.of(context).hintColor)))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (_banner.isNotEmpty) _bannerView(context),
                Semantics(
                  container: true,
                  label: on ? 'Privacy Center is on since ${_c.state.consentAt}. Consent words: ${_c.state.consentWords}.' : 'Privacy Center is off. Nothing is kept until you turn it on.',
                  child: ExcludeSemantics(
                    child: Text(
                      on ? 'On since ${_c.state.consentAt}\nYour words: "${_c.state.consentWords}"' : 'Off. Nothing is kept until you say "turn on Privacy Center".',
                      style: theme.headlineSmall,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Text('CHE never keeps a Social Security number. Everything here stays on this iPhone.', style: theme.titleMedium),
                const SizedBox(height: 12),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  _button('Read Aloud', 'Read Aloud: everything on the Privacy Center screen', Icons.record_voice_over_rounded,
                      widget.onSpeak == null ? null : () => widget.onSpeak!(_c.speakAll())),
                  if (!on)
                    _button('Turn on', 'Turn on Privacy Center. Records your consent with the time on this iPhone', Icons.verified_user_outlined,
                        () => _run(() => _c.turnOn('Turn on Privacy Center (button)'))),
                  if (on && !_c.awaitingTurnOff)
                    _button('Turn off', 'Turn off Privacy Center. Asks before deleting its data', Icons.remove_circle_outline, () => _run(_c.requestTurnOff)),
                  if (_c.awaitingTurnOff) ...[
                    _button('Yes, delete', 'Yes: turn off Privacy Center and delete its data on this iPhone', Icons.delete_outline_rounded, () => _run(() => _c.confirmTurnOff(true))),
                    _button('No, keep', 'No: keep Privacy Center on and delete nothing', Icons.check_circle_outline, () => _run(() => _c.confirmTurnOff(false))),
                  ],
                ]),
                if (on) ...[
                  _heading('Your services'),
                  Text('Services you connected in CHE or added by voice. Names only.', style: theme.bodyLarge),
                  if (_c.inventory.isEmpty) Text('None yet. Say "add Chase to my privacy list".', style: theme.titleMedium),
                  for (final (i, s) in _c.inventory.indexed) _serviceTile(i, s),
                  _heading('Password breach check'),
                  Text('Checks the passwords in your on-device vault against Have I Been Pwned. Only the first five characters of each password\'s fingerprint leave this iPhone.',
                      style: theme.bodyLarge),
                  const SizedBox(height: 8),
                  _button(_c.checking ? 'Checking…' : 'Check my passwords', 'Check my passwords for breaches, on this iPhone', Icons.lock_outline_rounded,
                      _c.checking ? null : () => _run(_c.checkPasswords)),
                  if (_c.state.passwordCheckAt.isNotEmpty)
                    Semantics(
                      container: true,
                      label: 'Last check ${_c.state.passwordCheckAt}. ${cheSpeakPasswordFindings(_c.state.passwordFindings)}',
                      child: ExcludeSemantics(
                        child: Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text('Last check ${_c.state.passwordCheckAt}\n${cheSpeakPasswordFindings(_c.state.passwordFindings)}', style: theme.titleMedium),
                        ),
                      ),
                    ),
                  _heading('People-search sites'),
                  Text('Each site\'s own opt-out page. CHE opens it; you fill it in. Nothing is called removed until the site confirms.', style: theme.bodyLarge),
                  for (final (i, b) in cheDataBrokers.indexed) _brokerTile(i, b),
                ],
                _heading('Official links'),
                Text('Credit freezes are free by federal law and must be placed at each bureau. You enter your details on these sites yourself.', style: theme.bodyLarge),
                for (final (i, l) in cheOfficialPrivacyLinks.indexed) _linkTile(i, l),
                _heading('Not available at no cost'),
                Text('Automatic email breach lookups need Have I Been Pwned\'s paid API key, and no free service can find everywhere your SSN is held. Location tracking is not built.',
                    style: theme.bodyLarge),
                const SizedBox(height: 24),
              ],
            ),
    );
  }

  Widget _bannerView(BuildContext context) => Semantics(
        container: true,
        liveRegion: true,
        label: _banner,
        child: ExcludeSemantics(
          child: Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Theme.of(context).colorScheme.secondaryContainer, borderRadius: BorderRadius.circular(10)),
            child: Text(_banner, style: Theme.of(context).textTheme.titleMedium),
          ),
        ),
      );

  Widget _heading(String text) => Padding(
        padding: const EdgeInsets.only(top: 24, bottom: 4),
        child: Semantics(header: true, child: Text(text, style: Theme.of(context).textTheme.titleLarge)),
      );

  Widget _button(String text, String label, IconData icon, VoidCallback? onPressed) => Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: OutlinedButton.icon(icon: Icon(icon), label: Text(text, style: const TextStyle(fontSize: 18)), onPressed: _busy ? null : onPressed),
      );

  Widget _actions(String id, String name, {ChePrivacyLink? link}) => Wrap(spacing: 4, runSpacing: 4, children: [
        _button('Monitor', 'Monitor $name', Icons.person_search_outlined, () => _run(() => _c.act(id, name, 'monitor', link: link))),
        _button('Request removal', 'Request removal from $name${link == null ? '' : ': opens its official page'}', Icons.open_in_new_rounded,
            () => _run(() => _c.act(id, name, 'request_removal', link: link))),
        _button('Ignore', 'Ignore $name', Icons.block_rounded, () => _run(() => _c.act(id, name, 'ignore', link: link))),
        _button('Resolved', 'Mark $name resolved', Icons.check_circle_outline, () => _run(() => _c.act(id, name, 'resolved', link: link))),
      ]);

  String _status(String id) {
    final a = _c.state.latest(id);
    return a == null ? 'No action yet' : '${a.label} · ${a.at}';
  }

  Widget _serviceTile(int i, ChePrivacyService s) {
    final id = 'service:${s.name.toLowerCase()}';
    final spoken = '${i + 1}. ${s.name}. ${s.source}. ${_status(id)}.';
    return Card(
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(container: true, label: spoken, child: ExcludeSemantics(child: Text('${i + 1}. ${s.name}\n${s.source} · ${_status(id)}', style: Theme.of(context).textTheme.titleMedium))),
          _actions(id, s.name),
        ]),
      ),
    );
  }

  Widget _brokerTile(int i, ChePrivacyLink b) {
    final spoken = '${i + 1}. ${b.name}. ${b.purpose} ${b.verification}. ${_status(b.id)}.';
    return Card(
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(
            container: true,
            label: spoken,
            child: ExcludeSemantics(
              child: Text('${i + 1}. ${b.name}\n${b.purpose}\n${b.verified ? 'Official page' : 'Address not confirmed on the site'} · ${_status(b.id)}',
                  style: Theme.of(context).textTheme.titleMedium),
            ),
          ),
          _actions(b.id, b.name, link: b),
        ]),
      ),
    );
  }

  Widget _linkTile(int i, ChePrivacyLink l) => Semantics(
        button: true,
        label: 'Open ${l.name}: ${l.purpose}',
        excludeSemantics: true,
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.link_rounded),
          title: Text('${i + 1}. ${l.name}', style: Theme.of(context).textTheme.titleMedium),
          subtitle: Text(l.purpose, style: Theme.of(context).textTheme.bodyLarge),
          onTap: () => _run(() => _c.openLink(l)),
        ),
      );
}
