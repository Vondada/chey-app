// Spoken or typed Office navigation (owner UI cleanup, 2026-10-25), parsed on the phone before any model reply:
//   "take me to the trading desk", "open the creative studio"   → that Office zone
//   "open Atlas's desk", "show Atlas", "show me Nova's card"      → that agent's desk
//   "message Atlas in the War Room"                              → a War Room message to Atlas
//   "assign a task to Atlas", "give Atlas a task"                 → the Assign box on Atlas's desk
// "What is Atlas working on?" is not here on purpose: the Worker answers it from the real board (office_phrases.js
// agentStatus), and the Brain answers it from its live agent orbs. Nothing here opens another app or acts by itself:
// it only opens Office screens, and an assignment is still sent by the owner from the box it opens.

import '../che_wake_match.dart';
import 'che_office_status.dart';

enum CheOfficeVoiceAction { open, message, assign }

class CheOfficeVoiceRequest {
  const CheOfficeVoiceRequest({this.zone, this.agentName, this.action = CheOfficeVoiceAction.open});
  final CheOfficeZone? zone;

  /// Capitalised agent name ("Atlas"), or null for a zone.
  final String? agentName;
  final CheOfficeVoiceAction action;

  /// What CHE says when the screen opens (the command was spoken, so CHE answers).
  String get reply {
    if (agentName != null) {
      return switch (action) {
        CheOfficeVoiceAction.message => 'Opening the War Room message to $agentName.',
        CheOfficeVoiceAction.assign => 'Opening $agentName\'s desk. Say or type the task, then send it.',
        CheOfficeVoiceAction.open => 'Opening $agentName\'s desk in the Office.',
      };
    }
    return 'Opening the ${zone!.title} in the Office.';
  }
}

/// The Office crew's names (office_router.js OFFICE_AGENTS) plus CHE.
const List<String> cheOfficeAgentNames = ['nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'orion', 'iris', 'vale'];

String _cap(String n) => n.isEmpty ? n : '${n[0].toUpperCase()}${n.substring(1)}';

CheOfficeVoiceRequest? cheParseOfficeVoice(String raw) {
  var t = raw.trim().toLowerCase().replaceAll(RegExp(r'[’‘]'), "'").replaceAll(RegExp(r'[.!?]+$'), '');
  t = (cheWakeRemainder(t) ?? t).replaceFirst(RegExp(r'^(?:please\s+|can you\s+|could you\s+)'), '').trim();
  if (t.isEmpty) return null;
  final names = cheOfficeAgentNames.join('|');
  const open = r'(?:open|show(?: me)?|go to|take me to|bring up|enter)';

  final message = RegExp('^(?:message|send a message to|write to|talk to) ($names) in the war room\$').firstMatch(t);
  if (message != null) return CheOfficeVoiceRequest(agentName: _cap(message.group(1)!), action: CheOfficeVoiceAction.message);

  final assign = RegExp('^(?:assign (?:a |an |one )?(?:new )?(?:task|job) to ($names)|give ($names) (?:a |an )?(?:new )?(?:task|job))\$').firstMatch(t);
  if (assign != null) {
    return CheOfficeVoiceRequest(agentName: _cap((assign.group(1) ?? assign.group(2))!), action: CheOfficeVoiceAction.assign);
  }

  final desk = RegExp("^$open (?:the )?($names)(?:'s)?(?: (?:desk|card|contact card|profile))?(?: in the office)?\$").firstMatch(t);
  if (desk != null) return CheOfficeVoiceRequest(agentName: _cap(desk.group(1)!));

  for (final zone in CheOfficeZone.values) {
    for (final words in zone.spoken) {
      final w = RegExp.escape(words);
      if (RegExp("^$open (?:the |my )?$w(?: in the office)?\$").hasMatch(t) ||
          RegExp("^$open (?:the |my )?office(?:'s)? $w\$").hasMatch(t)) {
        return CheOfficeVoiceRequest(zone: zone);
      }
    }
  }
  return null;
}
