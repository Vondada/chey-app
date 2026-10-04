// "Open Supabase"-style actions under a CHE reply. Each one opens the
// destination inside CHE's own expandable browser (CheEmbeddedAppScreen →
// CheBrowserScreen), which keeps sign-ins in its cookie store. Closing or
// swiping it away pops back to the chat, which stays mounted underneath, so
// the conversation and its scroll position are exactly where they were.
// Safari is used only when the link needs it or the owner asks.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show CustomSemanticsAction;
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../browser/che_chat_links.dart';
import '../browser/che_embedded_app_shell.dart';
import '../che_app_portal.dart';
import '../che_ui/che_theme.dart';

/// How links open. Tests replace these; the app uses the defaults.
class CheChatLinkOpener {
  CheChatLinkOpener._();

  /// Opens inside CHE. The browser announces "Opening `name` inside CHE."
  static Future<bool> Function(BuildContext context, CheChatLink link) inApp = _openInApp;

  /// Opens in Safari (or the app that owns the link).
  static Future<bool> Function(Uri uri) external = _openExternal;

  static Future<bool> _openInApp(BuildContext context, CheChatLink link) async {
    await CheEmbeddedAppScreen.open(
      context,
      app: CheAppDefinition(name: link.name, webUrl: link.url, icon: Icons.language, aliases: const []),
    );
    return true;
  }

  static Future<bool> _openExternal(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      return false;
    }
  }
}

// Spoken through CHE's voice and shown as a banner, like every status.
void _say(BuildContext context, String message) {
  CheEmbeddedAppAnnouncer.say(context, message);
  ScaffoldMessenger.maybeOf(context)
    ?..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message, style: const TextStyle(fontSize: 18)), duration: const Duration(seconds: 4)));
}

/// Opens [link] inside CHE, or in Safari when [external] is true, the link
/// needs it, or CHE runs in a desktop/web browser. Announces what opens and
/// reports a failure aloud. Returns whether it opened.
Future<bool> cheOpenChatLink(BuildContext context, CheChatLink link, {bool external = false}) async {
  final uri = cheSafeLinkUri(link.url);
  if (uri == null) {
    HapticFeedback.heavyImpact();
    _say(context, 'I did not open that link because it is not a safe web address.');
    return false;
  }
  if (external || link.opensExternally || kIsWeb) {
    final why = link.externalReason;
    HapticFeedback.mediumImpact();
    _say(context, 'Opening ${link.name} in Safari${why != null && !external ? ', because $why' : ''}.');
    final ok = await CheChatLinkOpener.external(uri);
    if (!ok && context.mounted) {
      HapticFeedback.heavyImpact();
      _say(context, 'I could not open ${link.name}. Say "what\'s the link" and I will read the address.');
    }
    return ok;
  }
  HapticFeedback.selectionClick();
  try {
    return await CheChatLinkOpener.inApp(context, link);
  } catch (_) {
    if (!context.mounted) return false;
    HapticFeedback.heavyImpact();
    _say(context, 'I could not open ${link.name} inside CHE, so I am opening it in Safari.');
    return CheChatLinkOpener.external(uri);
  }
}

/// Reads the raw address aloud and shows it, for when the owner asks.
void cheReadChatLink(BuildContext context, CheChatLink link) => _say(context, '${link.label}: ${link.url}');

Future<void> cheCopyChatLink(BuildContext context, CheChatLink link) async {
  await Clipboard.setData(ClipboardData(text: link.url));
  HapticFeedback.lightImpact();
  if (context.mounted) _say(context, 'Copied the link for ${link.name}.');
}

/// The row of actions under a reply. Renders nothing when there are no links.
class CheChatLinkActions extends StatelessWidget {
  const CheChatLinkActions({super.key, required this.links});

  final List<CheChatLink> links;

  @override
  Widget build(BuildContext context) {
    if (links.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Wrap(spacing: 8, runSpacing: 8, children: [for (final l in links) CheChatLinkButton(link: l)]),
    );
  }
}

class CheChatLinkButton extends StatelessWidget {
  const CheChatLinkButton({super.key, required this.link});

  final CheChatLink link;

  String get _where => link.opensExternally ? 'in Safari' : 'inside CHE';

  Future<void> _more(BuildContext context) async {
    HapticFeedback.selectionClick();
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: CheColors.surface,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
            child: SelectableText(link.url, style: CheType.caption),
          ),
          for (final (value, icon, text) in [
            if (!link.opensExternally) ('in', Icons.open_in_full_rounded, 'Open inside CHE'),
            ('out', Icons.open_in_new_rounded, 'Open in Safari'),
            ('read', Icons.record_voice_over_rounded, 'Read the link aloud'),
            ('copy', Icons.copy_rounded, 'Copy the link'),
          ])
            ListTile(
              leading: Icon(icon, color: CheColors.accent),
              title: Text(text, style: CheType.body),
              onTap: () => Navigator.of(sheet).pop(value),
            ),
        ]),
      ),
    );
    if (!context.mounted || choice == null) return;
    switch (choice) {
      case 'in':
        await cheOpenChatLink(context, link);
      case 'out':
        await cheOpenChatLink(context, link, external: true);
      case 'read':
        cheReadChatLink(context, link);
      case 'copy':
        await cheCopyChatLink(context, link);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      link: true,
      excludeSemantics: true,
      label: '${link.label} $_where',
      hint: 'Link to ${link.host}. More options: open in Safari, read the link, copy the link.',
      onTap: () => cheOpenChatLink(context, link),
      onLongPress: () => _more(context),
      customSemanticsActions: {
        if (!link.opensExternally)
          const CustomSemanticsAction(label: 'Open in Safari'): () => cheOpenChatLink(context, link, external: true),
        const CustomSemanticsAction(label: 'Read the link aloud'): () => cheReadChatLink(context, link),
        const CustomSemanticsAction(label: 'Copy the link'): () => cheCopyChatLink(context, link),
      },
      child: Material(
        color: CheColors.accent.withValues(alpha: 0.12),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: CheColors.accent.withValues(alpha: 0.45)),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () => cheOpenChatLink(context, link),
          onLongPress: () => _more(context),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48, maxWidth: 320),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(link.opensExternally ? Icons.open_in_new_rounded : Icons.open_in_full_rounded, size: 20, color: CheColors.accent),
                const SizedBox(width: 10),
                Flexible(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                    Text(link.label, style: CheType.body.copyWith(fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis),
                    Text(link.host, style: CheType.caption, overflow: TextOverflow.ellipsis),
                  ]),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
