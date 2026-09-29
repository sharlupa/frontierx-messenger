package com.frontierx.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class SetupActivity : AppCompatActivity() {

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)

		WindowCompat.setDecorFitsSystemWindows(window, false)
		WindowCompat.getInsetsController(window, window.decorView).apply {
			isAppearanceLightStatusBars = false
			isAppearanceLightNavigationBars = false
		}

		setContentView(R.layout.activity_setup)

		val root = findViewById<View>(R.id.setup_root)
		ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
			val bars = insets.getInsets(
				WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
			)
			val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
			view.setPadding(
				bars.left,
				bars.top,
				bars.right,
				maxOf(bars.bottom, keyboard.bottom),
			)
			WindowInsetsCompat.CONSUMED
		}

		val input = findViewById<EditText>(R.id.server_url)
		val connect = findViewById<Button>(R.id.connect)
		input.setText(ServerConfig.getServerUrl(this) ?: "")

		connect.setOnClickListener {
			val normalized = ServerConfig.normalize(input.text.toString())
			if (normalized == null) {
				Toast.makeText(this, R.string.setup_invalid, Toast.LENGTH_LONG).show()
			} else {
				ServerConfig.setServerUrl(this, normalized)
				val intent = Intent(this, MainActivity::class.java)
				intent.flags =
					Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
				startActivity(intent)
				finish()
			}
		}
	}
}
