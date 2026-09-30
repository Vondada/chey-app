import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('office3d scenes use shared FPS-capped frameLoop and cheap renderer tune', () {
    final root = Directory.current.path.endsWith('chey-app-uijank') ||
            File('assets/office3d/che3d-agents.js').existsSync()
        ? '.'
        : '.';
    final agents = File('$root/assets/office3d/che3d-agents.js').readAsStringSync();
    expect(agents.contains('function frameLoop'), isTrue);
    expect(agents.contains('function tuneRenderer'), isTrue);
    expect(agents.contains('__che3dSetPaused'), isTrue);

    for (final name in [
      'index.html',
      'warroom.html',
      'theater.html',
      'artstudio.html',
      'musicstudio.html',
      'projects.html',
    ]) {
      final html = File('$root/assets/office3d/$name').readAsStringSync();
      expect(html.contains('Che3D.frameLoop'), isTrue, reason: '$name missing frameLoop');
      expect(html.contains('Che3D.tuneRenderer'), isTrue, reason: '$name missing tuneRenderer');
      expect(html.contains('PCFSoftShadowMap'), isFalse, reason: '$name still uses soft shadows');
      expect(html.contains('requestAnimationFrame(animate)'), isFalse, reason: '$name still uncapped rAF');
    }
  });
}
