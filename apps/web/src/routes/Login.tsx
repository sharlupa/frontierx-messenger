import { useState } from "react"
import type { FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { signedOutAccount, useAuth } from "../state/auth"
import { api } from "../lib/api"
import { errorText } from "../lib/errorText"
import { useSettings } from "../state/settings"
import { LANGS } from "../lib/i18n"
import { BrandLogo } from "../components/BrandLogo"
import { SegToggle } from "../components/SegToggle"
import { AuthBackdrop } from "../components/Expressive"
import { Avatar } from "../components/m3"

export function Login(props: { adding?: boolean }) {
	const { login, accounts, switchAccount, removeAccountFromDevice } = useAuth()
	const navigate = useNavigate()
	const { t, lang, setLang } = useSettings()
	// The session of the active account ended (signed out elsewhere, expired):
	// offer it again, and the other accounts on this device.
	const [ended] = useState(() => (props.adding ? null : signedOutAccount()))
	const others = accounts.filter((account) => account.token && account.id !== ended?.id)
	const [username, setUsername] = useState(ended?.username ?? "")
	const [password, setPassword] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [mode, setMode] = useState<"signIn" | "recover">("signIn")
	const [recoverStep, setRecoverStep] = useState<"request" | "confirm">("request")
	const [recoverEmail, setRecoverEmail] = useState("")
	const [recoverCode, setRecoverCode] = useState("")
	const [recoverPassword, setRecoverPassword] = useState("")
	const [notice, setNotice] = useState<string | null>(null)

	async function onSubmit(e: FormEvent) {
		e.preventDefault()
		setError(null)
		setBusy(true)
		try {
			await login(username.trim(), password, { add: props.adding })
			navigate("/")
		} catch (err) {
			setError(errorText(err, t("unableSignIn")))
		} finally {
			setBusy(false)
		}
	}

	async function onRequestCode(e: FormEvent) {
		e.preventDefault()
		setError(null)
		setNotice(null)
		setBusy(true)
		try {
			await api.requestPasswordReset(recoverEmail.trim())
			setRecoverStep("confirm")
			setNotice(t("recoverySent"))
		} catch (err) {
			setError(errorText(err, t("unableReset")))
		} finally {
			setBusy(false)
		}
	}

	async function onResetPassword(e: FormEvent) {
		e.preventDefault()
		setError(null)
		setNotice(null)
		setBusy(true)
		try {
			await api.resetPassword({ email: recoverEmail.trim(), code: recoverCode.trim(), password: recoverPassword })
			setMode("signIn")
			setRecoverStep("request")
			setRecoverCode("")
			setRecoverPassword("")
			setNotice(t("passwordChanged"))
		} catch (err) {
			setError(errorText(err, t("unableReset")))
		} finally {
			setBusy(false)
		}
	}

	if (mode === "recover") {
		return (
			<div className="auth-shell">
				<AuthBackdrop />
				<form className="auth-card" onSubmit={recoverStep === "request" ? onRequestCode : onResetPassword}>
					<div className="auth-brand">
						<BrandLogo size={54} />
						<div className="auth-brand-name">FrontierX</div>
					</div>
					<p className="auth-sub">{t("recoveryTitle")}</p>
					<p className="auth-sub">{t("recoverySub")}</p>
					{error ? <div className="auth-error">{error}</div> : null}
					{notice ? <p className="auth-sub">{notice}</p> : null}
					<div className="auth-field">
						<label htmlFor="recover-email">{t("emailAddress")}</label>
						<input id="recover-email" className="input" type="email" value={recoverEmail} onChange={(e) => setRecoverEmail(e.target.value)} autoComplete="email" />
					</div>
					{recoverStep === "confirm" ? (
						<div className="auth-field">
							<label htmlFor="recover-code">{t("recoveryCode")}</label>
							<input id="recover-code" className="input" inputMode="numeric" maxLength={6} value={recoverCode} onChange={(e) => setRecoverCode(e.target.value)} />
						</div>
					) : null}
					{recoverStep === "confirm" ? (
						<div className="auth-field">
							<label htmlFor="recover-password">{t("newPassword")}</label>
							<input id="recover-password" className="input" type="password" value={recoverPassword} onChange={(e) => setRecoverPassword(e.target.value)} autoComplete="new-password" />
						</div>
					) : null}
					<div className="auth-actions">
						<button className="button primary" type="submit" disabled={busy}>
							{recoverStep === "request" ? t("emailSendCode") : t("changePassword")}
						</button>
					</div>
					<div className="auth-switch">
						<button type="button" onClick={() => { setMode("signIn"); setError(null); setNotice(null); setRecoverStep("request") }}>
							{t("backToSignIn")}
						</button>
					</div>
				</form>
			</div>
		)
	}

	return (
		<div className="auth-shell">
			<AuthBackdrop />
			<form className="auth-card" onSubmit={onSubmit}>
				<div className="auth-brand">
					<BrandLogo size={54} />
					<div className="auth-brand-name">FrontierX</div>
				</div>
				<p className="auth-sub">{props.adding ? t("addAccountSub") : ended ? t("accountSignedOut") : t("signInSub")}</p>
				{ended ? (
					<div className="auth-account">
						<Avatar src={ended.avatar} label={ended.displayName || ended.username} seed={ended.id} size={40} />
						<span className="auth-account-text">
							<span className="auth-account-name">{ended.displayName || ended.username}</span>
							<span className="auth-account-sub">@{ended.username}</span>
						</span>
						<button type="button" className="m3-btn text" onClick={() => removeAccountFromDevice(ended.id)}>{t("removeFromDevice")}</button>
					</div>
				) : null}
				{error ? <div className="auth-error">{error}</div> : null}
				{notice ? <p className="auth-sub">{notice}</p> : null}
				<div className="auth-field">
					<label htmlFor="login-username">{t("username")}</label>
					<input
						id="login-username"
						className="input"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						autoComplete="username"
					/>
				</div>
				<div className="auth-field">
					<label htmlFor="login-password">{t("password")}</label>
					<input
						id="login-password"
						className="input"
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="current-password"
					/>
				</div>
				<div className="auth-actions">
					<button className="button primary" type="submit" disabled={busy}>
						{busy ? t("signingIn") : props.adding ? t("addAccount") : t("signIn")}
					</button>
					{props.adding ? (
						<button className="button ghost" type="button" onClick={() => navigate("/")}>
							{t("cancel")}
						</button>
					) : null}
				</div>
				<div className="auth-switch">
					<button type="button" onClick={() => { setMode("recover"); setError(null); setNotice(null) }}>
						{t("forgotPassword")}
					</button>
				</div>
				<div className="auth-switch">
					{t("noAccount")}{" "}
					<button type="button" onClick={() => navigate(props.adding ? "/register?add=1" : "/register")}>
						{t("createOne")}
					</button>
				</div>
				{others.length > 0 && !props.adding ? (
					<div className="auth-others">
						<span className="auth-others-label">{t("accountsOnDevice")}</span>
						{others.map((account) => (
							<button key={account.id} type="button" className="auth-account interactive" onClick={() => switchAccount(account.id)}>
								<Avatar src={account.avatar} label={account.displayName || account.username} seed={account.id} size={36} />
								<span className="auth-account-text">
									<span className="auth-account-name">{account.displayName || account.username}</span>
									<span className="auth-account-sub">@{account.username}</span>
								</span>
							</button>
						))}
					</div>
				) : null}
				<div className="auth-lang">
					<SegToggle options={LANGS.map((item) => ({ value: item.code, label: item.label }))} value={lang} onChange={(next) => setLang(next)} ariaLabel={t("language")} />
				</div>
			</form>
		</div>
	)
}