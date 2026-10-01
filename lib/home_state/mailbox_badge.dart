part of '../main.dart';

// Mailbox badge (iOS-style unread count) and the keyboard on/off switch.
extension _CheMailboxBadge on _CHEHomeState {
  /// Checks CHE's server for unread mailbox messages and letters. When the
  /// count goes up, CHE taps the phone and shows a banner, like iOS Mail.
  Future<void> _refreshMailboxBadge({bool announce = true}) async {
    if (_deviceToken == null) return;
    try {
      final response = await http
          .get(Uri.parse('$cheAgentBaseUrl/api/mailbox/badge'), headers: _authHeaders)
          .timeout(const Duration(seconds: 12));
      if (response.statusCode != 200 || !mounted) return;
      final data = jsonDecode(response.body);
      if (data is! Map) return;
      final count = (data['unread'] as num?)?.toInt() ?? 0;
      final previous = _mailboxUnread;
      if (count == previous) return;
      _updateHomeState(() => _mailboxUnread = count);
      if (!announce || count <= previous) return;
      final fresh = count - previous;
      HapticFeedback.mediumImpact();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          content: Text(fresh == 1 ? 'New message in your Mailbox' : '$fresh new messages in your Mailbox'),
          action: SnackBarAction(label: 'Open', onPressed: () => _openMailbox()),
        ),
      );
    } catch (_) {}
  }

  Future<void> _openMailbox({int tab = 0}) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CheMailboxScreen(
        baseUrl: cheAgentBaseUrl,
        headers: () => _authHeaders,
        onSpeak: (text) => unawaited(speakText(text, record: false)),
        initialTab: tab,
      ),
    ));
    await _refreshMailboxBadge(announce: false);
  }

  Future<void> _loadTypingPref() async {
    final prefs = await SharedPreferences.getInstance();
    final on = prefs.getBool('che_typing_on') ?? false;
    if (mounted && on != _typingOn) _updateHomeState(() => _typingOn = on);
  }

  /// Keyboard off: CHE is voice-first, so the text box stays hidden until the
  /// owner asks for it. The choice is remembered.
  void _toggleTyping() {
    final on = !_typingOn;
    HapticFeedback.selectionClick();
    _updateHomeState(() => _typingOn = on);
    if (on) {
      Future<void>.delayed(const Duration(milliseconds: 60), () {
        if (mounted) _composerFocus.requestFocus();
      });
    } else {
      _composerFocus.unfocus();
    }
    unawaited(SharedPreferences.getInstance().then((p) => p.setBool('che_typing_on', on)));
  }
}
