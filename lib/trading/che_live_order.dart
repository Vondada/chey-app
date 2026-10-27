// The Live Order Preview (owner, 2026-10-23): what a real-money order WOULD be, and the gates it must pass.
//
// Real-money submission is DISABLED. [kCheLiveOrderSubmissionEnabled] is a compile-time false and there is
// no network send path anywhere in this file: CHE's Rithmic connection is the ticker plant only (market
// data, lib/rithmic/rithmic_wire.dart has no order message), and order routing needs Rithmic's conformance
// approval plus the prop firm's permission (docs/CHE_FYE_RITHMIC_ORDER_ENTRY.md). Even once those exist,
// every order needs its own fresh Face ID check (never a cached session), a preview, and an explicit
// approval; nothing switches a paper trade to live by itself. Broker acknowledgments, order IDs, fills and
// rejections are shown only from a broker's own response; without one the screen says "not supported yet".
// Every preview, approval and refusal is appended to an on-device audit log that has no delete.
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'che_account_kind.dart';
import 'che_trade_compare.dart';

/// Real-money order submission. False until broker authorization, risk controls and end-to-end
/// execution testing are verified, and changing it is a reviewed code change, never a setting.
const bool kCheLiveOrderSubmissionEnabled = false;

/// Why a live order cannot be sent today, in the owner's words.
const String kCheLiveOrderDisabledReason =
    'Live order submission is disabled. CHE\'s Rithmic connection reads market data only; sending orders needs '
    'Rithmic order-routing approval, FundYourEdge\'s permission, risk limits and end-to-end testing. Nothing was sent.';

/// Estimated round-turn costs per contract, USD. Estimates for the preview only, labelled as estimates.
/// Exchange + clearing + NFA + typical broker commission; the owner's firm may charge differently.
const kCheEstimatedRoundTurnFee = <String, double>{'MNQ': 1.24, 'MES': 1.24, 'NQ': 4.24, 'ES': 4.24};

class CheLiveOrderTicket {
  const CheLiveOrderTicket({
    required this.accountName,
    required this.contract,
    required this.side,
    required this.qty,
    required this.entry,
    this.stop,
    this.target,
    this.orderType = 'limit',
  });

  /// The account the order would go to, e.g. "FundYourEdge (Rithmic)". Always shown with LIVE ACCOUNT.
  final String accountName;
  final String contract, side, orderType;
  final int qty;
  final double entry;
  final double? stop, target;

  CheAccountKind get account => CheAccountKind.live;
  String get root => cheContractRoot(contract);
  double? get pointValue => kChePointValue[root];

  double? get dollarRisk => stop == null || pointValue == null ? null : (entry - stop!).abs() * qty * pointValue!;
  double? get dollarReward => target == null || pointValue == null ? null : (target! - entry).abs() * qty * pointValue!;
  double? get riskReward => dollarRisk == null || dollarReward == null || dollarRisk == 0 ? null : dollarReward! / dollarRisk!;
  double? get estimatedFees => kCheEstimatedRoundTurnFee[root] == null ? null : kCheEstimatedRoundTurnFee[root]! * qty;

  /// Problems that block even an approval: a stop on the wrong side, no stop at all, a bad size.
  List<String> get problems {
    final out = <String>[];
    final long = side.toLowerCase() == 'buy' || side.toLowerCase() == 'long';
    if (qty < 1) out.add('Quantity must be at least 1 contract.');
    if (pointValue == null) out.add('CHE does not know the $contract contract multiplier, so the dollar risk is unknown.');
    if (stop == null) {
      out.add('Every live order needs a stop loss.');
    } else if (long ? stop! >= entry : stop! <= entry) {
      out.add('The stop is on the wrong side of the entry for a ${long ? 'buy' : 'sell'}.');
    }
    if (target != null && (long ? target! <= entry : target! >= entry)) out.add('The target is on the wrong side of the entry.');
    return out;
  }

  Map<String, dynamic> toJson() => {
        'account': accountName,
        'contract': contract,
        'side': side,
        'qty': qty,
        'entry': entry,
        'stop': stop,
        'target': target,
        'order_type': orderType,
        'dollar_risk': dollarRisk,
        'estimated_fees': estimatedFees,
      };
}

/// What a broker said about an order. Built only from a broker's own response; CHE never fills one in.
class CheBrokerResponse {
  const CheBrokerResponse({this.supported = false, this.acknowledged = false, this.orderId, this.status, this.fills = const [], this.rejection, this.raw});

  /// No broker order path exists yet, so there is nothing to show.
  static const notSupported = CheBrokerResponse();

  final bool supported, acknowledged;
  final String? orderId, status, rejection;
  final List<Map<String, dynamic>> fills;
  final Map<String, dynamic>? raw;

