import 'package:chey/che_model_selector.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const dolphin = 'Dolphin 3.0 1B (on this iPhone)';

  test('Offline with the model loaded answers on the phone, even with no internet', () {
    final c = chooseCheEngine(mode: CheModelMode.offline, internetAvailable: false, onDeviceReady: true, onDeviceName: dolphin);
    expect(c.engine, CheEngine.onDevice);
    expect(c.label, dolphin);
  });

  test('Offline with no model loaded refuses and never goes online', () {
    final c = chooseCheEngine(mode: CheModelMode.offline, internetAvailable: true, onDeviceReady: false, onDeviceName: dolphin);
    expect(c.engine, CheEngine.none);
    expect(c.reason, contains('Nothing was sent online'));
    expect(c.label, isEmpty);
  });

  test('Online with no internet refuses and does not silently use the phone', () {
    final c = chooseCheEngine(mode: CheModelMode.online, internetAvailable: false, onDeviceReady: true, onDeviceName: dolphin);
    expect(c.engine, CheEngine.none);
    expect(c.reason, contains('no internet connection'));
  });

  test('Online with internet answers from the online provider', () {
    final c = chooseCheEngine(mode: CheModelMode.online, internetAvailable: true, onDeviceReady: true, onDeviceName: dolphin, onlineName: 'Strong provider');
    expect(c.engine, CheEngine.online);
    expect(c.label, 'Strong provider');
  });

  test('Auto keeps an everyday turn on the phone, even when the internet is up', () {
    final c = chooseCheEngine(mode: CheModelMode.auto, internetAvailable: true, onDeviceReady: true, onDeviceName: dolphin);
    expect(c.engine, CheEngine.onDevice);
  });

  test('Auto sends a hard turn to the stronger provider when the internet is up', () {
    final c = chooseCheEngine(mode: CheModelMode.auto, internetAvailable: true, onDeviceReady: true, onDeviceName: dolphin, hardTurn: true, onlineName: 'Strong provider');
    expect(c.engine, CheEngine.online);
    expect(c.reason, contains('hard question'));
  });

  test('Auto keeps a hard turn on the phone when there is no internet', () {
    final c = chooseCheEngine(mode: CheModelMode.auto, internetAvailable: false, onDeviceReady: true, onDeviceName: dolphin, hardTurn: true);
    expect(c.engine, CheEngine.onDevice);
  });

  test('Auto with no model and no internet says nothing was answered', () {
    final c = chooseCheEngine(mode: CheModelMode.auto, internetAvailable: false, onDeviceReady: false, onDeviceName: dolphin);
    expect(c.engine, CheEngine.none);
    expect(c.reason, 'No internet and no offline model is loaded, so nothing was answered.');
  });

  test('Auto with no offline model uses the online provider, and says so', () {
    final c = chooseCheEngine(mode: CheModelMode.auto, internetAvailable: true, onDeviceReady: false, onDeviceName: dolphin, onlineName: 'Online provider');
    expect(c.engine, CheEngine.online);
    expect(c.reason, contains('no offline model is loaded'));
  });

  test('every choice names its engine in words, and the modes have their owner names', () {
    expect(cheModelModeName(CheModelMode.auto), 'Auto');
    expect(cheModelModeName(CheModelMode.offline), 'Offline');
    expect(cheModelModeName(CheModelMode.online), 'Online');
  });
}
