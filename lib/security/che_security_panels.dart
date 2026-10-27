// Security pages opened from the Security command center: access control (agents, tools, apps, devices and their
// scopes), incident replay (each recorded step, nothing invented between them) and the lockdown preview (effects
// first, then an explicit confirmation). All of them read CHE's real records and speak only when asked.
import 'package:flutter/material.dart';

typedef CheSpeak = ValueChanged<String>;

/// Access control: every principal CHE has, grouped by kind, with its scopes and the least-privilege findings.
class CheSecurityAccessScreen extends StatelessWidget {
  const CheSecurityAccessScreen({super.key, required this.access, this.onSpeak});
  final Map<String, dynamic> access;
  final CheSpeak? onSpeak;

  static const kinds = ['agent', 'tool', 'app', 'device'];
  static const kindTitles = {'agent': 'Agents', 'tool': 'Tools', 'app': 'Apps', 'device': 'Devices'};

  List<Map<String, dynamic>> get principals => [for (final p in (access['principals'] as List? ?? const [])) Map<String, dynamic>.from(p as Map)];
  List<Map<String, dynamic>> get findings => [for (final f in ((access['review'] as Map?)?['findings'] as List? ?? const [])) Map<String, dynamic>.from(f as Map)];

  String summary() {
    final ps = principals;
    final f = findings;
    final counts = kinds.map((k) => '${ps.where((p) => p['kind'] == k).length} ${kindTitles[k]!.toLowerCase()}').join(', ');
    return 'Access control: $counts. ${f.isEmpty ? 'No least-privilege problems found.' : '${f.length} finding${f.length == 1 ? '' : 's'}: ${[for (var i = 0; i < f.length && i < 5; i++) '${i + 1}. ${f[i]['id']} ${f[i]['issue']}'].join('; ')}.'}';
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final ps = principals;
    final f = findings;
    return Scaffold(
      appBar: AppBar(title: const Text('Access Control'), actions: [
        IconButton(tooltip: 'Read access control aloud', icon: const Icon(Icons.record_voice_over_rounded), onPressed: onSpeak == null ? null : () => onSpeak!(summary())),
      ]),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Semantics(container: true, label: summary(), child: ExcludeSemantics(child: Text(summary(), style: text.titleMedium))),
        for (final k in kinds) ...[
          const SizedBox(height: 16),
          Semantics(header: true, child: Text(kindTitles[k]!, style: text.titleLarge)),
          for (final p in ps.where((p) => p['kind'] == k))
            Builder(builder: (context) {
              final scopes = [for (final s in (p['scopes'] as List? ?? const [])) '$s'];
              final issues = f.where((x) => x['id'] == p['id']).map((x) => '${x['issue']}').toList();
              final label = '${p['name']}, ${p['status']}. Scopes: ${scopes.isEmpty ? 'none' : scopes.join(', ')}.${issues.isEmpty ? '' : ' Finding: ${issues.join('; ')}.'}';
              return Semantics(
                container: true,
                label: label,
                child: ExcludeSemantics(
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(issues.isEmpty ? Icons.verified_user_outlined : Icons.warning_amber),
                    title: Text('${p['name']}'),
                    subtitle: Text('${scopes.isEmpty ? 'No scopes' : scopes.join(' · ')}${issues.isEmpty ? '' : '\n${issues.join('; ')}'}'),
                    trailing: Text('${p['status']}'),
                  ),
                ),
              );
            }),
        ],
      ]),
    );
  }
}

/// One incident, step by step as recorded. A drill is labelled SIMULATION on every step.
class CheIncidentReplayScreen extends StatefulWidget {
  const CheIncidentReplayScreen({super.key, required this.replay, this.onSpeak});
  final Map<String, dynamic> replay;
  final CheSpeak? onSpeak;

  @override
  State<CheIncidentReplayScreen> createState() => _CheIncidentReplayScreenState();
}

class _CheIncidentReplayScreenState extends State<CheIncidentReplayScreen> {
  int _at = 0;

  List<Map<String, dynamic>> get _frames => [for (final f in (widget.replay['frames'] as List? ?? const [])) Map<String, dynamic>.from(f as Map)];

  String _frameText(Map<String, dynamic> f, int i, int n) {
    final secs = ((f['offset_ms'] as num?) ?? 0) / 1000;
    return '${widget.replay['label']}. Step ${i + 1} of $n: ${'${f['stage']}'.toLowerCase()}, ${secs.toStringAsFixed(secs < 10 ? 1 : 0)} seconds after detection, by ${f['by']}. ${f['note']}';
  }

