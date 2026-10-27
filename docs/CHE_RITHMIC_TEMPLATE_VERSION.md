# Rithmic login error 1084

Base commit: 0049056b5c57054b136e9d8fa1c24d49b09e9c87.

## Demonstrated cause

The live client called encodeLogin without templateVersion. Its empty default omitted protobuf field 153634 entirely. The old login fixture also omitted this field, so the regression test encoded the same defect. The owner's provider response was 1084, template version field missing; this is a protocol error, not proof of incorrect credentials.

The encoder now always emits field 153634 as a length-delimited string, default 3.9, and rejects an empty/malformed override. RithmicClient explicitly passes that constant. The byte sequence is 92 82 4b 03 33 2e 39: field 153634 / wire type 2 / length 3 / UTF-8 3.9. CHE app_version remains 1.0 in separate field 131803; app_name remains CHE; system_name remains the discovered Rithmic Paper Trading. Infrastructure remains ticker plant (1), with market-data subscription only and no order messages.

## Protocol evidence and limitation

The accessible request_login.proto schema copy defines template_id 154467, template_version string 153634, system_name 153628, app_name 130002, app_version 131803, infra_type 153621:

https://github.com/rundef/async_rithmic/blob/a985931ed1fb608d416ddf23ad92d789102bef47/async_rithmic/protocol_buffers/source/request_login.proto

That same client's plants/base.py supplies template_version 3.9. An independent client also supplies 3.9 in md_stream.py:

https://github.com/rayeni/python_rithmic_trading_app/blob/main/md_stream.py

These are public client/schema copies, not vendor-hosted official documentation. Rithmic's official API page directs developers to request its dev kit:

https://www.rithmic.com/apis

The owner's original licensed R | Protocol kit is not present in this workspace. Do not claim it was reread, or that these sources verify account/gateway conformance. The protocol field and value are corroborated by the accessible implementations; validation against the owner's original kit and actual gateway remains outstanding.

## Error handling and scope

1084/template-version refusals are now classified as protocolVersion, application identity refusals separately, and an unknown rejection no longer asserts a bad password. Rejected login closes the socket and never sends a market-data subscription. Gateway must be secure wss, without embedded credentials/query/fragment; app/system identity must be present before opening it. Discovery, current contract selection, on-device vault and owner credential values are preserved. App identity registration and gateway/account entitlements are not verified by a correctly encoded frame.

## Verification

Updated independent wire fixture; empty version refusal; actual client-sent fake-socket login frame checks; simulated 1084 must close and not subscribe; identity and unknown-error classification. Full Flutter analysis/tests and required CI must pass before merge. No real account login, entitlement, trade or fill is claimed. The fix is Flutter/Dart only: delivery uses the existing compatible Shorebird workflow, and physical iPhone reconnection is required. A Worker redeploy alone cannot deliver this native-client change.
