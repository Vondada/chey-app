import 'package:flutter_test/flutter_test.dart';
import 'package:chey/create/che_scene_preview_model.dart';

/// The Worker's GET /api/scene/latest body for the owner's test sentence (scene_director.sceneFromWords output).
Map<String, dynamic> latest({List<double> offset = const [0, 0]}) => {
      'ok': true,
      'project_id': 'scp_0123456789abcdef',
      'title': 'Nova in the office',
      'version': 2,
      'spec': {
        'v': 1,
        'seconds': 11.1,
        'set': {'kind': 'office', 'light': 'sunset'},
        'seats': {
          'owner': [0.55, 0.3, 0],
          'guest': [-0.55, 0.3, 0],
        },
        'actors': [
          {'id': 'nova', 'model': 'assets/characters/crew/nova.glb', 'start': [-4.4, 0.4, -90], 'cloth': null, 'offset': offset},
        ],
        'timeline': [
          {'actor': 'nova', 'action': 'walk', 'to': [-0.55, 0.3], 't0': 0, 't1': 3.5},
          {'actor': 'nova', 'action': 'sit', 'seat': 'guest', 't0': 3.5, 't1': 5},
          {'actor': 'nova', 'action': 'talk', 'line': 'Hey! I made it.', 't0': 5, 't1': 10.6},
        ],
      },
      'renders': [
        {'job': 'scj_x', 'version': 2, 'status': 'queued', 'media_id': null, 'seconds': null},
      ],
    };

