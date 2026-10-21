package com.frontierx.app

import android.content.Context
import android.content.pm.ApplicationInfo

/** The FrontierX server the app talks to. */
object ServerConfig {
	private const val PREFS = "frontierx"
	private const val KEY_SERVER_URL = "serverUrl"

	/** Official FrontierX server. The app ships pointed at it. */
	const val DEFAULT_URL = "https://frontierx.zkito.fun"

	// Release builds always use the official server: an address typed into the
	// old setup screen (or a tunnel from before there was a server) is ignored.
	// Debug builds read prefs serverUrl, so a test server can be set with run-as.
	fun getServerUrl(context: Context): String {
		if ((context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) return DEFAULT_URL
		val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SERVER_URL, null)
		return if (stored.isNullOrBlank()) DEFAULT_URL else stored.trimEnd('/')
	}
}
