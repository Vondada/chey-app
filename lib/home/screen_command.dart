// Spoken or typed screen edits. The phone applies these before any model
// reply, so CHE never asks and never claims a change that did not happen.

import '../che_wake_match.dart';
import '../commands/che_command_voice.dart';

enum ScreenOp {
  clearChips,
  showChips,
  addChip,
  removeChip,
  clearChat,
  removeLast,
  hideGreeting,
  showGreeting,
  openCommands,
  searchCommands,
  openConnections,
  changeVoice,
  naturalVoice,
  openAtlas,
}

class ScreenCommand {
  const ScreenCommand(this.op, [this.text = '', this.list]);
  final ScreenOp op;
  final String text;

  /// For [ScreenOp.searchCommands]: the whole request (topic, number,
  /// readiness question), which the Commands page answers.
  final CheCommandListRequest? list;
}

final _polite = RegExp(r'^(?:please\s+|can you\s+|could you\s+|i want you to\s+)', caseSensitive: false);

// Which Connections row a spoken "connect ..." means.
String _connectTarget(String spoken) {
  if (spoken.startsWith('youtube') || spoken == 'google account') return 'youtube';
  if (spoken == 'ninjatrader' || spoken == 'tradovate') return 'broker';
  if (spoken == 'gmail') return 'gmail';
  if (spoken.contains('drive')) return 'drive';
  if (spoken.contains('calendar')) return 'calendar';
  return 'google_ads';
}

