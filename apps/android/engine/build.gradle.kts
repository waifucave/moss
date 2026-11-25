import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The real engine client: the screens' `EngineClient` over the shared phone core (native/phone-core) and its Kotlin
// binding. A module of its own so :shared builds, and its JVM tests and pictures run, without the native library.
//
// The binding and the core's .so files are built in CI, never here (`.github/workflows/android-engine.yml`):
//   phonecore/kotlin/   `uniffi-bindgen generate --language kotlin` over the built library
//   phonecore/jniLibs/  `cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o phonecore/jniLibs build --release`
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.waifucave.moss.phone.engine"
    compileSdk = 35
    defaultConfig {
        minSdk = 26
        // :shared's real flavour: the engine client is the real build's alone.
        missingDimensionStrategy("engine", "real")
        consumerProguardFiles("consumer-rules.pro")
    }
    sourceSets["main"].java.srcDir("phonecore/kotlin")
    sourceSets["main"].jniLibs.srcDir("phonecore/jniLibs")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    api(project(":shared"))
    // The binding calls the core through JNA (the aar carries JNA's own native part for each ABI).
    implementation(libs.jna) { artifact { type = "aar" } }
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
