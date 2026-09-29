import { useState } from "react"
import type { FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { useAuth } from "../state/auth"
import { api } from "../lib/api"
import { errorText } from "../lib/errorText"
import { pushToast } from "../lib/toasts"
import { useSettings } from "../state/settings"
import { LANGS } from "../lib/i18n"
import { BrandLogo } from "../components/BrandLogo"
import { SegToggle } from "../components/SegToggle"
import { AuthBackdrop } from "../components/Expressive"

export function Register(props: { adding?: boolean }) {
	const { register } = useAuth()
	const navigate = useNavigate()
	const { t, lang, setLang } = useSettings()
	const [username, setUsername] = useState("")
	const [displayName, setDisplayName] = useState("")
	const [password, setPassword] = useState("")
	const [email, setEmail] = useState("")
	const [stage, setStage] = useState<"form" | "verify">("form")
	const [code, setCode] = useState("")
	const [pendingEmail, setPendingEmail] = useState("")
	const [delivered, setDelivered] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [accepted, setAccepted] = useState(false)

	async function onSubmit(e: FormEvent) {
		e.preventDefault()
		setError(null)
		if (!accepted) {
			setError(t("policyRequired"))
			return
		}
		setBusy(true)
		try {
			const outcome = await register(username.trim(), password, displayName.trim(), email.trim(), { add: props.adding })
			if (outcome.emailPending) {
				// The screen opens even when the letter was refused: the code stays
				// valid, a fallback route often delivers it a moment later, and the
				// resend button is right here.
				setPendingEmail(outcome.emailPending)
				setDelivered(Boolean(outcome.emailSent))
				setStage("verify")
				setBusy(false)
				return
			}
			if (outcome.emailError) pushToast({ title: t("emailSection"), body: t("emailAttachFailed") })
			navigate("/")
		} catch (err) {
			setError(errorText(err, t("unableCreate")))
		} finally {
			setBusy(false)
		}
	}

	async function onConfirm(e: FormEvent) {
		e.preventDefault()
		setError(null)
		setBusy(true)
		try {
			await api.confirmEmailAttach(code.trim())
			// A new second account: the app restarts in it.
			if (props.adding) window.location.assign("/")
			else navigate("/")
		} catch (err) {
			setError(errorText(err, t("emailFailed")))
		} finally {
			setBusy(false)
		}
	}

	async function onResend() {
		if (!pendingEmail) return
		setError(null)
		setBusy(true)
		try {
			const res = await api.startEmailAttach(pendingEmail)
			setDelivered(res.sent !== false)
			if (res.sent === false) setError(t("emailNotDelivered"))
		} catch (err) {
			setError(errorText(err, t("emailFailed")))
		} finally {
			setBusy(false)
		}
	}

	if (stage === "verify") {
		return (
			<div className="auth-shell">
				<AuthBackdrop />
				<form className="auth-card" onSubmit={onConfirm}>
					<div className="auth-brand">
						<BrandLogo size={54} />
						<div className="auth-brand-name">{t("emailVerifyTitle")}</div>
					</div>
					<p className="auth-sub">
						{t("emailVerifySub")} {pendingEmail}
					</p>
					{error ? <div className="auth-error">{error}</div> : null}
					{delivered ? null : <p className="auth-hint">{t("emailNotDelivered")}</p>}
					<div className="auth-field">
						<label htmlFor="reg-code">{t("emailCodeLabel")}</label>
						<input
							id="reg-code"
							className="input"
							value={code}
							onChange={(e) => setCode(e.target.value)}
							inputMode="numeric"
							autoComplete="one-time-code"
						/>
					</div>
					<p className="auth-hint">{t("emailSpamHint")}</p>
					<div className="auth-actions">
						<button className="button primary" type="submit" disabled={busy || code.trim().length < 6}>
							{busy ? t("emailSending") : t("emailConfirm")}
						</button>
						<button className="button ghost" type="button" disabled={busy} onClick={() => void onResend()}>
							{t("emailResend")}
						</button>
					</div>
					<div className="auth-switch">
						<button type="button" onClick={() => (props.adding ? window.location.assign("/") : navigate("/"))}>
							{t("emailSkip")}
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
					<div className="auth-brand-name">{t("createAccount")}</div>
				</div>
				<p className="auth-sub">{t("joinFrontierX")}</p>
				{error ? <div className="auth-error">{error}</div> : null}
				<div className="auth-field">
					<label htmlFor="reg-username">{t("username")}</label>
					<input
						id="reg-username"
						className="input"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						autoComplete="username"
					/>
				</div>
				<div className="auth-field">
					<label htmlFor="reg-display">{t("displayName")}</label>
					<input
						id="reg-display"
						className="input"
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
						autoComplete="name"
					/>
				</div>
				<div className="auth-field">
					<label htmlFor="reg-email">{t("emailOptional")}</label>
					<input
						id="reg-email"
						className="input"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						autoComplete="email"
					/>
					<p className="auth-hint">{t("emailSignupHint")}</p>
				</div>
				<div className="auth-field">
					<label htmlFor="reg-password">{t("password")}</label>
					<input
						id="reg-password"
						className="input"
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="new-password"
					/>
				</div>
				<label className="auth-consent">
					<input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
					<span>
						{t("policyAcceptPrefix")}{" "}
						<a href="/privacy" target="_blank" rel="noreferrer">{t("policyAcceptLink")}</a>
					</span>
				</label>
				<div className="auth-actions">
					<button className="button primary" type="submit" disabled={busy || !accepted}>
						{busy ? t("creating") : t("createAccount")}
					</button>
					{props.adding ? (
						<button className="button ghost" type="button" onClick={() => navigate("/")}>
							{t("cancel")}
						</button>
					) : null}
				</div>
				<div className="auth-switch">
					{t("haveAccount")}{" "}
					<button type="button" onClick={() => navigate(props.adding ? "/login?add=1" : "/login")}>
						{t("signIn")}
					</button>
				</div>
				<div className="auth-lang">
					<SegToggle options={LANGS.map((item) => ({ value: item.code, label: item.label }))} value={lang} onChange={(next) => setLang(next)} ariaLabel={t("language")} />
				</div>
			</form>
		</div>
	)
}