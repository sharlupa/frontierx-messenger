package com.frontierx.app

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream

// Bridge between the web app and the native shell.
//
// Originally this only handled blob:/data: downloads, which the WebView cannot
// fetch on its own. It now also carries the session token used for push
// registration and exposes manual update checks, so the page has a single
// native object to talk to (window.FrontierXNative).
class FxDownloads(private val activity: Activity) {

    @JavascriptInterface
    fun saveBase64(fileName: String?, mimeType: String?, base64: String?) {
        val bytes = try {
            Base64.decode(base64 ?: "", Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            ByteArray(0)
        }
        if (bytes.isEmpty()) {
            report(false, null)
            return
        }
        val name = safeName(fileName)
        val mime = if (mimeType.isNullOrBlank()) "application/octet-stream" else mimeType
        val ok = try {
            save(name, mime, bytes)
        } catch (e: Exception) {
            false
        }
        report(ok, name)
    }

    private fun save(name: String, mime: String, bytes: ByteArray): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues()
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime)
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            values.put(MediaStore.MediaColumns.IS_PENDING, 1)
            val resolver = activity.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return false
            val stream = resolver.openOutputStream(uri) ?: return false
            stream.use { it.write(bytes) }
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return true
        }
        val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return false
        if (!dir.exists() && !dir.mkdirs()) {
            return false
        }
        FileOutputStream(File(dir, name)).use { it.write(bytes) }
        return true
    }

    private fun safeName(raw: String?): String {
        val bad = charArrayOf('\\', '/', ':', '*', '?', '"', '<', '>', '|')
        val sb = StringBuilder()
        for (ch in (raw ?: "").trim()) {
            sb.append(if (bad.contains(ch)) '_' else ch)
        }
        val out = sb.toString()
        return if (out.isEmpty()) "frontierx-file" else out.take(120)
    }

    private fun report(ok: Boolean, name: String?) {
        activity.runOnUiThread {
            val text = if (ok && name != null) {
                activity.getString(R.string.download_saved, name)
            } else {
                activity.getString(R.string.download_failed)
            }
            Toast.makeText(activity, text, Toast.LENGTH_LONG).show()
        }
    }

    // Foreground notification requested by the page itself.
    @JavascriptInterface
    fun notify(title: String?, body: String?, tag: String?) {
        val head = if (title.isNullOrBlank()) "FrontierX" else title
        val text = body ?: ""
        val key = if (tag.isNullOrBlank()) "frontierx" else tag
        activity.runOnUiThread {
            try {
                Notifications.show(activity, Notifications.CHANNEL_MESSAGES, head, text, key, null)
            } catch (e: Exception) {
            }
        }
    }

    @JavascriptInterface
    fun platform(): String = "android"

    // The web app calls this right after login and after restoring a session,
    // so the device can be subscribed for background push.
    @JavascriptInterface
    fun setAuthToken(token: String?) {
        activity.runOnUiThread {
            try {
                Push.setSession(activity, token, ServerConfig.getServerUrl(activity))
                val server = ServerConfig.getServerUrl(activity) ?: ServerConfig.DEFAULT_URL
                // The own socket (and its ongoing notification) is only needed
                // when the phone's push channel cannot be used. While FCM worked
                // last time the socket stays off; it is started if FCM fails.
                if (token.isNullOrBlank()) return@runOnUiThread
                if (!Fcm.isActive(activity)) PushSocketService.start(activity, token, server)
                Fcm.setup(activity, token, server) { ok ->
                    if (ok) PushSocketService.stop(activity)
                    else PushSocketService.start(activity, token, server)
                }
            } catch (e: Exception) {
            }
        }
    }

    // Called on logout: drops the endpoint on the server and locally.
    @JavascriptInterface
    fun clearAuthToken() {
        activity.runOnUiThread {
            try {
                Push.clearSession(activity)
                Fcm.clear(activity)
                PushSocketService.stop(activity)
            } catch (e: Exception) {
            }
        }
    }

    @JavascriptInterface
    fun pushEnabled(): Boolean = true

    // Manual "check for updates" entry point from the settings screen.
    @JavascriptInterface
    fun checkUpdates() {
        activity.runOnUiThread {
            Toast.makeText(activity, R.string.update_checking, Toast.LENGTH_SHORT).show()
            Updater.check(activity, ServerConfig.getServerUrl(activity) ?: ServerConfig.DEFAULT_URL) { release ->
                if (activity.isFinishing || activity.isDestroyed) return@check
                if (release == null) {
                    Toast.makeText(activity, R.string.update_up_to_date, Toast.LENGTH_LONG).show()
                } else {
                    Updater.prompt(activity, release)
                }
            }
        }
    }
}