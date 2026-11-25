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
        // Google's mirror of Maven Central (the same artifacts and checksums), before Central itself: Central throttles the
        // shared CI runners' addresses with 429. Central stays as the fallback.
        maven("https://maven-central.storage-download.googleapis.com/maven2") { name = "MavenCentralMirror" }
        mavenCentral()
    }
}

rootProject.name = "moss-android"
// The shared library (models, the engine client and its fake, every screen) and the two apps built from it.
include(":shared", ":moss", ":code")
// The real engine client over the shared core (native/phone-core), apart so :shared builds and tests without the native library.
include(":engine")
