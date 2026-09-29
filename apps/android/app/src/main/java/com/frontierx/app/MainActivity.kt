package com.frontierx.app

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.Intent
import android.content.Context
import android.os.PowerManager
import android.provider.Settings
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : AppCompatActivity() {

    private lateinit var rootView: FrameLayout
    private lateinit var webView: WebView
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>

    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermissionRequest: PermissionRequest? = null
    private var pendingGeolocation: Pair<String, GeolocationPermissions.Callback>? = null
    private var backLongPressed = false
    private var pendingConversation: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val serverUrl = ServerConfig.getServerUrl(this)
        if (serverUrl.isNullOrBlank()) {
            openSetup()
            return
        }

        // The socket dies with the process, so an existing session brings the
        // delivery channel back up as soon as the app is opened.
        if (!Fcm.isActive(this)) PushSocketService.startIfConfigured(this)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = false
        controller.isAppearanceLightNavigationBars = false

        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val callback = fileChooserCallback
            fileChooserCallback = null
            if (callback != null) {
                val uris = if (result.resultCode == Activity.RESULT_OK) {
                    WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
                } else {
                    null
                }
                callback.onReceiveValue(uris)
            }
        }

        rootView = FrameLayout(this)
        rootView.setBackgroundColor(ContextCompat.getColor(this, R.color.fx_bars))

        webView = WebView(this)
        webView.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        )
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.fx_background))
        rootView.addView(webView)
        setContentView(rootView)

        applyWindowInsets()
        configureWebView()
        Notifications.ensureChannels(this)
        takeConversationExtra()
        webView.loadUrl(consumeDeepLink() ?: serverUrl)
        Updater.checkOnStart(this, serverUrl)
    }

    private fun applyWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            val params = webView.layoutParams as FrameLayout.LayoutParams
            params.leftMargin = bars.left
            params.topMargin = bars.top
            params.rightMargin = bars.right
            params.bottomMargin = maxOf(bars.bottom, keyboard.bottom)
            webView.layoutParams = params
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.setGeolocationEnabled(true)
        settings.mediaPlaybackRequiresUserGesture = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = false
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        WebView.setWebContentsDebuggingEnabled(true)
        webView.addJavascriptInterface(FxDownloads(this), "FrontierXNative")
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            startHttpDownload(url, userAgent, contentDisposition, mimeType)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                handleWebPermissionRequest(request)
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest?) {
                if (pendingPermissionRequest == request) {
                    pendingPermissionRequest = null
                }
            }

            // "Share location" in a chat. Only the app's own server may ask, and
            // only after the person granted Android's location permission; the
            // answer is not remembered, so every request is decided anew.
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                handleGeolocationRequest(origin ?: "", callback ?: return)
            }

            override fun onGeolocationPermissionsHidePrompt() {
                pendingGeolocation = null
            }

            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                return openFileChooser(callback, params)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                syncSystemBarColor()
                installDownloadHook()
                deliverConversation()
                view?.postDelayed({ syncSystemBarColor() }, 700)
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    Toast.makeText(
                        this@MainActivity,
                        R.string.connect_failed,
                        Toast.LENGTH_LONG
                    ).show()
                    openSetup()
                }
            }
        }
    }

    private fun openFileChooser(
        callback: ValueCallback<Array<Uri>>?,
        params: WebChromeClient.FileChooserParams?
    ): Boolean {
        if (callback == null) {
            return false
        }
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = callback

        val intent = params?.createIntent()
        if (intent == null) {
            fileChooserCallback = null
            return false
        }
        if (intent.type.isNullOrBlank()) {
            intent.type = "*/*"
        }

        try {
            fileChooserLauncher.launch(intent)
            return true
        } catch (first: Exception) {
            try {
                fileChooserLauncher.launch(Intent.createChooser(intent, null))
                return true
            } catch (second: Exception) {
                fileChooserCallback = null
                Toast.makeText(this, R.string.file_pick_failed, Toast.LENGTH_LONG).show()
                return false
            }
        }
    }

    private fun handleWebPermissionRequest(request: PermissionRequest) {
        val audio = request.resources
            .filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
            .toTypedArray()

        if (audio.isEmpty()) {
            request.deny()
            return
        }
        if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
            request.grant(audio)
            return
        }
        pendingPermissionRequest = request
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.RECORD_AUDIO),
            REQUEST_MEDIA
        )
    }

    private fun isOwnOrigin(origin: String): Boolean {
        val server = ServerConfig.getServerUrl(this) ?: return false
        return try {
            val a = Uri.parse(origin)
            val b = Uri.parse(server)
            a.scheme == b.scheme && a.host == b.host && a.port == b.port
        } catch (e: Exception) {
            false
        }
    }

    private fun handleGeolocationRequest(origin: String, callback: GeolocationPermissions.Callback) {
        if (!isOwnOrigin(origin)) {
            callback.invoke(origin, false, false)
            return
        }
        if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
            hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        ) {
            callback.invoke(origin, true, false)
            return
        }
        pendingGeolocation?.let { (pendingOrigin, pendingCallback) -> pendingCallback.invoke(pendingOrigin, false, false) }
        pendingGeolocation = Pair(origin, callback)
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
            REQUEST_LOCATION
        )
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_LOCATION) {
            val pending = pendingGeolocation
            pendingGeolocation = null
            if (pending != null) {
                val granted = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
                    hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                pending.second.invoke(pending.first, granted, false)
                if (!granted) Toast.makeText(this, R.string.location_denied, Toast.LENGTH_LONG).show()
            }
            return
        }
        if (requestCode != REQUEST_MEDIA) {
            return
        }
        val request = pendingPermissionRequest
        pendingPermissionRequest = null
        if (request == null) {
            return
        }
        if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
            val audio = request.resources
                .filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                .toTypedArray()
            if (audio.isEmpty()) request.deny() else request.grant(audio)
        } else {
            request.deny()
            Toast.makeText(this, R.string.mic_denied, Toast.LENGTH_LONG).show()
        }
    }

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(this, permission) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun installDownloadHook() {
        val js = """
            (function(){
              if (window.__fxDownloadHook) { return; }
              window.__fxDownloadHook = true;
              function isLocal(href){
                return href.indexOf('blob:') === 0 || href.indexOf('data:') === 0;
              }
              function send(blob, name){
                var r = new FileReader();
                r.onloadend = function(){
                  var s = String(r.result || '');
                  var i = s.indexOf(',');
                  if (i < 0) { return; }
                  try {
                    FrontierXNative.saveBase64(name, blob.type || '', s.substring(i + 1));
                  } catch (e) {}
                };
                r.readAsDataURL(blob);
              }
              function grab(href, name){
                try {
                  fetch(href).then(function(res){
                    return res.blob();
                  }).then(function(b){
                    send(b, name);
                  }).catch(function(){});
                } catch (e) {}
              }
              var origClick = HTMLAnchorElement.prototype.click;
              HTMLAnchorElement.prototype.click = function(){
                try {
                  var href = this.getAttribute('href') || '';
                  var dl = this.getAttribute('download');
                  if (dl !== null && isLocal(href)) {
                    grab(href, dl || 'file');
                    return;
                  }
                } catch (e) {}
                return origClick.apply(this, arguments);
              };
              document.addEventListener('click', function(ev){
                var el = ev.target;
                while (el && el.tagName !== 'A') { el = el.parentElement; }
                if (!el) { return; }
                var dl = el.getAttribute('download');
                if (dl === null) { return; }
                var href = el.getAttribute('href') || '';
                if (!isLocal(href)) { return; }
                ev.preventDefault();
                ev.stopPropagation();
                grab(href, dl || 'file');
              }, true);
            })()
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun startHttpDownload(
        url: String?,
        userAgent: String?,
        disposition: String?,
        mime: String?
    ) {
        if (url == null || !URLUtil.isNetworkUrl(url)) {
            return
        }
        try {
            val name = URLUtil.guessFileName(url, disposition, mime)
            val request = DownloadManager.Request(Uri.parse(url))
            request.setMimeType(mime)
            if (!userAgent.isNullOrBlank()) {
                request.addRequestHeader("User-Agent", userAgent)
            }
            val cookie = CookieManager.getInstance().getCookie(url)
            if (!cookie.isNullOrBlank()) {
                request.addRequestHeader("Cookie", cookie)
            }
            request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
            )
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            val manager = getSystemService(DownloadManager::class.java)
            if (manager == null) {
                Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
                return
            }
            manager.enqueue(request)
            Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
        }
    }

    // Turns frontierx://invite/CODE into a normal page load on the configured server.
    private fun consumeDeepLink(): String? {
        val data = intent?.data ?: return null
        if (data.scheme != "frontierx") {
            return null
        }
        intent?.data = null
        val server = ServerConfig.getServerUrl(this) ?: return null
        val code = data.lastPathSegment
        if (code.isNullOrBlank()) {
            return null
        }
        return server.trimEnd('/') + "/invite/" + Uri.encode(code)
    }

    private var notifPermissionAsked = false

    private fun ensureNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        if (notifPermissionAsked) return
        if (hasPermission("android.permission.POST_NOTIFICATIONS")) return
        notifPermissionAsked = true
        ActivityCompat.requestPermissions(this, arrayOf("android.permission.POST_NOTIFICATIONS"), 4711)
    }
    private fun setWebPresence(visible: Boolean) {
        if (!this::webView.isInitialized) return
        val flag = if (visible) "true" else "false"
        try {
            webView.evaluateJavascript("window.fxSetPresence && window.fxSetPresence(" + flag + ")", null)
        } catch (e: Exception) {
        }
    }

    private fun ensureBackgroundDelivery() {
        val prefs = getSharedPreferences("frontierx.app", Context.MODE_PRIVATE)
        if (prefs.getBoolean("batteryAsked", false)) return
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (power.isIgnoringBatteryOptimizations(packageName)) return
        prefs.edit().putBoolean("batteryAsked", true).apply()
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + packageName)))
        } catch (e: Exception) {
        }
    }

    override fun onResume() {
        super.onResume()
        Push.setAppVisible(true)
        PushSocketService.setAppVisible(true)
        setWebPresence(true)
        ensureBackgroundDelivery()
        ensureNotificationPermission()
        val target = consumeDeepLink()
        if (target != null && ::webView.isInitialized) {
            webView.loadUrl(target)
            return
        }
        deliverConversation()
    }

    override fun onPause() {
        Push.setAppVisible(false)
        PushSocketService.setAppVisible(false)
        setWebPresence(false)
        super.onPause()
    }

    // Tapping a notification reuses this activity because it is singleTop.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeConversationExtra()
        val target = consumeDeepLink()
        if (target != null && ::webView.isInitialized) {
            webView.loadUrl(target)
            return
        }
        deliverConversation()
    }

    private fun takeConversationExtra() {
        val current = intent ?: return
        val conversationId = current.getStringExtra(Notifications.EXTRA_CONVERSATION)
        if (conversationId.isNullOrBlank()) return
        current.removeExtra(Notifications.EXTRA_CONVERSATION)
        pendingConversation = conversationId
    }

    // Hands the conversation from a tapped notification over to the web layer.
    private fun deliverConversation() {
        val conversationId = pendingConversation ?: return
        if (!::webView.isInitialized) return
        pendingConversation = null
        val payload = org.json.JSONObject.quote(conversationId)
        val js = "(function(){try{window.dispatchEvent(new CustomEvent('frontierx:open-conversation'," +
            "{detail:{conversationId:" + payload + "}}));}catch(e){}})()"
        webView.evaluateJavascript(js, null)
    }

    private fun syncSystemBarColor() {
        val js = """
            (function(){
              try{
                var s = getComputedStyle(document.documentElement);
                var c = s.getPropertyValue('--bg-header')
                  || s.getPropertyValue('--bg-panel')
                  || s.getPropertyValue('--bg-sidebar');
                if(!c){
                  var m = document.querySelector('meta[name=theme-color]');
                  c = m ? m.getAttribute('content') : '';
                }
                if(!c && document.body){
                  c = getComputedStyle(document.body).backgroundColor;
                }
                return (c || '').trim();
              }catch(e){ return ''; }
            })()
        """.trimIndent()
        webView.evaluateJavascript(js) { raw -> applyBarColor(raw) }
    }

    private fun applyBarColor(raw: String?) {
        if (raw == null) {
            return
        }
        val value = raw.trim().trim('"').trim()
        val color = parseCssColor(value) ?: return
        rootView.setBackgroundColor(color)
        val light = isLightColor(color)
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = light
        controller.isAppearanceLightNavigationBars = light
    }

    private fun parseCssColor(value: String): Int? {
        val v = value.trim()
        if (v.isEmpty() || v == "null" || v == "transparent") {
            return null
        }
        if (v.startsWith("rgb")) {
            val nums = Regex("[0-9]+(\\.[0-9]+)?").findAll(v).map { it.value }.toList()
            if (nums.size < 3) {
                return null
            }
            if (nums.size >= 4 && nums[3].toFloat() == 0f) {
                return null
            }
            return Color.rgb(
                nums[0].toFloat().toInt().coerceIn(0, 255),
                nums[1].toFloat().toInt().coerceIn(0, 255),
                nums[2].toFloat().toInt().coerceIn(0, 255)
            )
        }
        val hex = if (v.startsWith("#") && v.length == 4) expandShortHex(v) else v
        return try {
            Color.parseColor(hex)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    private fun expandShortHex(v: String): String {
        val sb = StringBuilder("#")
        for (i in 1 until v.length) {
            sb.append(v[i]).append(v[i])
        }
        return sb.toString()
    }

    private fun isLightColor(color: Int): Boolean {
        val r = Color.red(color) / 255.0
        val g = Color.green(color) / 255.0
        val b = Color.blue(color) / 255.0
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.6
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (::webView.isInitialized) {
            webView.postDelayed({ syncSystemBarColor() }, 250)
        }
    }

    private fun openSetup() {
        val intent = Intent(this, SetupActivity::class.java)
        intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        startActivity(intent)
        finish()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            event.startTracking()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }


    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (backLongPressed) {
                backLongPressed = false
                return true
            }
            if (::webView.isInitialized && webView.canGoBack()) {
                webView.goBack()
            } else {
                finish()
            }
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        if (::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_MEDIA = 1001
        private const val REQUEST_LOCATION = 1002
    }
}
