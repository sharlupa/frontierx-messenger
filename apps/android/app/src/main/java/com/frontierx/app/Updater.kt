package com.frontierx.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

// In-app updates for the Android build.
//
// The API exposes GET /api/updates/latest?platform=android&version=..&versionCode=..
// which returns the newest published release. When a newer build exists the
// user is asked once per version, the APK is downloaded with a progress
// notification, verified against its sha256 and handed to the package
// installer through a FileProvider URI.
object Updater {
    private const val TAG = "FrontierXUpdater"
    private const val PREFS = "frontierx.updates"
    private const val KEY_SKIPPED = "skipped_version"
    private const val KEY_LAST_CHECK = "last_check"
    private const val CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L

    data class Release(
        val version: String,
        val versionCode: Long,
        val url: String,
        val size: Long,
        val sha256: String,
        val notes: String,
        val mandatory: Boolean,
    )

    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var downloading = false

    fun currentVersionName(context: Context): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"
        } catch (err: PackageManager.NameNotFoundException) {
            "0"
        }
    }

    fun currentVersionCode(context: Context): Long {
        return try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
            else @Suppress("DEPRECATION") info.versionCode.toLong()
        } catch (err: PackageManager.NameNotFoundException) {
            0L
        }
    }

    // Called on startup. Throttled so the app does not hit the API on every
    // resume, and silent on any failure: updates must never block usage.
    fun checkOnStart(activity: Activity, baseUrl: String) {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val last = prefs.getLong(KEY_LAST_CHECK, 0L)
        if (now - last < CHECK_INTERVAL_MS) return
        prefs.edit().putLong(KEY_LAST_CHECK, now).apply()
        check(activity, baseUrl) { release ->
            if (release == null) return@check
            if (activity.isFinishing || activity.isDestroyed) return@check
            val skipped = prefs.getString(KEY_SKIPPED, "") ?: ""
            if (!release.mandatory && skipped == release.version) return@check
            prompt(activity, release)
        }
    }

    fun check(context: Context, baseUrl: String, onResult: (Release?) -> Unit) {
        val appContext = context.applicationContext
        Thread {
            val release = try {
                fetchLatest(appContext, baseUrl)
            } catch (err: Exception) {
                Log.w(TAG, "update check failed: " + err.message)
                null
            }
            main.post { onResult(release) }
        }.start()
    }

    private fun fetchLatest(context: Context, baseUrl: String): Release? {
        val base = baseUrl.trimEnd('/')
        val target = base + "/api/updates/latest?platform=android" +
            "&version=" + Uri.encode(currentVersionName(context)) +
            "&versionCode=" + currentVersionCode(context)
        val connection = URL(target).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 15000
        connection.readTimeout = 15000
        connection.setRequestProperty("accept", "application/json")
        try {
            if (connection.responseCode !in 200..299) return null
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            if (!json.optBoolean("updateAvailable", false)) return null
            val latest = json.optJSONObject("latest") ?: return null
            val rawUrl = latest.optString("url", "")
            if (rawUrl.isBlank()) return null
            val absolute = if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) rawUrl
            else base + (if (rawUrl.startsWith("/")) rawUrl else "/" + rawUrl)
            return Release(
                version = latest.optString("version", ""),
                versionCode = latest.optLong("versionCode", 0L),
                url = absolute,
                size = latest.optLong("size", 0L),
                sha256 = latest.optString("sha256", ""),
                notes = latest.optString("notes", ""),
                mandatory = latest.optBoolean("mandatory", false),
            )
        } finally {
            connection.disconnect()
        }
    }

    fun prompt(activity: Activity, release: Release) {
        UpdateDialog.show(activity, release)
    }

    internal fun skipVersion(context: Context, version: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SKIPPED, version)
            .apply()
    }

    // Android 8+ needs an explicit "install unknown apps" grant before the
    // package installer can be launched from inside the app.
    internal fun ensureInstallPermission(activity: Activity): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        if (activity.packageManager.canRequestPackageInstalls()) return true
        AlertDialog.Builder(activity)
            .setTitle(R.string.update_permission_title)
            .setMessage(R.string.update_permission_body)
            .setPositiveButton(R.string.update_permission_open) { _, _ ->
                val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                intent.data = Uri.parse("package:" + activity.packageName)
                try {
                    activity.startActivity(intent)
                } catch (err: Exception) {
                    Log.w(TAG, "cannot open install settings: " + err.message)
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
        return false
    }

    internal fun download(context: Context, release: Release, onProgress: (Int) -> Unit): File {
        val dir = File(context.getExternalFilesDir(null) ?: context.filesDir, "updates")
        if (!dir.exists()) dir.mkdirs()
        dir.listFiles()?.forEach { old -> if (old.isFile) old.delete() }
        val target = File(dir, "FrontierX-" + sanitize(release.version) + ".apk")
        val connection = URL(release.url).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 20000
        connection.readTimeout = 60000
        try {
            if (connection.responseCode !in 200..299) {
                throw IllegalStateException("HTTP " + connection.responseCode)
            }
            val total = if (release.size > 0) release.size else connection.contentLengthLong
            val digest = MessageDigest.getInstance("SHA-256")
            connection.inputStream.use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var read = input.read(buffer)
                    var written = 0L
                    var lastPercent = -1
                    while (read > 0) {
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        written += read.toLong()
                        if (total > 0) {
                            val percent = ((written * 100L) / total).toInt()
                            if (percent != lastPercent) {
                                lastPercent = percent
                                onProgress(percent)
                                Notifications.showProgress(
                                    context,
                                    context.getString(R.string.update_downloading),
                                    percent,
                                    false,
                                )
                            }
                        }
                        read = input.read(buffer)
                    }
                    output.flush()
                }
            }
            if (release.sha256.isNotBlank()) {
                val actual = digest.digest().joinToString("") { byte -> "%02x".format(byte) }
                if (!actual.equals(release.sha256.trim(), ignoreCase = true)) {
                    target.delete()
                    throw IllegalStateException(context.getString(R.string.update_checksum_failed))
                }
            }
            return target
        } finally {
            connection.disconnect()
            Notifications.clearProgress(context)
        }
    }

    private fun sanitize(value: String): String {
        val cleaned = value.filter { char -> char.isLetterOrDigit() || char == '.' || char == '-' || char == '_' }
        return if (cleaned.isBlank()) "update" else cleaned
    }

    internal fun install(context: Context, file: File) {
        val authority = context.packageName + ".updates"
        val uri = FileProvider.getUriForFile(context, authority, file)
        val intent = Intent(Intent.ACTION_VIEW)
        intent.setDataAndType(uri, "application/vnd.android.package-archive")
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (err: Exception) {
            Log.w(TAG, "cannot start installer: " + err.message)
        }
    }
}