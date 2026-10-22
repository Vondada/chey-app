// CHE Creator / Sound Studio: neon production room. ON AIR and the meters
// react only to real activity (CHE speaking, cloud renders running). The
// render queue is CHE's real background-job list (podcast / long create jobs
// via /api/job/create). Video creation routes through the existing Worker
// media system and requires a live HTTPS renderer (CHE_VIDEO_GEN_URL or
// CHE_VIDEO_RENDER_URL). Pending tasks are not finished MP4 files.
// Pictures live in Art Studio (FLUX / CHE_IMAGE_GEN_URL).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../che_ui/che_hud.dart';
import '../che_ui/che_rooms.dart';
import '../che_ui/che_screen_awareness.dart';
import '../che_ui/che_theme.dart';
import '../widgets/che_native_scene_world.dart';

/// Coding and repository work (self-development, PRs, deploys, app builds, skill imports, exams). It belongs in Projects and Office, never in the
/// Music or Create render queue (2026-10-22: the coding investigation history showed up inside Music).
const _kCodingJobKinds = {
  'self_development', 'software_agent', 'repo_study', 'verify_deploy', 'merge_pr', 'pr_opened', 'merged',
  'update_approved', 'autonomy_exam', 'reasoning_exam', 'verify_app_build', 'office_skill_import',
};

bool cheIsCodingJob(Map<String, dynamic> job) => _kCodingJobKinds.contains('${job['kind'] ?? ''}');

class CheStudioAction {
  const CheStudioAction({
    required this.icon,
    required this.title,
    required this.body,
    required this.connected,
    required this.connectorName,
    required this.onRun,
    this.background = false,
  });
  final IconData icon;
  final String title;
  final String body;
  final bool connected;
  final String connectorName;
  final VoidCallback onRun;

  /// Runs as a real cloud job that keeps going with the phone locked.
  final bool background;
}

class CheCreatorStudio extends StatefulWidget {
  const CheCreatorStudio({
    super.key,
    required this.speaking,
    required this.jobs,
    required this.actions,
    required this.onOpenJob,
    required this.musicScene,
    this.seriesPanel,
  });

  /// CHE is speaking right now (drives the meters).
  final bool speaking;

  /// Real background jobs (render queue).
  final List<Map<String, dynamic>> jobs;
  final List<CheStudioAction> actions;
  final void Function(Map<String, dynamic> job) onOpenJob;

  /// The existing Music room (playlists, connected audio, car).
  final Widget musicScene;

  /// The original series panel (issue #347): bible, pilot, render and platforms.
  final Widget? seriesPanel;

  @override
  State<CheCreatorStudio> createState() => _CheCreatorStudioState();
}

class _CheCreatorStudioState extends State<CheCreatorStudio> {
  static const _magenta = Color(0xFFFF3D8B);
  static const _cyan = Color(0xFF3FD0F0);

  int _view = 0;
  Object? _screen;