  String get summary {
    if (!supported) return 'Broker acknowledgment, order ID, fills and rejections: not supported yet. No broker order connection exists.';
    if (rejection != null) return 'Rejected by the broker: $rejection';
    if (!acknowledged) return 'No broker acknowledgment received. Do not assume the order exists.';
    return 'Broker acknowledged order ${orderId ?? '(no ID given)'}${status == null ? '' : ', status $status'}${fills.isEmpty ? ', no fills yet' : ', ${fills.length} fill(s)'}.';
  }
}

enum CheLiveOrderStep { previewed, faceIdPassed, faceIdFailed, blocked, refusedDisabled }

class CheLiveOrderOutcome {
  const CheLiveOrderOutcome({required this.sent, required this.step, required this.message, this.broker = CheBrokerResponse.notSupported});
  final bool sent;
  final CheLiveOrderStep step;
  final String message;
  final CheBrokerResponse broker;
}

/// Append-only audit of live-order previews, Face ID results, approvals and refusals. There is no
/// remove or clear: entries are only added, and the newest [maxEntries] are kept on the phone.
class CheLiveOrderAudit {
  CheLiveOrderAudit({this.storageKey = 'che_live_order_audit_v1', this.maxEntries = 500});

  final String storageKey;
  final int maxEntries;

  Future<List<Map<String, dynamic>>> entries() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return [
        for (final line in prefs.getStringList(storageKey) ?? const <String>[])
          if (jsonDecode(line) case final Map m) Map<String, dynamic>.from(m),
      ];
    } catch (_) {
      return const [];
    }
  }

  Future<void> append(String event, Map<String, dynamic> details, {DateTime? at}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final list = [...prefs.getStringList(storageKey) ?? const <String>[]];
      list.add(jsonEncode({'at': (at ?? DateTime.now().toUtc()).toIso8601String(), 'event': event, 'account': CheAccountKind.live.label, ...details}));
      await prefs.setStringList(storageKey, list.length > maxEntries ? list.sublist(list.length - maxEntries) : list);
    } catch (_) {}
  }
}

typedef CheFaceIdCheck = Future<bool> Function(String reason);

/// The gate every real-money order goes through. Face ID is asked for EACH order with a fresh prompt;
/// a passed check is never reused for another order. Submission stays refused while disabled.
class CheLiveOrderGate {
  CheLiveOrderGate({required this.faceId, CheLiveOrderAudit? audit, this.submissionEnabled = kCheLiveOrderSubmissionEnabled})
      : audit = audit ?? CheLiveOrderAudit();

  final CheFaceIdCheck faceId;
  final CheLiveOrderAudit audit;

  /// Tests may pass true to prove the Face ID step still runs per order; the app always uses the constant.
  final bool submissionEnabled;

  Future<void> recordPreview(CheLiveOrderTicket t) => audit.append('preview', {'ticket': t.toJson()});

  /// The owner pressed Approve on this one ticket. Runs the checks in order and reports what happened.
  Future<CheLiveOrderOutcome> approve(CheLiveOrderTicket t) async {
    final problems = t.problems;
    if (problems.isNotEmpty) {
      await audit.append('blocked', {'ticket': t.toJson(), 'problems': problems});
      return CheLiveOrderOutcome(sent: false, step: CheLiveOrderStep.blocked, message: 'Not sent: ${problems.join(' ')}');
    }
    final ok = await faceId(
        'Face ID for one LIVE ACCOUNT order: ${t.side.toUpperCase()} ${t.qty} ${t.contract} at ${t.entry}${t.stop == null ? '' : ', stop ${t.stop}'}');
    if (!ok) {
      await audit.append('face_id_failed', {'ticket': t.toJson()});
      return const CheLiveOrderOutcome(sent: false, step: CheLiveOrderStep.faceIdFailed, message: 'Face ID did not pass. Nothing was sent.');
    }
    await audit.append('face_id_passed', {'ticket': t.toJson()});
    if (!submissionEnabled) {
      await audit.append('refused_disabled', {'ticket': t.toJson(), 'reason': kCheLiveOrderDisabledReason});
      return const CheLiveOrderOutcome(sent: false, step: CheLiveOrderStep.refusedDisabled, message: kCheLiveOrderDisabledReason);
    }
    // No broker order path exists. Even with the flag on, nothing is sent and nothing is claimed.
    await audit.append('refused_no_broker', {'ticket': t.toJson()});
    return const CheLiveOrderOutcome(
        sent: false, step: CheLiveOrderStep.refusedDisabled, message: 'No broker order connection exists, so nothing was sent.');
  }
}
