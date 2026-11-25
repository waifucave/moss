pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // Google's mirror of Maven Central, for Robolectric's artifacts only (the ones Central throttled on CI with 429):
        // every other group comes from Google's and Central's own repositories. Central stays as Robolectric's fallback.
        maven("https://maven-central.storage-download.googleapis.com/maven2") {
            name = "MavenCentralMirror"
            content { includeGroup("org.robolectric") }
        }
        mavenCentral()
    }
}

rootProject.name = "moss-android"
// The shared library (models, the engine client and its fake, every screen) and the two apps built from it.
include(":shared", ":moss", ":code")
// The real engine client over the shared core (native/phone-core), apart so :shared builds and tests without the native library.
include(":engine")
