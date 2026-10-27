// CHE phone shell — 5-tab bottom nav matching owner mockups:
// Home | Chat | Office | Apps | More

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_hud.dart';
import 'che_theme.dart';

enum ChePhoneTab { home, chat, office, apps, more }

extension ChePhoneTabX on ChePhoneTab {
  String get label => switch (this) {
    ChePhoneTab.home => 'Home',
    ChePhoneTab.chat => 'Chat',
    ChePhoneTab.office => 'Office',
    ChePhoneTab.apps => 'CHE World',
    ChePhoneTab.more => 'More',
  };

  IconData get icon => switch (this) {
    ChePhoneTab.home => Icons.home_rounded,
    ChePhoneTab.chat => Icons.chat_bubble_rounded,
    ChePhoneTab.office => Icons.apartment_rounded,
    ChePhoneTab.apps => Icons.dashboard_rounded,
    ChePhoneTab.more => Icons.more_horiz_rounded,
  };

  String get semanticsLabel => switch (this) {
    ChePhoneTab.home => 'Home tab',
    ChePhoneTab.chat => 'Chat tab',
    ChePhoneTab.office => 'Office tab',
    ChePhoneTab.apps => 'CHE World tab',
    ChePhoneTab.more => 'More tab',
  };
}

/// Bottom navigation: a floating glass capsule in the HUD look, else the glowing teal bar (mockups 03 / 04).
class ChePhoneBottomNav extends StatelessWidget {
  const ChePhoneBottomNav({
    super.key,
    required this.index,
    required this.onChanged,
  });

  final int index;
  final ValueChanged<int> onChanged;

  static const tabs = ChePhoneTab.values;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewPaddingOf(context).bottom;
    final items = [
      for (var i = 0; i < tabs.length; i++)
        Expanded(
          child: _NavItem(
            tab: tabs[i],
            selected: i == index,
            onTap: () {
              if (i == index) return;
              HapticFeedback.selectionClick();
              onChanged(i);
            },
          ),
        ),
    ];
    // HUD glass: a floating glass capsule over the backdrop.
    if (cheHudActive) {
      return Material(
        type: MaterialType.transparency,
        child: Padding(
          padding: EdgeInsets.fromLTRB(12, 4, 12, bottom > 0 ? bottom : 8),
          child: CheGlass(
            radius: 32,
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Row(children: items),
          ),
        ),
      );
    }
    return Material(
      color: const Color(0xE6081012),
      elevation: 0,
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(color: CheColors.accent.withValues(alpha: 0.22)),
          ),
          boxShadow: [
            BoxShadow(
              color: CheColors.accent.withValues(alpha: 0.08),
              blurRadius: 24,
              offset: const Offset(0, -4),
            ),
          ],
        ),
        child: Padding(
          padding: EdgeInsets.only(bottom: bottom > 0 ? bottom : 6, top: 6),
          child: Row(children: items),
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.tab,
    required this.selected,
    required this.onTap,
  });

  final ChePhoneTab tab;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final hud = cheHudActive;
    final on = hud ? Colors.white : CheColors.accent;
    return Semantics(
      button: true,
      selected: selected,
      label: tab.semanticsLabel,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        splashFactory: NoSplash.splashFactory,
        child: SizedBox(
          height: 56,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              AnimatedContainer(
                duration: CheMotion.fast,
                width: hud ? 52 : 44,
                height: 32,
                // HUD: the selected tab is an angled chip of light, cut like the panels.
                decoration: hud
                    ? ShapeDecoration(
                        shape: BeveledRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                          side: selected ? BorderSide(color: CheHud.ice.withValues(alpha: 0.8)) : BorderSide.none,
                        ),
                        gradient: selected
                            ? LinearGradient(
                                begin: Alignment.topCenter,
                                end: Alignment.bottomCenter,
                                colors: [CheHud.ice.withValues(alpha: 0.32), CheHud.iceDeep.withValues(alpha: 0.10)],
                              )
                            : null,
                        shadows: selected ? [BoxShadow(color: CheHud.iceDeep.withValues(alpha: 0.5), blurRadius: 14)] : null,
                      )
                    : BoxDecoration(
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                  gradient: hud && selected
                      ? LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Colors.white.withValues(alpha: 0.30), CheHud.iceDeep.withValues(alpha: 0.30)],
                        )
                      : null,
                  border: hud && selected ? Border.all(color: Colors.white.withValues(alpha: 0.45)) : null,
                  color: hud
                      ? null
                      : selected
                          ? CheColors.accent.withValues(alpha: 0.22)
                          : Colors.transparent,
                  boxShadow: selected
                      ? [
                          BoxShadow(
                            color: CheColors.accent.withValues(alpha: 0.45),
                            blurRadius: 14,
                          ),
                        ]
                      : null,
                ),
                child: Icon(
                  tab.icon,
                  size: 22,
                  color: selected ? on : CheColors.textDim,
                ),
              ),
              const SizedBox(height: 2),
              // One line, shrunk to the room left under the icon: with Larger Text the label was taller than the fixed
              // nav height and overflowed (FittedBox alone got no height limit inside the Column).
              Flexible(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(
                    tab.label,
                    maxLines: 1,
                    style: CheType.caption.copyWith(
                      fontSize: 10.5,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                      color: selected ? on : CheColors.textDim,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
