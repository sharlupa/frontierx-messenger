import { useEffect, useState } from "react"
import { api } from "../../lib/api"
import { errorText } from "../../lib/errorText"
import { isNativeApp } from "../../lib/native"
import { setSoundEnabled, soundEnabled } from "../../lib/sound"
import { currentSubscription, disableWebPush, enableWebPush, webPushSupport } from "../../lib/webpush"
import { useSettings } from "../../state/settings"
import { Banner, Button, ListGroup, ListItem, SwitchItem } from "../m3"
import { IApple, IBell, IBellOff, ISilent, ISound } from "../m3icons"
import { PageIntro } from "./common"

export function NotificationsPage() {
	const { t } = useSettings()
	const support = webPushSupport()
	const [pushOn, setPushOn] = useState(false)
	const [sound, setSound] = useState(soundEnabled)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)

	useEffect(() => {
		if (support !== "supported") return
		void currentSubscription().then((subscription) => setPushOn(Boolean(subscription) && Notification.permission === "granted"))
	}, [support])

	const togglePush = async (next: boolean) => {
		setBusy(true)
		setError(null)
		setNotice(null)
		try {
			if (next) {
				const ok = await enableWebPush()
				setPushOn(ok)
				if (!ok) setError(t("pushDenied"))
			} else {
				await disableWebPush()
				setPushOn(false)
			}
		} catch (err) {
			setError(errorText(err, t("pushFailed")))
		} finally {
			setBusy(false)
		}
	}

	const test = async () => {
		setBusy(true)
		setError(null)
		try {
			const res = await api.sendTestPush()
			setNotice(res.delivered > 0 ? t("pushTestSent") : t("pushTestNone"))
		} catch (err) {
			setError(errorText(err, t("pushFailed")))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="m3-stack">
			<PageIntro>{t("notificationsCopy")}</PageIntro>
			{error ? <Banner tone="error">{error}</Banner> : null}
			{notice ? <Banner tone="success">{notice}</Banner> : null}
			<ListGroup label={t("pushTitle")}>
				{support === "supported" ? (
					<SwitchItem title={t("pushBackground")} subtitle={t("pushBackgroundHint")} icon={pushOn ? <IBell /> : <IBellOff />} shape="sunny" tone="orange" checked={pushOn} disabled={busy} onChange={(next) => void togglePush(next)} />
				) : support === "ios-app" ? (
					<ListItem title={t("pushIosApp")} subtitle={t("pushIosAppHint")} multiline icon={<IApple />} shape="sunny" tone="orange" />
				) : support === "native" ? (
					<ListItem title={t("pushNative")} subtitle={t("pushNativeHint")} multiline icon={<IBell />} shape="sunny" tone="orange" />
				) : support === "needs-install" ? (
					<ListItem title={t("pushInstallIos")} subtitle={t("pushInstallIosHint")} multiline icon={<IApple />} shape="sunny" tone="orange" />
				) : (
					<ListItem title={t("pushUnsupported")} subtitle={t("pushUnsupportedHint")} multiline icon={<IBellOff />} shape="sunny" tone="neutral" />
				)}
			</ListGroup>
			<ListGroup label={t("inApp")}>
				<SwitchItem title={t("messageSounds")} subtitle={t("messageSoundsHint")} icon={sound ? <ISound /> : <ISilent />} shape="circle" tone="blue" checked={sound} onChange={(next) => { setSoundEnabled(next); setSound(next) }} />
			</ListGroup>
			{pushOn || isNativeApp() ? (
				<div className="m3-row">
					<Button variant="tonal" busy={busy} icon={<IBell size={18} />} onClick={() => void test()}>{t("pushTest")}</Button>
				</div>
			) : null}
		</div>
	)
}
