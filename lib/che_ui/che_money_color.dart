// The money color rule (owner, 2026-10-26): profit is green, a loss is red, and break-even or unknown is gray.
// Every money figure in the app uses these, so the rule lives in one place.
import 'package:flutter/material.dart';

import 'che_futuristic.dart';

/// Gray for break-even, unknown or neutral money (balances that are not compared, fees, limits).
const Color cheMoneyGray = Color(0xFF8D96A3);

/// Green for profit, red for a loss, gray at zero or when there is no number.
Color cheMoneyColor(num? value) {
  if (value == null || value == 0) return cheMoneyGray;
  return value > 0 ? CheEnergy.green : CheEnergy.red;
}
