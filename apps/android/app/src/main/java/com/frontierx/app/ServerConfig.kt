package com.frontierx.app

import android.content.Context

/** Stores the FrontierX server address the app should connect to. */
object ServerConfig {
	private const val PREFS = "frontierx"
	private const val KEY_SERVER_URL = "serverUrl"
	private const val KEY_CONFIG_VERSION = "configVersion"
	private const val CONFIG_VERSION = 2

	/** Official FrontierX server. The app ships pointed at it. */
	const val DEFAULT_URL = "https://frontierx.zkito.fun"

	fun getServerUrl(context: Context): String? {
		val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
		if (prefs.getInt(KEY_CONFIG_VERSION, 0) < CONFIG_VERSION) {
			// Older builds stored a temporary tunnel address; drop it.
			prefs.edit().remove(KEY_SERVER_URL).putInt(KEY_CONFIG_VERSION, CONFIG_VERSION).apply()
			return DEFAULT_URL
		}
		val stored = prefs.getString(KEY_SERVER_URL, null)
		return if (stored.isNullOrBlank()) DEFAULT_URL else stored
	}

	fun setServerUrl(context: Context, url: String) {
		context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
			.edit()
			.putString(KEY_SERVER_URL, url)
			.putInt(KEY_CONFIG_VERSION, CONFIG_VERSION)
			.apply()
	}

	/** Turns user input such as "192.168.1.10:8080" into a loadable URL. */
	fun normalize(raw: String): String? {
		var value = raw.trim()
		if (value.isEmpty()) return null
		if (!value.startsWith("http://") && !value.startsWith("https://")) {
			value = "http://" + value
		}
		value = value.trimEnd('/')
		return if (value == "http://" || value == "https://") null else value
	}
}
