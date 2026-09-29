import { useEffect, useState } from "react"
import { api } from "../../lib/api"
import type { SessionDevice } from "../../lib/types"
import { errorText } from "../../lib/errorText"
import { formatDateTime } from "../../lib/i18n"
import { useAuth } from "../../state/auth"
import { useSettings } from "../../state/settings"
import { LoadingBlock } from "../Expressive"
import { Banner, Button, IconButton, ListGroup, ListItem } from "../m3"
import { IDesktop, ILogout, IPhone, IApple, IGlobe } from "../m3icons"
import { PageIntro } from "./common"

function deviceIcon(label: string) {
	if (/iPhone|iPad|iOS|Macintosh|Mac OS/i.test(label)) return <IApple />
	if (/Android|Mobile/i.test(label)) return <IPhone />
	if (/Windows|Linux|X11|Electron|FrontierX/i.test(label)) return <IDesktop />
	return <IGlobe />
}

// Short, readable name for a user-agent string.
export function deviceName(label: string): string {
	const app = /FrontierX/i.test(label) || /Electron/i.test(label) ? "FrontierX" : null
	const browser = /Edg\//.test(label) ? "Edge" : /OPR\//.test(label) ? "Opera" : /YaBrowser/.test(label) ? "Yandex Browser" : /Firefox\//.test(label) ? "Firefox" : /Chrome\//.test(label) ? "Chrome" : /Safari\//.test(label) ? "Safari" : null
	const os = /iPhone/.test(label) ? "iPhone" : /iPad/.test(label) ? "iPad" : /Android/.test(label) ? "Android" : /Mac OS X|Macintosh/.test(label) ? "macOS" : /Windows/.test(label) ? "Windows" : /Linux/.test(label) ? "Linux" : null
	const who = app ?? browser
	if (who && os) return who + " · " + os
	return who ?? os ?? label.slice(0, 60)
}

export function DevicesPage() {
	const { t, lang } = useSettings()
	const { logout } = useAuth()
	const [sessions, setSessions] = useState<SessionDevice[] | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const load = async () => {
		try {
			setSessions((await api.listSessions()).sessions)
		} catch (err) {
			setError(errorText(err, t("devicesLoadFailed")))
		}
	}
	useEffect(() => {
		void load()
	}, [])

	const revoke = async (session: SessionDevice) => {
		setBusy(session.id)
		setError(null)
		try {
			const res = await api.revokeSession(session.id)
			if (res.currentSessionRevoked) {
				logout()
				return
			}
			setSessions((items) => (items ?? []).filter((item) => item.id !== session.id))
		} catch (err) {
			setError(errorText(err, t("deviceSignOutFailed")))
		} finally {
			setBusy(null)
		}
	}

	const revokeOthers = async () => {
		setBusy("others")
		setError(null)
		try {
			await api.revokeOtherSessions()
			setSessions((items) => (items ?? []).filter((item) => item.current))
		} catch (err) {
			setError(errorText(err, t("otherDevicesSignOutFailed")))
		} finally {
			setBusy(null)
		}
	}

	if (!sessions) return error ? <Banner tone="error">{error}</Banner> : <LoadingBlock size={44} label={t("loadingDevices")} />
	const current = sessions.filter((session) => session.current)
	const others = sessions.filter((session) => !session.current)
	return (
		<div className="m3-stack">
			<PageIntro>{t("devicesCopy")}</PageIntro>
			{error ? <Banner tone="error">{error}</Banner> : null}
			<ListGroup label={t("thisDevice")}>
				{current.map((session) => (
					<ListItem key={session.id} title={deviceName(session.label)} subtitle={t("current")} icon={deviceIcon(session.label)} shape="cookie" tone="primary" selected />
				))}
			</ListGroup>
			<ListGroup label={t("otherDevices")}>
				{others.length === 0 ? <ListItem title={t("noOtherDevices")} /> : null}
				{others.map((session) => (
					<ListItem
						key={session.id}
						title={deviceName(session.label)}
						subtitle={t("lastActive") + " " + formatDateTime(lang, session.lastSeenAt)}
						icon={deviceIcon(session.label)}
						shape="circle"
						tone="neutral"
						trailing={
							<IconButton label={t("signOutDevice")} disabled={busy !== null} onClick={() => void revoke(session)}>
								<ILogout />
							</IconButton>
						}
					/>
				))}
			</ListGroup>
			{others.length > 0 ? (
				<div className="m3-row">
					<Button variant="tonal" icon={<ILogout size={18} />} busy={busy === "others"} onClick={() => void revokeOthers()}>{t("signOutOthers")}</Button>
				</div>
			) : null}
		</div>
	)
}
