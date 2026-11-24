# MOSS for Android

Two phone apps built from one shared module, mirroring the iPhone apps (`apps/ios`):

- `moss/`: **MOSS** (`com.waifucave.moss.android`), the bots.
- `code/`: **MOSS Code** (`com.waifucave.moss.code.android`), sessions with coding agents.
- `shared/`: the models, the `EngineClient` interface (the same calls and names as the iPhone's, so the shared core's binding
  fits both), `FakeEngineClient` with the iPhone fake's sample data, the faces (a port of the desktop kit, held to the
  JavaScript by `LivingBotsTest`), and every screen in Jetpack Compose and Material 3.

No networking yet: the screens run on the fake, as the iPhone's do. Nothing here asks for a fingerprint, a face or the device
credential.

## Building

Nothing is built on a developer Mac: `.github/workflows/android.yml` builds both apps on GitHub's Linux runners, runs the
tests and uploads a picture of every screen in light and dark (`android-pictures`). Locally, with a JDK 21 and the Android
SDK: `gradle -p apps/android :moss:assembleDebug :code:assembleDebug :shared:recordRoborazziDebug` (Gradle 8.13, the version
the workflow pins; no wrapper jar is committed).

For a picture of one state on a device, the activity takes the iPhone's launch arguments as extras, for example
`adb shell am start -n com.waifucave.moss.android/.MainActivity --es screen conversation --es scenario midTurn`.

## Minimum Android version: 8.0 (API 26)

- It covers practically every phone in use today: Google's own distribution figures put Android 8.0 and newer at well over
  ninety per cent of active devices (check the current figure in Android Studio's "API level distribution" before a release).
  Unlike the iPhone, Android phones stay on old versions for years, so the newest release alone would shut most people out.
- It is the floor the code needs without extra machinery: `java.time` (every time on screen) without desugaring, and adaptive
  launcher icons only, so the icons are two small vector files per app and no bitmaps.
- Going lower would buy little (a few per cent of phones, all past their last security update) and cost desugaring and
  bitmap icons. Predictive back needs Android 13 or newer; older phones get the plain back gesture, which the same code serves.
