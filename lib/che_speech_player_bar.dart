// The audio player under a spoken CHE reply (owner, 2026-10-22). The same bar serves Chat and Read This, and every
// control has a spoken label for VoiceOver. It drives a [CheSpeechPlayback]; it never generates speech itself.
import 'package:flutter/material.dart';

import 'che_speech_playback.dart';
import 'che_ui/che_theme.dart';

/// m:ss, or "--:--" when the length is not known yet. Never a guessed time.
String cheSpeechClock(Duration? d) {
  if (d == null) return '--:--';
  final total = d.inSeconds < 0 ? 0 : d.inSeconds;
  final m = total ~/ 60;
  final s = (total % 60).toString().padLeft(2, '0');
  return '$m:$s';
}

/// What the owner is told after a seek or replay that could not happen as asked.
String cheSeekMessage(CheSeekResult result) => switch (result) {
      CheSeekResult.moved => '',
      CheSeekResult.unknownLength => 'CHE needs to play through the earlier part once before I can jump to this point.',
      CheSeekResult.audioMissing =>
        'That part of the reply is no longer kept. Press Play to make it again; this uses ElevenLabs credits.',
      CheSeekResult.unsupported => 'Seeking is not available on this iPhone build yet. Use Stop, then Play.',
    };

/// Shown on every bar: pausing never gives credits back.
const kCheSpeechCreditNote =
    'Audio that was already generated may have used ElevenLabs credits. Pausing, stopping or skipping does not refund them. Replaying kept audio and changing speed do not use credits.';

class CheSpeechPlayerBar extends StatelessWidget {
  const CheSpeechPlayerBar({super.key, required this.playback, this.label = "CHE's speech"});

  final CheSpeechPlayback playback;

  /// Names the reply for screen readers, e.g. "CHE's speech".
  final String label;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: playback,
      builder: (context, _) {
        final playing = playback.state == CheSpeechState.playing;
        final position = playback.position;
        final total = playback.total;
        final canPause = playback.player.capabilities.pause;
        final canSeek = playback.player.capabilities.seek;
        return Container(
          padding: const EdgeInsets.all(CheSpace.sm),
          decoration: BoxDecoration(
            color: CheColors.surface,
            borderRadius: BorderRadius.circular(CheRadius.lg),
            border: Border.all(color: CheColors.accent.withValues(alpha: 0.2)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                _button(
                  playing && canPause ? Icons.pause_rounded : Icons.play_arrow_rounded,
                  playing && canPause ? 'Pause $label.' : 'Play $label.',
                  () => playing ? playback.pause() : playback.play(),
                ),
                _button(Icons.stop_rounded, 'Stop $label completely.', playback.stop),
                _button(Icons.replay_rounded, 'Play $label from the beginning.', () => _report(playback.replay())),
                _button(Icons.fast_forward, 'Skip the rest of $label.', playback.skipRemaining),
              ]),
              Row(children: [
                for (final seconds in const [10, 15, 30])
                  _button(Icons.replay_rounded, 'Rewind $label $seconds seconds.',
                      () => _report(playback.seekBy(-Duration(seconds: seconds))), enabled: canSeek),
                for (final seconds in const [10, 15, 30])
                  _button(Icons.arrow_forward_rounded, 'Fast-forward $label $seconds seconds.',
                      () => _report(playback.seekBy(Duration(seconds: seconds))), enabled: canSeek),
              ]),
              Semantics(
                label: "$label position ${cheSpeechClock(position)} of ${cheSpeechClock(total)}",
                slider: true,
                value: '${cheSpeechClock(position)} of ${cheSpeechClock(total)}',
                child: Row(children: [
                  Text(cheSpeechClock(position), style: CheType.caption),
                  Expanded(
                    child: Slider(
                      value: _fraction(position, total),
                      // Dragging only moves the thumb; the seek happens when the owner lets go, once.
                      onChanged: canSeek && total != null ? (_) {} : null,
                      onChangeEnd: canSeek && total != null
                          ? (value) => _report(playback.seekTo(Duration(milliseconds: (total.inMilliseconds * value).round())))
                          : null,
                      activeColor: CheColors.accent,
                    ),
                  ),
                  Text(cheSpeechClock(total), style: CheType.caption),
                ]),
              ),
              Wrap(spacing: CheSpace.xs, runSpacing: CheSpace.xs, children: [
                for (final rate in kSpeechRates)
                  Semantics(
                    button: true,
                    selected: playback.rate == rate,
                    label: "Play $label at ${_rateWords(rate)} speed.",
                    excludeSemantics: true,
                    child: ChoiceChip(
                      label: Text('${_rateText(rate)}x'),
                      selected: playback.rate == rate,
                      onSelected: (_) => playback.setRate(rate),
                    ),
                  ),
              ]),
              Padding(
                padding: const EdgeInsets.only(top: CheSpace.xs),
                child: Text(_status(playback), style: CheType.caption),
              ),
              Text(kCheSpeechCreditNote, style: CheType.caption),
            ],
          ),
        );
      },
    );
  }

  // Messages are shown on screen. They are not spoken on their own (owner rule: no passive speech).
  void _report(Future<CheSeekResult> result) {
    result.then((value) {
      if (value != CheSeekResult.moved) playback.reportMessage(cheSeekMessage(value));
    });
  }

  static double _fraction(Duration? position, Duration? total) {
    if (position == null || total == null || total.inMilliseconds == 0) return 0;
    return (position.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0);
  }

  static String _rateText(double rate) => rate == rate.roundToDouble() ? rate.toStringAsFixed(1) : rate.toString();

  static String _rateWords(double rate) => switch (rate) {
        0.75 => 'zero point seven five times',
        1.0 => 'one times',
        1.25 => 'one point two five times',
        1.5 => 'one point five times',
        _ => 'two times',
      };

  String _status(CheSpeechPlayback p) {
    if (p.message.isNotEmpty) return p.message;
    return switch (p.state) {
      CheSpeechState.idle => 'Ready to play.',
      CheSpeechState.loading => 'Making the voice…',
      CheSpeechState.playing => 'Playing.',
      CheSpeechState.paused => 'Paused. Press Play to resume where you stopped.',
      CheSpeechState.stopped => 'Stopped. Play starts again from the top.',
      CheSpeechState.finished => 'Skipped to the end of this reply.',
    };
  }

  Widget _button(IconData icon, String semanticsLabel, VoidCallback? onTap, {bool enabled = true}) {
    return Expanded(
      child: Semantics(
        button: true,
        enabled: enabled,
        label: semanticsLabel,
        excludeSemantics: true,
        child: IconButton(
          tooltip: semanticsLabel,
          constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
          icon: Icon(icon),
          onPressed: enabled ? () => onTap?.call() : null,
        ),
      ),
    );
  }
}
