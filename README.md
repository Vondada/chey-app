# Chey

Chey is a Flutter application prepared for reproducible Android and iOS builds on
[Codemagic](https://codemagic.io/).

## Local development

Install the current stable [Flutter SDK](https://docs.flutter.dev/get-started/install),
then bootstrap the native projects and run the app:

```sh
./tool/bootstrap.sh
flutter run
```

The bootstrap script creates the generated Android and iOS runner projects when
they are absent. Keeping those generated projects out of source control makes the
initial scaffold small while still allowing Codemagic and local developers to
produce consistent runners from the selected Flutter SDK.

Run the same checks as CI with:

```sh
flutter pub get
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

## Codemagic

1. Add this repository as an application in Codemagic.
2. Select **Flutter App** and choose configuration from `codemagic.yaml`.
3. Start the **Chey Android and iOS** workflow (`chey-mobile`).

The workflow uses Codemagic's stable Flutter channel, runs formatting, analysis,
and tests, and then produces:

- a release Android APK; and
- an unsigned release iOS `.app` bundle.

These unsigned artifacts intentionally require no secrets, so a new repository
can verify the complete build immediately. Before publishing, configure Android
and Apple signing integrations in Codemagic and replace the unsigned build steps
with signed AAB and IPA builds.

## Project layout

```text
lib/                 Application source
test/                Widget tests
tool/bootstrap.sh    Native project generator
codemagic.yaml       CI workflow
```
