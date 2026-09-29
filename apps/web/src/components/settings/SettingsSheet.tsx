import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Avatar, Badge, IconButton, ListGroup, ListItem, Sheet, useSheetClose, type ShapeName, type Tone } from "../m3"
import { IAdd, IBack, IBell, IBot, IClose, IDevices, IInfo, IKey, ILogout, IPalette, IPerson, IShield } from "../m3icons"
import { MorphBlob } from "../Expressive"
import { useAuth } from "../../state/auth"
import { useSettings } from "../../state/settings"
import type { StringKey } from "../../lib/i18n"
import type { User } from "../../lib/types"
import { MAX_ACCOUNTS } from "../../lib/session"
import { AccountPage } from "./AccountPage"
import { PrivacyPage } from "./PrivacyPage"
import { SecurityPage } from "./SecurityPage"
import { DevicesPage } from "./DevicesPage"
import { NotificationsPage } from "./NotificationsPage"
import { AppearancePage } from "./AppearancePage"
import { BotsPage } from "./BotsPage"
import { AboutPage } from "./AboutPage"
import { SignOutSheet } from "./SignOutSheet"

export type SettingsPageId = "home" | "account" | "privacy" | "security" | "devices" | "notifications" | "appearance" | "bots" | "about"

type Category = { id: Exclude<SettingsPageId, "home">; title: StringKey; hint: StringKey; icon: ReactNode; shape: ShapeName; tone: Tone }

const CATEGORIES: Category[] = [
	{ id: "account", title: "settingsAccount", hint: "settingsAccountHint", icon: <IPerson />, shape: "cookie", tone: "blue" },
	{ id: "privacy", title: "privacy", hint: "settingsPrivacyHint", icon: <IShield />, shape: "clover", tone: "green" },
	{ id: "security", title: "settingsSecurity", hint: "settingsSecurityHint", icon: <IKey />, shape: "cookie12", tone: "violet" },
	{ id: "devices", title: "devices", hint: "settingsDevicesHint", icon: <IDevices />, shape: "pentagon", tone: "teal" },
	{ id: "notifications", title: "settingsNotifications", hint: "settingsNotificationsHint", icon: <IBell />, shape: "sunny", tone: "orange" },
	{ id: "appearance", title: "appearance", hint: "settingsAppearanceHint", icon: <IPalette />, shape: "burst", tone: "pink" },
	{ id: "bots", title: "settingsBots", hint: "settingsBotsHint", icon: <IBot />, shape: "pill", tone: "tertiary" },
	{ id: "about", title: "settingsAbout", hint: "settingsAboutHint", icon: <IInfo />, shape: "oval", tone: "neutral" },
]

function useWide(): boolean {
	const query = "(min-width: 900px)"
	const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches)
	useEffect(() => {
		const media = window.matchMedia(query)
		const update = () => setWide(media.matches)
		media.addEventListener("change", update)
		return () => media.removeEventListener("change", update)
	}, [])
	return wide
}

export function SettingsSheet(props: {
	user: User
	onClose: () => void
	onUpdated: (user: User) => void
	initialPage?: SettingsPageId
	backgroundUnread?: Record<string, number>
}) {
	return (
		<Sheet onClose={props.onClose} size="xl" hideHeader className="settings-sheet" bodyClassName="settings-sheet-body">
			<SettingsShell {...props} />
		</Sheet>
	)
}

