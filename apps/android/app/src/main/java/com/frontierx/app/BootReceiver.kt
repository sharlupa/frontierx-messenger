package com.frontierx.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Notifications have to survive a restart, so the delivery socket comes back
// with the device instead of waiting for the app to be opened.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != "android.intent.action.QUICKBOOT_POWERON") return
        // With FCM the system wakes the app itself; the socket is the fallback.
        if (!Fcm.isActive(context)) PushSocketService.startIfConfigured(context)
    }
}
