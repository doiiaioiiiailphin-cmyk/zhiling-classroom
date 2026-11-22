import java.net.URI
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val packageJsonFile = rootProject.file("../package.json")
val appVersionName: String = run {
    val raw = if (packageJsonFile.isFile) packageJsonFile.readText(Charsets.UTF_8) else ""
    val m = Regex(""""version"\s*:\s*"([^"]+)"""").find(raw)
    m?.groupValues?.get(1) ?: "0.1.10"
}
val appVersionCode: Int = run {
    val parts = appVersionName.split(".").mapNotNull { it.filter(Char::isDigit).toIntOrNull() }
    val major = parts.getOrElse(0) { 0 }
    val minor = parts.getOrElse(1) { 1 }
    val patch = parts.getOrElse(2) { 0 }
    major * 10000 + minor * 100 + patch
}

val sherpaAarFile = file("libs/sherpa-onnx-static-link-onnxruntime-2.0.3.aar")
val sherpaAarUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/sherpa-onnx-static-link-onnxruntime-2.0.3.aar"
val sherpaAarSha256 = "7744a3a8f08f017d59c2d8ed8d9b700345561f5abe9f4e06dc6eaef3a0b977b4"

fun ensureSherpaAar() {
    if (sherpaAarFile.isFile && sherpaAarFile.length() > 10_000_000L) {
        return
    }
    sherpaAarFile.parentFile.mkdirs()
    val tmp = file("libs/sherpa-onnx-static-link-onnxruntime-2.0.3.aar.part")
    logger.lifecycle("Downloading sherpa-onnx Android AAR from $sherpaAarUrl ...")
    URI(sherpaAarUrl).toURL().openStream().use { input ->
        tmp.outputStream().use { output -> input.copyTo(output) }
    }
    val digest = MessageDigest.getInstance("SHA-256")
    tmp.inputStream().use { input ->
        val buf = ByteArray(65536)
        while (true) {
            val n = input.read(buf)
            if (n <= 0) break
            digest.update(buf, 0, n)
        }
    }
    val actual = digest.digest().joinToString("") { "%02x".format(it) }
    if (!actual.equals(sherpaAarSha256, ignoreCase = true)) {
        tmp.delete()
        throw GradleException("sherpa-onnx AAR SHA-256 mismatch: expected=$sherpaAarSha256 actual=$actual")
    }
    if (sherpaAarFile.exists()) sherpaAarFile.delete()
    tmp.renameTo(sherpaAarFile)
}

ensureSherpaAar()

val abiMode = (project.findProperty("zhilingAbis") as String?)
    ?.split(",")
    ?.map { it.trim() }
    ?.filter { it.isNotEmpty() }
    ?: listOf("arm64-v8a", "x86_64")

android {
    namespace = "com.zhiling.classroom"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.zhiling.classroom"
        minSdk = 29
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "APP_VERSION_NAME", "\"$appVersionName\"")
        buildConfigField("String", "CNB_REPO", "\"dolphin114/zhiling-classroom\"")

        ndk {
            abiFilters.clear()
            abiFilters.addAll(abiMode)
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("debug")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/INDEX.LIST",
                "META-INF/io.netty.versions.properties",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
            )
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

val syncWebDist by tasks.registering(Sync::class) {
    val distDir = rootProject.file("../dist")
    from(distDir)
    into(layout.projectDirectory.dir("src/main/assets/www"))
    onlyIf { distDir.isDirectory }
}

tasks.named("preBuild") {
    dependsOn(syncWebDist)
}

dependencies {
    implementation(files("libs/sherpa-onnx-static-link-onnxruntime-2.0.3.aar"))

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Embedded local HTTP/WS server running inside ForegroundService on 127.0.0.1
    val ktorVersion = "2.3.12"
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    implementation("io.ktor:ktor-server-cio:$ktorVersion")
    implementation("io.ktor:ktor-server-websockets:$ktorVersion")

    // Upstream cloud LLM / ASR / CNB updater HTTP + SSE + WS client
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
