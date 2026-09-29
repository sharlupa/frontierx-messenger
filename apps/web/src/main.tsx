import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { App } from "./App"
import { AuthProvider } from "./state/auth"
import { SettingsProvider } from "./state/settings"
import "./theme.css"
import "./features.css"
import "./mobile-fixes.css"
import "./expressive.css"
import "./m3.css"
import "./m3-screens.css"
import "./m3-emoji.css"

const rootElement = document.getElementById("root")
if (!rootElement) {
	throw new Error("Root element not found")
}

ReactDOM.createRoot(rootElement).render(
	<React.StrictMode>
		<BrowserRouter>
			<SettingsProvider>
				<AuthProvider>
					<App />
				</AuthProvider>
			</SettingsProvider>
		</BrowserRouter>
	</React.StrictMode>,
)