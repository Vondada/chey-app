// Reusable navigation for every brain in the Brain Room: CHE's brain and each
// Office worker's brain use these same pieces, so switching brains never
// changes how the room works. Everything here is chrome around the existing
// space (lib/brain/che_brain_space.dart); none of it redraws an orb.
//
// Design rule (owner, 2026-10-18): keep the current dark, teal-centered Brain.
// These widgets use the Brain's own tokens (CheColors, CheType, CheRadius),
// the same compact 44-pt controls, and words plus icons for every state, never
// a color alone. Nothing here speaks on its own: status is quiet, muted text;
// CHE speaks only when the owner acts.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';
import '../home/che_memory_brain.dart' show cheMemoryCategoryColor, cheBrainHudFieldFill, cheBrainFieldBorder;
import 'che_brain_space.dart';
import 'che_brain_space_model.dart';

/// From this width the detail view is a side panel instead of a bottom sheet.
const double cheBrainSidePanelWidth = 720;

/// A fact-check label as the owner reads or hears it, with a non-color icon.
(String, IconData) cheBrainVerificationLabel(String verification) => switch (verification) {
      'owner_attested' => ('Owner attested: you said this', Icons.verified_user_outlined),
      'verified_source' => ('Verified against its source', Icons.verified_outlined),
      'hypothesis' => ('Hypothesis, not a fact', Icons.science_outlined),
      'model_opinion' => ("A model's opinion, not a fact", Icons.psychology_alt_outlined),
      'inferred' => ('Inferred by CHE, not confirmed', Icons.auto_awesome_outlined),
      'curated_lesson' => ('Curated lesson: teaching content, not your memory', Icons.school_outlined),
      'owner_practice' => ('Your practice, measured in chat', Icons.fact_check_outlined),
      'unverified_reference' || 'unverified_research_lead' => ('Unverified reference', Icons.help_outline_rounded),
      'external_correspondence' => ("Outside AI's message: advice, not your words", Icons.forum_outlined),
      '' || 'unknown' => ('Verification unknown', Icons.help_outline_rounded),
      final other => (other.replaceAll('_', ' '), Icons.help_outline_rounded),
    };

/// One compact pill in the Brain's own style: selected = teal fill and stroke.
class CheBrainPill extends StatelessWidget {
  const CheBrainPill({super.key, required this.label, required this.semanticsLabel, required this.onTap, this.selected = false, this.icon, this.dot, this.dimmed = false});

  final String label;
  final String semanticsLabel;
  final VoidCallback onTap;
  final bool selected;
  final IconData? icon;

  /// A small category swatch (used with a label, never alone).
  final Color? dot;
  final bool dimmed;

  @override
  Widget build(BuildContext context) {
    final hud = cheHudActive;
    final fg = selected ? (hud ? CheHud.ice : CheColors.accent) : dimmed ? CheColors.textFaint : CheColors.textDim;
    return Semantics(
      button: true,
      selected: selected,
      label: semanticsLabel,
      excludeSemantics: true,
      // The node carries the tap itself, so VoiceOver activates the pill wherever it sits.
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
      child: InkWell(
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        borderRadius: BorderRadius.circular(CheRadius.pill),
        child: Ink(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 11),
          decoration: hud
              // HUD glass: a clear ice-glass pill, lit brighter and rimmed in ice when selected.
              ? BoxDecoration(
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      CheHud.ice.withValues(alpha: selected ? .26 : .12),
                      CheHud.iceDeep.withValues(alpha: selected ? .10 : .04),
                    ],
                  ),
                  border: Border.all(color: CheHud.ice.withValues(alpha: selected ? .85 : .28)),
                  boxShadow: selected ? [BoxShadow(color: CheHud.ice.withValues(alpha: .30), blurRadius: 10)] : null,
                )
              : BoxDecoration(
                  color: selected ? CheColors.accent.withValues(alpha: .18) : CheColors.surface,
                  borderRadius: BorderRadius.circular(CheRadius.pill),
                  border: Border.all(color: selected ? CheColors.accent : CheColors.stroke),
                ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (dot != null) ...[CircleAvatar(radius: 4, backgroundColor: dot), const SizedBox(width: 6)],
            if (icon != null) ...[Icon(icon, size: 14, color: fg), const SizedBox(width: 5)],
            Text(label, style: CheType.caption.copyWith(color: fg, fontWeight: selected ? FontWeight.w700 : FontWeight.w600, fontSize: 12)),
          ]),
        ),
      ),
    );
  }
}

/// The brain switcher: CHE first, then every internal worker with a brain,
/// each with its record count and state. Selected = the brain in view. With
/// many brains a search field narrows the row.
class CheBrainSwitcher extends StatefulWidget {
  const CheBrainSwitcher({super.key, required this.controller, required this.onSpeak});

