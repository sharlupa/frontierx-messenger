package com.frontierx.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

// Receives FCM data messages. The system starts this briefly for each push, so
// the app needs no permanent background service while it is closed.
class FcmService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Fcm.onNewToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val type = data["type"].orEmpty().ifBlank { "message" }
        // Pushes carry no text at all; the wording comes from the app, so it also
        // follows the phone's language.
        val body = when (type) {
            "call" -> getString(R.string.push_call_body)
            "test" -> data["body"].orEmpty().ifBlank { getString(R.string.push_test_body) }
            else -> getString(R.string.push_message_body)
        }
        // The push carries no names; the chat title comes from our own server,
        // asked directly with this device's session.
        val conversationId = data["conversationId"].orEmpty()
        val title = Fcm.chatTitle(applicationContext, conversationId).orEmpty()
        val payload = JSONObject()
            .put("type", type)
            .put("title", title)
            .put("body", body)
            .put("conversationId", conversationId)
        Push.onMessage(applicationContext, payload.toString())
    }
}
