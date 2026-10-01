// Shared CHE-owned shell for embedded apps and web apps.
//
// App cards open through [CheEmbeddedAppRoute] (expand, not a website slide)
// and render under [CheEmbeddedAppShell]. The address bar, search field and
// browser bottom nav stay hidden until the owner asks for them.
//
// Dismissal lives on this shell — close, back, header swipe, left-edge swipe —
// never on the webview. Full-screen pages use non-eager recognizers so scroll
// and tap still work. [EagerGestureRecognizer] is never used: it wins the
// arena immediately and swallows CHE's exit gestures.
//
// In-tab previews use [cheEmbeddedParentFriendlyGestures], which is empty so a
// parent list, tab, or sheet can still dismiss.

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_theme.dart';

/// Gesture factories for a full-screen embedded page.
///
/// Scroll, tap, long-press and pinch are claimed only after they match.
/// Eager capture is intentionally absent so the CHE header and route can exit.
Set<Factory<OneSequenceGestureRecognizer>> cheEmbeddedWebViewGestures() => {
      Factory<VerticalDragGestureRecognizer>(() => VerticalDragGestureRecognizer()),
      Factory<HorizontalDragGestureRecognizer>(() => HorizontalDragGestureRecognizer()),
      Factory<ScaleGestureRecognizer>(() => ScaleGestureRecognizer()),
      Factory<LongPressGestureRecognizer>(() => LongPressGestureRecognizer()),
      Factory<TapGestureRecognizer>(() => TapGestureRecognizer()),
    };

/// Gesture factories for a web view that sits inside a scrolling tab or sheet.
///
/// Empty on purpose: the parent must be able to scroll and dismiss. The page
/// still receives pointers nobody else claims.
Set<Factory<OneSequenceGestureRecognizer>> cheEmbeddedParentFriendlyGestures() => const {};

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
                ),
                if (showBrowserControls && browserControls != null) browserControls!,
                Expanded(
                  child: MediaQuery.removeViewInsets(
                    context: context,
                    removeBottom: true,
                    child: child,
                  ),
                ),
              ],
            ),
            Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              width: 28,
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

class _Header extends StatefulWidget {
  const _Header({
    required this.title,
    required this.topInset,
    required this.canGoBackInPage,
    required this.onBack,
    required this.onClose,
    required this.onMoreSelected,
    required this.moreItems,
  });

  final String title;
  final double topInset;
  final bool canGoBackInPage;
  final VoidCallback? onBack;
  final VoidCallback onClose;
  final ValueChanged<String>? onMoreSelected;
  final List<PopupMenuEntry<String>> moreItems;

  @override
  State<_Header> createState() => _HeaderState();
}

class _HeaderState extends State<_Header> {
  double _dragDy = 0;

  void _end(DragEndDetails details) {
    final flung = (details.primaryVelocity ?? 0) > 280;
    final pulled = _dragDy > 72;
    _dragDy = 0;
    if (flung || pulled) widget.onClose();
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.title;
    final canGoBackInPage = widget.canGoBackInPage;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onVerticalDragUpdate: (details) => _dragDy += details.delta.dy,
      onVerticalDragEnd: _end,
      onVerticalDragCancel: () => _dragDy = 0,
      child: Material(
        color: const Color(0xFF0A1214),
        child: Padding(
          padding: EdgeInsets.only(top: widget.topInset),
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
                        tooltip: 'Back',
                        onPressed: widget.onBack ?? widget.onClose,
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
                          widget.onMoreSelected?.call(value);
                        },
                        itemBuilder: (_) => widget.moreItems,
                        icon: const Icon(Icons.more_horiz_rounded),
                      ),
                    ),
                    Semantics(
                      button: true,
                      label: 'Close $title',
                      child: IconButton(
                        tooltip: 'Close',
                        onPressed: widget.onClose,
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