  @override
  Widget build(BuildContext context) {
    final frames = _frames;
    final text = Theme.of(context).textTheme;
    final label = '${widget.replay['label']}';
    final sim = label == 'SIMULATION';
    final current = frames.isEmpty ? null : frames[_at.clamp(0, frames.length - 1)];
    return Scaffold(
      appBar: AppBar(title: Text(sim ? 'Replay · SIMULATION' : 'Incident Replay')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('${widget.replay['title']}', style: text.titleLarge),
        Text(label, style: text.titleMedium?.copyWith(color: sim ? const Color(0xFFB794F6) : null, fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        if (current != null)
          Semantics(liveRegion: true, container: true, label: _frameText(current, _at, frames.length), child: ExcludeSemantics(child: Text(_frameText(current, _at, frames.length), style: text.titleMedium))),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          OutlinedButton.icon(icon: const Icon(Icons.chevron_left_rounded), label: const Text('Previous Step'), onPressed: _at > 0 ? () => setState(() => _at--) : null),
          OutlinedButton.icon(icon: const Icon(Icons.chevron_right_rounded), label: const Text('Next Step'), onPressed: _at < frames.length - 1 ? () => setState(() => _at++) : null),
          OutlinedButton.icon(
            icon: const Icon(Icons.record_voice_over_rounded),
            label: const Text('Read Aloud'),
            onPressed: widget.onSpeak == null || current == null ? null : () => widget.onSpeak!(_frameText(current, _at, frames.length)),
          ),
        ]),
        const SizedBox(height: 16),
        for (var i = 0; i < frames.length; i++)
          Semantics(
            selected: i == _at,
            button: true,
            label: _frameText(frames[i], i, frames.length),
            excludeSemantics: true,
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              selected: i == _at,
              leading: Icon(i <= _at ? Icons.check_circle_rounded : Icons.radio_button_unchecked),
              title: Text('${frames[i]['stage']}'),
              subtitle: Text('${frames[i]['note']}'),
              onTap: () => setState(() => _at = i),
            ),
          ),
      ]),
    );
  }
}

/// The lockdown preview: what lockdown would do and what stays, then an explicit confirmation.
class CheLockdownPreview extends StatelessWidget {
  const CheLockdownPreview({super.key, required this.preview, required this.onConfirm, required this.onCancel, this.busy = false});
  final Map<String, dynamic> preview;
  final VoidCallback onConfirm;
  final VoidCallback onCancel;
  final bool busy;

  static String spoken(Map<String, dynamic> p) {
    final effects = [for (final e in (p['effects'] as List? ?? const [])) '${(e as Map)['effect']}'];
    final keeps = [for (final k in (p['unaffected'] as List? ?? const [])) '$k'];
    return 'Lockdown preview. If you confirm: ${[for (var i = 0; i < effects.length; i++) '${i + 1}. ${effects[i]}'].join(' ')} What stays: ${keeps.join(' ')} Nothing has changed yet.';
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final effects = [for (final e in (preview['effects'] as List? ?? const [])) '${(e as Map)['effect']}'];
    final keeps = [for (final k in (preview['unaffected'] as List? ?? const [])) '$k'];
    return Semantics(
      container: true,
      label: spoken(preview),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ExcludeSemantics(child: Text('Lockdown preview: nothing has changed yet', style: text.titleLarge)),
            const SizedBox(height: 8),
            ExcludeSemantics(child: Text('If you confirm', style: text.titleMedium)),
            for (var i = 0; i < effects.length; i++) ExcludeSemantics(child: Text('${i + 1}. ${effects[i]}', style: text.bodyLarge)),
            const SizedBox(height: 8),
            ExcludeSemantics(child: Text('What stays', style: text.titleMedium)),
            for (final k in keeps) ExcludeSemantics(child: Text('• $k', style: text.bodyLarge)),
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              FilledButton.icon(icon: const Icon(Icons.lock_rounded), label: const Text('Confirm Lockdown'), onPressed: busy ? null : onConfirm),
              OutlinedButton.icon(icon: const Icon(Icons.close_rounded), label: const Text('Cancel Lockdown Preview'), onPressed: busy ? null : onCancel),
            ]),
          ]),
        ),
      ),
    );
  }
}
