import 'package:flutter_test/flutter_test.dart';
import 'package:chey/create/che_scene_voice.dart';

void main() {
  test('"open the creation room" and similar phrases open the project list', () {
    for (final said in ['open the creation room', 'che, open the creation room', 'show my projects', 'open create studio', 'go to scene projects']) {
      expect(sceneVoiceRoute(said), SceneVoiceRoute.projects, reason: said);
    }
  });

  test('"open my last project" opens the newest saved project', () {
    for (final said in ['open my last project', 'che, open my last project', 'resume last character', 'continue my last scene']) {
      expect(sceneVoiceRoute(said), SceneVoiceRoute.lastProject, reason: said);
    }
  });

  test('"create a character" opens the character editor with a new person', () {
    for (final said in ['create a character', 'che, create a character', 'make me a new person', 'build a human', 'create an avatar']) {
      expect(sceneVoiceRoute(said), SceneVoiceRoute.newCharacter, reason: said);
    }
  });

  test('other requests, and a project mentioned in passing, are not Create Studio routes', () {
    for (final said in ['create a cube', 'show me my renders', 'what is my last project worth', 'open the creative studio', 'open the creation room tomorrow']) {
      expect(sceneVoiceRoute(said), isNull, reason: said);
    }
  });
}
