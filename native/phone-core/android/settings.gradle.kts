// The Android proof (lane PC, proof B): a library module with the generated bindings and the core's .so, and an
// instrumented test run in an emulator on GitHub's Linux runner (.github/workflows/phone-core.yml).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "moss-phone-core"
