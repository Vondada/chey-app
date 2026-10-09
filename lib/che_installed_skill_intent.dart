// Installed skills are Worker capabilities, never offline/general knowledge.
// Anchor at the owner's command so quoted examples and human-skill discussion
// do not turn into tool requests.
import 'package:flutter/material.dart';

final _installedSkillRequest = RegExp(
  r'^(?:(?:che|chay|chey)[,:]?\s+)?'
  r'(?:(?:please\s+)?can\s+you\s+(?:please\s+)?|please\s+)?'
  r'(?:'
  r'(?:list|show|read)\s+(?:the\s+)?(?:installed|approved|agent)\s+skills'
  r'|what\s+skills\s+are\s+installed'
  r'|which\s+skills\s+can\s+you\s+use'
  r'|(?:find|search(?:\s+for)?|discover)\s+(?:(?:a|an)\s+)?(?:agent\s+)?skills?\s+(?:(?:for|about|to)\s+)?\S[\s\S]*'
  r'|is\s+there\s+a\s+skill\s+(?:for|to|that\s+can)\s+\S[\s\S]*'
  r'|(?:use|run|install|update)\s+find-skills(?:\s+\S[\s\S]*)?'
  r'|(?:use|run|install|update|execute)\s+(?:the\s+)?(?:agent\s+)?skill\s+\S[\s\S]*'
  r')$',
  caseSensitive: false,
);

bool isInstalledSkillRequest(String message) => _installedSkillRequest.hasMatch(
  message.trim().replaceFirst(RegExp(r'[.!?]+$'), '').trim(),
);

/// Visible outcome of a Worker skill turn. The streamed reply itself is
/// spoken by the normal pipeline; this banner only adds the success/failure
/// receipt as large text in a screen-reader live region, without starting
/// another spoken turn.
SnackBar cheInstalledSkillReceiptBar(bool ok) => SnackBar(
  content: Semantics(
    liveRegion: true,
    child: Text(ok ? 'Skill request completed.' : 'Skill request could not be completed.'),
  ),
);
