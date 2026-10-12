plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseStore = providers.environmentVariable("ROOMILLION_ANDROID_KEYSTORE").orNull
val releaseStorePassword = providers.environmentVariable("ROOMILLION_ANDROID_STORE_PASSWORD").orNull
val releaseAlias = providers.environmentVariable("ROOMILLION_ANDROID_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("ROOMILLION_ANDROID_KEY_PASSWORD").orNull
val signingVariablesPresent = !releaseStore.isNullOrBlank() && !releaseStorePassword.isNullOrBlank() &&
    !releaseAlias.isNullOrBlank() && !releaseKeyPassword.isNullOrBlank()
val releaseStoreExists = !releaseStore.isNullOrBlank() && file(releaseStore).isFile
val releaseSigningReady = signingVariablesPresent && releaseStoreExists
val androidVersionCodeText = providers.gradleProperty("roomillionAndroidVersionCode").orNull
val androidVersionCode = androidVersionCodeText?.toIntOrNull() ?: if (androidVersionCodeText == null) 2 else error("Android versionCode 必须是正整数")
require(androidVersionCode > 0) { "Android versionCode 必须是正整数" }
val androidVersionName = providers.gradleProperty("roomillionAndroidVersionName").orNull ?: "0.1.1"
require(androidVersionName.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?"))) {
    "Android versionName 必须是语义版本号"
}
gradle.taskGraph.whenReady {
    val releaseArtifactTasks = setOf("assembleRelease", "bundleRelease", "packageRelease", "packageReleaseBundle")
    if (allTasks.any { it.project == project && it.name in releaseArtifactTasks }) {
        require(signingVariablesPresent) {
            "正式 Android 构建需要本地签名环境变量：ROOMILLION_ANDROID_KEYSTORE、ROOMILLION_ANDROID_STORE_PASSWORD、ROOMILLION_ANDROID_KEY_ALIAS、ROOMILLION_ANDROID_KEY_PASSWORD"
        }
        require(releaseStoreExists) { "Android 签名文件不存在" }
    }
}

android {
    namespace = "io.roomillion.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.roomillion.android"
        minSdk = 31
        targetSdk = 36
        versionCode = androidVersionCode
        versionName = androidVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    signingConfigs {
        if (releaseSigningReady) create("roomillionRelease") {
            storeFile = file(releaseStore!!)
            storePassword = releaseStorePassword
            keyAlias = releaseAlias
            keyPassword = releaseKeyPassword
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("roomillionRelease")
        }
    }
    sourceSets.getByName("androidTest").assets.srcDir("../../resources/examples")
    sourceSets.getByName("androidTest").assets.srcDir("build/generated/androidTestAssets")
    sourceSets.getByName("main").assets.srcDir("build/generated/androidAssets")
}

val desktopTransferFixture = tasks.register<Exec>("buildDesktopTransferFixture") {
    workingDir = rootProject.projectDir.parentFile
    commandLine("node", "scripts/android-test-transfer-fixture.cjs")
}
val lanRoomFixture = tasks.register<Exec>("buildLanRoomFixture") {
    workingDir = rootProject.projectDir.parentFile
    commandLine("node", "scripts/build-lan-test-room.cjs")
}
tasks.matching { it.name == "mergeDebugAndroidTestAssets" }.configureEach { dependsOn(lanRoomFixture) }
tasks.matching { it.name == "mergeDebugAndroidTestAssets" }.configureEach { dependsOn(desktopTransferFixture) }

val androidModuleAssets = tasks.register<Exec>("stageAndroidModuleAssets") {
    workingDir = rootProject.projectDir.parentFile
    commandLine("node", "scripts/android-stage-room-modules.cjs")
}
val bundledExampleAssets = tasks.register<Exec>("stageAndroidBundledExamples") {
    workingDir = rootProject.projectDir.parentFile
    commandLine("node", "scripts/android-stage-bundled-examples.cjs")
}
val aiProviderAssets = tasks.register<Exec>("stageAndroidAiProviders") {
    workingDir = rootProject.projectDir.parentFile
    commandLine("node", "scripts/android-stage-ai-providers.cjs")
}
val agentAssets = tasks.register<Exec>("stageAndroidAgent") {
    dependsOn(androidModuleAssets)
    workingDir = rootProject.projectDir.parentFile
    commandLine("node", "scripts/android-stage-agent.cjs")
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") && !it.name.contains("AndroidTest") }
    .configureEach { dependsOn(androidModuleAssets, bundledExampleAssets, aiProviderAssets, agentAssets) }

dependencies {
    implementation("androidx.webkit:webkit:1.16.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
}
