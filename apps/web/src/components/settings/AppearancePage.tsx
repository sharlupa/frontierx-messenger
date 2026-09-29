import { useState } from "react"
import { ACCENT_PRESETS, THEMES, useSettings } from "../../state/settings"
import type { Theme } from "../../state/settings"
import { LANGS } from "../../lib/i18n"
import type { StringKey } from "../../lib/i18n"
import { ListGroup, ListItem } from "../m3"
import { ICheck, IGlobe, IMotion } from "../m3icons"
import { ChoiceSheet } from "./common"

const THEME_LABEL: Record<Theme, StringKey> = {
	dark: "themeDark",
	light: "themeLight",
	ocean: "themeOcean",
	forest: "themeForest",
	sunset: "themeSunset",
	midnight: "themeMidnight",
	telegram: "themeTelegram",
	nord: "themeNord",
}

export function AppearancePage() {
	const { t, theme, setTheme, accent, setAccent, lang, setLang, motion, setMotion } = useSettings()
	const [picking, setPicking] = useState<"lang" | "motion" | null>(null)
	return (
		<div className="m3-stack">
			<ListGroup label={t("theme")}>
				<div className="m3-list-item settings-theme-grid-item">
					<div className="theme-grid m3-theme-grid" role="radiogroup" aria-label={t("theme")}>
						{THEMES.map((item) => {
							const active = item.id === theme
							return (
								<button key={item.id} type="button" role="radio" aria-checked={active} className={"theme-card" + (active ? " active" : "")} onClick={() => setTheme(item.id)}>
									<span className="theme-card-preview" data-theme-mini={item.id} aria-hidden="true">
										<span className="theme-mini-side" />
										<span className="theme-mini-chat">
											<span className="theme-mini-bubble in" />
											<span className="theme-mini-bubble out" />
										</span>
									</span>
									<span className="theme-card-name">{t(THEME_LABEL[item.id])}</span>
									{active ? <span className="theme-card-check" aria-hidden="true"><ICheck size={14} /></span> : null}
								</button>
							)
						})}
					</div>
				</div>
			</ListGroup>
			<ListGroup label={t("accentTitle")}>
				<div className="m3-list-item settings-accent-item">
					<p className="settings-intro">{t("accentCopy")}</p>
					<div className="accent-row" role="radiogroup" aria-label={t("accentTitle")}>
						{ACCENT_PRESETS.map((color) => {
							const active = accent?.toLowerCase() === color.toLowerCase()
							return (
								<button key={color} type="button" role="radio" aria-checked={active} className={"accent-dot" + (active ? " active" : "")} style={{ background: color }} aria-label={color} onClick={() => setAccent(active ? null : color)}>
									{active ? <ICheck size={16} /> : null}
								</button>
							)
						})}
						<label className="accent-custom" title={t("accentCustom")}>
							<input type="color" value={accent ?? "#3390ec"} onChange={(event) => setAccent(event.target.value)} aria-label={t("accentCustom")} />
							<span>{t("accentCustom")}</span>
						</label>
						{accent ? <button type="button" className="m3-btn text" onClick={() => setAccent(null)}>{t("accentReset")}</button> : null}
					</div>
				</div>
			</ListGroup>
			<ListGroup label={t("appearanceMore")}>
				<ListItem title={t("language")} subtitle={LANGS.find((item) => item.code === lang)?.label} icon={<IGlobe />} shape="circle" tone="blue" onClick={() => setPicking("lang")} chevron />
				<ListItem title={t("motionLabel")} subtitle={motion === "reduced" ? t("motionReduced") : t("motionFull")} icon={<IMotion />} shape="circle" tone="pink" onClick={() => setPicking("motion")} chevron />
			</ListGroup>
			{picking === "lang" ? (
				<ChoiceSheet title={t("language")} value={lang} options={LANGS.map((item) => ({ value: item.code, label: item.label }))} onPick={(value) => setLang(value)} onClose={() => setPicking(null)} />
			) : null}
			{picking === "motion" ? (
				<ChoiceSheet
					title={t("motionLabel")}
					value={motion}
					options={[
						{ value: "full", label: t("motionFull"), description: t("motionFullHint") },
						{ value: "reduced", label: t("motionReduced"), description: t("motionReducedHint") },
					]}
					onPick={(value) => setMotion(value)}
					onClose={() => setPicking(null)}
				/>
			) : null}
		</div>
	)
}
