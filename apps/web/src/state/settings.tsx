import { createContext, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import type { Lang, StringKey } from "../lib/i18n"
import { isLang, langFromTag, setActiveLang, translate } from "../lib/i18n"

export type Theme = "light" | "dark" | "ocean" | "forest" | "sunset" | "midnight" | "telegram" | "nord"

export type ThemeMeta = { id: Theme; fallback: "light" | "dark" }

export const THEMES: ReadonlyArray<ThemeMeta> = [
	{ id: "dark", fallback: "dark" },
	{ id: "light", fallback: "light" },
	{ id: "ocean", fallback: "dark" },
	{ id: "forest", fallback: "dark" },
	{ id: "sunset", fallback: "dark" },
	{ id: "midnight", fallback: "dark" },
	{ id: "telegram", fallback: "dark" },
	{ id: "nord", fallback: "light" },
]

export const THEME_IDS: ReadonlyArray<Theme> = THEMES.map((item) => item.id)

function themeFallback(theme: string): "light" | "dark" {
	const found = THEMES.find((item) => item.id === theme)
	return found ? found.fallback : "dark"
}

export const ACCENT_PRESETS: ReadonlyArray<string> = [
	"#3390ec",
	"#7c5cff",
	"#22b07d",
	"#ff9f43",
	"#ff6b81",
	"#38bdf8",
]

// "full" is the Material 3 Expressive motion set; "reduced" keeps only
// instant state changes. The OS "reduce motion" setting is honoured either way.
export type Motion = "full" | "reduced"

type SettingsValue = {
	theme: Theme
	lang: Lang
	accent: string | null
	motion: Motion
	setMotion: (value: Motion) => void
	setTheme: (value: Theme) => void
	setLang: (value: Lang) => void
	setAccent: (value: string | null) => void
	toggleTheme: () => void
	t: (key: StringKey) => string
}

const SettingsContext = createContext<SettingsValue | null>(null)

const THEME_KEY = "frontierx.theme"
const LANG_KEY = "frontierx.lang"
const ACCENT_KEY = "frontierx.accent"
const MOTION_KEY = "frontierx.motion"

function readMotion(): Motion {
	try {
		return localStorage.getItem(MOTION_KEY) === "reduced" ? "reduced" : "full"
	} catch {
		return "full"
	}
}

function readTheme(): Theme {
	try {
		const saved = localStorage.getItem(THEME_KEY)
		if (saved && (THEME_IDS as ReadonlyArray<string>).indexOf(saved) >= 0) return saved as Theme
		// Backward compatibility: old builds stored only light/dark.
		if (saved === "light" || saved === "dark") return saved
	} catch {
		// ignore storage access errors
	}
	return "dark"
}

function isValidAccent(value: string | null): value is string {
	if (!value) return false
	return /^#[0-9a-fA-F]{6}$/.test(value)
}

// Text colour that stays readable on a custom accent (WCAG relative luminance).
function textOnAccent(hex: string): string {
	const channel = (index: number) => {
		const value = parseInt(hex.slice(index, index + 2), 16) / 255
		return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
	}
	const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
	return luminance > 0.4 ? "#0b1620" : "#ffffff"
}

function readAccent(): string | null {
	try {
		const saved = localStorage.getItem(ACCENT_KEY)
		if (saved && isValidAccent(saved)) return saved
	} catch {
		// ignore storage access errors
	}
	return null
}

function readLang(): Lang {
	try {
		const saved = localStorage.getItem(LANG_KEY)
		if (isLang(saved)) return saved
	} catch {
		// ignore storage access errors
	}
	return langFromTag(typeof navigator !== "undefined" ? navigator.language : null)
}

export function SettingsProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(readTheme)
	const [lang, setLangState] = useState<Lang>(readLang)
	setActiveLang(lang)
	const [accent, setAccentState] = useState<string | null>(readAccent)
	const [motion, setMotionState] = useState<Motion>(readMotion)

	useEffect(() => {
		document.documentElement.dataset.motion = motion
		try {
			localStorage.setItem(MOTION_KEY, motion)
		} catch {
			// ignore storage access errors
		}
	}, [motion])

	useEffect(() => {
		const root = document.documentElement
		root.dataset.theme = theme
		// Keep color-scheme in sync so native controls follow light/dark base.
		root.style.colorScheme = themeFallback(theme)
		// The browser bar, the Android status bar and the iPhone app's status bar
		// take their colour from theme-color: keep it matching the theme.
		const themeColor = getComputedStyle(root).getPropertyValue("--bg-sidebar").trim()
		const meta = document.querySelector('meta[name="theme-color"]')
		if (meta && themeColor) meta.setAttribute("content", themeColor)
		try {
			localStorage.setItem(THEME_KEY, theme)
		} catch {
			// ignore storage access errors
		}
	}, [theme])

	useEffect(() => {
		const root = document.documentElement
		if (accent && isValidAccent(accent)) {
			root.style.setProperty("--accent", accent)
			root.style.setProperty("--denim", accent)
			root.style.setProperty("--on-accent", textOnAccent(accent))
		} else {
			root.style.removeProperty("--accent")
			root.style.removeProperty("--denim")
			root.style.removeProperty("--on-accent")
		}
		try {
			if (accent && isValidAccent(accent)) localStorage.setItem(ACCENT_KEY, accent)
			else localStorage.removeItem(ACCENT_KEY)
		} catch {
			// ignore storage access errors
		}
	}, [accent])

	useEffect(() => {
		document.documentElement.setAttribute("lang", lang)
		try {
			localStorage.setItem(LANG_KEY, lang)
		} catch {
			// ignore storage access errors
		}
	}, [lang])

	const value = useMemo<SettingsValue>(
		() => ({
			theme,
			lang,
			accent,
			motion,
			setMotion: setMotionState,
			setTheme: setThemeState,
			setLang: setLangState,
			setAccent: (next: string | null) => setAccentState(next && isValidAccent(next) ? next : null),
			toggleTheme: () => setThemeState((current) => (themeFallback(current) === "dark" ? "light" : "dark")),
			t: (key: StringKey) => translate(lang, key),
		}),
		[theme, lang, accent, motion],
	)

	return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsValue {
	const ctx = useContext(SettingsContext)
	if (!ctx) throw new Error("useSettings must be used within SettingsProvider")
	return ctx
}