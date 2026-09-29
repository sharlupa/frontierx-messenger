package com.frontierx.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

// Notification channels and posting helpers shared by push delivery, the
// in-page bridge and the updater. Kept in one place so every notification the
// app posts goes through the same channels and the same tap behaviour.
object Notifications {
    const val CHANNEL_MESSAGES = "frontierx.messages"
    const val CHANNEL_CALLS = "frontierx.calls"
    const val CHANNEL_UPDATES = "frontierx.updates"
    const val CHANNEL_SERVICE = "frontierx.service"

    const val EXTRA_CONVERSATION = "fx_conversation"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val messages = NotificationChannel(
            CHANNEL_MESSAGES,
            context.getString(R.string.channel_messages),
            NotificationManager.IMPORTANCE_HIGH,
        )
        messages.description = context.getString(R.string.channel_messages_desc)
        messages.enableVibration(true)

        val calls = NotificationChannel(
            CHANNEL_CALLS,
            context.getString(R.string.channel_calls),
            NotificationManager.IMPORTANCE_HIGH,
        )
        calls.description = context.getString(R.string.channel_calls_desc)
        calls.enableVibration(true)

        val updates = NotificationChannel(
            CHANNEL_UPDATES,
            context.getString(R.string.channel_updates),
            NotificationManager.IMPORTANCE_LOW,
        )
        updates.description = context.getString(R.string.channel_updates_desc)

        val service = NotificationChannel(
            CHANNEL_SERVICE,
            context.getString(R.string.channel_service),
            NotificationManager.IMPORTANCE_MIN,
        )
        service.description = context.getString(R.string.channel_service_desc)
        service.setShowBadge(false)

        manager.createNotificationChannel(messages)
        manager.createNotificationChannel(calls)
        manager.createNotificationChannel(updates)
        manager.createNotificationChannel(service)
    }

    private fun openAppIntent(context: Context, conversationId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
        intent.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        if (!conversationId.isNullOrBlank()) intent.putExtra(EXTRA_CONVERSATION, conversationId)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
        val requestCode = (conversationId ?: "frontierx").hashCode()
        return PendingIntent.getActivity(context, requestCode, intent, flags)
    }

    fun show(
        context: Context,
        channelId: String,
        title: String,
        body: String,
        tag: String,
        conversationId: String? = null,
    ) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        ensureChannels(context)
        val priority =
            if (channelId == CHANNEL_UPDATES) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(priority)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context, conversationId))
            .build()
        manager.notify(tag.hashCode(), notification)
    }

    // Progress is shown on the low priority updates channel so a download never
    // buzzes the device.
    fun showProgress(context: Context, title: String, percent: Int, indeterminate: Boolean) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        ensureChannels(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_UPDATES)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setProgress(100, percent.coerceIn(0, 100), indeterminate)
            .build()
        manager.notify(UPDATE_PROGRESS_ID, notification)
    }

    fun clearProgress(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(UPDATE_PROGRESS_ID)
    }

    private const val UPDATE_PROGRESS_ID = 90210
}