  final CheBrainSpaceController controller;
  final void Function(String text) onSpeak;

  @override
  State<CheBrainSwitcher> createState() => _CheBrainSwitcherState();
}

class _CheBrainSwitcherState extends State<CheBrainSwitcher> {
  final _query = TextEditingController();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final q = _query.text.trim().toLowerCase();
    final workers = [for (final w in c.workers) if (q.isEmpty || w.name.toLowerCase().contains(q) || w.role.toLowerCase().contains(q)) w];
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (c.workers.length > 8)
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, 6),
          child: SizedBox(
            height: 36,
            child: TextField(
              controller: _query,
              onChanged: (_) => setState(() {}),
              style: const TextStyle(fontSize: 13),
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Find a brain by worker or role',
                prefixIcon: Icon(Icons.search_rounded, size: 16, color: CheColors.accent),
                filled: true,
                fillColor: cheHudActive ? cheBrainHudFieldFill : CheColors.surfaceHi,
                contentPadding: const EdgeInsets.symmetric(vertical: 6),
                border: cheBrainFieldBorder(),
              ),
            ),
          ),
        ),
      SizedBox(
        height: 40,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
          child: Row(children: [
            Padding(
              padding: const EdgeInsets.only(right: 6, bottom: 4),
              child: CheBrainPill(
                label: 'CHE',
                icon: Icons.hub_rounded,
                selected: c.scope == null,
                semanticsLabel: "CHE's brain, the central brain${c.scope == null ? ', in view' : ''}",
                onTap: () => widget.onSpeak(c.setScope(null)),
              ),
            ),
            if (c.workers.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('No Office worker has experience in the Brain yet.', style: CheType.caption.copyWith(color: CheColors.textFaint)),
              ),
            for (final w in workers)
              Padding(
                padding: const EdgeInsets.only(right: 6, bottom: 4),
                child: CheBrainPill(
                  label: '${w.name} · ${w.records}',
                  icon: w.state == 'working' ? Icons.bolt_rounded : Icons.person_outline_rounded,
                  selected: c.scope == w.name,
                  dimmed: w.records == 0,
                  semanticsLabel: "${w.name}'s brain${w.role.isNotEmpty ? ', ${w.role}' : ''}: ${w.records} record${w.records == 1 ? '' : 's'}"
                      '${w.state.isNotEmpty ? ', ${w.state}' : ''}${c.scope == w.name ? ', in view' : ''}',
                  onTap: () => widget.onSpeak(c.setScope(w.name)),
                ),
              ),
            if (q.isNotEmpty && workers.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('No brain matches "$q".', style: CheType.caption.copyWith(color: CheColors.textFaint)),
              ),
          ]),
        ),
      ),
    ]);
  }
}

/// Where the owner is: CHE › worker › lobe › filters › memory, plus the mode.
/// Each crumb is a button back to that level. One quiet line, never a banner.
class CheBrainContextBar extends StatelessWidget {
  const CheBrainContextBar({super.key, required this.controller, required this.onSpeak});

  final CheBrainSpaceController controller;
  final void Function(String text) onSpeak;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final atTop = c.scope == null && c.filter.isEmpty && c.lens.isEmpty && c.selectedId == null;
    final clean = c.filter.isEmpty && c.lens.isEmpty && c.selectedId == null;
    // (label, what it is, what tapping it does: back to that level, with filters and selection below it cleared)
    final crumbs = <(String, String, VoidCallback?)>[
      ('CHE', "CHE's brain", atTop ? null : () => onSpeak(c.goHome())),
      if (c.scope != null) (c.scope!, "${c.scope}'s brain", clean ? null : () => onSpeak(c.clearView())),
      if (c.filter.isNotEmpty) (c.filter.join(', '), '${c.filter.join(', ')} memories', c.selectedId == null && c.lens.isEmpty ? null : () { c.deselect(); onSpeak(c.setLens(CheBrainLens.none).replaceFirst('Filters cleared: showing all', '${c.filter.join(', ')} memories only, of')); }),
      if (!c.lens.isEmpty) (c.lens.describe(), 'Filters: ${c.lens.describe()}', c.selectedId == null ? null : () { c.deselect(); onSpeak('${c.lens.describe()}: ${c.visibleCount} of ${c.layout.nodes.length}.'); }),
      if (c.selected != null) (c.selected!.dot.title, 'Selected memory ${c.selected!.dot.title}', null),
    ];
    final mode = c.mode;
    // The whole line is one VoiceOver sentence; every crumb that leads somewhere is a button of its own.
    return Semantics(
      container: true,
      label: 'You are in ${c.describe()}.',
      child: SizedBox(
        height: 24,
        child: Row(children: [
          const SizedBox(width: CheSpace.gutter),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                for (var i = 0; i < crumbs.length; i++) ...[
                  if (i > 0) ExcludeSemantics(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: Text('›', style: CheType.caption.copyWith(color: CheColors.textFaint)))),
                  Semantics(
                    button: crumbs[i].$3 != null,
                    label: crumbs[i].$3 == null ? crumbs[i].$2 : 'Back to ${crumbs[i].$2}',
                    excludeSemantics: true,
                    child: InkWell(
                      onTap: crumbs[i].$3,
                      borderRadius: BorderRadius.circular(6),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
                        child: Text(
                          crumbs[i].$1,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: CheType.caption.copyWith(
                            fontSize: 11,
                            color: i == crumbs.length - 1 ? CheColors.text : CheColors.textDim,
                            fontWeight: i == crumbs.length - 1 ? FontWeight.w700 : FontWeight.w500,
                            decoration: crumbs[i].$3 == null ? null : TextDecoration.underline,
                            decorationColor: CheColors.textFaint,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ]),
            ),
          ),
          ExcludeSemantics(child: Text(mode, style: cheHudActive ? CheHud.label.copyWith(fontSize: 10, letterSpacing: .8) : CheType.caption.copyWith(fontSize: 11, color: CheColors.textFaint))),
          const SizedBox(width: CheSpace.gutter),
        ]),
      ),
    );
  }
}

