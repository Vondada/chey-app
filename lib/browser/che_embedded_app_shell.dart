// Shared CHE-owned shell for embedded apps and web apps.
//
// App cards open through [CheEmbeddedAppRoute] (expand, not a website slide)
// and render under [CheEmbeddedAppShell]. The address bar, search field and
// browser bottom nav stay hidden until the owner asks for them.
//
// Dismissal lives on this shell — close, back, header swipe, left-edge swipe —
// never on the webview. [cheEmbeddedWebViewGestures] stays empty on purpose:
// EagerGestureRecognizer wins the arena immediately and swallows those exits.

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';

/// Gesture factories passed to an embedded web view.
///
/// Must stay empty. An [EagerGestureRecognizer] claims every pointer before
/// CHE's header, route back, or swipe-down can see it, which trapped tabs.
Set<Factory<OneSequenceGestureRecognizer>> cheEmbeddedWebViewGestures() => const {};

/// Spoken confirmations for open / close / browser-control toggles.
/// Wired once from the app to CHE's voice. VoiceOver still gets labels.
class CheEmbeddedAppAnnouncer {
  CheEmbeddedAppAnnouncer._();
  static void Function(String message)? speak;

  static void say(BuildContext context, String message) {
    speak?.call(message);
    SemanticsService.announce(message, Directionality.of(context));
  }
}

/// Expand-open route. Feels like an app opening inside CHE, not Safari sliding in.
class CheEmbeddedAppRoute<T> extends PageRoute<T> {
  CheEmbeddedAppRoute({required this.builder, super.settings});

  final WidgetBuilder builder;

  @override
  bool get opaque => true;

  @override
  bool get barrierDismissible => false;

  @override
  Color? get barrierColor => null;

  @override
  String? get barrierLabel => null;

  @override
  bool get maintainState => true;

  @override
  Duration get transitionDuration => const Duration(milliseconds: 420);

  @override
  Duration get reverseTransitionDuration => const Duration(milliseconds: 260);

  @override
  Widget buildPage(BuildContext context, Animation<double> animation, Animation<double> secondaryAnimation) {
    return builder(context);
  }

  @override
  Widget buildTransitions(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    if (CheMotion.reduced(context)) {
      return FadeTransition(opacity: animation, child: child);
    }
    final curved = CurvedAnimation(
      parent: animation,
      curve: Curves.easeOutCubic,
      reverseCurve: Curves.easeInCubic,
    );
    return FadeTransition(
      opacity: curved,
      child: ScaleTransition(
        scale: Tween<double>(begin: 0.86, end: 1).animate(curved),
        alignment: Alignment.center,
        child: child,
      ),
    );
  }
}

/// Minimal CHE chrome over an embedded app. Exit controls sit outside the page.
class CheEmbeddedAppShell extends StatelessWidget {
  const CheEmbeddedAppShell({
    super.key,
    required this.title,
    required this.child,
    required this.onClose,
    this.onBack,
    this.canGoBackInPage = false,
    this.onMoreSelected,
    this.moreItems = const [],
    this.browserControls,
    this.showBrowserControls = false,
  });

  final String title;
  final Widget child;
  final VoidCallback onClose;
  final VoidCallback? onBack;
  final bool canGoBackInPage;
  final ValueChanged<String>? onMoreSelected;
  final List<PopupMenuEntry<String>> moreItems;
  final Widget? browserControls;
  final bool showBrowserControls;

  void _edgeDismiss(DragEndDetails details) {
    if ((details.primaryVelocity ?? 0) > 280) onClose();
  }

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    return PopScope(
      canPop: true,
      child: Scaffold(
        backgroundColor: const Color(0xFF060B11),
        resizeToAvoidBottomInset: true,
        body: Stack(
          children: [
            Column(
              children: [
                _Header(
                  title: title,
                  topInset: top,
                  canGoBackInPage: canGoBackInPage,
                  onBack: onBack,
                  onClose: onClose,
                  onMoreSelected: onMoreSelected,
                  moreItems: moreItems,
                  onSwipeDown: _edgeDismiss,
                ),
                if (showBrowserControls && browserControls != null) browserControls!,
                Expanded(child: child),
              ],
            ),
            Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              width: 22,
              child: GestureDetector(
                behavior: HitTestBehavior.translucent,
                onHorizontalDragEnd: _edgeDismiss,
                child: const SizedBox.expand(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.title,
    required this.topInset,
    required this.canGoBackInPage,
    required this.onBack,
    required this.onClose,
    required this.onMoreSelected,
    required this.moreItems,
    required this.onSwipeDown,
  });

  final String title;
  final double topInset;
  final bool canGoBackInPage;
  final VoidCallback? onBack;
  final VoidCallback onClose;
  final ValueChanged<String>? onMoreSelected;
  final List<PopupMenuEntry<String>> moreItems;
  final GestureDragEndCallback onSwipeDown;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onVerticalDragEnd: onSwipeDown,
      child: Material(
        color: const Color(0xFF0A1214),
        child: Padding(
          padding: EdgeInsets.only(top: topInset),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(height: 6),
              Semantics(
                label: 'Swipe down on the $title header to close',
                child: Container(
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.white24,
                    borderRadius: BorderRadius.circular(99),
                  ),
                ),
              ),
              SizedBox(
                height: 48,
                child: Row(
                  children: [
                    Semantics(
                      button: true,
                      label: canGoBackInPage ? 'Back in $title' : 'Back, close $title',
                      child: IconButton(
                        tooltip: canGoBackInPage ? 'Back' : 'Back',
                        onPressed: onBack ?? onClose,
                        icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18),
                      ),
                    ),
                    Expanded(
                      child: Semantics(
                        header: true,
                        label: title,
                        child: Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.center,
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                        ),
                      ),
                    ),
                    Semantics(
                      button: true,
                      label: 'More actions for $title',
                      child: PopupMenuButton<String>(
                        tooltip: 'More',
                        onSelected: (value) {
                          HapticFeedback.selectionClick();
                          onMoreSelected?.call(value);
                        },
                        itemBuilder: (_) => moreItems,
                        icon: const Icon(Icons.more_horiz_rounded),
                      ),
                    ),
                    Semantics(
                      button: true,
                      label: 'Close $title',
                      child: IconButton(
                        tooltip: 'Close',
                        onPressed: onClose,
                        icon: const Icon(Icons.close_rounded),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
