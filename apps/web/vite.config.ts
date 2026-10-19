import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { VitePWA } from "vite-plugin-pwa"
import { readFileSync } from "node:fs"

// The version comes from package.json and the build time is stamped in, so
// the About page and bug reports say exactly which build someone runs.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__APP_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16) + "Z"),
	},
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			manifest: {
				name: "FrontierX",
				short_name: "FrontierX",
				description: "FrontierX secure messenger",
				theme_color: "#17212b",
				background_color: "#0e1621",
				display: "standalone",
				start_url: "/?app=1",
				icons: [
					{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
					{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
					{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
					{ src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
				],
				categories: ["social", "communication"],
			},
			includeAssets: ["favicon.svg", "icons/apple-touch-icon.png", "icons/badge-96.png"],
			workbox: {
				// Web push (notifications with the app closed, including installed
				// web apps on iPhone) is handled by a small script of our own.
				importScripts: ["/push-sw.js"],
				// The emoji search index is fetched only when someone searches, so
				// it is not downloaded ahead with the rest of the app.
				globIgnores: ["**/emojiNames-*.js"],
				// frontierx-landing
				navigateFallback: "/index.html",
				// Landing routes must reach the server: without them here the app's
				// service worker answers the navigation with its own index.html and
				// the visitor lands in the chat instead of the page they opened.
				navigateFallbackDenylist: [/^[/]$/, /^[/]home/, /^[/]download/, /^[/]features/, /^[/]privacy/, /^[/]delete-account/, /^[/]changes/, /^[/]changelog/, /^[/]site[/]/, /^[/]releases[/]/, /^[/]sdk[/]/],
			},
		}),
	],
	server: {
		port: 5173,
		host: true,
		// Cloudflare quick tunnels use a random *.trycloudflare.com hostname.
		allowedHosts: true,
		proxy: {
			"/api": "http://127.0.0.1:8080",
			"/ws": { target: "ws://127.0.0.1:8080", ws: true },
		},
	},
})