/// Facet filters beyond the category lobes, as rows of pills with a heading
/// each: Verification, Time, State, Ownership, Task outcome. "Clear all" sits
/// first whenever anything is set. The same panel serves every brain.
class CheBrainFilterPanel extends StatelessWidget {
  const CheBrainFilterPanel({super.key, required this.controller, required this.onSpeak, required this.categoryCounts, required this.onCategory});

  final CheBrainSpaceController controller;
  final void Function(String text) onSpeak;
  final Map<String, int> categoryCounts;
  final void Function(String? category) onCategory;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final lens = c.lens;
    Widget row(String heading, List<Widget> pills) => Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Row(children: [
            const SizedBox(width: CheSpace.gutter),
            SizedBox(width: 68, child: Text(heading, style: cheHudActive ? CheHud.label.copyWith(fontSize: 10) : CheType.overline.copyWith(fontSize: 10, color: CheColors.textFaint))),
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: [for (final p in pills) Padding(padding: const EdgeInsets.only(right: 6), child: p)]),
              ),
            ),
          ]),
        );
    CheBrainPill facet(String label, bool on, CheBrainLens next, {IconData? icon}) => CheBrainPill(
          label: label,
          icon: icon,
          selected: on,
          semanticsLabel: '$label${on ? ', on' : ''}',
          onTap: () => onSpeak(c.setLens(on ? _without(lens, next) : _merge(lens, next))),
        );
    final anySet = c.filter.isNotEmpty || !lens.isEmpty;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      row('Lobe', [
        if (anySet)
          CheBrainPill(label: 'Clear all', icon: Icons.filter_alt_off_outlined, semanticsLabel: 'Clear all filters', onTap: () => onSpeak(c.clearAll())),
        for (final category in cheBrainCategories)
          if ((categoryCounts[category] ?? 0) > 0 || c.filter.contains(category))
            CheBrainPill(
              label: '$category ${categoryCounts[category] ?? 0}',
              dot: cheMemoryCategoryColor(category),
              selected: c.filter.contains(category),
              semanticsLabel: '$category ${category == 'Knowledge Atlas' ? 'records' : 'memories'}, ${categoryCounts[category] ?? 0}${c.filter.contains(category) ? ', showing only these' : ''}',
              onTap: () => onCategory(c.filter.contains(category) ? null : category),
            ),
      ]),
      row('Truth', [
        facet('Verified', lens.verified == true, const CheBrainLens(verified: true), icon: Icons.verified_outlined),
        facet('Inferred', lens.verified == false, const CheBrainLens(verified: false), icon: Icons.auto_awesome_outlined),
      ]),
      row('Time', [
        facet('Last 7 days', lens.recentDays == 7, const CheBrainLens(recentDays: 7), icon: Icons.schedule_rounded),
        facet('Last 30 days', lens.recentDays == 30, const CheBrainLens(recentDays: 30), icon: Icons.calendar_month_outlined),
      ]),
      row('State', [
        facet('Active', lens.archived == false, const CheBrainLens(archived: false), icon: Icons.bolt_rounded),
        facet('Archived', lens.archived == true, const CheBrainLens(archived: true), icon: Icons.inventory_2_outlined),
        facet('Done tasks', lens.status == 'done', const CheBrainLens(status: 'done'), icon: Icons.task_alt_rounded),
        facet('Failed tasks', lens.status == 'failed', const CheBrainLens(status: 'failed'), icon: Icons.error_outline_rounded),
        facet('Live tasks', lens.status == 'live', const CheBrainLens(status: 'live'), icon: Icons.timelapse_rounded),
      ]),
      row('Owner', [
        facet('Personal', lens.personal == true, const CheBrainLens(personal: true), icon: Icons.lock_outline_rounded),
        facet('Shared', lens.personal == false, const CheBrainLens(personal: false), icon: Icons.groups_outlined),
      ]),
    ]);
  }

  static CheBrainLens _merge(CheBrainLens base, CheBrainLens add) => base.copyWith(
        verified: add.verified ?? base.verified,
        recentDays: add.recentDays ?? base.recentDays,
        archived: add.archived ?? base.archived,
        personal: add.personal ?? base.personal,
        status: add.status ?? base.status,
        project: add.project ?? base.project,
      );

  static CheBrainLens _without(CheBrainLens base, CheBrainLens drop) => base.copyWith(
        verified: drop.verified != null ? null : base.verified,
        recentDays: drop.recentDays != null ? null : base.recentDays,
        archived: drop.archived != null ? null : base.archived,
        personal: drop.personal != null ? null : base.personal,
        status: drop.status != null ? null : base.status,
        project: drop.project != null ? null : base.project,
      );
}