  @override
  void initState() {
    super.initState();
    // "What is on my screen?" while the studio is the room in front.
    _screen = CheScreenAwareness.register(context, () => CheScreenReport(
          page: 'Creator Studio',
          tab: _view == 0 ? 'Studio' : 'Music',
          tabs: const ['Studio', 'Music'],
          detail: _view == 1
              ? 'The Music room: playlists, connected audio and the car'
              : '${widget.speaking ? 'On air: CHE is speaking' : _rendering ? 'On air: rendering in the cloud' : 'Studio ready, not on air'}. '
                  'Render queue: ${widget.jobs.isEmpty ? 'nothing rendering' : '${widget.jobs.length} jobs, first "${widget.jobs.first['title'] ?? 'Render job'}" ${widget.jobs.first['status'] ?? 'queued'}'}. '
                  'Create: ${widget.actions.isEmpty ? 'no actions' : [for (final a in widget.actions) '${a.title} (${a.connected ? 'ready' : 'needs ${a.connectorName}'})'].join(', ')}'
                  '${widget.seriesPanel == null ? '' : '. Series panel: the original series, its pilot, its render and each platform\'s state'}',
          controls: [
            'Studio', 'Music',
            if (widget.seriesPanel != null) ...['Read aloud', 'Series bible', 'Pilot script', 'Render pilot', 'Export for every platform', 'Post to YouTube Shorts', 'Growth plan'],
            'Close rooms',
          ],
        ));
  }

  @override
  void dispose() {
    CheScreenAwareness.unregister(_screen);
    super.dispose();
  }

  bool get _rendering => widget.jobs.any((j) => j['status'] == 'queued' || j['status'] == 'running');

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: CheTheme.dark(),
      child: Material(
        // HUD glass: the page's HUD backdrop shows through. Other palettes keep the neon studio's black.
        color: cheHudActive ? CheColors.screen : const Color(0xFF07040A),
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(CheSpace.gutter, CheSpace.sm, CheSpace.gutter, CheSpace.sm),
            child: SegmentedButton<int>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(value: 0, icon: Icon(Icons.graphic_eq_rounded, size: 16), label: Text('Studio')),
                ButtonSegment(value: 1, icon: Icon(Icons.queue_music_rounded, size: 16), label: Text('Music')),
              ],
              selected: {_view},
              onSelectionChanged: (v) {
                HapticFeedback.selectionClick();
                setState(() => _view = v.first);
              },
            ),
          ),
          Expanded(child: _view == 1 ? _music(context) : _studio(context)),
        ]),
      ),
    );
  }

  Widget _music(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.sm),
          child: CheNativeRoomStage(
            mode: CheSceneMode.musicStudio,
            height: 250,
            semanticsLabel: 'Immersive native Music Studio.',
            entities: [
              CheSceneEntity(
                id: 'che',
                label: 'CHE',
                description: 'Music room host',
                color: _cyan,
                state: widget.speaking ? 'talking' : 'idle',
                speaking: widget.speaking,
              ),
            ],
          ),
        ),
        Expanded(child: widget.musicScene),
      ],
    );
  }
  Widget _studio(BuildContext context) {
    final onAir = widget.speaking || _rendering;
    final hud = cheHudActive;
    Widget onAirPanel(Widget child) => hud
        ? CheGlass(radius: CheRadius.lg, padding: const EdgeInsets.all(CheSpace.md), child: child)
        : ClipRRect(
            borderRadius: BorderRadius.circular(CheRadius.lg),
            child: CheRoomBackdrop(
              room: CheRoom.studio,
              scrim: 0.5,
              child: Padding(padding: const EdgeInsets.all(CheSpace.md), child: child),
            ),
          );
    TextStyle section(Color color) => hud ? CheHud.label : CheType.overline.copyWith(color: color);
    return ListView(
      padding: const EdgeInsets.fromLTRB(CheSpace.gutter, 0, CheSpace.gutter, CheSpace.xxl),
      children: [
        onAirPanel(
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  AnimatedContainer(
                    duration: CheMotion.base,
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: onAir ? Colors.red.withValues(alpha: 0.85) : Colors.white10,
                      borderRadius: BorderRadius.circular(6),
                      boxShadow: onAir ? [BoxShadow(color: Colors.red.withValues(alpha: 0.6), blurRadius: 14)] : null,
                    ),
                    child: Text('ON AIR',
                        style: TextStyle(color: onAir ? Colors.white : Colors.white38, fontWeight: FontWeight.w900, letterSpacing: 2)),
                  ),
                  const SizedBox(width: CheSpace.sm),
                  Expanded(
                    child: Text(
                      widget.speaking ? 'CHE is speaking' : _rendering ? 'Rendering in the cloud' : 'Studio ready',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: CheType.caption.copyWith(color: Colors.white70),
                    ),
                  ),
                ]),
              ]),
        ),
        if (widget.seriesPanel != null) ...[
          const SizedBox(height: CheSpace.lg),
          Text('SERIES', style: section(_magenta)),
          const SizedBox(height: CheSpace.xs),
          widget.seriesPanel!,
        ],
        const SizedBox(height: CheSpace.lg),
        Text('RENDER QUEUE', style: section(_cyan)),
        const SizedBox(height: CheSpace.xs),
        if (widget.jobs.isEmpty)
          Text('Nothing rendering.', style: CheType.bodyDim)
        else
          for (final job in widget.jobs) _JobRow(job: job, onTap: () => widget.onOpenJob(job)),
        const SizedBox(height: CheSpace.lg),
        Text('CREATE', style: section(_magenta)),
        const SizedBox(height: CheSpace.sm),
        for (final a in widget.actions) _actionCard(hud, ListTile(
              onTap: () {
                HapticFeedback.selectionClick();
                a.onRun();
              },
              leading: Icon(a.icon, color: _magenta),
              title: Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
              subtitle: Text(
                a.connected
                    ? '${a.body}${a.background ? '\nRuns as a cloud job.' : ''}'
                    : '${a.body}\nNeeds: ${a.connectorName}. CHE will write the brief and plan until it is connected.',
                style: CheType.caption,
              ),
              isThreeLine: !a.connected || a.background,
              trailing: Text(a.connected ? 'READY' : 'CONNECT',
                  style: TextStyle(color: a.connected ? CheColors.success : CheColors.warning, fontSize: 10, fontWeight: FontWeight.w700)),
            )),
      ],
    );
  }

  /// One Create action: a glass pane on the HUD, the neon card otherwise. The tile inside is the same either way.
  Widget _actionCard(bool hud, Widget tile) => hud
      ? Padding(
          padding: const EdgeInsets.only(bottom: CheSpace.sm),
          child: CheGlass(
            radius: CheRadius.md,
            shadow: false,
            child: Material(type: MaterialType.transparency, child: tile),
          ),
        )
      : Card(
          color: const Color(0xFF130A14),
          margin: const EdgeInsets.only(bottom: CheSpace.sm),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(CheRadius.md),
            side: BorderSide(color: _magenta.withValues(alpha: 0.25)),
          ),
          child: tile,
        );
}

class _JobRow extends StatelessWidget {
  const _JobRow({required this.job, required this.onTap});
  final Map<String, dynamic> job;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final status = '${job['status'] ?? ''}';
    final (color, icon) = switch (status) {
      'queued' => (CheColors.textDim, Icons.schedule_rounded),
      'running' => (const Color(0xFF3FD0F0), Icons.graphic_eq_rounded),
      'complete' => (CheColors.success, Icons.check_circle_rounded),
      'failed' => (CheColors.danger, Icons.error_outline_rounded),
      _ => (CheColors.textFaint, Icons.remove_circle_outline_rounded),
    };
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      onTap: onTap,
      leading: Icon(icon, color: color),
      title: Text('${job['title'] ?? 'Job'}', maxLines: 1, overflow: TextOverflow.ellipsis, style: CheType.label),
      subtitle: Text(status, style: CheType.caption.copyWith(color: color)),
      trailing: const Icon(Icons.chevron_right_rounded),
    );
  }
}
