import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { api } from "../lib/api"
import type { StringKey } from "../lib/i18n"
import { useSettings } from "../state/settings"
import { AuthBackdrop, LoadingBlock } from "../components/Expressive"

type InviteInfo = {
	code: string
	kind: string
	title: string | null
	avatar: string | null
}

function kindKey(kind: string): StringKey {
	if (kind === "channel") return "kindChannel"
	if (kind === "group") return "kindGroup"
	return "kindDirect"
}

function initial(title: string | null): string {
	const value = (title ?? "").trim()
	if (!value) return "?"
	return value.slice(0, 1).toUpperCase()
}

export function Invite() {
	const { code } = useParams()
	const navigate = useNavigate()
	const { t } = useSettings()
	const [info, setInfo] = useState<InviteInfo | null>(null)
	const [failed, setFailed] = useState(false)
	const [loading, setLoading] = useState(true)

	// Inside the Android shell or the desktop app there is nothing to choose:
	// both expose a bridge object on window, so we can just continue.
	const insideApp = useMemo(() => {
		const scope = window as unknown as Record<string, unknown>
		return Boolean(scope.FrontierXNative) || Boolean(scope.frontierxDesktop)
	}, [])

	function continueInBrowser() {
		if (code) {
			try {
				window.localStorage.setItem("pendingInvite", code)
			} catch {
				/* storage disabled, the code is simply lost */
			}
		}
		navigate("/", { replace: true })
	}

	function openInApp() {
		if (!code) return
		window.location.href = "frontierx://invite/" + encodeURIComponent(code)
	}

	useEffect(() => {
		if (!code) {
			setFailed(true)
			setLoading(false)
			return
		}
		if (insideApp) {
			continueInBrowser()
			return
		}
		let alive = true
		api
			.inviteInfo(code)
			.then((res) => {
				if (!alive) return
				setInfo(res)
				setLoading(false)
			})
			.catch(() => {
				if (!alive) return
				setFailed(true)
				setLoading(false)
			})
		return () => {
			alive = false
		}
	}, [code, insideApp])

	if (loading) {
		return (
			<div className="auth-shell">
				<AuthBackdrop />
				<LoadingBlock label={t("inviteLoading")} />
			</div>
		)
	}

	if (failed || !info) {
		return (
			<div className="auth-shell">
				<AuthBackdrop />
				<div className="auth-card invite-card">
					<div className="invite-title">{t("inviteInvalidTitle")}</div>
					<p className="invite-kind">{t("inviteInvalidBody")}</p>
					<div className="invite-actions">
						<button type="button" className="button" onClick={() => navigate("/", { replace: true })}>
							{t("inviteOpenApp")}
						</button>
					</div>
				</div>
			</div>
		)
	}

	return (
		<div className="auth-shell">
			<AuthBackdrop />
			<div className="auth-card invite-card">
				<div className={"invite-avatar" + (info.kind === "channel" ? " shape-channel" : info.kind === "group" ? " shape-group" : "")}>
					{info.avatar ? <img src={info.avatar} alt="" /> : <span>{initial(info.title)}</span>}
				</div>
				<div className="invite-title">{info.title ?? t("inviteUntitled")}</div>
				<p className="invite-kind">{t(kindKey(info.kind))} — {t("inviteKindSuffix")}</p>
				<div className="invite-actions">
					<button type="button" className="button" onClick={continueInBrowser}>
						{t("inviteContinueBrowser")}
					</button>
					<button type="button" className="button ghost" onClick={openInApp}>
						{t("inviteOpenInApp")}
					</button>
				</div>
				<p className="invite-hint">
					{t("inviteAppHint")}
				</p>
			</div>
		</div>
	)
}
