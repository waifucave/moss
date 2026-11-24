import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.waifucave.moss.code.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.waifucave.moss.code.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    // Which engine client the app runs on: `real`, the shared core over the link to the person's computer (anything a
    // person runs), or `fake`, the in-memory sample (pictures of a running app, no native library needed).
    flavorDimensions += "engine"
    productFlavors {
        create("real") { dimension = "engine" }
        create("fake") { dimension = "engine" }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":shared"))
    "realImplementation"(project(":engine"))
    // The real build's instrumented proof in an emulator (.github/workflows/android-engine.yml).
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}
