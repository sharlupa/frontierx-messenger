import { useState } from "react"
import { isNativeApp, nativeCheckUpdates } from "../../lib/native"
import { APP_BUILD, APP_VERSION } from "../../lib/buildInfo"
import { platformKind, type PlatformKind } from "../../lib/platform"
import type { StringKey } from "../../lib/i18n"
import { useSettings } from "../../state/settings"
import { BrandLogo } from "../BrandLogo"
import { Banner, ListGroup, ListItem } from "../m3"
import { IApple, ICode, IDesktop, IInfo, IPhone, IShield, IUpdate } from "../m3icons"

// Systems go by their own names; the two web cases are described in words.
const PLATFORM_NAMES: Record<PlatformKind, string | { key: StringKey }> = {
	android: "Android",
	ios: "iOS",
	macos: "macOS",
	windows: "Windows",
	linux: "Linux",
	webapp: { key: "platformWebApp" },
	browser: { key: "platformBrowser" },
}

export function usePlatformLabel(): string {
	const { t } = useSettings()
	const name = PLATFORM_NAMES[platformKind()]
	return typeof name === "string" ? name : t(name.key)
}

export function AboutPage() {
	const { t } = useSettings()
	const platform = usePlatformLabel()
	const [notice, setNotice] = useState<string | null>(null)
	return (
		<div className="m3-stack">
			<section className="settings-about-hero">
				<BrandLogo size={72} />
				<h3>FrontierX</h3>
				<p title={APP_BUILD || undefined}>{t("aboutVersion")} {APP_VERSION} · {platform}</p>
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