void main() {
  test('the latest scene parses, and an empty answer is no scene', () {
    final spec = ScenePreviewSpec.fromLatest(latest())!;
    expect([spec.projectId, spec.version, spec.seconds, spec.light], ['scp_0123456789abcdef', 2, 11.1, 'sunset']);
    expect(spec.actors.single.name, 'Nova');
    expect(spec.timeline.map((s) => s.action), ['walk', 'sit', 'talk']);
    expect(ScenePreviewSpec.fromLatest({'ok': false, 'detail': 'There is no scene yet.'}), isNull);
  });

  test('timeline to pose: Nova walks from the door, turns into the chair, sits, and talks while seated', () {
    final spec = ScenePreviewSpec.fromLatest(latest())!;
    final start = spec.poseAt('nova', 0);
    expect([start.x, start.y, start.clip], [-4.4, 0.4, 'walk']);
    final half = spec.poseAt('nova', 1.75);
    expect(half.clip, 'walk');
    expect(half.x, closeTo((-4.4 + -0.55) / 2, 1e-9), reason: 'halfway along the straight walk');
    expect(half.clipTime, closeTo(1.75, 1e-9));
    expect(half.heading, closeTo(headingTo(-4.4, 0.4, -0.55, 0.3), 1e-9), reason: 'facing where she walks, as the renderer turns her');
    final sitting = spec.poseAt('nova', 4);
    expect([sitting.clip, sitting.seated, sitting.x, sitting.y], ['sit', true, -0.55, 0.3]);
    expect(sitting.heading, closeTo(0, 1e-9), reason: 'turned to the chair\'s heading after the short turn');
    final talking = spec.poseAt('nova', 7);
    expect([talking.clip, talking.seated, talking.line], ['sit', true, 'Hey! I made it.'], reason: 'she talks from her chair, so the sit is held');
    expect(talking.clipTime, greaterThanOrEqualTo(cheSceneHoldEnd));
    expect(spec.poseAt('nova', 11).clip, 'sit', reason: 'after the last step she stays seated');
  });

  test('a touch move shifts her walk and her chair, never the doorway', () {
    final spec = ScenePreviewSpec.fromLatest(latest(offset: [-0.5, 0]))!;
    expect(spec.poseAt('nova', 0).x, -4.4);
    expect(spec.poseAt('nova', 4).x, closeTo(-1.05, 1e-9));
  });

  test('a tap selects the actor that owns the hit mesh; props and empty space select nobody', () {
    expect(cheSceneActorFromNodeNames(['Body_mesh', 'Armature', '', 'actor:nova']), 'nova');
    expect(cheSceneActorFromNodeNames(['ring:nova', 'actor:nova']), 'nova');
    expect(cheSceneActorFromNodeNames(['chair:guest']), isNull);
    expect(cheSceneActorFromNodeNames(const []), isNull);
    expect(cheSceneActorFromNodeNames(['actor:']), isNull);
  });

  test('touch controls send the same words the Scene Director understands by voice', () {
    final nova = ScenePreviewSpec.fromLatest(latest())!.actors.single;
    const atlas = SceneActor(id: 'atlas', model: 'assets/characters/crew/atlas.glb', start: [0, 0, 0]);
    expect(SceneEditWords.outfit(nova, 'red'), 'make her outfit red');
    expect(SceneEditWords.outfit(atlas, 'black'), 'make his outfit black');
    expect(SceneEditWords.move(nova, 'left'), 'move her left');
    expect(SceneEditWords.size(atlas, bigger: true), 'make him bigger');
    expect(SceneEditWords.light('sunset'), 'relight the office for sunset');
    expect(SceneEditWords.light('warm'), 'relight the office warm');
  });

  test('every preview action has words: play, pause, seek, select, read, options and scene edits', () {
    final spec = ScenePreviewSpec.fromLatest(latest())!;
    ScenePreviewVoice? kind(String s) => scenePreviewCommand(s, spec)?.kind;
    expect(kind('play'), ScenePreviewVoice.play);
    expect(kind('Che, pause.'), ScenePreviewVoice.pause);
    expect(scenePreviewCommand('go to 5 seconds', spec)?.seconds, 5);
    expect(scenePreviewCommand('jump to seven', spec)?.seconds, 7);
    expect(scenePreviewCommand('go to the start', spec)?.seconds, 0);
    expect(scenePreviewCommand('go to the end', spec)?.seconds, 11.1);
    expect(scenePreviewCommand('select Nova', spec)?.actor, 'nova');
    expect(kind('select Orion'), isNull, reason: 'not in this scene');
    expect(kind('clear the selection'), ScenePreviewVoice.deselect);
    expect(kind('read the scene'), ScenePreviewVoice.read);
    expect(kind("what's on screen"), ScenePreviewVoice.read);
    expect(kind('options'), ScenePreviewVoice.options);
    for (final edit in ['make her outfit red', 'move him left', 'make him bigger', 'relight the office for sunset', 'undo', 'is my scene ready', 'make the camera circle around us']) {
      final c = scenePreviewCommand(edit, spec);
      expect([c?.kind, c?.words], [ScenePreviewVoice.edit, edit], reason: edit);
    }
    expect(kind('what is the weather tomorrow'), isNull, reason: 'other words go to the chat');
  });

  test('the numbered options are read aloud and chosen by number', () {
    final spec = ScenePreviewSpec.fromLatest(latest())!;
    final options = scenePreviewOptions(spec);
    expect(options.take(4), ['play the scene', 'pause', 'go to the start', 'select nova']);
    expect(scenePreviewCommand('option 1', spec)?.kind, ScenePreviewVoice.play);
    expect(scenePreviewCommand('option four', spec)?.actor, 'nova');
    expect(scenePreviewCommand('number ${options.indexOf('undo') + 1}', spec)?.words, 'undo');
    expect(scenePreviewCommand('option 40', spec)?.kind, ScenePreviewVoice.options, reason: 'out of range: the list is read again');
    for (final o in options) {
      expect(scenePreviewCommand(o, spec), isNotNull, reason: 'every option is a command: $o');
    }
  });

  test('spec coordinates map into the y-up 3D view', () {
    expect(cheSceneToView(1, 2, 3), [1, 3, -2]);
  });
}
