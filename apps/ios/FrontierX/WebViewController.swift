import UIKit
import WebKit
import UserNotifications

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
	static let serverHost = "frontierx.zkito.fun"
	static let startURL = URL(string: "https://frontierx.zkito.fun/?app=1")!
	static let backgroundColor = UIColor(red: 14 / 255, green: 22 / 255, blue: 33 / 255, alpha: 1)

	private var webView: WKWebView!
	private let bridge = NativeBridge()
	private var errorView: UIView?
	private var pageLoaded = false
	private var pendingConversation: String?
	private var downloadTargets: [WKDownload: URL] = [:]
	private var themeObservation: NSKeyValueObservation?
	private var statusBarStyle: UIStatusBarStyle = .lightContent

	static var appVersion: String {
		return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
	}

	private static var russian: Bool {
		return Locale.preferredLanguages.first?.lowercased().hasPrefix("ru") ?? false
	}

	override var preferredStatusBarStyle: UIStatusBarStyle {
		return statusBarStyle
	}

	override func loadView() {
		let configuration = WKWebViewConfiguration()
		// The default store is persistent: chats, keys and settings stay on the
		// device between launches, like in a browser.
		configuration.websiteDataStore = .default()
		configuration.allowsInlineMediaPlayback = true
		configuration.mediaTypesRequiringUserActionForPlayback = []
		configuration.applicationNameForUserAgent = "FrontierX-iOS/" + WebViewController.appVersion
		let content = WKUserContentController()
		content.addUserScript(WKUserScript(source: NativeBridge.script(version: WebViewController.appVersion), injectionTime: .atDocumentStart, forMainFrameOnly: true))
		content.add(WeakScriptMessageHandler(bridge), name: NativeBridge.name)
		configuration.userContentController = content

		let webView = WKWebView(frame: .zero, configuration: configuration)
		webView.navigationDelegate = self
		webView.uiDelegate = self
		webView.allowsBackForwardNavigationGestures = false
		webView.allowsLinkPreview = false
		// The page lays itself out around the notch and the home indicator
		// (viewport-fit=cover and safe-area insets in its CSS).
		webView.scrollView.contentInsetAdjustmentBehavior = .never
		webView.scrollView.bounces = false
		webView.isOpaque = false
		webView.backgroundColor = WebViewController.backgroundColor
		webView.scrollView.backgroundColor = WebViewController.backgroundColor
		#if DEBUG
		if #available(iOS 16.4, *) {
			webView.isInspectable = true
		}
		#endif
		self.webView = webView
		view = webView
	}

	override func viewDidLoad() {
		super.viewDidLoad()
		bridge.controller = self
		// The status bar follows the page's theme colour.
		themeObservation = webView.observe(\.themeColor, options: [.new]) { [weak self] webView, _ in
			self?.applyThemeColor(webView.themeColor)
		}
		NotificationCenter.default.addObserver(self, selector: #selector(appBecameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
		NotificationCenter.default.addObserver(self, selector: #selector(appResignedActive), name: UIApplication.willResignActiveNotification, object: nil)
		webView.load(URLRequest(url: WebViewController.startURL))
	}

	deinit {
		NotificationCenter.default.removeObserver(self)
	}

	// MARK: - State shared with the page

	@objc private func appBecameActive() {
		webView.evaluateJavaScript("window.__fxSetFocused && window.__fxSetFocused(true)", completionHandler: nil)
		UNUserNotificationCenter.current().removeAllDeliveredNotifications()
		if errorView != nil {
			reload()
		}
	}

	@objc private func appResignedActive() {
		webView.evaluateJavaScript("window.__fxSetFocused && window.__fxSetFocused(false)", completionHandler: nil)
	}

	private func applyThemeColor(_ color: UIColor?) {
		guard let color = color else { return }
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return }
		let luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
		statusBarStyle = luminance > 0.6 ? .darkContent : .lightContent
		view.window?.backgroundColor = color
		setNeedsStatusBarAppearanceUpdate()
	}

	func openConversation(_ id: String) {
		// Conversation ids are plain tokens; anything else is not passed on.
		guard id.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else { return }
		guard pageLoaded else {
			pendingConversation = id
			return
		}
		let script = "window.dispatchEvent(new CustomEvent('frontierx:open-conversation', { detail: { conversationId: '\(id)' } }))"
		webView.evaluateJavaScript(script, completionHandler: nil)
	}

	func showNotification(title: String, body: String, tag: String) {
		let center = UNUserNotificationCenter.current()
		center.getNotificationSettings { settings in
			switch settings.authorizationStatus {
			case .authorized, .provisional, .ephemeral:
				let content = UNMutableNotificationContent()
				content.title = title.isEmpty ? "FrontierX" : String(title.prefix(200))
				content.body = String(body.prefix(600))
				content.sound = .default
				if !tag.isEmpty && tag != "frontierx" {
					content.threadIdentifier = tag
					content.userInfo = ["conversationId": tag]
				}
				// One notification per chat: a newer one replaces the older.
				let identifier = "fx-" + (tag.isEmpty ? "frontierx" : tag)
				center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil), withCompletionHandler: nil)
			default:
				break
			}
		}
	}

	func showVersionInfo() {
		let message = WebViewController.russian
			? "Чаты и функции мессенджера обновляются сами. Новую версию самого приложения для iPhone устанавливают новой сборкой из Xcode или через TestFlight."
			: "Chats and messenger features update by themselves. A new version of the iPhone app itself is installed with a new build from Xcode or through TestFlight."
		presentAlert(title: "FrontierX " + WebViewController.appVersion, message: message)
	}

	private func presentAlert(title: String?, message: String) {
		guard presentedViewController == nil else { return }
		let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "OK", style: .default))
		present(alert, animated: true)
	}

	// MARK: - Connection errors

	private func reload() {
		hideError()
		webView.load(URLRequest(url: WebViewController.startURL))
	}

	private func showError() {
		guard errorView == nil else { return }
		let overlay = UIView()
		overlay.backgroundColor = WebViewController.backgroundColor
		overlay.translatesAutoresizingMaskIntoConstraints = false

		let label = UILabel()
		label.text = WebViewController.russian ? "Нет соединения с FrontierX" : "Cannot reach FrontierX"
		label.textColor = .white
		label.font = .systemFont(ofSize: 20, weight: .bold)
		label.textAlignment = .center
		label.numberOfLines = 0

		let hint = UILabel()
		hint.text = WebViewController.russian ? "Проверьте интернет и попробуйте снова." : "Check the internet connection and try again."
		hint.textColor = UIColor(white: 1, alpha: 0.7)
		hint.font = .systemFont(ofSize: 15)
		hint.textAlignment = .center
		hint.numberOfLines = 0

		let button = UIButton(type: .system)
		button.setTitle(WebViewController.russian ? "Повторить" : "Try again", for: .normal)
		button.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
		button.setTitleColor(UIColor(red: 0.04, green: 0.13, blue: 0.27, alpha: 1), for: .normal)
		button.backgroundColor = UIColor(red: 0.64, green: 0.8, blue: 1, alpha: 1)
		button.layer.cornerRadius = 22
		button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 28, bottom: 12, right: 28)
		button.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

		let stack = UIStackView(arrangedSubviews: [label, hint, button])
		stack.axis = .vertical
		stack.alignment = .center
		stack.spacing = 14
		stack.translatesAutoresizingMaskIntoConstraints = false
		overlay.addSubview(stack)
		view.addSubview(overlay)
		NSLayoutConstraint.activate([
			overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
			overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
			overlay.topAnchor.constraint(equalTo: view.topAnchor),
			overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
			stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
			stack.leadingAnchor.constraint(equalTo: overlay.leadingAnchor, constant: 32),
			stack.trailingAnchor.constraint(equalTo: overlay.trailingAnchor, constant: -32),
		])
		errorView = overlay
	}

	private func hideError() {
		errorView?.removeFromSuperview()
		errorView = nil
	}

	@objc private func retryTapped() {
		reload()
	}

	// MARK: - WKNavigationDelegate

	private func isOwnPage(_ url: URL) -> Bool {
		return url.scheme == "https" && url.host == WebViewController.serverHost
	}

	func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		if navigationAction.shouldPerformDownload {
			decisionHandler(.download)
			return
		}
		guard let url = navigationAction.request.url else {
			decisionHandler(.cancel)
			return
		}
		let scheme = url.scheme?.lowercased() ?? ""
		if isOwnPage(url) || scheme == "blob" || scheme == "data" || scheme == "about" {
			decisionHandler(.allow)
			return
		}
		// Maps, mail, phone numbers and other sites open outside the app.
		if navigationAction.targetFrame?.isMainFrame ?? true {
			UIApplication.shared.open(url)
			decisionHandler(.cancel)
			return
		}
		decisionHandler(.allow)
	}

	func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
		decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
	}

	func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		hideError()
		pageLoaded = true
		webView.evaluateJavaScript("window.__fxSetFocused && window.__fxSetFocused(\(UIApplication.shared.applicationState == .active))", completionHandler: nil)
		if let id = pendingConversation {
			pendingConversation = nil
			openConversation(id)
		}
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		handleLoadError(error)
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		handleLoadError(error)
	}

	private func handleLoadError(_ error: Error) {
		let nsError = error as NSError
		if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
		// A download that replaced a navigation is not a failure.
		if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
		pageLoaded = false
		showError()
	}

	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		pageLoaded = false
		webView.reload()
	}

	// MARK: - WKUIDelegate

	// Links meant for a new window: our own pages load here, the rest opens in
	// Safari or the app that handles them.
	func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
		if let url = navigationAction.request.url {
			if isOwnPage(url) {
				webView.load(URLRequest(url: url))
			} else if url.scheme?.lowercased() != "about" {
				UIApplication.shared.open(url)
			}
		}
		return nil
	}

	// Calls and voice messages: only the FrontierX page may use the microphone
	// and the camera (iOS asks the person once per app).
	func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
		decisionHandler(origin.protocol == "https" && origin.host == WebViewController.serverHost ? .grant : .deny)
	}

	func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
		guard presentedViewController == nil else {
			completionHandler()
			return
		}
		let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
		present(alert, animated: true)
	}

	func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
		guard presentedViewController == nil else {
			completionHandler(false)
			return
		}
		let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: WebViewController.russian ? "Отмена" : "Cancel", style: .cancel) { _ in completionHandler(false) })
		alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
		present(alert, animated: true)
	}

	func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
		guard presentedViewController == nil else {
			completionHandler(nil)
			return
		}
		let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
		alert.addTextField { field in field.text = defaultText }
		alert.addAction(UIAlertAction(title: WebViewController.russian ? "Отмена" : "Cancel", style: .cancel) { _ in completionHandler(nil) })
		alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text ?? "") })
		present(alert, animated: true)
	}

	// MARK: - Downloads (recovery key files, exported chats, attachments)

	func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
		let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
		do {
			try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		} catch {
			completionHandler(nil)
			return
		}
		let cleaned = suggestedFilename.replacingOccurrences(of: "/", with: "_").trimmingCharacters(in: .whitespacesAndNewlines)
		let target = folder.appendingPathComponent(cleaned.isEmpty ? "FrontierX-file" : cleaned)
		downloadTargets[download] = target
		completionHandler(target)
	}

	func downloadDidFinish(_ download: WKDownload) {
		guard let file = downloadTargets.removeValue(forKey: download) else { return }
		// The share sheet offers "Save to Files", AirDrop and other apps.
		let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
		if let popover = share.popoverPresentationController {
			popover.sourceView = view
			popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
			popover.permittedArrowDirections = []
		}
		share.completionWithItemsHandler = { _, _, _, _ in
			try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
		}
		if presentedViewController == nil {
			present(share, animated: true)
		}
	}

	func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
		downloadTargets.removeValue(forKey: download)
		presentAlert(title: nil, message: WebViewController.russian ? "Не удалось сохранить файл." : "The file could not be saved.")
	}
}