function SettingsShell(props: { user: User; onUpdated: (user: User) => void; initialPage?: SettingsPageId; backgroundUnread?: Record<string, number> }) {
	const { t } = useSettings()
	const close = useSheetClose()
	const wide = useWide()
	const [page, setPage] = useState<SettingsPageId>(props.initialPage ?? "home")
	const [direction, setDirection] = useState<"forward" | "back">("forward")
	const [signingOut, setSigningOut] = useState(false)

	const open = (next: SettingsPageId) => {
		setDirection("forward")
		setPage(next)
	}
	const back = () => {
		setDirection("back")
		setPage("home")
	}

	const current = CATEGORIES.find((item) => item.id === page)
	const title = current ? t(current.title) : t("settingsTitle")
	const showBack = !wide && page !== "home"

	const body = useMemo(() => {
		switch (page) {
			case "account":
				return <AccountPage user={props.user} onUpdated={props.onUpdated} />
			case "privacy":
				return <PrivacyPage />
			case "security":
				return <SecurityPage />
			case "devices":
				return <DevicesPage />
			case "notifications":
				return <NotificationsPage />
			case "appearance":
				return <AppearancePage />
			case "bots":
				return <BotsPage />
			case "about":
				return <AboutPage />
			default:
				return <SettingsHome user={props.user} wide={wide} onOpen={open} onSignOut={() => setSigningOut(true)} backgroundUnread={props.backgroundUnread} />
		}
	}, [page, props.user, props.onUpdated, wide, props.backgroundUnread])

	return (
		<div className={"settings-layout" + (wide ? " wide" : "")}>
			{wide ? (
				<nav className="settings-rail" aria-label={t("settingsTitle")}>
					<button type="button" className={"settings-rail-profile" + (page === "home" ? " selected" : "")} onClick={() => { setDirection("back"); setPage("home") }}>
						<Avatar src={props.user.avatar} label={props.user.displayName || props.user.username} seed={props.user.id} size={44} />
						<span className="settings-rail-profile-text">
							<span className="settings-rail-name">{props.user.displayName || props.user.username}</span>
							<span className="settings-rail-handle">@{props.user.username}</span>
						</span>
					</button>
					<ListGroup>
						{CATEGORIES.map((category) => (
							<ListItem key={category.id} title={t(category.title)} icon={category.icon} shape={category.shape} tone={category.tone} selected={page === category.id} onClick={() => open(category.id)} />
						))}
					</ListGroup>
					<ListGroup>
						<ListItem title={t("signOut")} icon={<ILogout />} shape="circle" tone="error" danger onClick={() => setSigningOut(true)} />
					</ListGroup>
				</nav>
			) : null}
			<div className="settings-content">
				<header className="settings-topbar">
					{showBack ? (
						<IconButton label={t("back")} onClick={back}>
							<IBack />
						</IconButton>
					) : null}
					<h2 className="settings-topbar-title">{page === "home" && !wide ? t("settingsTitle") : title}</h2>
					<IconButton label={t("close")} variant="tonal" onClick={close}>
						<IClose />
					</IconButton>
				</header>
				<div className="settings-scroll">
					<div key={page} className={"m3-page settings-page" + (direction === "back" ? " back" : "")}>
						{body}
					</div>
				</div>
			</div>
			{signingOut ? <SignOutSheet onClose={() => setSigningOut(false)} /> : null}
		</div>
	)
}

function SettingsHome(props: { user: User; wide: boolean; onOpen: (page: SettingsPageId) => void; onSignOut: () => void; backgroundUnread?: Record<string, number> }) {
	const { t } = useSettings()
	const { accounts, switchAccount, keys } = useAuth()
	const others = accounts.filter((account) => account.id !== props.user.id)
	const keyHint = keys.status === "ready"
		? keys.health.hasRecoverySlot ? t("keysBackedUp") : t("keysNeedRecovery")
		: keys.status === "locked" ? t("keysLockedShort") : t("keysChecking")
	return (
		<div className="settings-home">
			<section className="settings-hero">
				<span className="settings-hero-art" aria-hidden="true">
					<MorphBlob className="settings-hero-blob" size={220} shapes={[1, 6, 7, 2]} morphMs={1200} holdMs={1800} />
				</span>
				<Avatar src={props.user.avatar} label={props.user.displayName || props.user.username} seed={props.user.id} size={96} className="settings-hero-avatar" />
				<h3 className="settings-hero-name">{props.user.displayName || props.user.username}</h3>
				<p className="settings-hero-handle">@{props.user.username}</p>
				<div className="m3-row settings-hero-actions">
					<button type="button" className="m3-btn tonal" onClick={() => props.onOpen("account")}>{t("editProfile")}</button>
				</div>
			</section>

			<ListGroup label={t("accountsOnDevice")}>
				<ListItem
					leading={<Avatar src={props.user.avatar} label={props.user.displayName || props.user.username} seed={props.user.id} size={40} />}
					title={props.user.displayName || props.user.username}
					subtitle={t("accountCurrent")}
					selected
				/>
				{others.map((account) => (
					<ListItem
						key={account.id}
						leading={<Avatar src={account.avatar} label={account.displayName || account.username} seed={account.id} size={40} />}
						title={account.displayName || account.username}
						subtitle={account.token ? "@" + account.username : t("accountSignedOut")}
						trailing={<Badge count={props.backgroundUnread?.[account.id] ?? 0} />}
						onClick={() => switchAccount(account.id)}
						chevron
					/>
				))}
				{accounts.length < MAX_ACCOUNTS ? (
					<ListItem title={t("addAccount")} icon={<IAdd />} shape="circle" tone="secondary" onClick={() => window.location.assign("/login?add=1")} />
				) : null}
			</ListGroup>

			{!props.wide ? (
				<>
					<ListGroup label={t("settingsTitle")}>
						{CATEGORIES.map((category) => (
							<ListItem
								key={category.id}
								title={t(category.title)}
								subtitle={category.id === "security" ? keyHint : t(category.hint)}
								icon={category.icon}
								shape={category.shape}
								tone={category.tone}
								onClick={() => props.onOpen(category.id)}
								chevron
							/>
						))}
					</ListGroup>
					<ListGroup>
						<ListItem title={t("signOut")} icon={<ILogout />} shape="circle" tone="error" danger onClick={props.onSignOut} />
					</ListGroup>
				</>
			) : (
				<ListGroup label={t("settingsSecurity")}>
					<ListItem title={t("encryptionTitle")} subtitle={keyHint} icon={<IKey />} shape="cookie12" tone="violet" onClick={() => props.onOpen("security")} chevron />
				</ListGroup>
			)}
		</div>
	)
}
