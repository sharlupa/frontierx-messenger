package com.frontierx.app

import android.app.Activity
import android.content.Context
import android.util.Log
import android.widget.Toast
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

// Background notifications over UnifiedPush.
//
// The web app hands its session token to the native layer through the JS
// bridge. We ask the UnifiedPush distributor installed on the device (ntfy or
// any compatible client) for an endpoint URL and report it to the API, which
// then POSTs small JSON payloads to it whenever a message or call arrives while
// the socket is closed.
object Push {
    private const val TAG = "FrontierXPush"
    private const val PREFS = "frontierx.push"
    private const val KEY_TOKEN = "authToken"
    private const val KEY_BASE = "baseUrl"
    private const val KEY_DEVICE = "deviceId"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_WARNED = "warnedNoDistributor"
    private const val DISTRIBUTOR_LABEL = "FrontierX"

    @Volatile
    private var appVisible = false

    fun setAppVisible(visible: Boolean) {
        appVisible = visible
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun deviceId(context: Context): String {
        val store = prefs(context)
        val existing = store.getString(KEY_DEVICE, null)
        if (!existing.isNullOrBlank()) return existing
        val generated = "android-" + UUID.randomUUID().toString()
        store.edit().putString(KEY_DEVICE, generated).apply()
        return generated
    }

    private fun baseUrl(context: Context): String {
        val stored = prefs(context).getString(KEY_BASE, "").orEmpty()
        if (stored.isNotBlank()) return stored
        return ServerConfig.getServerUrl(context).orEmpty().trimEnd('/')
    }

    // Called from the JS bridge when the web app has an authenticated session.
    fun setSession(activity: Activity, token: String?, base: String?) {
        val clean = token?.trim().orEmpty()
        if (clean.isEmpty()) {
            clearSession(activity)
            return
        }
        val server = if (base.isNullOrBlank()) ServerConfig.getServerUrl(activity).orEmpty() else base
        val store = prefs(activity)
        val previous = store.getString(KEY_TOKEN, "").orEmpty()
        store.edit()
            .putString(KEY_TOKEN, clean)
            .putString(KEY_BASE, server.trimEnd('/'))
            .apply()
        val endpoint = store.getString(KEY_ENDPOINT, "").orEmpty()
        if (endpoint.isNotBlank() && previous != clean) {
            sendRegistration(activity.applicationContext, endpoint)
        }
        ensureRegistered(activity)
    }

    fun clearSession(activity: Activity) {
        val context = activity.applicationContext
        val store = prefs(context)
        val endpoint = store.getString(KEY_ENDPOINT, "").orEmpty()
        val token = store.getString(KEY_TOKEN, "").orEmpty()
        if (endpoint.isNotBlank() && token.isNotBlank()) {
            sendUnregistration(context, endpoint, token)
        }
        store.edit().remove(KEY_TOKEN).remove(KEY_ENDPOINT).apply()
        try {
            UnifiedPush.unregister(context)
        } catch (err: Exception) {
            Log.w(TAG, "unregister failed: " + err.message)
        }
    }

    // Picks the distributor the user already uses for other apps, or asks the
    // system to choose one. Never blocks: without a distributor the app simply
    // keeps working with foreground notifications only.
    fun ensureRegistered(activity: Activity) {
        try {
            if (UnifiedPush.getAckDistributor(activity) != null) {
                UnifiedPush.register(activity, messageForDistributor = DISTRIBUTOR_LABEL)
                return
            }
            UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { success ->
                if (success) {
                    try {
                        UnifiedPush.register(activity, messageForDistributor = DISTRIBUTOR_LABEL)
                    } catch (err: Exception) {
                        Log.w(TAG, "register failed: " + err.message)
                    }
                } else {
                    warnNoDistributor(activity)
                }
            }
        } catch (err: Exception) {
            Log.w(TAG, "distributor lookup failed: " + err.message)
        }
    }

    private fun warnNoDistributor(activity: Activity) {
        val store = prefs(activity)
        if (store.getBoolean(KEY_WARNED, false)) return
        store.edit().putBoolean(KEY_WARNED, true).apply()
        activity.runOnUiThread {
            Toast.makeText(activity, R.string.push_no_distributor, Toast.LENGTH_LONG).show()
        }
    }

    fun hasDistributor(context: Context): Boolean {
        return try {
            UnifiedPush.getAckDistributor(context) != null
        } catch (err: Exception) {
            false
        }
    }

    fun onEndpoint(context: Context, url: String) {
        prefs(context).edit().putString(KEY_ENDPOINT, url).apply()
        sendRegistration(context, url)
    }

    fun onUnregistered(context: Context) {
        val store = prefs(context)
        val endpoint = store.getString(KEY_ENDPOINT, "").orEmpty()
        val token = store.getString(KEY_TOKEN, "").orEmpty()
        store.edit().remove(KEY_ENDPOINT).apply()
        if (endpoint.isNotBlank() && token.isNotBlank()) {
            sendUnregistration(context, endpoint, token)
        }
    }

    fun onRegistrationFailed(context: Context, reason: String) {
        Log.w(TAG, "registration failed: " + reason)
    }

    // Payload shape produced by apps/api/src/push.ts.
    fun onMessage(context: Context, raw: String) {
        val json = try {
            JSONObject(raw)
        } catch (err: Exception) {
            null
        }
        val type = json?.optString("type", "message").orEmpty().ifBlank { "message" }
        val title = json?.optString("title").orEmpty().ifBlank { context.getString(R.string.app_name) }
        val body = json?.optString("body").orEmpty()
        val rawConversation = json?.optString("conversationId").orEmpty()
        val conversationId = if (rawConversation.isBlank() || rawConversation == "null") null else rawConversation

        // While the user is looking at the app the web layer already shows its
        // own in-page notification; only ringing calls are worth duplicating.
        if (appVisible && type != "call") return

        val channel = if (type == "call") Notifications.CHANNEL_CALLS else Notifications.CHANNEL_MESSAGES
        val tag = when {
            type == "call" -> "call:" + (conversationId ?: "unknown")
            conversationId != null -> "conv:" + conversationId
            else -> "frontierx"
        }
        Notifications.show(context, channel, title, body, tag, conversationId)
    }

    private fun sendRegistration(context: Context, endpoint: String) {
        val store = prefs(context)
        val token = store.getString(KEY_TOKEN, "").orEmpty()
        val base = baseUrl(context)
        if (token.isBlank() || base.isBlank()) return
        val payload = JSONObject()
        payload.put("endpoint", endpoint)
        payload.put("deviceId", deviceId(context))
        post(base + "/api/me/push/register", token, payload.toString())
    }

    private fun sendUnregistration(context: Context, endpoint: String, token: String) {
        val base = baseUrl(context)
        if (base.isBlank()) return
        val payload = JSONObject()
        payload.put("endpoint", endpoint)
        payload.put("deviceId", deviceId(context))
        post(base + "/api/me/push/unregister", token, payload.toString())
    }

    private fun post(url: String, token: String, body: String) {
        Thread {
            var connection: HttpURLConnection? = null
            try {
                connection = URL(url).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.connectTimeout = 15000
                connection.readTimeout = 15000
                connection.setRequestProperty("content-type", "application/json")
                connection.setRequestProperty("authorization", "Bearer " + token)
                connection.outputStream.use { stream -> stream.write(body.toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                if (code !in 200..299) Log.w(TAG, "api " + url + " returned " + code)
            } catch (err: Exception) {
                Log.w(TAG, "api call failed: " + err.message)
            } finally {
                connection?.disconnect()
            }
        }.start()
    }
}