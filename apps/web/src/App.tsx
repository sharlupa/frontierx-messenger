import { Navigate, Route, Routes, useLocation } from "react-router-dom"
import { useAuth } from "./state/auth"
import { useSettings } from "./state/settings"
import { Login } from "./routes/Login"
import { Register } from "./routes/Register"
import { Chat } from "./routes/Chat"
import { Invite } from "./routes/Invite"
import { LoadingBlock } from "./components/Expressive"

export function App() {
	const { user, initializing } = useAuth()
	const { t } = useSettings()
	const location = useLocation()
	// "Add account" opens the sign-in screens while another account is active.
	const adding = Boolean(user) && new URLSearchParams(location.search).get("add") === "1"

	if (initializing) {
		return (
			<div className="auth-shell">
				<LoadingBlock label={t("loadingApp")} size={64} />
			</div>
		)
	}

	return (
		<Routes>
			<Route path="/login" element={user && !adding ? <Navigate to="/" replace /> : <Login adding={adding} />} />
			<Route path="/register" element={user && !adding ? <Navigate to="/" replace /> : <Register adding={adding} />} />
			<Route path="/invite/:code" element={<Invite />} />
			<Route path="/" element={user ? <Chat /> : <Navigate to="/login" replace />} />
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	)
}