/// Zoom, fit, center and back as a row of pills. Voice reaches the same methods.
class CheBrainViewControls extends StatelessWidget {
  const CheBrainViewControls({super.key, required this.controller, required this.onSpeak});

  final CheBrainSpaceController controller;
  final void Function(String text) onSpeak;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final pills = <CheBrainPill>[
      CheBrainPill(label: 'Whole brain', icon: Icons.center_focus_strong_rounded, semanticsLabel: 'Show the whole brain', onTap: () => onSpeak(c.overview())),
      CheBrainPill(label: 'Zoom in', icon: Icons.add_rounded, semanticsLabel: 'Zoom in', onTap: () => onSpeak(c.zoomIn())),
      CheBrainPill(label: 'Zoom out', icon: Icons.remove_rounded, semanticsLabel: 'Zoom out', onTap: () => onSpeak(c.zoomOut())),
      CheBrainPill(label: 'Fit', icon: Icons.fit_screen_outlined, semanticsLabel: 'Fit everything in view', onTap: () => onSpeak(c.fit())),
      CheBrainPill(label: 'Center on CHE', icon: Icons.hub_rounded, semanticsLabel: 'Center on CHE', onTap: () => onSpeak(c.centerOnChe())),
      CheBrainPill(label: 'Center on selected', icon: Icons.center_focus_weak_rounded, semanticsLabel: 'Center on the selected memory', dimmed: c.selectedId == null, onTap: () => onSpeak(c.centerOnSelected())),
      CheBrainPill(label: 'Inside', icon: Icons.blur_on_rounded, semanticsLabel: 'Go inside the brain', onTap: () => onSpeak(c.inside())),
      CheBrainPill(label: 'Back', icon: Icons.undo_rounded, semanticsLabel: 'Back to the previous view', dimmed: !c.canGoBack, onTap: () => onSpeak(c.goBack())),
    ];
    return SizedBox(
      height: 40,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: CheSpace.gutter),
        child: Row(children: [for (final p in pills) Padding(padding: const EdgeInsets.only(right: 6, bottom: 4), child: p)]),
      ),
    );
  }
}

/// A quiet state line in the chrome (never over the orbs, never spoken on its
/// own): loading, offline, waiting to sync, an error, an empty brain, no
/// matches. Optional action pill (for example "Clear filters").
class CheBrainStateNotice extends StatelessWidget {
  const CheBrainStateNotice({super.key, required this.icon, required this.text, this.actionLabel, this.onAction, this.tone = CheBrainNoticeTone.quiet});

  final IconData icon;
  final String text;
  final String? actionLabel;
  final VoidCallback? onAction;
  final CheBrainNoticeTone tone;

  @override
  Widget build(BuildContext context) {
    final color = switch (tone) { CheBrainNoticeTone.quiet => CheColors.textDim, CheBrainNoticeTone.warning => CheColors.warning, CheBrainNoticeTone.error => CheColors.danger };
    return Semantics(
      container: true,
      // The action pill stays its own VoiceOver button instead of merging into the notice text.
      explicitChildNodes: true,
      liveRegion: false,
      label: text,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 2, CheSpace.gutter, 6),
        child: Row(children: [
          ExcludeSemantics(child: Icon(icon, size: 14, color: color)),
          const SizedBox(width: 6),
          Expanded(child: ExcludeSemantics(child: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis, style: CheType.caption.copyWith(fontSize: 12, color: color)))),
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(width: 6),
            CheBrainPill(label: actionLabel!, semanticsLabel: actionLabel!, onTap: onAction!),
          ],
        ]),
      ),
    );
  }
}

enum CheBrainNoticeTone { quiet, warning, error }
