package com.frontierx.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

// Delivery through Firebase Cloud Messaging, the phone's own push channel.
//
// When the device has Google services and the server has FCM configured, the
// app registers an FCM token and stops its own background socket, so there is
// no ongoing "running in background" notification. Otherwise nothing changes:
// the built-in socket service keeps delivering as before.
object Fcm {
    private const val TAG = "FrontierXFcm"
    private const val PREFS = "frontierx.fcm"
    private const val KEY_ACTIVE = "active"
    private const val KEY_TOKEN = "fcmToken"
    private const val KEY_AUTH = "authToken"
    private const val KEY_BASE = "baseUrl"
    private const val KEY_DEVICE = "deviceId"

    private val main = Handler(Looper.getMainLooper())

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // True once the server confirmed an FCM registration for this install.
    fun isActive(context: Context): Boolean = prefs(context).getBoolean(KEY_ACTIVE, false)

    private fun deviceId(context: Context): String {
        val store = prefs(context)
        store.getString(KEY_DEVICE, null)?.let { if (it.isNotBlank()) return it }
        val generated = "android-fcm-" + UUID.randomUUID().toString()
        store.edit().putString(KEY_DEVICE, generated).apply()
        return generated
    }

    private fun servicesAvailable(context: Context): Boolean {
        return try {
            FirebaseApp.getApps(context).isNotEmpty() &&
                GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
        } catch (err: Throwable) {
            false
        }
    }

    // Tries to switch delivery to FCM. `done(true)` means FCM is registered and
    // the socket service can stop; `done(false)` means keep the socket.
    fun setup(context: Context, authToken: String, base: String, done: (Boolean) -> Unit) {
        val app = context.applicationContext
        prefs(app).edit().putString(KEY_AUTH, authToken).putString(KEY_BASE, base.trimEnd('/')).apply()
        if (!servicesAvailable(app)) {
            finish(app, false, done)
            return
        }
        Thread {
            val serverSupports = try {
                val response = request(base.trimEnd('/') + "/api/push/config", "GET", null, null)
                response != null && JSONObject(response).optBoolean("fcm", false)
            } catch (err: Exception) {
                false
            }
            if (!serverSupports) {
                finish(app, false, done)
                return@Thread
            }
            try {
                FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                    val token = if (task.isSuccessful) task.result else null
                    if (token.isNullOrBlank()) {
                        finish(app, false, done)
                        return@addOnCompleteListener
                    }
                    Thread { finish(app, register(app, token), done) }.start()
                }
            } catch (err: Exception) {
                Log.w(TAG, "token request failed: " + err.message)
                finish(app, false, done)
            }
        }.start()
    }

    private fun finish(context: Context, ok: Boolean, done: (Boolean) -> Unit) {
        prefs(context).edit().putBoolean(KEY_ACTIVE, ok).apply()
        main.post { done(ok) }
    }

    // FCM rotates tokens now and then; the new one replaces the old on the server.
    fun onNewToken(context: Context, token: String) {
        Thread { prefs(context).edit().putBoolean(KEY_ACTIVE, register(context, token)).apply() }.start()
    }

    private fun register(context: Context, token: String): Boolean {
        val store = prefs(context)
        val auth = store.getString(KEY_AUTH, null) ?: return false
        val base = store.getString(KEY_BASE, null) ?: return false
        val body = JSONObject().put("token", token).put("deviceId", deviceId(context)).toString()
        val ok = request("$base/api/me/push/fcm", "POST", auth, body) != null
        if (ok) store.edit().putString(KEY_TOKEN, token).apply()
        return ok
    }

    // Logout: the server forgets this device and FCM stops delivering here.
    fun clear(context: Context) {
        val store = prefs(context)
        val auth = store.getString(KEY_AUTH, null)
        val base = store.getString(KEY_BASE, null)
        val token = store.getString(KEY_TOKEN, null)
        val device = deviceId(context)
        store.edit().remove(KEY_ACTIVE).remove(KEY_AUTH).remove(KEY_TOKEN).apply()
        if (auth.isNullOrBlank() || base.isNullOrBlank()) return
        Thread {
            val body = JSONObject().put("deviceId", device)
            if (!token.isNullOrBlank()) body.put("endpoint", "fcm:$token")
            request("$base/api/me/push/unregister", "POST", auth, body.toString())
        }.start()
    }

    // Name to show for a chat: the group or channel title, or the other
    // person's display name. Null when offline or unknown (the app name is used).
    fun chatTitle(context: Context, conversationId: String): String? {
        if (conversationId.isBlank()) return null
        val store = prefs(context)
        val auth = store.getString(KEY_AUTH, null) ?: return null
        val base = store.getString(KEY_BASE, null) ?: return null
        val body = request("$base/api/conversations", "GET", auth, null, 5000) ?: return null
        return try {
            val list = JSONObject(body).optJSONArray("conversations") ?: return null
            for (i in 0 until list.length()) {
                val chat = list.optJSONObject(i) ?: continue
                if (chat.optString("id") != conversationId) continue
                val title = chat.optString("title").takeIf { it.isNotBlank() && it != "null" }
                val peer = chat.optJSONObject("peer")?.optString("displayName")?.takeIf { it.isNotBlank() }
                return title ?: peer
            }
            null
        } catch (err: Exception) {
            null
        }
    }

    // Returns the response body for a 2xx answer, null otherwise.
    private fun request(url: String, method: String, auth: String?, body: String?, timeoutMs: Int = 15000): String? {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL(url).openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            if (auth != null) connection.setRequestProperty("authorization", "Bearer $auth")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("content-type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            if (code in 200..299) connection.inputStream.bufferedReader().use { it.readText() } else null
        } catch (err: Exception) {
            Log.w(TAG, "$method $url failed: " + err.message)
            null
        } finally {
            connection?.disconnect()
        }
    }
}
