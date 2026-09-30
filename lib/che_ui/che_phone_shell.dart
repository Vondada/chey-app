// CHE phone shell — 5-tab bottom nav matching owner mockups:
// Home | Chat | Office | Apps | More

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'che_theme.dart';

enum ChePhoneTab { home, chat, office, apps, more }

extension ChePhoneTabX on ChePhoneTab {
  String get label => switch (this) {
        ChePhoneTab.home => 'Home',
        ChePhoneTab.chat => 'Chat',
        ChePhoneTab.office => 'Office',
        ChePhoneTab.apps => 'Apps',
        ChePhoneTab.more => 'More',
      };

  IconData get icon => switch (this) {
        ChePhoneTab.home => Icons.home_rounded,
        ChePhoneTab.chat => Icons.chat_bubble_rounded,
        ChePhoneTab.office => Icons.apartment_rounded,
        ChePhoneTab.apps => Icons.apps_rounded,
        ChePhoneTab.more => Icons.more_horiz_rounded,
      };

  String get semanticsLabel => switch (this) {
        ChePhoneTab.home => 'Home tab',
        ChePhoneTab.chat => 'Chat tab',
        ChePhoneTab.office => 'Office tab',
        ChePhoneTab.apps => 'Apps tab',
        ChePhoneTab.more => 'More tab',
      };
}

/// Glowing teal bottom navigation bar (mockups 03 / 04).
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
          child: Row(
            children: [
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
            ],
          ),
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
                width: 44,
                height: 32,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                  color: selected
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
                  color: selected ? CheColors.accent : CheColors.textDim,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                tab.label,
                style: CheType.caption.copyWith(
                  fontSize: 10.5,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                  color: selected ? CheColors.accent : CheColors.textDim,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
