package com.frontierx.app

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// Built-in delivery channel. Keeps one authenticated socket to the server so
// notifications arrive without installing any third party distributor app.
class PushSocketService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var client: OkHttpClient? = null
    private var socket: WebSocket? = null
    private var selfId: String? = null
    private var attempt = 0
    private var stopping = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannels(this)
        startForeground(SERVICE_ID, serviceNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopping = true
            close()
            stopSelf()
            return START_NOT_STICKY
        }
        val token = intent?.getStringExtra(EXTRA_TOKEN)
        val base = intent?.getStringExtra(EXTRA_BASE)
        if (!token.isNullOrEmpty() && !base.isNullOrEmpty()) save(this, token, base)
        stopping = false
        attempt = 0
        connect()
        return START_STICKY
    }

    override fun onDestroy() {
        close()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!stopping && !Fcm.isActive(applicationContext)) startIfConfigured(applicationContext)
        super.onTaskRemoved(rootIntent)
    }

    private fun serviceNotification(): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)
        return NotificationCompat.Builder(this, Notifications.CHANNEL_SERVICE)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.push_service_title))
            .setContentText(getString(R.string.push_service_text))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    private fun connect() {
        if (stopping || socket != null) return
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val token = prefs.getString(KEY_TOKEN, null) ?: return
        val base = prefs.getString(KEY_BASE, null) ?: return
        val url = base.trimEnd('/')
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://") + "/ws?token=" + token + "&presence=0"
        val http = client ?: OkHttpClient.Builder()
            .pingInterval(25, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
            .also { client = it }
        socket = http.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    attempt = 0
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleEvent(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    retry()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    retry()
                }
            },
        )
    }

    private fun retry() {
        socket = null
        if (stopping) return
        attempt = if (attempt >= 6) 6 else attempt + 1
        handler.postDelayed({ connect() }, 2000L * attempt)
    }

    private fun close() {
        try {
            socket?.close(1000, null)
        } catch (e: Exception) {
        }
        socket = null
    }

    private fun handleEvent(text: String) {
        try {
            val json = JSONObject(text)
            when (json.optString("type")) {
                "ready" -> selfId = json.optString("userId")
                "push.test" -> {
                    // A test is shown even with the app in front, because the
                    // point of it is to prove the system channel works.
                    val title = json.optString("title").ifEmpty { "FrontierX" }
                    val body = json.optString("body").ifEmpty { getString(R.string.push_test_body) }
                    Notifications.show(this, Notifications.CHANNEL_MESSAGES, title, body, "socket-test", null)
                }
                "message.created" -> {
                    if (appVisible) return
                    val message = json.optJSONObject("message") ?: return
                    val sender = message.optString("senderId")
                    if (sender.isNotEmpty() && sender == selfId) return
                    val conversationId = message.optString("conversationId")
                    Notifications.show(
                        this,
                        Notifications.CHANNEL_MESSAGES,
                        getString(R.string.push_message_title),
                        getString(R.string.push_message_body),
                        "socket-message-" + conversationId,
                        if (conversationId.isEmpty()) null else conversationId,
                    )
                }
                "call.invite" -> {
                    if (appVisible) return
                    val conversationId = json.optString("conversationId")
                    Notifications.show(
                        this,
                        Notifications.CHANNEL_CALLS,
                        getString(R.string.push_call_title),
                        getString(R.string.push_call_body),
                        "socket-call-" + conversationId,
                        if (conversationId.isEmpty()) null else conversationId,
                    )
                }
            }
        } catch (e: Exception) {
        }
    }

    companion object {
        private const val SERVICE_ID = 90310
        private const val PREFS = "frontierx.socket"
        private const val KEY_TOKEN = "token"
        private const val KEY_BASE = "base"
        private const val EXTRA_TOKEN = "fx_token"
        private const val EXTRA_BASE = "fx_base"
        const val ACTION_STOP = "com.frontierx.app.STOP_SOCKET"

        @Volatile
        private var appVisible = false

        fun setAppVisible(visible: Boolean) {
            appVisible = visible
        }

        private fun save(context: Context, token: String, base: String) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_BASE, base)
                .apply()
        }

        fun start(context: Context, token: String?, base: String?) {
            if (token.isNullOrEmpty() || base.isNullOrEmpty()) return
            val intent = Intent(context, PushSocketService::class.java)
                .putExtra(EXTRA_TOKEN, token)
                .putExtra(EXTRA_BASE, base)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
            }
        }

        fun stop(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
            try {
                context.startService(
                    Intent(context, PushSocketService::class.java).setAction(ACTION_STOP),
                )
            } catch (e: Exception) {
            }
        }

        // Restores delivery after a reboot or a process kill, without waiting
        // for the web layer to hand the session token over again.
        fun startIfConfigured(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            start(context, prefs.getString(KEY_TOKEN, null), prefs.getString(KEY_BASE, null))
        }

        fun isConfigured(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return !prefs.getString(KEY_TOKEN, null).isNullOrEmpty()
        }
    }
}