import UIKit
import UserNotifications

// FrontierX for iPhone and iPad: a native window around the FrontierX web
// client. Chats, keys and encryption all live in the web client (the same one
// the browser, Android and desktop apps load), so the app itself stays small:
// permissions, notifications, downloads and links opening outside.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
	var window: UIWindow?

	func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
		UNUserNotificationCenter.current().delegate = self
		let window = UIWindow(frame: UIScreen.main.bounds)
		window.backgroundColor = WebViewController.backgroundColor
		window.rootViewController = WebViewController()
		window.makeKeyAndVisible()
		self.window = window
		UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
		return true
	}

	// A tap on a notification opens its chat.
	func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
		let conversationId = response.notification.request.content.userInfo["conversationId"] as? String
		DispatchQueue.main.async {
			if let id = conversationId, let controller = self.window?.rootViewController as? WebViewController {
				controller.openConversation(id)
			}
			completionHandler()
		}
	}

	// The page only asks for a system notification while it is not on screen,
	// so whatever arrives here is shown.
	func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
		completionHandler([.banner, .list, .sound])
	}
}
