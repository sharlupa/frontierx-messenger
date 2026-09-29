import Foundation
import WebKit

// window.FrontierXNative for the web client: the same small bridge the Android
// and desktop apps provide. Calls from the page arrive as script messages;
// only the FrontierX server's own page may use it.
final class NativeBridge: NSObject, WKScriptMessageHandler {
	static let name = "frontierx"

	weak var controller: WebViewController?

	// Installed before any page script runs. isFocused() must answer at once,
	// so the app pushes its focus state into the page instead of being asked.
	static func script(version: String) -> String {
		return """
		(function () {
			if (window.FrontierXNative) return;
			var focused = true;
			function post(message) {
				try { window.webkit.messageHandlers.\(name).postMessage(message); } catch (e) {}
			}
			window.__fxSetFocused = function (value) { focused = !!value; };
			window.FrontierXNative = {
				platform: "ios",
				version: "\(version)",
				isFocused: function () { return focused && !document.hidden; },
				notify: function (title, body, tag) {
					post({ type: "notify", title: String(title == null ? "" : title), body: String(body == null ? "" : body), tag: String(tag == null ? "" : tag) });
				},
				checkUpdates: function () { post({ type: "checkUpdates" }); },
				setAuthToken: function () {},
				clearAuthToken: function () {},
				pushEnabled: function () { return false; }
			};
		})();
		"""
	}

	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
		guard message.frameInfo.isMainFrame else { return }
		let origin = message.frameInfo.securityOrigin
		guard origin.protocol == "https", origin.host == WebViewController.serverHost else { return }
		guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
		switch type {
		case "notify":
			let title = body["title"] as? String ?? ""
			let text = body["body"] as? String ?? ""
			let tag = body["tag"] as? String ?? ""
			controller?.showNotification(title: title, body: text, tag: tag)
		case "checkUpdates":
			controller?.showVersionInfo()
		default:
			break
		}
	}
}

// WKUserContentController keeps its handlers alive; this breaks the cycle
// between the web view and the controller that owns it.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
	private weak var target: WKScriptMessageHandler?

	init(_ target: WKScriptMessageHandler) {
		self.target = target
	}

	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
		target?.userContentController(userContentController, didReceive: message)
	}
}
