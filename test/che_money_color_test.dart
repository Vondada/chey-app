// The money color rule (owner, 2026-10-26): profit green, loss red, break-even or unknown gray.
import 'package:chey/che_ui/che_futuristic.dart';
import 'package:chey/che_ui/che_money_color.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('profit is green, a loss is red', () {
    expect(cheMoneyColor(12.5), CheEnergy.green);
    expect(cheMoneyColor(-0.01), CheEnergy.red);
    expect(cheMoneyColor(1000000), CheEnergy.green);
  });

  test('break-even and unknown money are gray', () {
    expect(cheMoneyColor(0), cheMoneyGray);
    expect(cheMoneyColor(0.0), cheMoneyGray);
    expect(cheMoneyColor(null), cheMoneyGray);
  });
}
