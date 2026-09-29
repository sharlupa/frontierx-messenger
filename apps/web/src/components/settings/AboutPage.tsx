import { useState } from "react"
import { isNativeApp, nativeCheckUpdates, nativePlatform } from "../../lib/native"
import { isStandalone } from "../../lib/webpush"
import { useSettings } from "../../state/settings"
import { BrandLogo } from "../BrandLogo"
import { Banner, ListGroup, ListItem } from "../m3"
import { IApple, ICode, IDesktop, IInfo, IPhone, IShield, IUpdate } from "../m3icons"

const APP_VERSION = "0.3.0"

function platformLabel(): string {
	const native = nativePlatform()
	if (native === "android") return "Android"
	if (native === "ios") return "iOS"
	if (native === "desktop") return /Mac/i.test(navigator.userAgent) ? "macOS" : /Windows/i.test(navigator.userAgent) ? "Windows" : "Linux"
	return isStandalone() ? "Web app" : "Browser"
}

export function AboutPage() {
	const { t } = useSettings()
	const [notice, setNotice] = useState<string | null>(null)
	return (
		<div className="m3-stack">
			<section className="settings-about-hero">
				<BrandLogo size={72} />
				<h3>FrontierX</h3>
				<p>{t("aboutVersion")} {APP_VERSION} · {platformLabel()}</p>
			</section>
			{notice ? <Banner tone="info" icon={<IInfo />}>{notice}</Banner> : null}
			<ListGroup label={t("updatesSection")}>
				<ListItem
					title={t("updatesCheck")}
					subtitle={isNativeApp() ? t("updatesNativeHint") : t("updatesBrowser")}
					multiline
					icon={<IUpdate />}
					shape="circle"
					tone="blue"
					onClick={() => {
						if (isNativeApp()) nativeCheckUpdates()
						else setNotice(t("updatesBrowser"))
					}}
				/>
			</ListGroup>
			<ListGroup label={t("getTheApp")}>
				<ListItem title="Android" subtitle={t("getAndroid")} icon={<IPhone />} shape="cookie" tone="green" href="/download" chevron />
				<ListItem title="iPhone / iPad" subtitle={t("getIos")} multiline icon={<IApple />} shape="cookie" tone="neutral" href="/download#ios" chevron />
				<ListItem title="Windows · macOS · Linux" subtitle={t("getDesktop")} icon={<IDesktop />} shape="cookie" tone="blue" href="/download#desktop" chevron />
			</ListGroup>
			<ListGroup>
				<ListItem title={t("policyLink")} icon={<IShield />} shape="circle" tone="neutral" href="/privacy" chevron />
				<ListItem title={t("botsDocs")} icon={<ICode />} shape="circle" tone="neutral" href="/sdk/README.md" chevron />
			</ListGroup>
		</div>
	)
}
