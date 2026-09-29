import groovy.json.JsonSlurper
import java.io.File
import java.io.FileInputStream
import java.util.Properties

// Firebase settings come from app/google-services.json (downloaded from the
// Firebase console, not committed). Instead of the google-services Gradle
// plugin, the few values Firebase reads at start-up are turned into string
// resources here. Without the file the app builds as before and simply keeps
// using its own delivery socket.
val firebaseValues: Map<String, String> = run {
	val file = rootProject.file("app/google-services.json")
	if (!file.exists()) return@run emptyMap()
	@Suppress("UNCHECKED_CAST")
	val json = JsonSlurper().parse(file) as Map<String, Any?>
	val project = json["project_info"] as Map<String, Any?>
	val clients = json["client"] as List<Map<String, Any?>>
	val client = clients.first { c ->
		val info = c["client_info"] as Map<String, Any?>
		val android = info["android_client_info"] as Map<String, Any?>
		android["package_name"] == "com.frontierx.app"
	}
	val info = client["client_info"] as Map<String, Any?>
	val keys = client["api_key"] as List<Map<String, Any?>>
	mapOf(
		"google_app_id" to info["mobilesdk_app_id"].toString(),
		"gcm_defaultSenderId" to project["project_number"].toString(),
		"google_api_key" to keys.first()["current_key"].toString(),
		"project_id" to project["project_id"].toString(),
		"google_storage_bucket" to (project["storage_bucket"] ?: "").toString(),
	)
}

plugins {
	// AGP 9 provides built-in Kotlin compilation; no separate Kotlin plugin needed.
	id("com.android.application")
}

android {
	namespace = "com.frontierx.app"
	compileSdk = 36

	defaultConfig {
		applicationId = "com.frontierx.app"
		minSdk = 26
		targetSdk = 36
		versionCode = 15
		versionName = "0.3.0"

		for ((name, value) in firebaseValues) resValue("string", name, value)

		// Single modern 64-bit ARM architecture only.
		ndk {
			abiFilters += listOf("arm64-v8a")
		}
	}

	signingConfigs {
		create("release") {
			val propsFile = rootProject.file("keystore.properties")
			if (propsFile.exists()) {
				val props = Properties()
				val stream = FileInputStream(propsFile)
				props.load(stream)
				stream.close()
				storeFile = File(props.getProperty("storeFile"))
				storePassword = props.getProperty("storePassword")
				keyAlias = props.getProperty("keyAlias")
				keyPassword = props.getProperty("keyPassword")
			}
		}
	}
	buildTypes {
		getByName("release") {
			signingConfig = signingConfigs.getByName("release")
			isMinifyEnabled = false
			proguardFiles(
				getDefaultProguardFile("proguard-android-optimize.txt"),
				"proguard-rules.pro",
			)
		}
	}

	buildFeatures {
		resValues = true
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}
}

dependencies {
	implementation("androidx.appcompat:appcompat:1.7.0")
	implementation("androidx.core:core-ktx:1.13.1")
	// UnifiedPush: background delivery through a distributor app such as ntfy.
	implementation("org.unifiedpush.android:connector:3.3.3")
	implementation("com.squareup.okhttp3:okhttp:4.12.0")
	// Firebase Cloud Messaging: background delivery without a persistent socket.
	implementation("com.google.firebase:firebase-messaging:24.1.0")
	// Tells whether the phone has Google services at all (otherwise: own socket).
	implementation("com.google.android.gms:play-services-base:18.5.0")
}