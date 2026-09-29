package com.frontierx.app

import android.content.Context
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

// Receives UnifiedPush callbacks from the distributor app (ntfy or any other
// compatible client). All logic lives in Push so the receiver stays a thin
// adapter over the connector library.
class PushReceiver : MessagingReceiver() {

    override fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) {
        Push.onEndpoint(context, endpoint.url)
    }

    override fun onRegistrationFailed(context: Context, reason: FailedReason, instance: String) {
        Push.onRegistrationFailed(context, reason.name)
    }

    override fun onUnregistered(context: Context, instance: String) {
        Push.onUnregistered(context)
    }

    override fun onMessage(context: Context, message: PushMessage, instance: String) {
        Push.onMessage(context, String(message.content, Charsets.UTF_8))
    }
}