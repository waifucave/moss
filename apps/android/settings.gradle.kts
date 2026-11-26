pluginManagement {
    repositories {
        google()
        // Kotlin's plugins come from Maven Central only (its Google mirror first, against Central's 429s on CI, then Central
        // itself), never the Gradle Plugin Portal: the Portal serves its own plugin marker poms, whose bytes differ from
        // Central's (org.jetbrains.kotlin.android and .plugin.compose 2.1.20), so a run that fell through to it failed
        // dependency verification. One repository per plugin: what verification-metadata.xml recorded.
        maven("https://maven-central.storage-download.googleapis.com/maven2") {
            name = "MavenCentralMirror"
            content { includeGroupByRegex("org\\.jetbrains\\.kotlin(\\..*)?") }
        }
        mavenCentral()
        gradlePluginPortal {
            content { excludeGroupByRegex("org\\.jetbrains\\.kotlin(\\..*)?") }
        }
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