ScreenCommand? parseScreenCommand(String raw) {
  var t = raw.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
  // CHE's name however speech spells it: "CHE,", "Chay", "Hey CHE", "Che.".
  t = (cheWakeRemainder(t) ?? t).replaceFirst(_polite, '').trim();
  if (t.isEmpty) return null;

  // On-device navigation only. A spoken connect opens Connections and starts
  // that one official sign-in; the provider still asks the owner on its page.
  final connect = RegExp(r'^connect\s+(?:my\s+|the\s+)?(youtube(?: channel)?|google account|ninjatrader|tradovate|gmail|(?:google\s+)?drive|(?:google\s+)?calendar|google ads)$').firstMatch(t);
  if (connect != null) {
    return ScreenCommand(ScreenOp.openConnections, _connectTarget(connect.group(1)!));
  }
  if (RegExp(
    r'^(?:(?:open|show(?: me)?|go to|take me to|bring up)\s+(?:my\s+|the\s+)?(?:connections?|connected accounts|integrations?|connection center)|connect\s+(?:my\s+)?bank(?: account)?)$',
  ).hasMatch(t)) {
    return const ScreenCommand(ScreenOp.openConnections);
  }
  // Natural cloud voices: the picker lists verified voices and takes spoken choices.
  if (RegExp(r'^(?:change|switch|choose|pick|preview)\s+(?:your\s+|che\s+|my\s+)?voice$').hasMatch(t)) {
    return const ScreenCommand(ScreenOp.naturalVoice);
  }
  if (RegExp(r'^(?:open|show(?: me)?|go to)\s+(?:the\s+|my\s+)?(?:voice settings|voice selector|change voice)$').hasMatch(t)) {
    return const ScreenCommand(ScreenOp.changeVoice);
  }
  if (RegExp(
    r'^(?:show(?: me)?|check)\s+(?:my\s+)?bank\s+(?:transactions?|balance|accounts?)$',
  ).hasMatch(t)) {
    return const ScreenCommand(ScreenOp.openConnections);
  }

  // The Knowledge Atlas page (issue #346). "Atlas" alone is the Office agent, so the page is
  // always named in full.
  if (RegExp(r"^(?:open|show(?: me)?|go to|take me to|bring up)\s+(?:the\s+|my\s+|your\s+|che's\s+)?knowledge atlas(?:\s+(?:page|screen|cards))?$").hasMatch(t)) {
    return const ScreenCommand(ScreenOp.openAtlas);
  }

  // "open commands", "show me the command center", "command library".
  if (RegExp(r"^(?:open|show|show me|go to|take me to|bring up)\s+(?:the\s+|my\s+|your\s+|che's\s+)?(?:commands?|command center|command library|slash commands)(?:\s+(?:page|screen|list))?$").hasMatch(t) ||
      RegExp(r'^(?:commands?|command center|command library)$').hasMatch(t)) {
    return const ScreenCommand(ScreenOp.openCommands);
  }

  // A request for the complete list is navigation, not a literal search for
  // the word "all" (which can otherwise yield an empty filtered library).
  if (RegExp(
    r'^(?:list|show(?: me)?|find|search(?: for)?)\s+(?:me\s+)?(?:all|every|the full list of|the complete list of|full list of)\s+(?:the\s+)?(?:commands?|command library|slash commands)$',
  ).hasMatch(t)) {
    return const ScreenCommand(ScreenOp.openCommands);
  }

  // CHE's own commands, asked for in natural speech: "show me five YouTube
  // commands and tell me which are ready", "open your Commands page and
  // show me commands to publish faceless videos". The Commands page lists
  // them from the catalog; no model is asked and nothing is run. "Search
  // YouTube for jazz" and "five Linux commands" are not CHE's commands.
  final list = cheCommandListRequest(raw);
  if (list != null) return ScreenCommand(ScreenOp.searchCommands, list.topic, list);

  // A prompt about editing code is not a phone-screen action. Only a short,
  // direct edit request may change the displayed conversation or controls.
  // Navigation and command-library requests were handled above.
  if (t.contains('\n') || t.length > 180) return null;
  if (!RegExp(
    r'^(?:(?:start off (?:with|wit) )?(?:clear(?:ing)?|remove|delete|hide|get rid of|take off|wipe|erase|add|put|place|insert|show|bring back|put back|restore)\b)',
  ).hasMatch(t)) {
    return null;
  }

  final add = RegExp(r'\b(add|put|place|insert)\b').hasMatch(t);
  final remove = RegExp(r'\b(clear|remove|delete|hide|get rid of|take off|clearing|wipe|erase)\b').hasMatch(t);
  final show = RegExp(r'\b(show|bring back|put back|restore)\b').hasMatch(t);
  final chips = RegExp(r'\b(bubble|bubbles|chip|chips|suggestion|suggestions)\b').hasMatch(t);
  final greeting = RegExp(r'\b(greeting|hello line|status line)\b').hasMatch(t);
  final last = RegExp(r'\b(last|previous)\b').hasMatch(t) && RegExp(r'\b(message|bubble|reply)\b').hasMatch(t);

  if (chips && remove && !add) {
    final quoted = RegExp(r'["\u201c](.+?)["\u201d]').firstMatch(raw);
    final named = RegExp(r'\b(?:called|named|saying|that says)\s+(.+)$', caseSensitive: false).firstMatch(t);
    final label = (quoted?.group(1) ?? named?.group(1) ?? '').trim();
    if (label.isNotEmpty && !RegExp(r'\b(those|these|three|all|the)\b').hasMatch(label)) {
      return ScreenCommand(ScreenOp.removeChip, label);
    }
    return const ScreenCommand(ScreenOp.clearChips);
  }
  if (chips && add) {
    final quoted = RegExp(r'["\u201c](.+?)["\u201d]').firstMatch(raw);
    final named = RegExp(r'\b(?:saying|that says|called|labeled)\s+(.+)$', caseSensitive: false).firstMatch(raw.trim());
    final label = (quoted?.group(1) ?? named?.group(1) ?? '').trim();
    if (label.isEmpty) return null;
    return ScreenCommand(ScreenOp.addChip, label);
  }
  if (chips && show) return const ScreenCommand(ScreenOp.showChips);
  if (greeting && remove) return const ScreenCommand(ScreenOp.hideGreeting);
  if (greeting && show) return const ScreenCommand(ScreenOp.showGreeting);
  // Destructive local edits must match the *entire* owner instruction.
  // Shared words in a programming request (e.g. "remove" and "chat")
  // must never clear CHE's visible conversation.
  if (last && RegExp(
    r'^(?:remove|delete|erase)\s+(?:(?:the|my)\s+)?(?:last|previous)\s+(?:message|bubble|reply)$',
  ).hasMatch(t)) {
    return const ScreenCommand(ScreenOp.removeLast);
  }
  if (RegExp(
    r'^(?:clear|remove|delete|wipe|erase)\s+(?:(?:all|the|my|entire)\s+){0,2}(?:chat(?:\s+(?:history|messages))?|messages|screen\s+text|the\s+text|everything\s+on\s+(?:the\s+)?screen)$',
  ).hasMatch(t)) {
    return const ScreenCommand(ScreenOp.clearChat);
  }
  return null;
}
